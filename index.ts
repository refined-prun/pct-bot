import { Client, GatewayIntentBits, Events, Partials, ThreadChannel, Message, ForumChannel } from "discord.js";
import { Octokit } from '@octokit/rest';
import * as dotenv from 'dotenv';

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

const TRACKED_IN_REGEX = /Tracked in (https:\/\/github\.com\/.*\/issues\/(\d+))/;

async function summarizeThread(thread: ThreadChannel) {
  const messages = await thread.messages.fetch({ limit: 100 });
  const sortedMessages = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  let content = `Thread ${thread.url}`;
  const references = new Map<string, string>();

  sortedMessages.forEach(msg => {
    if (msg.type === 4) return;
    if (msg.author.id === bot.user?.id) return;
    const match = msg.content.match(TRACKED_IN_REGEX);
    if (match) return;
    if (msg.author.id === OWNER_DISCORD_ID && msg.content.startsWith('!')) return;
    content += `\n\n`;
    content += msg.reference?.messageId ? `↳<sub>${references.get(msg.reference.messageId)}</sub>\n` : ``;
    content += `**${msg.author.username}**`;
    let messageContent = '';
    if (msg.content) {
      messageContent += `\n${msg.content}`;
    }
    msg.attachments.forEach(attachment => {
      messageContent += `\n[${attachment.name}]`;
    });
    content += messageContent;
    let reference = messageContent.trim().split('\n')[0];
    if (reference.length > 50) {
      reference = reference.slice(0, 47) + '...';
    }
    references.set(msg.id, reference);
  });

  return content;
}

function isFeatureChannel(name: string) {
  return name.toLowerCase().includes('feature');
}

async function processTrack(thread: ThreadChannel, message: Message) {
  const messages = await thread.messages.fetch({ limit: 100 });
  for (const [, msg] of messages) {
    if (msg.author.id === OWNER_DISCORD_ID || msg.author.id === bot.user?.id) {
      const match = msg.content.match(TRACKED_IN_REGEX);
      if (match) {
        await replaceWithNotice(thread, message, 'Issue already exists for this thread.');
        return;
      }
    }
  }

  let body = await summarizeThread(thread);
  const channelName = thread.parent!.name.toLowerCase();
  const labels = ['discord'];
  if (isFeatureChannel(channelName)) {
    labels.push('enhancement');
  } else {
    labels.push('bug');
  }

  const [owner, repo] = GITHUB_REPO.split('/');
  const issue = await octokit.rest.issues.create({
    owner,
    repo,
    title: thread.name,
    body,
    labels,
  });

  await thread.send(`Tracked in ${issue.data.html_url}`);
  await message.delete();

  const channel = thread.parent as ForumChannel;
  const trackedTag = channel.availableTags.find(tag => tag.name.toLowerCase() === 'tracked');
  await thread.setAppliedTags([trackedTag!.id]);
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
  let body = await summarizeThread(thread);
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

  await replaceWithNotice(thread, message, 'Issue updated.');
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
bot.login(DISCORD_TOKEN);
