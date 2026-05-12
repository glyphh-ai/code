/**
 * cypher.ts — Cypher workspace renderer.
 *
 * Three-column layout: Files+Jammers | Monaco | Feed+Chat.
 * Columns and panes are resizable via drag splitters.
 */

import { identiconSvg } from "./identicon";

interface CypherAPI {
  authMe: () => Promise<{ id?: string; email?: string; handle?: string }>;
  cypherGet: (id: string) => Promise<any>;
  cypherJammers: (id: string, opts?: { limit?: number; offset?: number }) => Promise<any>;
  cypherEventsList: (id: string, opts?: { since?: number; limit?: number }) => Promise<any>;
  cypherSpawnJammers: (id: string) => Promise<any>;
  cypherWrap: (id: string) => Promise<any>;
  cypherCoverGet: (id: string) => Promise<{ ok: boolean; data_base64?: string; content_type?: string }>;
  cypherPostEvent: (id: string, kind: string, payload: Record<string, unknown>, jamId?: string, byAgentId?: string) => Promise<any>;
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;
  onAgentStatus: (cb: (agentName: string, status: string) => void) => () => void;
  onJammerActivity: (cb: (event: { from: string; kind: string; body: string; tags?: string[]; ts: number }) => void) => () => void;
  agentStop: (agentName: string) => void;
  agentSend: (agentName: string, message: string) => void;
  dripsPreview: (recipe: string) => Promise<string>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
  getCypherContext: () => Promise<{ cypherId: string; isOwner: boolean } | null>;
  leaveCypher: () => void;
  listDir: (dirPath: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  readFile: (filePath: string) => Promise<{ content: string; binary: boolean }>;
  getCypherWorkspacePath: (cypherId: string) => Promise<string | null>;
  projectBoard: (cypherId: string) => Promise<{ items: Array<{ id: string; title: string; status: string; assignee?: string; pr_url?: string | null }> }>;
  itemDetail: (cypherId: string, itemId: string) => Promise<{
    number: number;
    title: string;
    body: string | null;
    status: string | null;
    assignees: string[];
    url: string;
    state: string;
    labels: string[];
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    comments: Array<{
      id: number;
      user: string;
      avatar_url: string;
      body: string;
      created_at: string;
      updated_at: string;
    }>;
  } | null>;
  onProjectItemUpdate: (cb: (item: { id: string; title: string; status: string; assignee?: string }) => void) => () => void;
  openInVSCode: (filePath: string) => void;
  loadFeed: (cypherId: string, limit?: number) => Promise<Array<{ ts: number; from: string; kind: string; body: string; tags?: string[] }>>;
  onContextReady: (cb: () => void) => () => void;
}

const api = (window as any).cypher as CypherAPI;

// ── State ──────────────────────────────────────────────
let cypherId: string | null = null;
let isOwner = false;
let myHandle: string | null = null;
let workspacePath: string | null = null;

interface Jammer {
  agent_local_id: string;
  name: string | null;
  avatar_url: string | null;
  position: string;
  status: "idle" | "running" | "waiting" | "starting" | "error";
  input_tokens: number;
  output_tokens: number;
  turns: number;
}
let jammers: Jammer[] = [];
let jammerTotal = 0;
const JAMMERS_PER_PAGE = 50;
let jammerPage = 0;
let jammerLoading = false;

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
  expanded?: boolean;
  depth: number;
}
let fileTree: FileNode[] = [];
let activeFile: string | null = null;

interface OpenTab {
  path: string;
  name: string;
}
let openTabs: OpenTab[] = [];

interface BoardItem {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  pr_url?: string | null;
}
let boardItems: BoardItem[] = [];

interface FeedEntry {
  from: string;
  kind: string;
  body: string;
  ts: number;
  avatar_url?: string | null;
}
const feedItems: FeedEntry[] = [];
const MAX_FEED_ITEMS = 200;
let feedPaused = false;
let feedFilter: string = "all";
let jammerSearchQuery = "";

let monacoEditor: any = null;
let monacoReady: Promise<void> | null = null;

let unsubEvents: (() => void) | null = null;
let unsubStatus: (() => void) | null = null;
let unsubItemUpdate: (() => void) | null = null;
let unsubActivity: (() => void) | null = null;
let fileTreeRefreshTimer: ReturnType<typeof setInterval> | null = null;
let boardRefreshTimer: ReturnType<typeof setInterval> | null = null;
let initRunning = false;

// ── Helpers ────────────────────────────────────────────
function $(id: string): HTMLElement { return document.getElementById(id)!; }
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
function languageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", html: "html", css: "css", scss: "scss",
    py: "python", rs: "rust", go: "go", rb: "ruby", sh: "shell",
    yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", java: "java",
    swift: "swift", kt: "kotlin", xml: "xml", svg: "xml",
  };
  return map[ext] || "plaintext";
}
function isMediaFile(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "ogg", "mp4", "webm"].includes(ext);
}
function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

