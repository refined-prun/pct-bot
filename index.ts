import { Client, GatewayIntentBits, Events, Partials, ThreadChannel, Message, ForumChannel } from "discord.js";
import { Octokit } from '@octokit/rest';
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
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
const openai = new OpenAI();

const TRACKED_IN_REGEX = /Tracked in (https:\/\/github\.com\/.*\/issues\/(\d+))/;

const FeatureRequestSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const BugReportSchema = z.object({
  title: z.string(),
  description: z.string(),
  replicationSteps: z.string().nullable(),
  extensionVersion: z.string().nullable(),
  browsersUsed: z.string().nullable(),
});

async function summarizeThread(thread: ThreadChannel) {
  const messages = await thread.messages.fetch({ limit: 100 });
  const sortedMessages = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  let rawContent = `Thread title: ${thread.name}\n\n`;

  sortedMessages.forEach(msg => {
    if (msg.author.id === bot.user?.id) return;
    const replyInfo = msg.reference?.messageId ? `(replies to ${msg.reference.messageId})` : '';
    rawContent += `Message ID ${msg.id} ${replyInfo} ${msg.author?.username}: ${msg.content}\n\n`;
  });

  return rawContent;
}

async function generateNewIssue<T extends z.ZodRawShape>(thread: string, schema: z.ZodObject<T>) {
  const chatCompletion = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: 'Summarize the following Discord thread into a concise GitHub issue description. ' +
          'Include main problem, relevant details, and any steps to reproduce if mentioned. Don\'t include details ' +
          'that became irrelevant later. Ignore greetings and small talk. Format description as paragraphs if it helps readability. ' +
          'Don\'t use markdown headers. Don\'t duplicate information in output sections.'},
      { role: 'user', content: thread },
    ],
    text: {
      format: zodTextFormat(schema, 'issue'),
    },
    temperature: 0.3,
  });

  return JSON.parse(chatCompletion.output_text) as z.infer<typeof schema>;
}

async function updateExistingIssue<T extends z.ZodRawShape>(thread: string, title: string, description: string, schema: z.ZodObject<T>) {
  const chatCompletion = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: 'You are updating an existing GitHub issue. Provided is the existing title and description, followed by Discord thread content. ' +
          'Interpret the existing issue description according to the output schema. Don\'t duplicate information in output sections. ' +
          'Only change title or description if there is significant new or corrected information. If the existing title and description are still accurate, leave them unchanged. ' +
          'If issue includes a Discord link, remove it.' +
          'Summarize the following Discord thread into a concise GitHub issue description. ' +
          'Include main problem, relevant details, and any steps to reproduce if mentioned. Don\'t include details ' +
          'that became irrelevant later. Ignore greetings and small talk. Format description as paragraphs if it helps readability.' +
          'Don\'t use markdown headers.' },
      { role: 'user', content: `GitHub Issue:\n\n${title}\n${description}` },
      { role: 'user', content: `Discord Thread:\n${thread}` },
    ],
    text: {
      format: zodTextFormat(schema, 'issue'),
    },
    temperature: 0.3,
  });

  return JSON.parse(chatCompletion.output_text) as z.infer<typeof schema>;
}

function isFeatureChannel(name: string) {
  return name.toLowerCase().includes('feature');
}

function formatBugReport(summary: z.infer<typeof BugReportSchema>) {
  const parts = [`### Description\n\n${summary.description}`];
  if (summary.replicationSteps) parts.push(`### How to replicate the issue\n\n${summary.replicationSteps}`);
  if (summary.extensionVersion) parts.push(`### Extension version\n\n${summary.extensionVersion}`);
  if (summary.browsersUsed) parts.push(`### Browser(s) used\n\n${summary.browsersUsed}`);
  return parts.join('\n\n');
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

  const rawContent = await summarizeThread(thread);

  const channelName = thread.parent!.name.toLowerCase();
  let title: string;
  let body: string;
  const labels = ['discord', 'auto-generated'];
  if (isFeatureChannel(channelName)) {
    const summary = await generateNewIssue(rawContent, FeatureRequestSchema);
    title = summary.title;
    body = summary.description;
    labels.push('enhancement');
  } else {
    const summary = await generateNewIssue(rawContent, BugReportSchema);
    title = summary.title;
    body = formatBugReport(summary);
    labels.push('bug');
  }

  body += `\n\nTracked in ${thread.url}`;

  const [owner, repo] = GITHUB_REPO.split('/');
  const issue = await octokit.rest.issues.create({
    owner,
    repo,
    title,
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
  const existingIssue = await octokit.rest.issues.get({ owner, repo, issue_number: trackedNumber });

  await message.react('🧠')
  const rawContent = await summarizeThread(thread);
  const channelName = thread.parent!.name.toLowerCase();
  let title: string;
  let body: string;
  const labels = ['discord', 'auto-generated'];
  if (isFeatureChannel(channelName)) {
    const summary = await updateExistingIssue(rawContent, existingIssue.data.title, existingIssue.data.body || '', FeatureRequestSchema);
    title = summary.title;
    body = summary.description;
    labels.push('enhancement');
  } else {
    const summary = await updateExistingIssue(rawContent, existingIssue.data.title, existingIssue.data.body || '', BugReportSchema);
    title = summary.title;
    body = formatBugReport(summary);
    labels.push('bug');
  }

  body += `\n\nTracked in ${thread.url}`;

  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: trackedNumber,
    title,
    body,
    labels,
  });

  await replaceWithNotice(thread, message, 'Issue updated.');
}

async function replaceWithNotice(thread: ThreadChannel, message: Message, reply: string) {
  const notice = await thread.send(reply);
  await message.delete();
  await new Promise(resolve => setTimeout(resolve, 60000));
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
