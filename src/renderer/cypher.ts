/**
 * cypher.ts — Cypher workspace renderer.
 *
 * Layout: flow board (top) + file tree (left) + Monaco viewer (center).
 * Roster is compact in the left sidebar below the file tree.
 * All orchestrator/agent output goes through the yo panel (not rendered here).
 */

interface CypherAPI {
  authMe: () => Promise<{ id?: string; email?: string; handle?: string }>;
  cypherGet: (id: string) => Promise<any>;
  cypherJammers: (id: string) => Promise<any>;
  cypherSpawnJammers: (id: string) => Promise<any>;
  cypherPostEvent: (id: string, kind: string, payload: Record<string, unknown>, jamId?: string, byAgentId?: string) => Promise<any>;
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;
  onAgentStatus: (cb: (agentName: string, status: string) => void) => () => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
  getCypherContext: () => Promise<{ cypherId: string; isOwner: boolean } | null>;
  leaveCypher: () => void;
  listDir: (dirPath: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  readFile: (filePath: string) => Promise<{ content: string; binary: boolean }>;
  getCypherWorkspacePath: (cypherId: string) => Promise<string | null>;
  projectBoard: (cypherId: string) => Promise<{ items: Array<{ id: string; title: string; status: string; assignee?: string; pr_url?: string | null }> }>;
  onProjectItemUpdate: (cb: (item: { id: string; title: string; status: string; assignee?: string }) => void) => () => void;
  openInVSCode: (filePath: string) => void;
  onContextReady: (cb: () => void) => () => void;
}

const api = (window as any).cypher as CypherAPI;

// ── State ──────────────────────────────────────────────
let cypherId: string | null = null;
let isOwner = false;
let workspacePath: string | null = null;

interface Jammer {
  agent_local_id: string;
  position: string;
  status: "idle" | "running" | "waiting" | "starting" | "error";
}
let jammers: Jammer[] = [];

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

interface BoardItem {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  pr_url?: string | null;
}
let boardItems: BoardItem[] = [];

interface OpenTab {
  path: string;
  name: string;
}
let openTabs: OpenTab[] = [];

let monacoEditor: any = null;
let monacoReady: Promise<void> | null = null;

let unsubEvents: (() => void) | null = null;
let unsubStatus: (() => void) | null = null;
let unsubItemUpdate: (() => void) | null = null;
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
    expanded: depth === 0, // auto-expand first level
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
    const icon = node.isDir
      ? (node.expanded ? "▾" : "▸")
      : "·";
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