// ── Drag / Resize ──────────────────────────────────────
function initSplitters(): void {
  const workspace = $("workspace");

  // Left vsplit: drag resizes col-left (positive delta = wider)
  setupVSplit("vsplit-left", "col-left", false);
  // Right vsplit: drag resizes col-right (inverted — drag right = narrower)
  setupVSplit("vsplit-right", "col-right", true);

  // Horizontal splitters (within columns)
  setupHSplit("hsplit-left", "pane-files", "pane-jammers", "col-left");
  setupHSplit("hsplit-right", "pane-feed", "pane-chat", "col-right");

  // Double-click to toggle collapse
  $("vsplit-right").addEventListener("dblclick", () => {
    const el = $("col-right");
    if (el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      el.style.width = "280px";
    } else {
      el.classList.add("collapsed");
    }
    triggerEditorResize();
  });
  $("vsplit-left").addEventListener("dblclick", () => {
    const el = $("col-left");
    if (el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      el.style.width = "220px";
    } else {
      el.classList.add("collapsed");
    }
    triggerEditorResize();
  });

  function setupVSplit(splitId: string, targetId: string, invertDelta: boolean): void {
    const split = $(splitId);

    split.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const targetEl = $(targetId);
      const startX = e.clientX;
      const startW = targetEl.getBoundingClientRect().width;
      split.classList.add("dragging");
      document.body.classList.add("dragging");

      const onMove = (ev: MouseEvent) => {
        const rawDelta = ev.clientX - startX;
        const delta = invertDelta ? -rawDelta : rawDelta;
        const newW = Math.max(140, Math.min(startW + delta, workspace.clientWidth * 0.45));
        targetEl.style.width = `${newW}px`;
        targetEl.style.flex = "none";
        triggerEditorResize();
      };
      const onUp = () => {
        split.classList.remove("dragging");
        document.body.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        triggerEditorResize();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function setupHSplit(splitId: string, topId: string, bottomId: string, colId: string): void {
    const split = $(splitId);

    split.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const topEl = $(topId);
      const colEl = $(colId);
      const startY = e.clientY;
      const startTopH = topEl.getBoundingClientRect().height;
      const colH = colEl.getBoundingClientRect().height;
      split.classList.add("dragging");
      document.body.classList.add("dragging-h");

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY;
        const maxH = colH - 60 - 5;
        const newH = Math.max(60, Math.min(startTopH + delta, maxH));
        const ratio = newH / colH;
        topEl.style.flex = `${ratio}`;
        $(bottomId).style.flex = `${1 - ratio}`;
      };
      const onUp = () => {
        split.classList.remove("dragging");
        document.body.classList.remove("dragging-h");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
}

function triggerEditorResize(): void {
  if (monacoEditor) {
    requestAnimationFrame(() => monacoEditor.layout());
  }
}

// ── Center tab switching ──────────────────────────────
let activeCenterTab: "board" | "files" = "board";

function switchCenterTab(tab: "board" | "files"): void {
  activeCenterTab = tab;
  const boardPane = $("center-board");
  const filesPane = $("center-files");

  if (tab === "board") {
    boardPane.classList.remove("hidden");
    filesPane.classList.add("hidden");
  } else {
    boardPane.classList.add("hidden");
    filesPane.classList.remove("hidden");
    triggerEditorResize();
  }

  document.querySelectorAll(".center-tab").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.ctab === tab);
  });
}

// ── Monaco ─────────────────────────────────────────────
function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as any;
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}

async function initEditor(): Promise<void> {
  await ensureMonaco();
  const monaco = (window as any).monaco;
  const container = $("monaco-container");
  if (monacoEditor) return;
  monacoEditor = monaco.editor.create(container, {
    value: "",
    language: "plaintext",
    theme: "vs-dark",
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
    minimap: { enabled: false },
    wordWrap: "on",
    automaticLayout: true,
    readOnly: true,
    padding: { top: 12 },
    smoothScrolling: true,
    scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
    renderLineHighlight: "none",
    lineNumbers: "on",
  });
}

// ── File Tree ──────────────────────────────────────────
async function loadFileTree(dirPath: string, depth: number = 0): Promise<FileNode[]> {
  const entries = await api.listDir(dirPath);
  return entries.map((e) => ({
    name: e.name,
    path: dirPath + "/" + e.name,
    isDir: e.isDir,
    children: undefined,
    expanded: depth === 0,
    depth,
  }));
}

async function expandNode(node: FileNode): Promise<void> {
  if (!node.isDir) return;
  if (!node.children) {
    node.children = await loadFileTree(node.path, node.depth + 1);
  }
  node.expanded = !node.expanded;
}

function flattenTree(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.isDir && n.expanded && n.children) {
      out.push(...flattenTree(n.children));
    }
  }
  return out;
}

function renderFileTree(filter?: string): void {
  const container = $("file-tree");
  container.innerHTML = "";
  const flat = flattenTree(fileTree);
  const lowerFilter = filter?.toLowerCase();

  for (const node of flat) {
    if (lowerFilter && !node.name.toLowerCase().includes(lowerFilter)) {
      if (!node.isDir) continue;
    }
    const el = document.createElement("div");
    el.className = `tree-item${node.path === activeFile ? " active" : ""}${node.isDir ? " dir" : ""}`;
    const indent = node.depth * 12;
    const icon = node.isDir ? (node.expanded ? "▾" : "▸") : "·";
    el.innerHTML = `<span class="tree-indent" style="width:${indent}px"></span><span class="tree-icon">${icon}</span>${escapeHtml(node.name)}`;
    el.addEventListener("click", async () => {
      if (node.isDir) {
        await expandNode(node);
        renderFileTree(filter);
      } else {
        openFile(node.path, node.name);
      }
    });
    el.addEventListener("dblclick", () => {
      if (!node.isDir) api.openInVSCode(node.path);
    });
    container.appendChild(el);
  }
}

// ── File Viewer ────────────────────────────────────────
async function openFile(filePath: string, name: string): Promise<void> {
  activeFile = filePath;
  if (!openTabs.find((t) => t.path === filePath)) {
    openTabs.push({ path: filePath, name });
  }
  renderTabs();
  renderFileTree();
  if (activeCenterTab !== "files") switchCenterTab("files");

  const ext = fileExtension(name);
  if (isMediaFile(ext)) {
    $("monaco-container").style.display = "none";
    const viewer = $("media-viewer");
    viewer.style.display = "flex";
    $("viewer-empty").classList.add("hidden");
    const { content, binary } = await api.readFile(filePath);
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
      const src = binary ? `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${content}` : "";
      viewer.innerHTML = `<img src="${src}" />`;
    } else if (ext === "svg") {
      viewer.innerHTML = binary ? "" : content;
    } else if (["mp3", "wav", "ogg"].includes(ext)) {
      const src = binary ? `data:audio/${ext};base64,${content}` : "";
      viewer.innerHTML = `<audio controls src="${src}"></audio>`;
    } else if (["mp4", "webm"].includes(ext)) {
      const src = binary ? `data:video/${ext};base64,${content}` : "";
      viewer.innerHTML = `<video controls src="${src}"></video>`;
    }
  } else {
    $("media-viewer").style.display = "none";
    $("monaco-container").style.display = "block";
    $("viewer-empty").classList.add("hidden");
    await initEditor();
    const { content } = await api.readFile(filePath);
    const monaco = (window as any).monaco;
    const lang = languageFromExt(ext);
    const model = monaco.editor.createModel(content, lang);
    monacoEditor.setModel(model);
  }
}

