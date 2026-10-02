import { marked } from "marked";
import DOMPurify from "dompurify";
import type { APIUser } from "discord.js";

export function safeUrl(value?: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
marked.use({
  breaks: true,
  gfm: true,
  renderer: { html: ({ text }) => escape(text) },
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
    if (!safeUrl(node.getAttribute("href"))) node.removeAttribute("href");
  }
  if (node.tagName === "IMG" && !safeUrl(node.getAttribute("src")))
    node.removeAttribute("src");
});

export function markdown(content: string, mentions: APIUser[] = []) {
  const text = content
    .replace(/<@!?(\d+)>/g, (_, id: string) => {
      const user = mentions.find((user) => user.id === id);
      return (
        "@" +
        (user?.global_name ?? user?.username ?? id).replace(/[\[\]<>*_`]/g, "")
      );
    })
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, seconds: string) => {
      const date = new Date(Number(seconds) * 1000);
      return Number.isNaN(date.getTime())
        ? "[timestamp]"
        : date.toLocaleString();
    });
  return DOMPurify.sanitize(marked.parse(text, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "input", "button", "form", "iframe"],
    FORBID_ATTR: ["style", "id", "name"],
  });
}

export function relative(value: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

export function dateTime(value: string) {
  return new Date(value).toLocaleString();
}
export function avatar(user?: APIUser) {
  return user?.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`
    : undefined;
}
export function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
