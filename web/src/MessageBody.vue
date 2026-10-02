<script setup lang="ts">
import type { APIMessage } from "discord.js";
import { markdown, safeUrl, fileSize } from "./format";

type Body = Pick<APIMessage, "content" | "attachments" | "embeds" | "mentions">;
defineProps<{ message: Body }>();
</script>

<template>
  <div
    v-if="message.content"
    class="markdown"
    v-html="markdown(message.content, message.mentions)"
  />
  <div v-if="message.attachments?.length" class="attachments">
    <div v-for="file in message.attachments" :key="file.id" class="attachment">
      <a
        v-if="
          file.content_type?.startsWith('image/') ||
          /\.(png|jpe?g|gif|webp|avif)$/i.test(file.filename)
        "
        :href="safeUrl(file.url)"
        target="_blank"
        rel="noopener noreferrer"
        class="image-link"
      >
        <img
          :src="safeUrl(file.proxy_url || file.url)"
          :alt="file.description || file.filename"
          loading="lazy"
        />
      </a>
      <video
        v-else-if="file.content_type?.startsWith('video/')"
        :src="safeUrl(file.url)"
        controls
        preload="metadata"
      />
      <audio
        v-else-if="file.content_type?.startsWith('audio/')"
        :src="safeUrl(file.url)"
        controls
        preload="none"
      />
      <a
        class="file-link"
        :href="safeUrl(file.url)"
        target="_blank"
        rel="noopener noreferrer"
        :download="file.filename"
      >
        <span>↓ {{ file.filename }}</span
        ><small>{{ fileSize(file.size) }}</small>
      </a>
    </div>
  </div>
  <div
    v-for="(embed, index) in message.embeds"
    :key="index"
    class="embed"
    :style="
      embed.color
        ? { borderColor: '#' + embed.color.toString(16).padStart(6, '0') }
        : {}
    "
  >
    <small v-if="embed.provider?.name" class="muted">{{
      embed.provider.name
    }}</small>
    <div v-if="embed.author" class="embed-author">{{ embed.author.name }}</div>
    <a
      v-if="embed.title"
      :href="safeUrl(embed.url)"
      target="_blank"
      rel="noopener noreferrer"
      class="embed-title"
      >{{ embed.title }}</a
    >
    <div
      v-if="embed.description"
      class="markdown"
      v-html="markdown(embed.description)"
    />
    <div
      v-for="(field, fieldIndex) in embed.fields"
      :key="fieldIndex"
      class="embed-field"
    >
      <strong>{{ field.name }}</strong>
      <div class="markdown" v-html="markdown(field.value)" />
    </div>
    <a
      v-if="embed.image || embed.thumbnail"
      :href="safeUrl(embed.url || embed.image?.url || embed.thumbnail?.url)"
      target="_blank"
      rel="noopener noreferrer"
    >
      <img
        :src="
          safeUrl(
            embed.image?.proxy_url ||
              embed.image?.url ||
              embed.thumbnail?.proxy_url ||
              embed.thumbnail?.url,
          )
        "
        :alt="embed.title || 'Embedded image'"
        loading="lazy"
      />
    </a>
    <a
      v-if="embed.video && embed.url"
      :href="safeUrl(embed.url)"
      target="_blank"
      rel="noopener noreferrer"
      >Watch video ↗</a
    >
    <small v-if="embed.footer" class="muted">{{ embed.footer.text }}</small>
  </div>
</template>