function renderTabs(): void {
  const container = $("viewer-tabs");
  container.innerHTML = "";
  for (const tab of openTabs) {
    const el = document.createElement("div");
    el.className = `viewer-tab${tab.path === activeFile ? " active" : ""}`;
    el.innerHTML = `${escapeHtml(tab.name)}<span class="tab-close">✕</span>`;
    el.addEventListener("click", () => openFile(tab.path, tab.name));
    el.querySelector(".tab-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });
    container.appendChild(el);
  }
}

function closeTab(filePath: string): void {
  openTabs = openTabs.filter((t) => t.path !== filePath);
  if (activeFile === filePath) {
    if (openTabs.length > 0) {
      openFile(openTabs[openTabs.length - 1].path, openTabs[openTabs.length - 1].name);
    } else {
      activeFile = null;
      $("monaco-container").style.display = "none";
      $("media-viewer").style.display = "none";
      $("viewer-empty").classList.remove("hidden");
      renderTabs();
      renderFileTree();
    }
  } else {
    renderTabs();
  }
}

// ── Jammers (left bottom, server-paginated) ────────────
async function fetchJammerPage(page: number): Promise<void> {
  if (!cypherId || jammerLoading) return;
  jammerLoading = true;
  try {
    const offset = page * JAMMERS_PER_PAGE;
    const data = await api.cypherJammers(cypherId, { limit: JAMMERS_PER_PAGE, offset });
    const raw = (data as any)?.jammers || [];
    jammerTotal = (data as any)?.total ?? raw.length;
    jammers = raw
      .filter((j: any) => !j.left_at)
      .map((j: any) => ({
        agent_local_id: j.agent_local_id,
        name: j.name || null,
        avatar_url: j.avatar_url || null,
        position: j.role || "jammer",
        status: "idle" as const,
        input_tokens: Number(j.input_tokens) || 0,
        output_tokens: Number(j.output_tokens) || 0,
        turns: Number(j.turns) || 0,
      }));
    jammerPage = page;
    renderJammers();
  } finally {
    jammerLoading = false;
  }
}

function renderJammers(): void {
  const container = $("jammer-list");
  const countEl = $("jammer-count");
  const controls = $("jammer-page-controls");

  countEl.textContent = String(jammerTotal);
  container.innerHTML = "";

  if (jammerTotal === 0) {
    container.innerHTML = `<div class="jammer-empty">No jammers joined</div>`;
    controls.classList.add("hidden");
    updateTokenScore();
    return;
  }

  const q = jammerSearchQuery.toLowerCase();
  const filtered = q
    ? jammers.filter((j) => (j.name || j.agent_local_id).toLowerCase().includes(q) || j.position.toLowerCase().includes(q))
    : jammers;

  for (const j of filtered) {
    const row = document.createElement("div");
    row.className = "jammer-row";
    const avatarHtml = j.avatar_url
      ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
      : identiconSvg(j.agent_local_id, 24);
    const totalTok = j.input_tokens + j.output_tokens;
    const tokenStr = totalTok > 0 ? `<span class="jammer-tokens">${formatTokens(totalTok)}</span> · ${j.turns} turns` : "";
    row.innerHTML = `
      <div class="jammer-avatar">${avatarHtml}</div>
      <div class="jammer-info">
        <div class="jammer-name">${escapeHtml(j.name || j.agent_local_id)}</div>
        <div class="jammer-role">${escapeHtml(j.position)}${tokenStr ? ` · ${tokenStr}` : ""}</div>
      </div>
      <div class="jammer-controls">
        <button class="jammer-msg-btn" title="Send message">💬</button>
        <button class="jammer-stop-btn" title="Stop jammer">■</button>
      </div>
      <div class="jammer-status-dot ${j.status}"></div>
    `;
    const stopBtn = row.querySelector(".jammer-stop-btn")!;
    stopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      api.agentStop(j.agent_local_id);
      j.status = "idle";
      scheduleJammerRender();
    });
    const msgBtn = row.querySelector(".jammer-msg-btn")!;
    msgBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.querySelector(".jammer-msg-input")) return;
      const inputRow = document.createElement("div");
      inputRow.className = "jammer-msg-input-row";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "jammer-msg-input";
      inp.placeholder = `Message ${j.name || j.agent_local_id}...`;
      const send = () => {
        if (inp.value.trim()) {
          api.agentSend(j.agent_local_id, inp.value.trim());
        }
        inputRow.remove();
      };
      inp.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") send();
        if (ke.key === "Escape") inputRow.remove();
      });
      inp.addEventListener("blur", () => setTimeout(() => inputRow.remove(), 150));
      inputRow.appendChild(inp);
      row.appendChild(inputRow);
      inp.focus();
    });
    container.appendChild(row);
  }

  const totalPages = Math.max(1, Math.ceil(jammerTotal / JAMMERS_PER_PAGE));
  if (totalPages > 1) {
    controls.classList.remove("hidden");
    ($("jammer-prev") as HTMLButtonElement).disabled = jammerPage === 0;
    ($("jammer-next") as HTMLButtonElement).disabled = jammerPage >= totalPages - 1;
    $("jammer-page-info").textContent = `${jammerPage + 1} / ${totalPages}`;
  } else {
    controls.classList.add("hidden");
  }

  updateTokenScore();
}

function updateTokenScore(): void {
  const totalIn = jammers.reduce((s, j) => s + j.input_tokens, 0);
  const totalOut = jammers.reduce((s, j) => s + j.output_tokens, 0);
  const el = $("cypher-tokens");
  if (totalIn + totalOut > 0) {
    el.innerHTML = `<span class="token-in">${formatTokens(totalIn)}</span><span class="token-label">IN</span><span class="token-sep">/</span><span class="token-out">${formatTokens(totalOut)}</span><span class="token-label">OUT</span>`;
  } else {
    el.innerHTML = "";
  }
}

// Debounced status update — batch rapid status changes into a single render
let statusRenderPending = false;
function scheduleJammerRender(): void {
  if (statusRenderPending) return;
  statusRenderPending = true;
  requestAnimationFrame(() => {
    statusRenderPending = false;
    renderJammers();
  });
}

