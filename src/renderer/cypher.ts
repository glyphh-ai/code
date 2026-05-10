/**
 * Cypher Mode — live collaborative workspace panel.
 *
 * Three columns:
 *  - Left: jammer roster with live status indicators
 *  - Center: agent output stream (owner sees full SDK output, observer sees SSE feed)
 *  - Right: chat/drips (real-time messages between participants)
 *
 * Owner mode: can spawn agents, send instructions, view full output.
 * Observer mode: sees SSE-forwarded events, can chat/drip.
 */

import { formatMarkdown } from "./format-markdown";

// ── Types ──────────────────────────────────────────────

interface CypherPanelAPI {
  authMe: () => Promise<{ id?: string; email?: string; handle?: string; error?: string }>;
  cypherGet: (id: string) => Promise<any>;
  cypherJammers: (id: string) => Promise<any>;
  cypherEventsList: (id: string, opts?: { since?: number; limit?: number }) => Promise<any>;
  cypherCoverGet: (id: string) => Promise<{ ok: boolean; data_base64?: string; content_type?: string }>;
  agentStart: (agentName: string) => void;
  agentStop: (agentName: string) => void;
  agentSend: (agentName: string, message: string) => void;
  cypherSpawnJammers: (id: string) => Promise<any>;
  cypherPostEvent: (id: string, kind: string, payload: Record<string, unknown>, jamId?: string, byAgentId?: string) => Promise<any>;
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;
  onAgentMessage: (cb: (agentName: string, msg: Record<string, unknown>) => void) => () => void;
  onAgentStatus: (cb: (agentName: string, status: string) => void) => () => void;
  onStageToken: (cb: (delta: string) => void) => () => void;
  onStageTool: (cb: (id: string, name: string, input: unknown) => void) => () => void;
  onStageToolResult: (cb: (id: string, detail: string) => void) => () => void;
  onStageDone: (cb: (fullText: string) => void) => () => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
  getCypherContext: () => Promise<{ cypherId: string; isOwner: boolean } | null>;
  leaveCypher: () => void;
  onContextReady: (cb: () => void) => () => void;
}

const api = (window as unknown as { cypher: CypherPanelAPI }).cypher;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// ── State ──────────────────────────────────────────────

interface Jammer {
  id: string;
  agent_local_id: string;
  user_id: string;
  position: string;
  status: "idle" | "running" | "waiting" | "error";
}

interface ChatMessage {
  author: string;
  body: string;
  time: Date;
  system?: boolean;
}

let cypherId: string | null = null;
let isOwner = false;
let currentUserId: string | null = null;
let cypherData: any = null;
let jammers: Jammer[] = [];
let focusedAgent: string | null = null;
let chatMessages: ChatMessage[] = [];
let unsubEvents: (() => void) | null = null;
let unsubAgentMsg: (() => void) | null = null;
let unsubAgentStatus: (() => void) | null = null;
let unsubStageToken: (() => void) | null = null;
let unsubStageTool: (() => void) | null = null;
let unsubStageToolResult: (() => void) | null = null;
let unsubStageDone: (() => void) | null = null;

// Per-agent message buffers for the stage
const agentStreams = new Map<string, string[]>();

// ── Init ───────────────────────────────────────────────

async function init(): Promise<void> {
  const ctx = await api.getCypherContext();
  if (!ctx) {
    $("stage-empty").textContent = "No cypher context. Open a cypher from The Drop.";
    return;
  }

  cypherId = ctx.cypherId;

  const me = await api.authMe();
  currentUserId = me.id || null;

  await loadCypher();

  // Determine ownership from cypher data (overrides context hint)
  isOwner = ctx.isOwner || (cypherData?.owner_user_id != null && cypherData.owner_user_id === currentUserId);
  await loadJammers();
  await loadRecentChat();
  subscribeEvents();
  renderRoster();
  renderStage();
  wireUI();

  // Hide owner-only controls for observers
  if (!isOwner) {
    $("btn-spawn").classList.add("hidden");
  }
}

async function loadCypher(): Promise<void> {
  if (!cypherId) return;
  try {
    const r = await api.cypherGet(cypherId);
    cypherData = (r as any)?.cypher || r;
    $("cypher-title").textContent = cypherData?.title || "Untitled";
    const status = cypherData?.status || "lobby";
    $("cypher-status-text").textContent = status;
    const statusEl = $("cypher-status");
    statusEl.className = `topbar-status ${status === "live" ? "live" : "lobby"}`;
  } catch { /* noop */ }
}

