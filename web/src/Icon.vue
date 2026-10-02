<script setup lang="ts">
defineProps<{
  name:
    | "search"
    | "refresh"
    | "message"
    | "arrow"
    | "close"
    | "board"
    | "clock"
    | "chevron";
}>();
const paths = {
  search: "m21 21-4.8-4.8M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  refresh:
    "M20 7v5h-5M4 17v-5h5M5.1 7a8 8 0 0 1 13.2-2L20 7M4 17l1.7 2A8 8 0 0 0 18.9 17",
  message:
    "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z",
  arrow: "M7 17 17 7M7 7h10v10",
  close: "m6 6 12 12M6 18 18 6",
  board: "M3 3h18v18H3zM9 3v18M15 3v18",
  clock: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  chevron: "m9 5 7 7-7 7",
};
</script>
<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