// ── Board (center, kanban) ─────────────────────────────
function renderBoard(): void {
  const columns: Record<string, BoardItem[]> = {
    Backlog: [], InProgress: [], Review: [], Done: [],
  };
  for (const item of boardItems) {
    const col = columns[item.status] || columns.Backlog;
    col.push(item);
  }

  for (const [status, items] of Object.entries(columns)) {
    const key = status === "InProgress" ? "active" : status.toLowerCase();
    const container = document.getElementById(`board-${key}`);
    const count = document.getElementById(`board-count-${key}`);
    if (container) {
      container.innerHTML = "";
      if (items.length === 0) {
        container.innerHTML = `<div class="board-empty">No items</div>`;
      }
      for (const item of items) {
        const jammer = item.assignee ? jammers.find((j) => j.agent_local_id === item.assignee) : null;
        const avatarHtml = jammer?.avatar_url
          ? `<img src="${escapeHtml(jammer.avatar_url)}" alt="" />`
          : item.assignee
            ? identiconSvg(item.assignee, 16)
            : "";
        const avatarWrap = avatarHtml ? `<div class="board-card-avatar">${avatarHtml}</div>` : "";
        const assigneeHtml = item.assignee
          ? `<span class="board-card-assignee">@${escapeHtml(item.assignee)}</span>`
          : "";
        const prHtml = item.pr_url
          ? `<a class="board-card-pr" href="${escapeHtml(item.pr_url)}" title="View PR">PR</a>`
          : "";

        const card = document.createElement("div");
        card.className = "board-card";
        card.style.cursor = "pointer";
        card.innerHTML = `
          <div class="board-card-title">${escapeHtml(item.title)}</div>
          <div class="board-card-meta">${avatarWrap}${assigneeHtml}${prHtml}</div>
        `;
        card.addEventListener("click", () => openCardModal(item.id));
        container.appendChild(card);
      }
    }
    if (count) count.textContent = String(items.length);
  }
}

