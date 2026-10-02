<script setup lang="ts">
import { computed } from "vue";
import type { APIMessage } from "discord.js";
import MessageBody from "./MessageBody.vue";
import { avatar, dateTime } from "./format";
const props = defineProps<{ message: APIMessage }>();
const referenceUrl = computed(() => {
  const reference = props.message.message_reference;
  if (!reference?.channel_id || !reference.message_id) return undefined;
  return `https://discord.com/channels/${reference.guild_id ?? "667551433503014924"}/${reference.channel_id}/${reference.message_id}`;
});
const name = computed(
  () => props.message.author.global_name || props.message.author.username,
);
</script>

<template>
  <article class="thread-message" :id="`message-${message.id}`">
    <div class="avatar">
      <img
        v-if="avatar(message.author)"
        :src="avatar(message.author)"
        alt=""
        loading="lazy"
      /><span v-else>{{ name.slice(0, 1).toUpperCase() }}</span>
    </div>
    <div class="message-main">
      <div class="message-byline">
        <strong>{{ name }}</strong
        ><span v-if="message.author.bot" class="bot-label">BOT</span
        ><time :datetime="message.timestamp">{{
          dateTime(message.timestamp)
        }}</time
        ><small
          v-if="message.edited_timestamp"
          :title="dateTime(message.edited_timestamp)"
          >(edited)</small
        >
      </div>
      <div
        v-if="message.message_reference && message.message_reference.type !== 1"
        class="reply-reference"
      >
        <a :href="referenceUrl" target="_blank" rel="noopener noreferrer"
          >↳ Reply to
          {{
            message.referenced_message?.author?.global_name ||
            message.referenced_message?.author?.username ||
            "message"
          }}
          ↗</a
        >
        <MessageBody
          v-if="message.referenced_message"
          :message="message.referenced_message"
        />
        <div
          v-for="(snapshot, index) in message.referenced_message
            ?.message_snapshots"
          :key="index"
          class="forward-reference"
        >
          <span class="muted">↪ Forwarded message</span>
          <MessageBody :message="snapshot.message" />
        </div>
        <span v-if="!message.referenced_message" class="muted"
          >Original message is unavailable or was deleted.</span
        >
      </div>
      <p v-if="message.type === 4" class="muted">Changed the ticket title:</p>
      <MessageBody :message="message" />
      <div
        v-for="(snapshot, index) in message.message_snapshots"
        :key="index"
        class="forward-reference"
      >
        <a :href="referenceUrl" target="_blank" rel="noopener noreferrer"
          >↪ Forwarded message ↗</a
        >
        <MessageBody :message="snapshot.message" />
      </div>
      <a
        v-if="
          message.message_reference?.type === 1 &&
          !message.message_snapshots?.length
        "
        :href="referenceUrl"
        target="_blank"
        rel="noopener noreferrer"
        >↪ Forwarded message · View in Discord ↗</a
      >
      <p
        v-if="
          !message.content &&
          !message.attachments?.length &&
          !message.embeds?.length &&
          !message.message_reference
        "
        class="muted"
      >
        {{
          message.type === 6
            ? "Pinned a message."
            : "System message or content available in Discord."
        }}
      </p>
      <div v-if="message.sticker_items?.length" class="stickers">
        <span v-for="sticker in message.sticker_items" :key="sticker.id"
          >Sticker: {{ sticker.name }}</span
        >
      </div>
      <div v-if="message.reactions?.length" class="reactions">
        <span
          v-for="reaction in message.reactions"
          :key="reaction.emoji.id || reaction.emoji.name || ''"
          ><img
            v-if="reaction.emoji.id"
            :src="`https://cdn.discordapp.com/emojis/${reaction.emoji.id}.webp?size=32${reaction.emoji.animated ? '&animated=true' : ''}`"
            :alt="reaction.emoji.name || 'Emoji'"
          /><template v-else>{{ reaction.emoji.name }}</template>
          {{ reaction.count }}</span
        >
      </div>
    </div>
  </article>
</template>
