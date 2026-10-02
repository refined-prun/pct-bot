<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type {
  Board,
  BoardKey,
  Ticket,
  TicketDetails,
  ForumTag,
  TrackResult,
} from "../../shared/board";
import Icon from "./Icon.vue";
import ThreadMessage from "./ThreadMessage.vue";
import { dateTime, relative } from "./format";

const selected = ref<BoardKey>(
  localStorage.getItem("prun-board") === "features" ? "features" : "bugs",
);
const board = ref<Board>();
const query = ref("");
const loading = ref(false);
const refreshing = ref(false);
const error = ref("");
const notice = ref("");
const token = ref("");
const moving = ref("");
const saving = ref<"" | "title" | "track">("");
const busy = computed(() => !!moving.value || !!saving.value);
const editingTitle = ref(false);
const titleDraft = ref("");
const titleInput = ref<HTMLInputElement>();
const issueUrl = ref("");
const drag = ref<{ id: string; source: string }>();
const dropTarget = ref("");
const details = ref<TicketDetails>();
const detailLoading = ref(false);
const detailError = ref("");
const activeTicket = ref<Ticket>();
const ticketPanel = ref<HTMLElement>();
let ticketOpener: HTMLElement | undefined;
const searchInput = ref<HTMLInputElement>();
const moveSource = ref("");
let boardRequest = 0;
let detailRequest = 0;
let timer: ReturnType<typeof setInterval>;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function dismissNotice() {
  clearTimeout(noticeTimer);
  notice.value = "";
}
function showNotice(message: string) {
  dismissNotice();
  notice.value = message;
  noticeTimer = setTimeout(dismissNotice, 4000);
}
const visible = computed(() =>
  (board.value?.tickets ?? []).filter((ticket) =>
    `${ticket.title} ${ticket.id}`
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
const columns = computed(() =>
  (board.value?.tags ?? []).map((tag) => ({
    tag,
    tickets: visible.value.filter((ticket) => ticket.tags.includes(tag.id)),
  })),
);
const ticketTags = computed(
  () =>
    board.value?.tags.filter((tag) =>
      activeTicket.value?.tags.includes(tag.id),
    ) ?? [],
);
const unrepresented = computed(
  () =>
    board.value?.tickets.filter(
      (ticket) =>
        !ticket.tags.some((id) =>
          board.value?.tags.some((tag) => tag.id === id),
        ),
    ).length ?? 0,
);
const currentBoardName = computed(() =>
  selected.value === "bugs" ? "Bug reports" : "Feature requests",
);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Unable to connect to the bot.");
  return body;
}
async function loadBoard(force = false, quiet = false) {
  const key = selected.value;
  const request = ++boardRequest;
  if (!quiet) {
    loading.value = !board.value;
    refreshing.value = true;
  }
  try {
    if (!token.value)
      token.value = (await api<{ token: string }>("/session")).token;
    const data = await api<Board>(`/boards/${key}${force ? "?refresh=1" : ""}`);
    if (request !== boardRequest || key !== selected.value) return;
    board.value = data;
    error.value = "";
  } catch (cause) {
    if (request === boardRequest)
      error.value =
        cause instanceof Error ? cause.message : "Could not load the board.";
  } finally {
    if (request === boardRequest) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}
function switchBoard(key: BoardKey) {
  if (selected.value === key || busy.value) return;
  closeTicket();
  selected.value = key;
  localStorage.setItem("prun-board", key);
  board.value = undefined;
  query.value = "";
  dismissNotice();
  error.value = "";
  void loadBoard();
}
async function openTicket(ticket: Ticket) {
  if (busy.value || activeTicket.value?.id === ticket.id) return;
  ticketOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  ++detailRequest;
  detailError.value = "";
  detailLoading.value = true;
  editingTitle.value = false;
  issueUrl.value = "";
  activeTicket.value = ticket;
  moveSource.value = ticket.tags[0] ?? "";
  details.value = undefined;
  await nextTick();
  if (activeTicket.value?.id !== ticket.id) return;
  if (ticketPanel.value) ticketPanel.value.scrollTop = 0;
  ticketPanel.value?.focus({ preventScroll: true });
  void loadDetails();
}
async function loadDetails() {
  if (!activeTicket.value) return;
  const id = activeTicket.value.id;
  const request = ++detailRequest;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const result = await api<TicketDetails>(
      `/boards/${selected.value}/tickets/${id}`,
    );
    if (request !== detailRequest) return;
    details.value = result;
    activeTicket.value = result.ticket;
    if (!result.ticket.tags.includes(moveSource.value))
      moveSource.value = result.ticket.tags[0] ?? "";
    updateTicket(result.ticket);
  } catch (cause) {
    if (request === detailRequest)
      detailError.value =
        cause instanceof Error ? cause.message : "Could not load this ticket.";
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}
function closeTicket() {
  if (saving.value) return;
  const restoreFocus = ticketPanel.value?.contains(document.activeElement);
  detailRequest++;
  activeTicket.value = undefined;
  details.value = undefined;
  detailLoading.value = false;
  const opener = ticketOpener;
  if (restoreFocus)
    void nextTick(() => {
      if (!activeTicket.value && opener?.isConnected)
        opener.focus({ preventScroll: true });
    });
}
function updateTicket(ticket: Ticket) {
  if (board.value)
    board.value.tickets = board.value.tickets
      .map((item) => (item.id === ticket.id ? ticket : item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (activeTicket.value?.id === ticket.id) activeTicket.value = ticket;
}
async function moveTicket(id: string, source: string, destination: string) {
  if (source === destination || busy.value) return;
  moving.value = id;
  dismissNotice();
  error.value = "";
  ++boardRequest; // Discard any refresh that started before this mutation.
  try {
    token.value = (await api<{ token: string }>("/session")).token;
    const result = await api<{ ticket: Ticket; warning?: string }>(
      `/boards/${selected.value}/tickets/${id}/move`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Board-Token": token.value,
        },
        body: JSON.stringify({ source, destination }),
      },
    );
    updateTicket(result.ticket);
    if (activeTicket.value?.id === id)
      moveSource.value = result.ticket.tags[0] ?? "";
    if (result.warning) error.value = result.warning;
    else
      showNotice(
        `Moved to ${board.value?.tags.find((tag) => tag.id === destination)?.name ?? "column"}.`,
      );
  } catch (cause) {
    const failure =
      cause instanceof Error ? cause.message : "Could not move this ticket.";
    await loadBoard(true, true);
    const current = board.value?.tickets.find((ticket) => ticket.id === id);
    if (current) updateTicket(current);
    error.value = failure;
  } finally {
    moving.value = "";
    refreshing.value = false;
  }
}
async function editTitle() {
  if (!activeTicket.value || busy.value) return;
  titleDraft.value = activeTicket.value.title;
  editingTitle.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}
async function saveTicket(action: "title" | "track") {
  if (!activeTicket.value || busy.value || detailLoading.value) return;
  const title = titleDraft.value.trim();
  if (action === "title" && (!title || title.length > 100)) return;
  const id = activeTicket.value.id;
  saving.value = action;
  error.value = "";
  dismissNotice();
  ++boardRequest;
  ++detailRequest;
  try {
    token.value = (await api<{ token: string }>("/session")).token;
    const result = await api<
      { ticket: Ticket; warning?: string } & Partial<TrackResult>
    >(`/boards/${selected.value}/tickets/${id}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Board-Token": token.value,
      },
      body: JSON.stringify(action === "title" ? { title } : {}),
    });
    updateTicket(result.ticket);
    if (action === "title") editingTitle.value = false;
    if (result.issueUrl) issueUrl.value = result.issueUrl;
    await loadDetails();
    if (result.warning) error.value = result.warning;
    else
      showNotice(
        action === "title"
          ? "Title saved."
          : result.alreadyTracked
            ? "Issue already exists."
            : "Tracked on GitHub.",
      );
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not update this ticket.";
  } finally {
    saving.value = "";
    refreshing.value = false;
  }
}
function startDrag(event: DragEvent, ticket: Ticket, source: string) {
  if (busy.value) {
    event.preventDefault();
    return;
  }
  drag.value = { id: ticket.id, source };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", ticket.id);
  }
}
function endDrag() {
  drag.value = undefined;
  dropTarget.value = "";
}
function drop(destination: string) {
  const from = drag.value;
  endDrag();
  if (from) void moveTicket(from.id, from.source, destination);
}
function dragOver(event: DragEvent, id: string) {
  if (!drag.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = id;
  const container = (event.currentTarget as HTMLElement).parentElement;
  if (!container) return;
  const bounds = container.getBoundingClientRect();
  if (event.clientX > bounds.right - 100) container.scrollLeft += 14;
  if (event.clientX < bounds.left + 100) container.scrollLeft -= 14;
}
function accent(tag: ForumTag) {
  const name = tag.name.toLowerCase();
  if (/open/.test(name)) return "#96baff";
  if (/track|progress/.test(name)) return "#edc176";
  if (/done|released|fixed/.test(name)) return "#8acbb0";
  if (/wont|won’t|not |reject/.test(name)) return "#d99a9f";
  if (/duplicate/.test(name)) return "#ad9edd";
  return "#a9b1bc";
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && activeTicket.value) {
    event.preventDefault();
    closeTicket();
    return;
  }
  if (
    event.key === "/" &&
    !(event.target instanceof HTMLInputElement) &&
    !(event.target instanceof HTMLTextAreaElement) &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    event.preventDefault();
    searchInput.value?.focus();
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void loadBoard();
  timer = setInterval(() => {
    if (!document.hidden && !busy.value && !loading.value && !refreshing.value)
      void loadBoard(false, true);
  }, 30_000);
});
onUnmounted(() => {
  clearInterval(timer);
  clearTimeout(noticeTimer);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="app-shell" :class="{ 'ticket-open': activeTicket }">
    <header class="topbar">
      <div class="brand">
        <img src="/refined-prun.png" alt="" /><span>Refined PrUn</span
        ><span class="brand-divider">/</span
        ><span class="workspace-label">Tickets</span>
      </div>
      <a
        :href="`https://discord.com/channels/667551433503014924/${selected === 'bugs' ? '1310995683066642483' : '1310995731640877161'}`"
        target="_blank"
        rel="noopener noreferrer"
        class="discord-link"
        aria-label="Open forum in Discord"
        >Open forum <Icon name="arrow"
      /></a>
    </header>
    <main class="workspace">
      <div class="toolbar">
        <div class="board-tabs" role="group" aria-label="Select board">
          <button
            :class="{ active: selected === 'bugs' }"
            :aria-pressed="selected === 'bugs'"
            :disabled="busy"
            @click="switchBoard('bugs')"
          >
            <span class="tab-symbol">⌘</span> Bug reports
          </button>
          <button
            :class="{ active: selected === 'features' }"
            :aria-pressed="selected === 'features'"
            :disabled="busy"
            @click="switchBoard('features')"
          >
            <span class="tab-symbol">✧</span> Feature requests
          </button>
        </div>
        <div class="toolbar-right">
          <label class="search"
            ><Icon name="search" /><input
              ref="searchInput"
              v-model="query"
              placeholder="Find a ticket…"
              aria-label="Find a ticket"
            /><kbd>/</kbd></label
          ><button
            class="icon-button refresh"
            :class="{ spinning: refreshing }"
            :disabled="refreshing || busy"
            aria-label="Refresh board"
            title="Refresh from Discord"
            @click="loadBoard(true)"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div class="board-caption">
        <div>
          <Icon name="board" /><strong>{{ currentBoardName }}</strong
          ><span class="count">{{ visible.length }}</span>
        </div>
        <span><Icon name="clock" /> Last message · newest first</span>
      </div>
      <div v-if="error" class="banner error" role="alert">
        <span>{{ error }}</span
        ><button @click="loadBoard(true)">Retry</button>
      </div>
      <div v-if="unrepresented" class="banner error" role="alert">
        {{ unrepresented }} ticket(s) have no matching forum tag. Assign a tag
        in Discord to show them here.
      </div>
      <div v-if="loading" class="loading-board" role="status">
        <span class="loader"></span> Loading tickets…
      </div>
      <div v-else-if="board" class="board" aria-label="Ticket board">
        <section
          v-for="column in columns"
          :key="column.tag.id"
          class="column"
          :class="{
            'drop-target':
              dropTarget === column.tag.id && drag?.source !== column.tag.id,
          }"
          :style="{ '--accent': accent(column.tag) }"
          :aria-label="column.tag.name"
          @dragover="dragOver($event, column.tag.id)"
          @drop.prevent="drop(column.tag.id)"
        >
          <div class="column-header">
            <span class="column-dot"></span
            ><img
              v-if="column.tag.emoji_id"
              class="tag-emoji"
              :src="`https://cdn.discordapp.com/emojis/${column.tag.emoji_id}.webp?size=32`"
              alt=""
            /><span v-else-if="column.tag.emoji_name" class="tag-emoji-text">{{
              column.tag.emoji_name
            }}</span>
            <h2>{{ column.tag.name }}</h2>
            <span class="column-count">{{ column.tickets.length }}</span>
          </div>
          <div class="column-cards">
            <button
              v-for="ticket in column.tickets"
              :key="ticket.id"
              class="ticket"
              :class="{
                dragging: drag?.id === ticket.id,
                saving: moving === ticket.id,
                selected: activeTicket?.id === ticket.id,
              }"
              :draggable="!busy"
              :disabled="busy"
              :aria-pressed="activeTicket?.id === ticket.id"
              :aria-label="`Open ticket: ${ticket.title}`"
              @dragstart="startDrag($event, ticket, column.tag.id)"
              @dragend="endDrag"
              @click="openTicket(ticket)"
            >
              <div class="ticket-top">
                <span class="ticket-kind"
                  >{{ selected === "bugs" ? "BUG" : "IDEA" }}
                  <span>· {{ ticket.id.slice(-5) }}</span></span
                ><span class="ticket-grip" aria-hidden="true">⠿</span>
              </div>
              <h3>{{ ticket.title }}</h3>
              <div v-if="ticket.tags.length > 1" class="extra-tags">
                <span
                  v-for="tag in board.tags.filter(
                    (tag) =>
                      ticket.tags.includes(tag.id) && tag.id !== column.tag.id,
                  )"
                  :key="tag.id"
                  >{{ tag.name }}</span
                >
              </div>
              <div class="ticket-footer">
                <span class="comment-count"
                  ><Icon name="message" /> {{ ticket.comments }}</span
                ><span :title="`Last message: ${dateTime(ticket.updatedAt)}`">{{
                  moving === ticket.id ? "Moving…" : relative(ticket.updatedAt)
                }}</span
                ><span
                  v-if="ticket.locked"
                  class="closed-indicator"
                  title="Closed and locked"
                  >Locked</span
                ><span
                  v-else-if="ticket.archived"
                  class="closed-indicator"
                  title="Older / closed post"
                  >Older</span
                >
              </div>
            </button>
            <div v-if="!column.tickets.length" class="empty-column">
              <span>—</span>{{ query ? "No matching tickets" : "No tickets" }}
            </div>
          </div>
          <div v-if="drag && drag.source !== column.tag.id" class="drop-hint">
            Drop to {{ column.tag.name.toLowerCase() }}
          </div>
        </section>
      </div>
      <footer class="workspace-footer">
        <span
          ><i :class="{ offline: !!error }"></i
          >{{
            error
              ? "Needs attention"
              : board
                ? "Connected to Discord"
                : "Connecting…"
          }}<span v-if="board">
            · Synced {{ relative(board.fetchedAt) }}</span
          ></span
        >
      </footer>
    </main>
    <aside
      v-if="activeTicket"
      ref="ticketPanel"
      class="ticket-panel"
      aria-label="Ticket details"
      tabindex="-1"
    >
      <header class="panel-header">
        <div class="panel-breadcrumb">
          <Icon name="board" />{{ currentBoardName
          }}<Icon name="chevron" /><span>Ticket</span>
        </div>
        <button
          class="icon-button"
          aria-label="Close ticket"
          :disabled="!!saving"
          @click="closeTicket"
        >
          <Icon name="close" />
        </button>
      </header>
      <div class="panel-title">
        <form
          v-if="editingTitle"
          class="title-editor"
          @submit.prevent="saveTicket('title')"
        >
          <label for="ticket-title-input">Title</label>
          <input
            id="ticket-title-input"
            ref="titleInput"
            v-model="titleDraft"
            maxlength="100"
            required
            :disabled="!!saving"
            @keydown.esc.stop.prevent="!saving && (editingTitle = false)"
          />
          <div class="title-actions">
            <button
              class="action-button"
              type="submit"
              :disabled="busy || detailLoading || !titleDraft.trim()"
            >
              {{ saving === "title" ? "Saving…" : "Save" }}
            </button>
            <button
              class="text-button"
              type="button"
              :disabled="!!saving"
              @click="editingTitle = false"
            >
              Cancel
            </button>
          </div>
        </form>
        <div v-else class="title-row">
          <h2 id="ticket-title">{{ activeTicket.title }}</h2>
          <button
            class="text-button"
            :disabled="busy || detailLoading"
            @click="editTitle"
          >
            Edit title
          </button>
        </div>
        <div class="ticket-tags">
          <span
            v-for="tag in ticketTags"
            :key="tag.id"
            :style="{ color: accent(tag) }"
            >{{ tag.emoji_name }} {{ tag.name }}</span
          >
        </div>
      </div>
      <div class="panel-layout">
        <div class="ticket-controls">
          <dl>
            <dt>Last message</dt>
            <dd :title="dateTime(activeTicket.updatedAt)">
              {{ relative(activeTicket.updatedAt) }}
            </dd>
            <dt>Post status</dt>
            <dd>
              {{
                activeTicket.locked
                  ? "Closed and locked"
                  : activeTicket.archived
                    ? "Older / closed"
                    : "Active"
              }}
            </dd>
            <dt>Ticket ID</dt>
            <dd class="ticket-id">{{ activeTicket.id }}</dd>
          </dl>
          <button
            class="action-button track-button"
            :disabled="busy || detailLoading || editingTitle"
            @click="saveTicket('track')"
          >
            {{ saving === "track" ? "Tracking…" : "Track on GitHub" }}
          </button>
          <a
            v-if="issueUrl"
            :href="issueUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="issue-link"
            >Open GitHub issue <Icon name="arrow"
          /></a>
          <label v-if="ticketTags.length > 1" class="move-label"
            >Replace tag<select v-model="moveSource" :disabled="busy">
              <option v-for="tag in ticketTags" :key="tag.id" :value="tag.id">
                {{ tag.name }}
              </option>
            </select></label
          >
          <label class="move-label"
            >Move to<select
              :value="''"
              :disabled="busy || detailLoading || editingTitle || !moveSource"
              aria-label="Move ticket to"
              @change="
                moveTicket(
                  activeTicket.id,
                  moveSource,
                  ($event.target as HTMLSelectElement).value,
                );
                ($event.target as HTMLSelectElement).value = '';
              "
            >
              <option value="" disabled>Choose a column…</option>
              <option
                v-for="tag in board?.tags.filter(
                  (tag) => tag.id !== moveSource,
                )"
                :key="tag.id"
                :value="tag.id"
              >
                {{ tag.name }}
              </option>
            </select></label
          >
          <p v-if="moving" class="muted" role="status">
            Saving tags to Discord…
          </p>
          <p v-if="error" class="sidebar-error" role="alert">{{ error }}</p>
          <a
            :href="activeTicket.url"
            target="_blank"
            rel="noopener noreferrer"
            class="discord-button"
            >Open in Discord <Icon name="arrow"
          /></a>
        </div>
        <div class="conversation">
          <div v-if="detailError" class="banner error" role="alert">
            {{ detailError }} <button @click="loadDetails">Retry</button>
          </div>
          <div
            v-if="detailLoading && !details"
            class="detail-loading"
            role="status"
          >
            <span class="loader"></span> Loading comments…
          </div>
          <template v-if="details">
            <h3 class="section-label">Description</h3>
            <ThreadMessage v-if="details.starter" :message="details.starter" />
            <p v-else class="muted">
              The original post is unavailable or has been deleted.
            </p>
            <div class="activity-heading">
              <h3 class="section-label">
                Conversation
                <span class="count">{{ details.messages.length }}</span>
              </h3>
              <button
                class="text-button"
                :disabled="detailLoading || busy"
                @click="loadDetails"
              >
                <Icon name="refresh" />{{
                  detailLoading ? "Refreshing…" : "Refresh"
                }}
              </button>
            </div>
            <ThreadMessage
              v-for="message in details.messages"
              :key="message.id"
              :message="message"
            />
            <div v-if="!details.messages.length" class="empty-conversation">
              <Icon name="message" />
              <p>No comments yet</p>
            </div>
          </template>
        </div>
      </div>
    </aside>
    <Teleport v-if="notice" to="body">
      <div class="toast" role="status" aria-atomic="true">
        <span>{{ notice }}</span>
        <button aria-label="Dismiss notification" @click="dismissNotice">
          <Icon name="close" />
        </button>
      </div>
    </Teleport>
  </div>
</template>