// ── Card detail modal ─────────────────────────────────
function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function simpleMarkdown(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function statusLabelColor(label: string): string {
  const map: Record<string, string> = {
    "status:lobby": "#c5def5", "status:backlog": "#d4c5f9",
    "status:in-progress": "#fbca04", "status:review": "#f9d0c4", "status:done": "#0e8a16",
  };
  return map[label] || "#999";
}

async function openCardModal(itemId: string): Promise<void> {
  const overlay = $("card-modal-overlay");
  const loading = $("card-modal-loading");
  const commentsEl = $("card-modal-comments");
  const titleEl = $("card-modal-title");
  const numberEl = $("card-modal-number");
  const metaEl = $("card-modal-meta");
  const bodyEl = $("card-modal-body");
  const countEl = $("card-modal-comment-count");

  titleEl.textContent = "";
  numberEl.textContent = "";
  metaEl.innerHTML = "";
  bodyEl.innerHTML = "";
  commentsEl.innerHTML = "";
  countEl.textContent = "0";
  loading.classList.remove("hidden");
  overlay.classList.remove("hidden");

  if (!cypherId) { overlay.classList.add("hidden"); return; }

  const detail = await api.itemDetail(cypherId, itemId);
  loading.classList.add("hidden");

  if (!detail) {
    commentsEl.innerHTML = '<div class="card-modal-no-comments">Failed to load issue detail</div>';
    return;
  }

  numberEl.textContent = `#${detail.number}`;
  titleEl.textContent = detail.title;

  let metaHtml = "";
  const stateClass = detail.state === "open" ? "status-open" : "status-closed";
  metaHtml += `<span class="card-modal-badge ${stateClass}">${detail.state === "open" ? "Open" : "Closed"}</span>`;

  for (const label of detail.labels) {
    const color = statusLabelColor(label);
    metaHtml += `<span class="card-modal-badge label" style="border-color:${color}; color:${color}">${escapeHtml(label)}</span>`;
  }

  for (const a of detail.assignees) {
    metaHtml += `<span class="card-modal-assignee">@${escapeHtml(a)}</span>`;
  }

  metaHtml += `<span class="card-modal-date">created ${formatDate(detail.created_at)}</span>`;
  if (detail.closed_at) {
    metaHtml += `<span class="card-modal-date">closed ${formatDate(detail.closed_at)}</span>`;
  }

  metaHtml += `<a class="card-modal-link" href="${escapeHtml(detail.url)}" target="_blank">View on GitHub</a>`;

  metaEl.innerHTML = metaHtml;

  if (detail.body?.trim()) {
    bodyEl.innerHTML = simpleMarkdown(detail.body);
  }

  countEl.textContent = String(detail.comments.length);

  if (detail.comments.length === 0) {
    commentsEl.innerHTML = '<div class="card-modal-no-comments">No comments yet</div>';
  } else {
    let html = "";
    for (const c of detail.comments) {
      const avatarImg = c.avatar_url
        ? `<img src="${escapeHtml(c.avatar_url)}" alt="" />`
        : identiconSvg(c.user, 28);
      html += `
        <div class="card-modal-comment">
          <div class="card-modal-comment-avatar">${avatarImg}</div>
          <div class="card-modal-comment-content">
            <div class="card-modal-comment-header">
              <span class="card-modal-comment-user">${escapeHtml(c.user)}</span>
              <span class="card-modal-comment-time">${formatDate(c.created_at)}</span>
            </div>
            <div class="card-modal-comment-body">${simpleMarkdown(c.body)}</div>
          </div>
        </div>`;
    }
    commentsEl.innerHTML = html;
  }
}

function closeCardModal(): void {
  $("card-modal-overlay").classList.add("hidden");
}

// ── Feed (right top) ──────────────────────────────────
function matchesFeedFilter(entry: FeedEntry): boolean {
  if (feedFilter === "all") return true;
  if (feedFilter === "board") return entry.kind === "board";
  if (feedFilter === "status") return entry.kind === "status";
  if (feedFilter === "broadcast") return entry.kind !== "board" && entry.kind !== "status";
  return true;
}

function addFeedEntry(entry: FeedEntry): void {
  feedItems.unshift(entry);
  if (feedItems.length > MAX_FEED_ITEMS) feedItems.length = MAX_FEED_ITEMS;
  if (!feedPaused && matchesFeedFilter(entry)) {
    renderFeedItem(entry, true);
  }
}

function renderFeedItem(entry: FeedEntry, prepend: boolean): void {
  const list = $("feed-list");
  const empty = document.getElementById("feed-empty");
  if (empty) empty.remove();

  const el = document.createElement("div");
  el.className = "feed-item";
  el.dataset.kind = entry.kind;

  const jammer = jammers.find((j) => j.agent_local_id === entry.from);
  const avatarHtml = jammer?.avatar_url
    ? `<img src="${escapeHtml(jammer.avatar_url)}" alt="" />`
    : identiconSvg(entry.from, 18);

  const fullBody = escapeHtml(entry.body);
  const truncated = entry.body.length > 200;

  el.innerHTML = `
    <div class="feed-item-header">
      <div class="feed-item-avatar">${avatarHtml}</div>
      <span class="feed-item-name">${escapeHtml(entry.from)}</span>
      <span class="feed-item-kind">${escapeHtml(entry.kind)}</span>
      <span class="feed-item-time">${relativeTime(entry.ts)}</span>
    </div>
    <div class="feed-item-body">${fullBody}</div>
    ${truncated ? `<div class="feed-item-expand">show more</div>` : ""}
  `;

  el.addEventListener("click", () => {
    const isExpanded = el.classList.toggle("expanded");
    const expandLabel = el.querySelector(".feed-item-expand");
    if (expandLabel) expandLabel.textContent = isExpanded ? "show less" : "show more";
  });

  if (prepend) {
    list.prepend(el);
    while (list.children.length > 100) list.removeChild(list.lastChild!);
  } else {
    list.appendChild(el);
  }
}

function rebuildFeed(): void {
  const list = $("feed-list");
  list.innerHTML = "";
  const filtered = feedItems.filter(matchesFeedFilter);
  if (filtered.length === 0) {
    list.innerHTML = `<div class="feed-empty" id="feed-empty">No activity yet</div>`;
    return;
  }
  const visible = filtered.slice(0, 100);
  for (const entry of visible) {
    renderFeedItem(entry, false);
  }
}

// ── Chat (right bottom) ──────────────────────────────
let lastDripTs = 0;
const DRIP_THROTTLE_MS = 3000;

function senderAvatar(sender: string): string {
  const jammer = jammers.find((j) => j.agent_local_id === sender || j.name === sender);
  if (jammer?.avatar_url) return `<img src="${escapeHtml(jammer.avatar_url)}" alt="" />`;
  return identiconSvg(sender, 22);
}

function addChatMessage(sender: string, body: string, mine: boolean): void {
  const container = $("chat-messages");
  const row = document.createElement("div");
  row.className = `chat-msg-row ${mine ? "mine" : "theirs"}`;

  const avatarHtml = `<div class="chat-msg-avatar">${senderAvatar(sender)}</div>`;
  const senderLine = !mine ? `<div class="chat-msg-sender">${escapeHtml(sender)}</div>` : "";
  const bodyHtml = `<div class="chat-msg-body">${escapeHtml(body)}</div>`;

  row.innerHTML = `
    ${avatarHtml}
    <div class="chat-msg-bubble">
      ${senderLine}${bodyHtml}
    </div>
  `;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function addDripMessage(sender: string, recipe: string, mine: boolean): void {
  const container = $("chat-messages");
  const row = document.createElement("div");
  row.className = `chat-msg-row ${mine ? "mine" : "theirs"}`;

  const avatarHtml = `<div class="chat-msg-avatar">${senderAvatar(sender)}</div>`;
  const senderLine = !mine ? `<div class="chat-msg-sender">${escapeHtml(sender)}</div>` : "";

  row.innerHTML = `
    ${avatarHtml}
    <div class="chat-msg-bubble">
      ${senderLine}
      <span class="chat-msg-drip">${escapeHtml(recipe)}</span>
    </div>
  `;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function fireDripThrottled(recipe: string): void {
  const now = Date.now();
  if (now - lastDripTs < DRIP_THROTTLE_MS) return;
  lastDripTs = now;
  api.dripsPreview(recipe);
}

function sendChat(): void {
  const input = $("chat-input") as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !cypherId) return;
  input.value = "";

  // Detect .drip command
  if (text.startsWith(".drip ") || text === ".drip") {
    const recipe = text.slice(5).trim() || "fireworks";
    addDripMessage(myHandle || "You", recipe, true);
    fireDripThrottled(recipe);
    api.cypherPostEvent(cypherId, "drip", { recipe, sender: myHandle || "unknown" });
    return;
  }

  addChatMessage(myHandle || "You", text, true);
  api.cypherPostEvent(cypherId, "chat", { message: text, sender: myHandle || "unknown" });
}

// ── Close Cypher + Wrapped Results ────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

async function closeCypher(): Promise<void> {
  if (!cypherId || !isOwner) return;
  const btn = $("btn-close-cypher") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Closing...";

  try {
    const result = await api.cypherWrap(cypherId);
    if ((result as any)?.error) {
      btn.textContent = "Close Cypher";
      btn.disabled = false;
      return;
    }

    // Reload all jammers (all pages) for the summary
    const allJammers: Jammer[] = [];
    let offset = 0;
    let total = 1;
    while (offset < total) {
      const data = await api.cypherJammers(cypherId, { limit: 200, offset });
      const raw = (data as any)?.jammers || [];
      total = (data as any)?.total ?? raw.length;
      for (const j of raw) {
        allJammers.push({
          agent_local_id: j.agent_local_id,
          name: j.name || null,
          avatar_url: j.avatar_url || null,
          position: j.role || "jammer",
          status: "idle",
          input_tokens: Number(j.input_tokens) || 0,
          output_tokens: Number(j.output_tokens) || 0,
          turns: Number(j.turns) || 0,
        });
      }
      offset += 200;
    }

    const cypher = (result as any)?.cypher;
    await showWrappedResults(cypher, allJammers);
  } catch {
    btn.textContent = "Close Cypher";
    btn.disabled = false;
  }
}

async function showWrappedResults(cypher: any, allJammers: Jammer[]): Promise<void> {
  $("workspace").classList.add("hidden");
  $("wrapped-view").classList.remove("hidden");
  $("btn-close-cypher").classList.add("hidden");
  $("cypher-status-text").textContent = "wrapped";
  $("cypher-status").className = "topbar-status lobby";

  const totalIn = allJammers.reduce((s, j) => s + j.input_tokens, 0);
  const totalOut = allJammers.reduce((s, j) => s + j.output_tokens, 0);
  const totalTurns = allJammers.reduce((s, j) => s + j.turns, 0);
  const duration = cypher?.started_at && cypher?.ended_at
    ? formatDuration(cypher.started_at, cypher.ended_at) : "—";

  // Hero — cover image + title
  $("wrapped-hero-title").textContent = cypher?.title || "Cypher";
  $("wrapped-hero-subtitle").textContent = `Session wrapped${duration !== "—" ? ` · ${duration}` : ""} · ${allJammers.length} jammers · ${formatTokens(totalIn + totalOut)} tokens`;

  if (cypherId) {
    try {
      const cover = await api.cypherCoverGet(cypherId);
      if (cover?.ok && cover.data_base64) {
        const img = $("wrapped-cover") as HTMLImageElement;
        img.src = `data:${cover.content_type || "image/png"};base64,${cover.data_base64}`;
        img.classList.remove("hidden");
      }
    } catch { /* no cover */ }
  }

  // Stats
  $("wrapped-stats").innerHTML = [
    { v: String(allJammers.length), l: "Jammers" },
    { v: formatTokens(totalIn), l: "Input" },
    { v: formatTokens(totalOut), l: "Output" },
    { v: String(totalTurns), l: "Turns" },
    { v: duration, l: "Duration" },
  ].map(s => `<div class="wrapped-stat"><div class="wrapped-stat-value">${s.v}</div><div class="wrapped-stat-label">${s.l}</div></div>`).join("");

  // Agents — compact chips
  allJammers.sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
  $("wrapped-agents-section").innerHTML = `
    <div class="wrapped-section-title">Team</div>
    <div class="wrapped-agents-grid">
      ${allJammers.map(j => {
        const av = j.avatar_url
          ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
          : identiconSvg(j.agent_local_id, 28);
        return `
          <div class="wrapped-agent-chip">
            <div class="wrapped-agent-avatar">${av}</div>
            <div>
              <div class="wrapped-agent-name">${escapeHtml(j.name || j.agent_local_id)}</div>
              <div class="wrapped-agent-role">${escapeHtml(j.position)}</div>
              <div class="wrapped-agent-tokens">${formatTokens(j.input_tokens)} in / ${formatTokens(j.output_tokens)} out</div>
            </div>
          </div>`;
      }).join("")}
    </div>`;

  // Output section — file tree + Monaco viewer (same as live view)
  const wrappedFileTree = $("wrapped-file-tree");
  const wrappedTabs = $("wrapped-viewer-tabs");
  const wrappedEmpty = $("wrapped-viewer-empty");
  const wrappedMonaco = $("wrapped-monaco-container");
  const wrappedMedia = $("wrapped-media-viewer");

  let wrappedEditor: any = null;
  let wrappedOpenTabs: { path: string; name: string }[] = [];
  let wrappedActiveFile: string | null = null;

  async function initWrappedEditor(): Promise<void> {
    await ensureMonaco();
    const monaco = (window as any).monaco;
    if (wrappedEditor) return;
    wrappedEditor = monaco.editor.create(wrappedMonaco, {
      value: "",
      language: "plaintext",
      theme: "vs-dark",
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
      minimap: { enabled: false },
      wordWrap: "on",
      automaticLayout: true,
      readOnly: true,
      padding: { top: 12 },
      smoothScrolling: true,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      renderLineHighlight: "none",
      lineNumbers: "on",
    });
  }

  function renderWrappedTabs(): void {
    wrappedTabs.innerHTML = "";
    for (const tab of wrappedOpenTabs) {
      const el = document.createElement("div");
      el.className = `viewer-tab${tab.path === wrappedActiveFile ? " active" : ""}`;
      el.innerHTML = `${escapeHtml(tab.name)}<span class="tab-close">✕</span>`;
      el.addEventListener("click", () => wrappedOpenFile(tab.path, tab.name));
      el.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        wrappedOpenTabs = wrappedOpenTabs.filter(t => t.path !== tab.path);
        if (wrappedActiveFile === tab.path) {
          if (wrappedOpenTabs.length > 0) {
            const last = wrappedOpenTabs[wrappedOpenTabs.length - 1];
            wrappedOpenFile(last.path, last.name);
          } else {
            wrappedActiveFile = null;
            wrappedMonaco.style.display = "none";
            wrappedMedia.style.display = "none";
            wrappedEmpty.classList.remove("hidden");
            renderWrappedTabs();
            renderWrappedTree();
          }
        } else {
          renderWrappedTabs();
        }
      });
      wrappedTabs.appendChild(el);
    }
  }

  async function wrappedOpenFile(filePath: string, name: string): Promise<void> {
    wrappedActiveFile = filePath;
    if (!wrappedOpenTabs.find(t => t.path === filePath)) {
      wrappedOpenTabs.push({ path: filePath, name });
    }
    renderWrappedTabs();
    renderWrappedTree();

    const ext = fileExtension(name);
    if (isMediaFile(ext)) {
      wrappedMonaco.style.display = "none";
      wrappedMedia.style.display = "flex";
      wrappedEmpty.classList.add("hidden");
      const { content, binary } = await api.readFile(filePath);
      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        const src = binary ? `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${content}` : "";
        wrappedMedia.innerHTML = `<img src="${src}" />`;
      } else if (ext === "svg") {
        wrappedMedia.innerHTML = binary ? "" : content;
      } else if (["mp3", "wav", "ogg"].includes(ext)) {
        const src = binary ? `data:audio/${ext};base64,${content}` : "";
        wrappedMedia.innerHTML = `<audio controls src="${src}"></audio>`;
      } else if (["mp4", "webm"].includes(ext)) {
        const src = binary ? `data:video/${ext};base64,${content}` : "";
        wrappedMedia.innerHTML = `<video controls src="${src}"></video>`;
      }
    } else {
      wrappedMedia.style.display = "none";
      wrappedMonaco.style.display = "block";
      wrappedEmpty.classList.add("hidden");
      await initWrappedEditor();
      const { content } = await api.readFile(filePath);
      const monaco = (window as any).monaco;
      const lang = languageFromExt(ext);
      const model = monaco.editor.createModel(content, lang);
      wrappedEditor.setModel(model);
    }
  }

  // Build and render file tree
  let wrappedTree: FileNode[] = [];

  function renderWrappedTree(): void {
    wrappedFileTree.innerHTML = "";
    renderWrappedNodes(wrappedTree, 0);
  }

  function renderWrappedNodes(nodes: FileNode[], depth: number): void {
    for (const node of nodes) {
      const item = document.createElement("div");
      const isActive = !node.isDir && node.path === wrappedActiveFile;
      item.className = `tree-item${node.isDir ? " dir" : ""}${isActive ? " active" : ""}`;
      item.style.paddingLeft = `${8 + depth * 14}px`;
      const icon = node.isDir ? (node.expanded ? "▾" : "▸") : "·";
      item.innerHTML = `<span class="tree-icon">${icon}</span> ${escapeHtml(node.name)}`;

      if (!node.isDir) {
        item.style.cursor = "pointer";
        item.addEventListener("click", () => wrappedOpenFile(node.path, node.name));
        item.addEventListener("dblclick", () => api.openInVSCode(node.path));
      } else {
        item.style.cursor = "pointer";
        item.addEventListener("click", async () => {
          node.expanded = !node.expanded;
          if (node.expanded && !node.children) {
            node.children = await loadFileTree(node.path, (node.depth ?? depth) + 1);
          }
          renderWrappedTree();
        });
      }

      wrappedFileTree.appendChild(item);
      if (node.isDir && node.expanded && node.children) {
        renderWrappedNodes(node.children, depth + 1);
      }
    }
  }

  if (workspacePath) {
    try {
      wrappedTree = await loadFileTree(workspacePath);
      for (const node of wrappedTree) {
        if (node.isDir) {
          node.children = await loadFileTree(node.path, 1);
          node.expanded = true;
        }
      }
      renderWrappedTree();
    } catch { /* no workspace */ }

    // Auto-open README.md: project root first, then leader's sandbox as fallback
    let readmePath: string | null = null;
    try {
      const rootReadme = workspacePath + "/README.md";
      const result = await api.readFile(rootReadme);
      if (result?.content && !result.binary) readmePath = rootReadme;
    } catch { /* no root readme */ }

    if (!readmePath) {
      const leaderJammer = allJammers.find(j => j.position === "leader");
      if (leaderJammer) {
        try {
          const leaderReadme = workspacePath + "/" + leaderJammer.agent_local_id + "/README.md";
          const result = await api.readFile(leaderReadme);
          if (result?.content && !result.binary) readmePath = leaderReadme;
        } catch { /* no leader readme */ }
      }
    }

    if (readmePath) {
      await wrappedOpenFile(readmePath, "README.md");
    }
  }
}

