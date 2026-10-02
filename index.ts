import { Client, GatewayIntentBits, Events, Partials, ThreadChannel, Message } from "discord.js";
import { Octokit } from '@octokit/rest';
import * as dotenv from 'dotenv';
import { startBoardServer } from './server/http.js';
import { TicketTracker, TRACKED_IN_REGEX, summarizeThread } from './server/tracking.js';
import { GitHubAttachments } from './server/attachments.js';

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_REPO = process.env.GITHUB_REPO!;
const OWNER_DISCORD_ID = process.env.OWNER_DISCORD_ID!;

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const tracker = new TicketTracker(bot, octokit, GITHUB_REPO, OWNER_DISCORD_ID, new GitHubAttachments(octokit, GITHUB_REPO));

function isFeatureChannel(name: string) {
  return name.toLowerCase().includes('feature');
}

async function processTrack(thread: ThreadChannel, message: Message) {
  const result = await tracker.track(thread);
  if (result.warning || result.alreadyTracked) {
    await replaceWithNotice(thread, message, result.warning ?? 'Issue already exists for this thread.');
  } else {
    await message.delete();
  }
}

async function processUpdate(thread: ThreadChannel, message: Message) {
  let trackedNumber: number | null = null;

  const messages = await thread.messages.fetch({ limit: 100 });
  for (const [, msg] of messages) {
    if (msg.author.id === OWNER_DISCORD_ID || msg.author.id === bot.user?.id) {
      const match = msg.content.match(TRACKED_IN_REGEX);
      if (match) {
        trackedNumber = parseInt(match[2]);
        break;
      }
    }
  }

  if (!trackedNumber) {
    await replaceWithNotice(thread, message, 'No tracked issue found in this thread.');
    return;
  }

  const [owner, repo] = GITHUB_REPO.split('/');

  await message.react('🧠')
  let body = await summarizeThread(thread, bot.user?.id, OWNER_DISCORD_ID);
  const channelName = thread.parent!.name.toLowerCase();
  const labels = ['discord'];
  if (isFeatureChannel(channelName)) {
    labels.push('enhancement');
  } else {
    labels.push('bug');
  }

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: trackedNumber,
    title: thread.name,
    body,
    labels,
  });

  let notice = 'Issue updated.';
  try {
    await tracker.syncAttachments(thread, trackedNumber);
  } catch (error) {
    notice = `Issue updated, but attachments could not be copied: ${error instanceof Error ? error.message : 'Upload failed'}`;
  }
  await replaceWithNotice(thread, message, notice);
}

async function replaceWithNotice(thread: ThreadChannel, message: Message, reply: string) {
  const notice = await thread.send(reply);
  await message.delete();
  await new Promise(resolve => setTimeout(resolve, 10000));
  await notice.delete();
}

bot.on(Events.MessageCreate, async (message) => {
  if (message.author.id !== OWNER_DISCORD_ID) return;
  if (!message.content.startsWith('!track') && !message.content.startsWith('!update')) return;

  const thread = message.channel instanceof ThreadChannel ? message.channel : null;
  if (!thread || thread.parent?.type !== 15) {
    await message.channel.send('This command must be used inside a forum thread.');
    return;
  }

  const title = message.content.split(' ').slice(1).join(' ').trim();
  if (title) {
    await thread.edit({ name: title });
  }

  await message.react('🧠');
  try {
    if (message.content.startsWith('!track')) {
      console.log('!track ' + thread.name);
      await processTrack(thread, message);
    }

    if (message.content.startsWith('!update')) {
      console.log('!update ' + thread.name);
      await processUpdate(thread, message);
    }
  } catch (e) {
    console.error(e);
    await replaceWithNotice(thread, message, 'Error processing request.');
  }
});

bot.on(Events.ClientReady, () => {
  console.log(`Logged in as ${bot.user?.tag}`);
});

console.log('Starting bot...');
const boardServer = await startBoardServer(bot, async (id) => {
  const thread = await bot.channels.fetch(id, { force: true });
  if (!(thread instanceof ThreadChannel)) throw new Error('Ticket thread not found.');
  return tracker.track(thread);
});
bot.login(DISCORD_TOKEN).catch(error => {
  console.error('Discord login failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
  void boardServer.close();
  bot.destroy();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void boardServer.close();
    bot.destroy();
  });
}