async function loadJammers(): Promise<void> {
  if (!cypherId) return;
  try {
    const r = await api.cypherJammers(cypherId);
    const raw = (r as any)?.jammers || [];
    jammers = raw
      .filter((j: any) => !j.left_at)
      .map((j: any) => ({
        id: j.id,
        agent_local_id: j.agent_local_id,
        user_id: j.user_id,
        position: j.position || "jammer",
        status: "idle" as const,
      }));
    // Default to orchestrator view (focusedAgent = null)
  } catch { /* noop */ }
}

async function loadRecentChat(): Promise<void> {
  if (!cypherId) return;
  try {
    const r = await api.cypherEventsList(cypherId, { limit: 50 });
    const events = (r as any)?.events || [];
    for (const ev of events) {
      if (ev.kind === "post" && ev.payload?.tags?.includes("drip")) {
        chatMessages.push({
          author: ev.payload.author || ev.by_agent_id || "unknown",
          body: ev.payload.body || ev.payload.text || "",
          time: new Date(ev.created_at),
          system: false,
        });
      } else if (ev.kind === "jammer_join" || ev.kind === "jammer_leave") {
        chatMessages.push({
          author: "system",
          body: `${ev.payload?.agent_local_id || "someone"} ${ev.kind === "jammer_join" ? "joined" : "left"}`,
          time: new Date(ev.created_at),
          system: true,
        });
      }
    }
    renderChat();
  } catch { /* noop */ }
}

// ── Event Subscriptions ────────────────────────────────

function subscribeEvents(): void {
  unsubEvents = api.onCypherEvent((evCypherId, kind, payload) => {
    if (evCypherId !== cypherId) return;

    if (kind === "post" && (payload as any)?.tags?.includes("drip")) {
      chatMessages.push({
        author: (payload as any).author || (payload as any).by_agent_id || "unknown",
        body: (payload as any).body || (payload as any).text || "",
        time: new Date(),
        system: false,
      });
      renderChat();
    } else if (kind === "jammer_join" || kind === "jammer_leave") {
      chatMessages.push({
        author: "system",
        body: `${(payload as any)?.agent_local_id || "someone"} ${kind === "jammer_join" ? "joined" : "left"}`,
        time: new Date(),
        system: true,
      });
      renderChat();
      void loadJammers().then(renderRoster);
    } else if (kind === "cypher_started") {
      $("cypher-status-text").textContent = "live";
      $("cypher-status").className = "topbar-status live";
    } else if (kind === "cypher_wrapped") {
      $("cypher-status-text").textContent = "wrapped";
      $("cypher-status").className = "topbar-status lobby";
    } else if (kind === "agent_output" && !isOwner) {
      // Observer: show relayed agent output
      const agent = (payload as any).agent_local_id || "agent";
      const text = (payload as any).text || "";
      appendAgentMessage(agent, text, "text");
    }
  });

  // Owner gets direct SDK messages
  if (isOwner) {
    unsubAgentMsg = api.onAgentMessage((agentName, msg) => {
      handleAgentMessage(agentName, msg);
    });

    unsubAgentStatus = api.onAgentStatus((agentName, status) => {
      const jammer = jammers.find((j) => j.agent_local_id === agentName);
      if (jammer) {
        jammer.status = status as Jammer["status"];
        renderRoster();
        if (agentName === focusedAgent) {
          $("stage-agent-status").textContent = status;
        }
      }
    });
  }

  // Subscribe to orchestrator (.yo agent) stream for the center stage
  unsubStageToken = api.onStageToken((delta) => {
    stageBuffer.push(delta);
    if (focusedAgent === null) {
      // Append live to the stage
      const stream = $("stage-stream");
      $("stage-empty").classList.add("hidden");
      if (!stageCurrentBlock) {
        stageCurrentBlock = document.createElement("div");
        stageCurrentBlock.className = "stage-msg";
        stream.appendChild(stageCurrentBlock);
      }
      stageCurrentBlock.innerHTML = formatMarkdown(stageBuffer.join(""));
      stream.scrollTop = stream.scrollHeight;
    }
  });

  unsubStageTool = api.onStageTool((_id, name, input) => {
    const text = `⚡ ${name}(${JSON.stringify(input).slice(0, 200)})`;
    stageBuffer.push(`\n\n${text}\n`);
    if (focusedAgent === null) {
      // Finalize current text block, add tool block
      stageCurrentBlock = null;
      const stream = $("stage-stream");
      const el = document.createElement("div");
      el.className = "stage-msg tool-use";
      el.textContent = text;
      stream.appendChild(el);
      stream.scrollTop = stream.scrollHeight;
    }
  });

  unsubStageToolResult = api.onStageToolResult((_id, detail) => {
    if (focusedAgent === null) {
      const stream = $("stage-stream");
      const el = document.createElement("div");
      el.className = "stage-msg tool-result";
      el.textContent = detail.slice(0, 500);
      stream.appendChild(el);
      stream.scrollTop = stream.scrollHeight;
    }
  });

  unsubStageDone = api.onStageDone(() => {
    stageCurrentBlock = null;
  });
}