// ── Init ───────────────────────────────────────────────
let initRetries = 0;
const MAX_INIT_RETRIES = 5;

async function init(): Promise<void> {
  if (initRunning) return;
  initRunning = true;

  try {
    const theme = await api.getTheme();
    document.documentElement.setAttribute("data-theme", theme);
    api.onThemeChanged((t) => document.documentElement.setAttribute("data-theme", t));
  } catch { /* theme IPC may not be ready yet */ }

  try {
    let ctx: { cypherId: string; isOwner: boolean } | null = null;
    let me: { id?: string; email?: string; handle?: string } | null = null;
    try {
      [ctx, me] = await Promise.all([
        api.getCypherContext(),
        api.authMe(),
      ]);
    } catch {
      // IPC handlers not registered yet — retry after a delay
      initRunning = false;
      if (initRetries < MAX_INIT_RETRIES) {
        initRetries++;
        setTimeout(() => void init(), 500);
      }
      return;
    }

    if (!ctx) {
      $("viewer-empty").textContent = "No cypher context. Open a cypher from The Drop.";
      initRunning = false;
      return;
    }
    cypherId = ctx.cypherId;
    isOwner = ctx.isOwner;
    myHandle = me?.handle || me?.email || null;

    const cypherData = await api.cypherGet(cypherId);
    const cypher = (cypherData as any)?.cypher;
    if (cypher) {
      $("cypher-title").textContent = cypher.title || "Untitled";
      $("cypher-status-text").textContent = cypher.status || "lobby";
      $("cypher-status").className = `topbar-status ${cypher.status === "live" ? "live" : "lobby"}`;
    }

    // If already wrapped, show results view
    if (cypher?.status === "wrapped") {
      // Load all jammers for summary
      const allJammers: Jammer[] = [];
      let offset = 0;
      let total = 1;
      while (offset < total) {
        const data = await api.cypherJammers(cypherId, { limit: 200, offset });
        const raw = (data as any)?.jammers || [];
        total = (data as any)?.total ?? raw.length;
        for (const j of raw) {
          allJammers.push({
            agent_local_id: j.agent_local_id,
            name: j.name || null,
            avatar_url: j.avatar_url || null,
            position: j.role || "jammer",
            status: "idle",
            input_tokens: Number(j.input_tokens) || 0,
            output_tokens: Number(j.output_tokens) || 0,
            turns: Number(j.turns) || 0,
          });
        }
        offset += 200;
      }
      // Load board and workspace for summary
      try {
        const boardData = await api.projectBoard(cypherId);
        boardItems = boardData.items || [];
      } catch {}
      try {
        workspacePath = await api.getCypherWorkspacePath(cypherId);
      } catch {}
      await showWrappedResults(cypher, allJammers);
      return;
    }

    // Only show close button for owner of a live cypher
    if (isOwner && cypher?.status === "live") {
      $("btn-close-cypher").classList.remove("hidden");
    } else {
      $("btn-close-cypher").classList.add("hidden");
    }

    await fetchJammerPage(0);

    // Load project board
    try {
      const boardData = await api.projectBoard(cypherId);
      boardItems = boardData.items || [];
      renderBoard();
    } catch { /* no project yet */ }

    try {
      workspacePath = await api.getCypherWorkspacePath(cypherId);
      if (workspacePath) {
        fileTree = await loadFileTree(workspacePath);
        for (const node of fileTree) {
          if (node.isDir) {
            node.children = await loadFileTree(node.path, 1);
            node.expanded = true;
          }
        }
        renderFileTree();
      }
    } catch { /* workspace IPC may not be ready */ }

    // Load persisted feed from local file (survives refresh)
    try {
      const entries = await api.loadFeed(cypherId, 200);
      for (const entry of entries) {
        feedItems.push({
          from: entry.from,
          kind: entry.kind,
          body: entry.body,
          ts: entry.ts,
        });
      }
      if (feedItems.length > MAX_FEED_ITEMS) feedItems.length = MAX_FEED_ITEMS;
      rebuildFeed();
    } catch { /* feed IPC may not be ready */ }

    subscribeEvents();
  } finally {
    initRunning = false;
  }
}