  // Add to tabs if not already open
  if (!openTabs.find((t) => t.path === filePath)) {
    openTabs.push({ path: filePath, name });
  }
  renderTabs();
  renderFileTree();

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

// ── Flow Board ─────────────────────────────────────────
function renderFlowBoard(): void {
  const columns: Record<string, BoardItem[]> = {
    Backlog: [], InProgress: [], Review: [], Done: [],
  };
  for (const item of boardItems) {
    const col = columns[item.status] || columns.Backlog;
    col.push(item);
  }

  for (const [status, items] of Object.entries(columns)) {
    const key = status === "InProgress" ? "active" : status.toLowerCase();
    const container = $(`flow-${key}`);
    const count = $(`flow-count-${key}`);
    if (container) {
      container.innerHTML = "";
      for (const item of items) {
        const card = document.createElement("div");
        card.className = "flow-card";
        card.innerHTML = `${escapeHtml(item.title)}${item.assignee ? `<div class="card-assignee">@${escapeHtml(item.assignee)}</div>` : ""}`;
        container.appendChild(card);
      }
    }
    if (count) count.textContent = String(items.length);
  }
}

// ── Roster ─────────────────────────────────────────────
function renderRoster(filter?: string): void {
  const container = $("roster-list");
  container.innerHTML = "";
  const lowerFilter = filter?.toLowerCase();

  for (const j of jammers) {
    if (lowerFilter && !j.agent_local_id.toLowerCase().includes(lowerFilter)) continue;
    const el = document.createElement("div");
    el.className = "roster-item";
    el.innerHTML = `
      <div class="roster-dot ${j.status}"></div>
      <span class="roster-name">${escapeHtml(j.agent_local_id)}</span>
      <span class="roster-role">${escapeHtml(j.position)}</span>
    `;
    container.appendChild(el);
  }
}

// ── Init ───────────────────────────────────────────────
async function init(): Promise<void> {
  if (initRunning) return;
  initRunning = true;

  try {
    const ctx = await api.getCypherContext();
    if (!ctx) {
      $("viewer-empty").textContent = "No cypher context. Open a cypher from The Drop.";
      initRunning = false;
      return;
    }
    cypherId = ctx.cypherId;
    isOwner = ctx.isOwner;

    // Load cypher data
    const cypherData = await api.cypherGet(cypherId);
    const cypher = (cypherData as any)?.cypher;
    if (cypher) {
      $("cypher-title").textContent = cypher.title || "Untitled";
      const statusText = $("cypher-status-text");
      const statusEl = $("cypher-status");
      statusText.textContent = cypher.status || "lobby";
      statusEl.className = `topbar-status ${cypher.status === "live" ? "live" : "lobby"}`;
    }

    // Load jammers
    const jData = await api.cypherJammers(cypherId);
    const raw = (jData as any)?.jammers || [];
    jammers = raw
      .filter((j: any) => !j.left_at)
      .map((j: any) => ({
        agent_local_id: j.agent_local_id,
        position: j.position || "jammer",
        status: "idle" as const,
      }));
    renderRoster();

    // Load project board
    const boardData = await api.projectBoard(cypherId);
    boardItems = boardData.items || [];
    renderFlowBoard();

    // Load file tree
    workspacePath = await api.getCypherWorkspacePath(cypherId);
    if (workspacePath) {
      fileTree = await loadFileTree(workspacePath);
      // Auto-expand first-level dirs
      for (const node of fileTree) {
        if (node.isDir) {
          node.children = await loadFileTree(node.path, 1);
          node.expanded = true;
        }
      }
      renderFileTree();
    }

    // Subscribe to events
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
      renderRoster();
    }
  });

  unsubEvents = api.onCypherEvent((evCypherId, kind, payload) => {
    if (evCypherId !== cypherId) return;
    if (kind === "cypher_started") {
      $("cypher-status-text").textContent = "live";
      $("cypher-status").className = "topbar-status live";
    } else if (kind === "cypher_wrapped") {
      $("cypher-status-text").textContent = "wrapped";
      $("cypher-status").className = "topbar-status lobby";
    }
  });

  unsubItemUpdate = api.onProjectItemUpdate((item) => {
    const existing = boardItems.find((i) => i.id === item.id);
    if (existing) {
      existing.status = item.status;
      existing.assignee = item.assignee;
    } else {
      boardItems.push(item as BoardItem);
    }
    renderFlowBoard();
  });
}

function cleanup(): void {
  unsubEvents?.();
  unsubStatus?.();
  unsubItemUpdate?.();
  unsubEvents = null;
  unsubStatus = null;
  unsubItemUpdate = null;
}

// ── Boot ───────────────────────────────────────────────
function boot(): void {
  // File search
  $("file-search").addEventListener("input", (e) => {
    renderFileTree((e.target as HTMLInputElement).value);
  });

  // Roster search
  $("roster-search").addEventListener("input", (e) => {
    renderRoster((e.target as HTMLInputElement).value);
  });

  // Spawn button
  $("btn-spawn").addEventListener("click", () => {
    if (cypherId) api.cypherSpawnJammers(cypherId);
  });

  // Leave button
  $("btn-leave").addEventListener("click", () => {
    api.leaveCypher();
  });

  // Context ready = new cypher loaded
  api.onContextReady(() => {
    cleanup();
    cypherId = null;
    jammers = [];
    fileTree = [];
    boardItems = [];
    openTabs = [];
    activeFile = null;
    if (monacoEditor) {
      monacoEditor.setModel(null);
    }
    $("file-tree").innerHTML = "";
    $("roster-list").innerHTML = "";
    $("viewer-tabs").innerHTML = "";
    $("monaco-container").style.display = "none";
    $("media-viewer").style.display = "none";
    $("viewer-empty").classList.remove("hidden");
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