function handleAgentMessage(agentName: string, msg: Record<string, unknown>): void {
  const type = msg.type as string;
  if (type === "assistant" && msg.content) {
    const parts = msg.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    for (const part of parts) {
      if (part.type === "text" && part.text) {
        appendAgentMessage(agentName, part.text, "text");
      } else if (part.type === "tool_use") {
        appendAgentMessage(agentName, `${part.name}(${JSON.stringify(part.input).slice(0, 120)})`, "tool");
      }
    }
  } else if (type === "result") {
    const text = msg.result as string;
    if (text) appendAgentMessage(agentName, text, "text");
  } else if (type === "error") {
    appendAgentMessage(agentName, (msg.text as string) || "Unknown error", "error");
  }
}

function appendAgentMessage(agentName: string, text: string, kind: "text" | "tool" | "error"): void {
  if (!agentStreams.has(agentName)) agentStreams.set(agentName, []);
  const entry = `${kind}::${text}`;
  agentStreams.get(agentName)!.push(entry);

  // Only render if this is the focused agent
  if (agentName === focusedAgent) {
    appendToStage(text, kind);
  }
}

// ── Rendering ──────────────────────────────────────────

function renderRoster(): void {
  const list = $("roster-list");
  list.innerHTML = "";

  // "All" feed option
  const allEl = document.createElement("div");
  allEl.className = `roster-item${focusedAgent === null ? " active" : ""}`;
  allEl.innerHTML = `
    <div class="roster-avatar" style="background:var(--accent)">ALL</div>
    <div class="roster-info">
      <div class="roster-name">All Agents</div>
      <div class="roster-role">combined feed</div>
    </div>
  `;
  allEl.addEventListener("click", () => {
    focusedAgent = null;
    renderRoster();
    renderStage();
  });
  list.appendChild(allEl);

  for (const j of jammers) {
    const el = document.createElement("div");
    el.className = `roster-item${j.agent_local_id === focusedAgent ? " active" : ""}`;
    el.innerHTML = `
      <div class="roster-avatar">${escapeHtml(j.agent_local_id.slice(0, 2).toUpperCase())}</div>
      <div class="roster-info">
        <div class="roster-name">${escapeHtml(j.agent_local_id)}</div>
        <div class="roster-role">${escapeHtml(j.position)}</div>
      </div>
      <div class="roster-status-dot ${j.status}"></div>
    `;
    el.addEventListener("click", () => {
      focusedAgent = j.agent_local_id;
      renderRoster();
      renderStage();
    });
    list.appendChild(el);
  }
}

// Orchestration stream buffer (the .yo agent's cypher-mode output)
const stageBuffer: string[] = [];
let stageCurrentBlock: HTMLElement | null = null;

function renderStage(): void {
  const stream = $("stage-stream");
  const empty = $("stage-empty");

  if (focusedAgent === null) {
    // "All" — show orchestration thread
    $("stage-agent-name").textContent = "Orchestrator";
    $("stage-agent-status").textContent = "";
    if (stageBuffer.length === 0) {
      empty.classList.remove("hidden");
      empty.textContent = "Waiting for orchestrator to start...";
      stream.querySelectorAll(".stage-msg").forEach((el) => el.remove());
      return;
    }
    empty.classList.add("hidden");
    // Don't re-render — live tokens are appended directly
  } else {
    // Individual agent feed
    $("stage-agent-name").textContent = focusedAgent;
    const jammer = jammers.find((j) => j.agent_local_id === focusedAgent);
    $("stage-agent-status").textContent = jammer?.status || "";

    const messages = agentStreams.get(focusedAgent) || [];
    if (messages.length === 0) {
      empty.classList.remove("hidden");
      empty.textContent = "Waiting for agent output...";
      stream.querySelectorAll(".stage-msg").forEach((el) => el.remove());
      return;
    }
    empty.classList.add("hidden");
    stream.innerHTML = "";
    for (const entry of messages) {
      const sep = entry.indexOf("::");
      const kind = entry.slice(0, sep) as "text" | "tool" | "error";
      const text = entry.slice(sep + 2);
      const el = document.createElement("div");
      el.className = `stage-msg${kind === "tool" ? " tool-use" : ""}${kind === "error" ? " error" : ""}`;
      el.innerHTML = kind === "text" ? formatMarkdown(text) : escapeHtml(text);
      stream.appendChild(el);
    }
    stream.scrollTop = stream.scrollHeight;
  }
}