function subscribeEvents(): void {
  cleanup();

  unsubStatus = api.onAgentStatus((agentName, status) => {
    const jammer = jammers.find((j) => j.agent_local_id === agentName);
    if (jammer) {
      jammer.status = status as Jammer["status"];
      scheduleJammerRender();
    }
  });

  unsubEvents = api.onCypherEvent((evCypherId, kind, payload) => {
    if (evCypherId !== cypherId) return;
    if (kind === "cypher_started") {
      $("cypher-status-text").textContent = "live";
      $("cypher-status").className = "topbar-status live";
    } else if (kind === "cypher_wrapped") {
      // Reload to show wrapped results
      cleanup();
      initRunning = false;
      void init();
      return;
    } else if (kind === "chat") {
      const sender = (payload as any).sender || (payload as any).from || "unknown";
      const msg = (payload as any).message || "";
      if (msg && sender !== myHandle) {
        addChatMessage(sender, msg, false);
      }
    } else if (kind === "drip") {
      const sender = (payload as any).sender || "unknown";
      const recipe = (payload as any).recipe || "fireworks";
      if (sender !== myHandle) {
        addDripMessage(sender, recipe, false);
        fireDripThrottled(recipe);
      }
    }
  });

  unsubItemUpdate = api.onProjectItemUpdate((item) => {
    // Update board state
    const existing = boardItems.find((i) => i.id === item.id);
    if (existing) {
      if (item.title) existing.title = item.title;
      if (item.status) existing.status = item.status;
      if (item.assignee !== undefined) existing.assignee = item.assignee;
    } else {
      boardItems.push({
        id: item.id,
        title: item.title || "Untitled",
        status: item.status || "Backlog",
        assignee: item.assignee,
      });
    }
    renderBoard();

    // Add to feed
    addFeedEntry({
      from: item.assignee || "system",
      kind: "board",
      body: `${item.title} → ${item.status}`,
      ts: Date.now(),
    });
  });

  unsubActivity = api.onJammerActivity((event) => {
    if (!event.from || event.from === "orchestrator" || event.from === "unknown") return;
    if (!event.body?.trim()) return;
    addFeedEntry({
      from: event.from,
      kind: event.kind,
      body: event.body,
      ts: event.ts || Date.now(),
    });
  });

  fileTreeRefreshTimer = setInterval(async () => {
    if (!workspacePath) return;
    try {
      const prevPaths = new Set(flattenTree(fileTree).map(n => n.path));
      const expanded = new Set(flattenTree(fileTree).filter(n => n.isDir && n.expanded).map(n => n.path));
      fileTree = await loadFileTree(workspacePath);
      for (const node of fileTree) {
        if (node.isDir) {
          node.children = await loadFileTree(node.path, 1);
          node.expanded = expanded.has(node.path) || !prevPaths.has(node.path);
          if (node.children) {
            for (const child of node.children) {
              if (child.isDir) {
                child.expanded = expanded.has(child.path);
              }
            }
          }
        }
      }
      renderFileTree();
    } catch { /* workspace may not exist yet */ }
  }, 3000);

  boardRefreshTimer = setInterval(async () => {
    if (!cypherId) return;
    try {
      const boardData = await api.projectBoard(cypherId);
      const newItems = boardData.items || [];
      const changed = newItems.length !== boardItems.length ||
        newItems.some((n, i) => n.id !== boardItems[i]?.id || n.status !== boardItems[i]?.status || n.assignee !== boardItems[i]?.assignee);
      if (changed) {
        boardItems = newItems;
        renderBoard();
      }
    } catch { /* project may not exist yet */ }
  }, 5000);
}

function cleanup(): void {
  unsubEvents?.();
  unsubStatus?.();
  unsubItemUpdate?.();
  unsubActivity?.();
  unsubEvents = null;
  unsubStatus = null;
  unsubItemUpdate = null;
  unsubActivity = null;
  if (fileTreeRefreshTimer) { clearInterval(fileTreeRefreshTimer); fileTreeRefreshTimer = null; }
  if (boardRefreshTimer) { clearInterval(boardRefreshTimer); boardRefreshTimer = null; }
}

// ── Boot ───────────────────────────────────────────────
function boot(): void {
  initSplitters();

  // Center tab switching (Board / Files)
  document.querySelectorAll(".center-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = (btn as HTMLElement).dataset.ctab as "board" | "files";
      if (tab) switchCenterTab(tab);
    });
  });

  $("file-search").addEventListener("input", (e) => {
    renderFileTree((e.target as HTMLInputElement).value);
  });

  $("jammer-search").addEventListener("input", (e) => {
    jammerSearchQuery = (e.target as HTMLInputElement).value;
    renderJammers();
  });

  $("jammer-prev").addEventListener("click", () => {
    if (jammerPage > 0) void fetchJammerPage(jammerPage - 1);
  });
  $("jammer-next").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(jammerTotal / JAMMERS_PER_PAGE));
    if (jammerPage < totalPages - 1) void fetchJammerPage(jammerPage + 1);
  });

  $("feed-pause").addEventListener("click", () => {
    feedPaused = !feedPaused;
    $("feed-pause").classList.toggle("active", feedPaused);
    $("feed-pause").innerHTML = feedPaused ? "&#9654;" : "&#9646;&#9646;";
    $("feed-pause").title = feedPaused ? "Resume feed" : "Pause feed";
    if (!feedPaused) rebuildFeed();
  });

  $("feed-filter").addEventListener("change", (e) => {
    feedFilter = (e.target as HTMLSelectElement).value;
    rebuildFeed();
  });

  $("wrapped-back-btn").addEventListener("click", () => {
    api.leaveCypher();
  });

  $("card-modal-close").addEventListener("click", closeCardModal);
  $("card-modal-overlay").addEventListener("click", (e) => {
    if (e.target === $("card-modal-overlay")) closeCardModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("card-modal-overlay").classList.contains("hidden")) {
      closeCardModal();
    }
  });

  $("btn-close-cypher").addEventListener("click", () => {
    void closeCypher();
  });

  $("btn-leave").addEventListener("click", () => {
    api.leaveCypher();
  });

  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") sendChat();
  });

  api.onContextReady(() => {
    cleanup();
    cypherId = null;
    jammers = [];
    fileTree = [];
    boardItems = [];
    feedItems.length = 0;
    openTabs = [];
    activeFile = null;
    jammerPage = 0;
    if (monacoEditor) monacoEditor.setModel(null);
    $("file-tree").innerHTML = "";
    $("jammer-list").innerHTML = "";
    $("feed-list").innerHTML = `<div class="feed-empty" id="feed-empty">No activity yet</div>`;
    $("chat-messages").innerHTML = "";
    $("viewer-tabs").innerHTML = "";
    $("monaco-container").style.display = "none";
    $("media-viewer").style.display = "none";
    $("viewer-empty").classList.remove("hidden");
    switchCenterTab("board");
    initRunning = false;
    void init();
  });

  void init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