function appendToStage(text: string, kind: "text" | "tool" | "error"): void {
  const stream = $("stage-stream");
  $("stage-empty").classList.add("hidden");

  const el = document.createElement("div");
  el.className = `stage-msg${kind === "tool" ? " tool-use" : ""}${kind === "error" ? " error" : ""}`;
  el.innerHTML = kind === "text" ? formatMarkdown(text) : escapeHtml(text);
  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
}

function renderChat(): void {
  const container = $("chat-messages");
  container.innerHTML = "";
  for (const msg of chatMessages) {
    const el = document.createElement("div");
    el.className = `chat-msg${msg.system ? " system" : ""}`;
    el.innerHTML = `
      <div class="chat-msg-author">${escapeHtml(msg.author)}</div>
      <div class="chat-msg-body">${escapeHtml(msg.body)}</div>
      <div class="chat-msg-time">${formatTime(msg.time)}</div>
    `;
    container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
  $("chat-count").textContent = String(chatMessages.filter((m) => !m.system).length);
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── UI Wiring ──────────────────────────────────────────

function wireUI(): void {
  // Spawn button (owner only)
  $("btn-spawn").addEventListener("click", async () => {
    if (!cypherId) return;
    $("btn-spawn").textContent = "Spawning...";
    try {
      await api.cypherSpawnJammers(cypherId);
      $("btn-spawn").textContent = "Spawned";
      setTimeout(() => { $("btn-spawn").textContent = "Spawn"; }, 2000);
    } catch {
      $("btn-spawn").textContent = "Failed";
      setTimeout(() => { $("btn-spawn").textContent = "Spawn"; }, 2000);
    }
  });

  // Leave button — close cypher tab, return to .drop
  $("btn-leave").addEventListener("click", () => {
    cleanup();
    api.leaveCypher();
  });

  // Chat input
  const chatInput = $("chat-input") as HTMLInputElement;
  const sendChat = async () => {
    const text = chatInput.value.trim();
    if (!text || !cypherId) return;
    chatInput.value = "";
    const me = currentUserId || "me";
    chatMessages.push({ author: me, body: text, time: new Date() });
    renderChat();
    try {
      await api.cypherPostEvent(cypherId, "post", {
        body: text,
        author: me,
        tags: ["drip"],
      });
    } catch { /* best effort */ }
  };
  $("btn-send-chat").addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); }
  });
}

function cleanup(): void {
  if (unsubEvents) { unsubEvents(); unsubEvents = null; }
  if (unsubAgentMsg) { unsubAgentMsg(); unsubAgentMsg = null; }
  if (unsubAgentStatus) { unsubAgentStatus(); unsubAgentStatus = null; }
  if (unsubStageToken) { unsubStageToken(); unsubStageToken = null; }
  if (unsubStageTool) { unsubStageTool(); unsubStageTool = null; }
  if (unsubStageToolResult) { unsubStageToolResult(); unsubStageToolResult = null; }
  if (unsubStageDone) { unsubStageDone(); unsubStageDone = null; }
}

// ── Theme ──────────────────────────────────────────────

api.getTheme().then((theme) => {
  document.documentElement.setAttribute("data-theme", theme);
});
api.onThemeChanged((theme) => {
  document.documentElement.setAttribute("data-theme", theme);
});

// ── Boot ───────────────────────────────────────────────

void init();

api.onContextReady(() => {
  cleanup();
  cypherId = null;
  jammers = [];
  focusedAgent = null;
  chatMessages = [];
  agentStreams.clear();
  stageBuffer.length = 0;
  stageCurrentBlock = null;
  $("stage-stream").innerHTML = "";
  void init();
});
