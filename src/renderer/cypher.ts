/**
 * cypher.ts — Cypher workspace renderer.
 *
 * Three-column layout: Files+Jammers | Monaco | Feed+Chat.
 * Columns and panes are resizable via drag splitters.
 */

import { identiconSvg } from "./identicon";
import { CypherCards } from "./cypher-cards";

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
  onJammerActivity: (cb: (event: { cypherId?: string; seq?: number; from: string; to?: string; kind: string; body: string; tags?: string[]; ts: number; meta?: Record<string, unknown> }) => void) => () => void;
  agentStart: (agentName: string) => void;
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
  projectInfo: (cypherId: string) => Promise<{ gh_project_url: string | null; linked_repos: string[] } | null>;
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
  onLeaderDone: (cb: (info: { agentId: string; agentName: string; body: string }) => void) => () => void;
  openExternal: (url: string) => void;
  openJammerPreview: (agentId: string, url: string) => void;
  loadFeed: (cypherId: string, limit?: number) => Promise<Array<{ ts: number; from: string; kind: string; body: string; tags?: string[] }>>;
  onContextReady: (cb: () => void) => () => void;
  ghTree: () => Promise<Array<{ path: string; type: string; size?: number }> | null>;
  ghFile: (filePath: string) => Promise<{ content: string; binary: boolean } | null>;
}

const api = (window as any).cypher as CypherAPI;

// ── State ──────────────────────────────────────────────
let cypherId: string | null = null;
let isOwner = false;
let myHandle: string | null = null;
let workspacePath: string | null = null;
let ghMode = false;

interface Jammer {
  agent_local_id: string;
  name: string | null;
  avatar_url: string | null;
  position: string;
  parentId: string | null;
  status: "idle" | "running" | "waiting" | "starting" | "error";
  input_tokens: number;
  output_tokens: number;
  turns: number;
}
let jammers: Jammer[] = [];
let jammerTotal = 0;
const JAMMERS_PER_PAGE = 12;
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


interface FeedEntry {
  from: string;
  to?: string;
  kind: string;
  body: string;
  ts: number;
  avatar_url?: string | null;
  meta?: Record<string, unknown>;
}
const feedItems: FeedEntry[] = [];
const MAX_FEED_ITEMS = 200;
let feedPaused = false;
let feedFilter: string = "all";
let jammerSearchQuery = "";

let monacoEditor: any = null;
let monacoReady: Promise<void> | null = null;
let cypherCards: CypherCards | null = null;

let unsubEvents: (() => void) | null = null;
let unsubStatus: (() => void) | null = null;
let unsubActivity: (() => void) | null = null;
let unsubLeaderDone: (() => void) | null = null;
let fileTreeRefreshTimer: ReturnType<typeof setInterval> | null = null;
let initRunning = false;
let feedLoadedUpTo = 0;

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
function inlineMarkdown(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return s;
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  let html = "";
  let inCode = false;
  let inList = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) { html += "</code></pre>"; inCode = false; }
      else { if (inList) { html += "</ul>"; inList = false; } html += "<pre><code>"; inCode = true; }
      continue;
    }
    if (inCode) { html += escapeHtml(line) + "\n"; continue; }
    const t = line.trim();
    if (!t) { if (inList) { html += "</ul>"; inList = false; } continue; }
    if (t.startsWith("### ")) { if (inList) { html += "</ul>"; inList = false; } html += `<h3>${inlineMarkdown(t.slice(4))}</h3>`; continue; }
    if (t.startsWith("## ")) { if (inList) { html += "</ul>"; inList = false; } html += `<h2>${inlineMarkdown(t.slice(3))}</h2>`; continue; }
    if (t.startsWith("# ")) { if (inList) { html += "</ul>"; inList = false; } html += `<h1>${inlineMarkdown(t.slice(2))}</h1>`; continue; }
    if (/^---+$/.test(t)) { if (inList) { html += "</ul>"; inList = false; } html += "<hr>"; continue; }
    if (t.startsWith("> ")) { if (inList) { html += "</ul>"; inList = false; } html += `<blockquote>${inlineMarkdown(t.slice(2))}</blockquote>`; continue; }
    if (/^[*\-] /.test(t)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inlineMarkdown(t.slice(2))}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    html += `<p>${inlineMarkdown(t)}</p>`;
  }
  if (inCode) html += "</code></pre>";
  if (inList) html += "</ul>";
  return html;
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

  // Horizontal splitter (left column: files / jammers)
  setupHSplit("hsplit-left", "pane-files", "pane-jammers", "col-left");

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
type CenterTab = "cypher" | "files";
let activeCenterTab: CenterTab = "cypher";

function switchCenterTab(tab: CenterTab): void {
  activeCenterTab = tab;
  for (const p of ["cypher", "files"]) {
    const el = document.getElementById(`center-${p}`);
    if (el) el.classList.toggle("hidden", p !== tab);
  }

  if (tab === "cypher") {
    if (!cypherCards) {
      cypherCards = new CypherCards();
      cypherCards.init($("cards-container"));
    }
    syncCards();
  }

  if (tab === "files") triggerEditorResize();

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

const GH_PREFIX = "gh://";

function buildGhFileTree(entries: { path: string; type: string; size?: number }[]): FileNode[] {
  const root: FileNode[] = [];
  const dirMap = new Map<string, FileNode>();
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const parts = entry.path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const isDir = entry.type === "tree";
    const node: FileNode = {
      name, path: GH_PREFIX + entry.path, isDir,
      depth: parts.length,
      expanded: false,
      children: isDir ? [] : undefined,
    };
    if (isDir) dirMap.set(entry.path, node);
    if (parentPath === "") {
      root.push(node);
    } else {
      const parent = dirMap.get(parentPath);
      if (parent?.children) parent.children.push(node);
    }
  }
  return root;
}

function buildCombinedTree(
  ghChildren: FileNode[],
  sandboxChildren: FileNode[],
  expandedPaths?: Set<string>,
): FileNode[] {
  const tree: FileNode[] = [];
  const isFirst = !expandedPaths;
  if (ghChildren.length > 0) {
    tree.push({
      name: "Project", path: GH_PREFIX, isDir: true,
      children: ghChildren,
      expanded: isFirst ? true : expandedPaths!.has(GH_PREFIX),
      depth: 0,
    });
  }
  if (sandboxChildren.length > 0) {
    const sp = workspacePath || "sandboxes";
    tree.push({
      name: "Sandboxes", path: sp, isDir: true,
      children: sandboxChildren,
      expanded: isFirst ? false : expandedPaths!.has(sp),
      depth: 0,
    });
  }
  return tree;
}

function restoreExpanded(nodes: FileNode[], paths: Set<string>): void {
  for (const n of nodes) {
    if (n.isDir && paths.has(n.path)) n.expanded = true;
    if (n.children) restoreExpanded(n.children, paths);
  }
}

async function expandNode(node: FileNode): Promise<void> {
  if (!node.isDir) return;
  if (!node.children && !node.path.startsWith(GH_PREFIX)) {
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

// ── File-tree icons (shared by the live tree + wrapped file table) ──────────
const TREE_CHEV = `<svg viewBox="0 0 8 8"><path d="M2.5 1l3.5 3-3.5 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TREE_FOLDER = `<svg viewBox="0 0 16 16"><path d="M1.5 3.6a1 1 0 011-1h3.3l1.3 1.5h5.4a1 1 0 011 1v6.3a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7.8z" fill="#5b8fd9"/></svg>`;
function treeFileIcon(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  let c = "#7d818c";
  if (/^(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|rb|php|swift|kt)$/.test(ext)) c = "#4fc1ff";
  else if (/^(json|ya?ml|toml|ini|env|lock)$/.test(ext)) c = "#cf9c4a";
  else if (/^(md|markdown|txt|rst)$/.test(ext)) c = "#9aa4ad";
  else if (/^(html?|xml|svg|vue|svelte)$/.test(ext)) c = "#e4774d";
  else if (/^(css|s[ca]ss|less)$/.test(ext)) c = "#56b6c2";
  else if (/^(png|jpe?g|gif|webp|ico|bmp)$/.test(ext)) c = "#c178dd";
  else if (/^(sh|bash|zsh)$/.test(ext)) c = "#3fb950";
  return `<svg viewBox="0 0 16 16"><path d="M3.5 1.6h5.4L13 5.6v8.8a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5V2.1a.5.5 0 01.5-.5z" fill="${c}" opacity="0.92"/><path d="M8.9 1.6v3.5a.5.5 0 00.5.5H13z" fill="rgba(0,0,0,0.32)"/></svg>`;
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
    const indent = node.depth * 13;
    const chev = node.isDir
      ? `<span class="tree-chev${node.expanded ? " open" : ""}">${TREE_CHEV}</span>`
      : `<span class="tree-chev"></span>`;
    const icon = node.isDir ? TREE_FOLDER : treeFileIcon(node.name);
    el.innerHTML = `<span class="tree-indent" style="width:${indent}px"></span>${chev}<span class="tree-icon">${icon}</span><span class="tree-name">${escapeHtml(node.name)}</span>`;
    el.addEventListener("click", async () => {
      if (node.isDir) {
        await expandNode(node);
        renderFileTree(filter);
      } else {
        openFile(node.path, node.name);
      }
    });
    el.addEventListener("dblclick", () => {
      if (!node.isDir && !node.path.startsWith(GH_PREFIX)) api.openInVSCode(node.path);
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
  const readFileFn = async (p: string) => {
    if (p.startsWith(GH_PREFIX)) {
      const r = await api.ghFile(p.slice(GH_PREFIX.length));
      return r ?? { content: "", binary: false };
    }
    return api.readFile(p);
  };
  if (isMediaFile(ext)) {
    $("monaco-container").style.display = "none";
    const viewer = $("media-viewer");
    viewer.style.display = "flex";
    $("viewer-empty").classList.add("hidden");
    const { content, binary } = await readFileFn(filePath);
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
    const { content } = await readFileFn(filePath);
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
        position: j.position || j.role || "jammer",
        parentId: j.parent_agent_id || null,
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
      openJammerModal(j.agent_local_id, j.name || j.agent_local_id);
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
  syncCards();
}

function syncCards(): void {
  if (!cypherCards) return;
  cypherCards.setJammers(
    jammers.map((j) => ({
      id: j.agent_local_id,
      name: j.name || j.agent_local_id,
      position: j.position,
      status: j.status,
      avatarUrl: j.avatar_url,
    })),
  );
}

function openJammerModal(agentId: string, name: string): void {
  const overlay = $("jammer-modal-overlay");
  const input = $("jammer-modal-input") as HTMLTextAreaElement;
  const title = $("jammer-modal-title");

  title.textContent = `Message ${name}`;
  input.value = "";
  overlay.classList.remove("hidden");
  input.focus();

  const close = () => overlay.classList.add("hidden");
  const send = () => {
    const msg = input.value.trim();
    if (msg) api.agentSend(agentId, msg);
    close();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { close(); cleanup(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { send(); cleanup(); }
  };
  const onOverlayClick = (e: MouseEvent) => {
    if (e.target === overlay) { close(); cleanup(); }
  };
  const onClose = () => { close(); cleanup(); };
  const onSend = () => { send(); cleanup(); };

  const cleanup = () => {
    document.removeEventListener("keydown", onKey);
    overlay.removeEventListener("click", onOverlayClick);
    $("jammer-modal-close").removeEventListener("click", onClose);
    $("jammer-modal-send").removeEventListener("click", onSend);
  };

  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", onOverlayClick);
  $("jammer-modal-close").addEventListener("click", onClose);
  $("jammer-modal-send").addEventListener("click", onSend);
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
  updateFeedSpinner();
}

function updateFeedSpinner(): void {
  const spinner = document.getElementById("feed-spinner");
  if (!spinner) return;
  const running = jammers.filter(j => j.status === "running" || j.status === "starting");
  if (running.length > 0) {
    const names = running.map(j => j.name || j.agent_local_id).join(", ");
    spinner.innerHTML = `<span class="feed-spinner-dot"></span>${escapeHtml(names)} working...`;
  } else {
    spinner.innerHTML = "";
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

// ── Feed (right top) ──────────────────────────────────
function matchesFeedFilter(entry: FeedEntry): boolean {
  if (feedFilter === "all") return true;
  if (feedFilter === "status") return entry.kind === "status";
  if (feedFilter === "broadcast") return entry.kind !== "status";
  return true;
}

function addFeedEntry(entry: FeedEntry): void {
  feedItems.unshift(entry);
  if (feedItems.length > MAX_FEED_ITEMS) feedItems.length = MAX_FEED_ITEMS;
  if (!feedPaused && matchesFeedFilter(entry)) {
    renderFeedItem(entry, true);
  }
  cypherCards?.onFeedEvent(entry.from, entry.kind, entry.body, entry.meta);
}

function feedKindLabel(kind: string): { label: string; cls: string } {
  switch (kind) {
    case "agent_thinking": return { label: "thinking", cls: "kind-thinking" };
    case "agent_tool_use": return { label: "tool", cls: "kind-tool" };
    case "agent_result": return { label: "done", cls: "kind-result" };
    case "agent_error": return { label: "error", cls: "kind-error" };
    case "preview_url": return { label: "preview", cls: "kind-preview" };
    case "show_output": return { label: "output", cls: "kind-output" };
    default: return { label: kind, cls: "kind-default" };
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
  const avatarSrc = (entry.meta?.avatar_url as string) || jammer?.avatar_url;
  const avatarHtml = avatarSrc
    ? `<img src="${escapeHtml(avatarSrc)}" alt="" class="feed-avatar-img" />`
    : identiconSvg(entry.from, 18);
  const displayName = (entry.meta?.display_name as string) || jammer?.name || entry.from;

  const { label, cls } = feedKindLabel(entry.kind);

  let bodyHtml: string;
  if (entry.kind === "show_output") {
    const title = entry.meta?.title ? escapeHtml(String(entry.meta.title)) : "Output";
    const truncated = entry.body.length > 600;
    const visibleBody = truncated ? entry.body.slice(0, 600) : entry.body;
    bodyHtml = `
      <div class="feed-output-title">${title}</div>
      <pre class="feed-output-code">${escapeHtml(visibleBody)}${truncated ? "\n..." : ""}</pre>
      ${truncated ? `<div class="feed-item-expand">show full output</div>` : ""}
    `;
  } else if (entry.kind === "preview_url") {
    const url = entry.meta?.url ? String(entry.meta.url) : "";
    const title = entry.meta?.title ? escapeHtml(String(entry.meta.title)) : escapeHtml(entry.body);
    bodyHtml = `
      <div class="feed-preview-card">
        <span class="feed-preview-icon">&#x1F310;</span>
        <div class="feed-preview-info">
          <div class="feed-preview-title">${title}</div>
          <div class="feed-preview-url">${escapeHtml(url)}</div>
        </div>
      </div>
    `;
  } else {
    const fullBody = escapeHtml(entry.body);
    const truncated = entry.body.length > 200;
    bodyHtml = `
      <div class="feed-item-body">${fullBody}</div>
      ${truncated ? `<div class="feed-item-expand">show more</div>` : ""}
    `;
  }

  el.innerHTML = `
    <div class="feed-item-header">
      <div class="feed-item-avatar">${avatarHtml}</div>
      <span class="feed-item-name">${escapeHtml(displayName)}</span>
      <span class="feed-item-kind ${cls}">${escapeHtml(label)}</span>
      <span class="feed-item-time">${relativeTime(entry.ts)}</span>
    </div>
    ${bodyHtml}
  `;

  if (entry.kind === "preview_url" && entry.meta?.url) {
    const card = el.querySelector(".feed-preview-card");
    card?.addEventListener("click", (e) => {
      e.stopPropagation();
      api.openJammerPreview(entry.from, String(entry.meta!.url));
    });
  }

  el.addEventListener("click", () => {
    const isExpanded = el.classList.toggle("expanded");
    const expandLabel = el.querySelector(".feed-item-expand");
    if (expandLabel) expandLabel.textContent = isExpanded
      ? (entry.kind === "show_output" ? "collapse" : "show less")
      : (entry.kind === "show_output" ? "show full output" : "show more");
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
  if (!cypherId) return;
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
          position: j.position || j.role || "jammer",
          parentId: j.parent_agent_id || null,
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

  // Banner image (same approach as lobby)
  const banner = $("wrapped-banner");
  if (cypherId) {
    try {
      const cover = await api.cypherCoverGet(cypherId);
      if (cover?.ok && cover.data_base64) {
        banner.style.backgroundImage = `url(data:${cover.content_type || "image/png"};base64,${cover.data_base64})`;
      } else {
        const title = cypher?.title || cypher?.slug || "";
        let h = 0;
        for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
        h = h >>> 0;
        const h1 = h % 360;
        const h2 = (h * 7 + 137) % 360;
        banner.style.backgroundImage = `linear-gradient(135deg, hsl(${h1},80%,40%) 0%, hsl(${h2},70%,25%) 100%)`;
      }
      banner.innerHTML = "&nbsp;";
    } catch {
      banner.innerHTML = "&nbsp;";
    }
  }

  // Title + goal (lobby style)
  $("wrapped-title").textContent = cypher?.title || "Cypher";
  $("wrapped-goal").textContent = cypher?.goal || cypher?.description || "";

  // Meta pills (same style as lobby)
  $("wrapped-meta-row").innerHTML = `
    <span class="wrapped-meta-pill status">Wrapped</span>
    <span class="wrapped-meta-pill">${allJammers.length} jammer${allJammers.length === 1 ? "" : "s"}</span>
    <span class="wrapped-meta-pill">${formatTokens(totalIn)} in / ${formatTokens(totalOut)} out</span>
    <span class="wrapped-meta-pill">${String(totalTurns)} turns</span>
    ${duration !== "—" ? `<span class="wrapped-meta-pill">${duration}</span>` : ""}
  `;

  // Agents — inline chips
  allJammers.sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
  $("wrapped-agents-row").innerHTML = allJammers.map(j => {
    const av = j.avatar_url
      ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
      : identiconSvg(j.agent_local_id, 20);
    return `
      <div class="wrapped-agent-chip">
        <div class="wrapped-agent-avatar">${av}</div>
        <span class="wrapped-agent-name">${escapeHtml(j.name || j.agent_local_id)}</span>
        <span class="wrapped-agent-tokens">${formatTokens(j.input_tokens + j.output_tokens)}</span>
      </div>`;
  }).join("");

  // Repo clone section
  if (cypherId) {
    try {
      const info = await api.projectInfo(cypherId);
      if (info && info.linked_repos.length > 0) {
        const repoFullName = info.linked_repos[0];
        const httpsUrl = `https://github.com/${repoFullName}.git`;
        const sshUrl = `git@github.com:${repoFullName}.git`;
        const ghCliUrl = `gh repo clone ${repoFullName}`;
        const repoEl = $("wrapped-repo");
        repoEl.innerHTML = `
          <span class="wrapped-repo-label">Clone</span>
          <div class="wrapped-clone-tabs">
            <button class="wrapped-clone-tab active" data-clone="https">HTTPS</button>
            <button class="wrapped-clone-tab" data-clone="ssh">SSH</button>
            <button class="wrapped-clone-tab" data-clone="cli">GitHub CLI</button>
          </div>
          <input class="wrapped-clone-url" id="wrapped-clone-url" value="${escapeHtml(httpsUrl)}" readonly />
          <button class="wrapped-clone-copy" id="wrapped-clone-copy">Copy</button>
        `;
        const urls: Record<string, string> = { https: httpsUrl, ssh: sshUrl, cli: ghCliUrl };
        repoEl.querySelectorAll(".wrapped-clone-tab").forEach(btn => {
          btn.addEventListener("click", () => {
            repoEl.querySelectorAll(".wrapped-clone-tab").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            const key = (btn as HTMLElement).dataset.clone || "https";
            (document.getElementById("wrapped-clone-url") as HTMLInputElement).value = urls[key] || httpsUrl;
          });
        });
        document.getElementById("wrapped-clone-copy")?.addEventListener("click", () => {
          const urlInput = document.getElementById("wrapped-clone-url") as HTMLInputElement;
          navigator.clipboard.writeText(urlInput.value);
          const copyBtn = document.getElementById("wrapped-clone-copy")!;
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        });
      }
    } catch { /* no project */ }
  }

  // GitHub-style file table + inline README
  const fileTableEl = $("wrapped-file-table");
  const fileContentEl = $("wrapped-file-content");
  const readmeEl = $("wrapped-readme");
  fileTableEl.innerHTML = "";
  fileContentEl.innerHTML = "";
  readmeEl.innerHTML = "";

  let wrappedGhMode = false;
  let wrappedGhTree: FileNode[] = [];

  const ghEntries = await api.ghTree();
  if (ghEntries && ghEntries.length > 0) {
    wrappedGhMode = true;
    wrappedGhTree = buildGhFileTree(ghEntries);
  }

  async function readWrappedFile(filePath: string): Promise<{ content: string; binary: boolean }> {
    if (wrappedGhMode) {
      const r = await api.ghFile(filePath);
      return r ?? { content: "", binary: false };
    }
    return api.readFile(filePath);
  }

  function renderGhDir(dirPath: string): void {
    fileTableEl.innerHTML = "";
    fileContentEl.innerHTML = "";

    let nodes = wrappedGhTree;
    if (dirPath) {
      const parts = dirPath.split("/");
      for (const part of parts) {
        const found = nodes.find(n => n.name === part && n.isDir);
        if (found?.children) { nodes = found.children; } else { return; }
      }
    }

    if (dirPath) {
      const bc = document.createElement("div");
      bc.className = "wrapped-file-breadcrumb";
      const rootLink = document.createElement("a");
      rootLink.textContent = "root";
      rootLink.addEventListener("click", () => renderGhDir(""));
      bc.appendChild(rootLink);

      const parts = dirPath.split("/");
      let cumPath = "";
      for (const part of parts) {
        cumPath = cumPath ? cumPath + "/" + part : part;
        bc.appendChild(document.createTextNode(" / "));
        const link = document.createElement("a");
        link.textContent = part;
        const navPath = cumPath;
        link.addEventListener("click", () => renderGhDir(navPath));
        bc.appendChild(link);
      }
      fileTableEl.appendChild(bc);

      const backRow = document.createElement("div");
      backRow.className = "wrapped-file-row";
      backRow.innerHTML = `<span class="wrapped-file-icon">..</span><span class="wrapped-file-name dir">..</span>`;
      const parentDir = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : "";
      backRow.addEventListener("click", () => renderGhDir(parentDir));
      fileTableEl.appendChild(backRow);
    }

    const dirs = nodes.filter(n => n.isDir).sort((a, b) => a.name.localeCompare(b.name));
    const files = nodes.filter(n => !n.isDir).sort((a, b) => a.name.localeCompare(b.name));

    for (const node of [...dirs, ...files]) {
      const row = document.createElement("div");
      row.className = "wrapped-file-row";
      const iconCls = node.isDir ? " dir" : "";
      const icon = node.isDir ? TREE_FOLDER : treeFileIcon(node.name);
      const nameCls = node.isDir ? " dir" : "";
      row.innerHTML = `<span class="wrapped-file-icon${iconCls}">${icon}</span><span class="wrapped-file-name${nameCls}">${escapeHtml(node.name)}</span>`;

      if (node.isDir) {
        row.addEventListener("click", () => renderGhDir(node.path));
      } else {
        row.addEventListener("click", () => {
          fileTableEl.querySelectorAll(".wrapped-file-row.active").forEach(r => r.classList.remove("active"));
          row.classList.add("active");
          showInlineFile(node.path, node.name);
        });
      }
      fileTableEl.appendChild(row);
    }
  }

  async function renderFileTable(dirPath: string): Promise<void> {
    fileTableEl.innerHTML = "";
    fileContentEl.innerHTML = "";

    let entries: Array<{ name: string; isDir: boolean }> = [];
    try { entries = await api.listDir(dirPath); } catch { return; }

    if (workspacePath && dirPath !== workspacePath) {
      const bc = document.createElement("div");
      bc.className = "wrapped-file-breadcrumb";
      const rootLink = document.createElement("a");
      rootLink.textContent = "root";
      rootLink.addEventListener("click", () => renderFileTable(workspacePath!));
      bc.appendChild(rootLink);

      const relative = dirPath.slice(workspacePath.length + 1);
      const parts = relative.split("/");
      let cumPath = workspacePath;
      for (const part of parts) {
        cumPath += "/" + part;
        bc.appendChild(document.createTextNode(" / "));
        const link = document.createElement("a");
        link.textContent = part;
        const navPath = cumPath;
        link.addEventListener("click", () => renderFileTable(navPath));
        bc.appendChild(link);
      }
      fileTableEl.appendChild(bc);

      const backRow = document.createElement("div");
      backRow.className = "wrapped-file-row";
      backRow.innerHTML = `<span class="wrapped-file-icon">..</span><span class="wrapped-file-name dir">..</span>`;
      const parentDir = dirPath.slice(0, dirPath.lastIndexOf("/")) || workspacePath;
      backRow.addEventListener("click", () => renderFileTable(parentDir));
      fileTableEl.appendChild(backRow);
    }

    const dirs = entries.filter(e => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of [...dirs, ...files]) {
      const row = document.createElement("div");
      row.className = "wrapped-file-row";
      const iconCls = entry.isDir ? " dir" : "";
      const icon = entry.isDir ? TREE_FOLDER : treeFileIcon(entry.name);
      const nameCls = entry.isDir ? " dir" : "";
      row.innerHTML = `<span class="wrapped-file-icon${iconCls}">${icon}</span><span class="wrapped-file-name${nameCls}">${escapeHtml(entry.name)}</span>`;

      if (entry.isDir) {
        row.addEventListener("click", () => renderFileTable(dirPath + "/" + entry.name));
      } else {
        const filePath = dirPath + "/" + entry.name;
        row.addEventListener("click", () => {
          fileTableEl.querySelectorAll(".wrapped-file-row.active").forEach(r => r.classList.remove("active"));
          row.classList.add("active");
          showInlineFile(filePath, entry.name);
        });
        row.addEventListener("dblclick", () => api.openInVSCode(dirPath + "/" + entry.name));
      }
      fileTableEl.appendChild(row);
    }
  }

  async function showInlineFile(filePath: string, name: string): Promise<void> {
    const ext = fileExtension(name);
    try {
      if (isMediaFile(ext)) {
        const { content, binary } = await readWrappedFile(filePath);
        let media = "";
        if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
          const src = binary ? `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${content}` : "";
          media = `<img src="${src}" />`;
        } else if (ext === "svg") {
          media = binary ? "" : content;
        } else if (["mp3", "wav", "ogg"].includes(ext)) {
          const src = binary ? `data:audio/${ext};base64,${content}` : "";
          media = `<audio controls src="${src}"></audio>`;
        } else if (["mp4", "webm"].includes(ext)) {
          const src = binary ? `data:video/${ext};base64,${content}` : "";
          media = `<video controls src="${src}"></video>`;
        }
        fileContentEl.innerHTML = `<div class="wrapped-file-content-header">${escapeHtml(name)}</div><div class="wrapped-file-content-body">${media}</div>`;
      } else {
        const { content } = await readWrappedFile(filePath);
        fileContentEl.innerHTML = `<div class="wrapped-file-content-header">${escapeHtml(name)}</div><div class="wrapped-file-content-body">${escapeHtml(content)}</div>`;
      }
    } catch {
      fileContentEl.innerHTML = `<div class="wrapped-file-content-header">${escapeHtml(name)}</div><div class="wrapped-file-content-body" style="color:var(--text-3)">Failed to load file</div>`;
    }
  }

  if (wrappedGhMode) {
    renderGhDir("");
    try {
      const readme = await api.ghFile("README.md");
      if (readme?.content) {
        readmeEl.innerHTML = `<div class="wrapped-readme-header">README.md</div><div class="wrapped-readme-content">${renderMarkdown(readme.content)}</div>`;
      }
    } catch { /* no readme */ }
  } else if (workspacePath) {
    try { await renderFileTable(workspacePath); } catch { /* no workspace */ }

    let readmeContent: string | null = null;
    let readmeSource = "README.md";
    try {
      const result = await api.readFile(workspacePath + "/README.md");
      if (result?.content && !result.binary) readmeContent = result.content;
    } catch { /* no root readme */ }

    if (!readmeContent) {
      const leaderJammer = allJammers.find(j => j.position === "leader");
      if (leaderJammer) {
        try {
          const leaderReadme = workspacePath + "/" + leaderJammer.agent_local_id + "/README.md";
          const result = await api.readFile(leaderReadme);
          if (result?.content && !result.binary) {
            readmeContent = result.content;
            readmeSource = leaderJammer.agent_local_id + "/README.md";
          }
        } catch { /* no leader readme */ }
      }
    }

    if (readmeContent) {
      readmeEl.innerHTML = `<div class="wrapped-readme-header">${escapeHtml(readmeSource)}</div><div class="wrapped-readme-content">${renderMarkdown(readmeContent)}</div>`;
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

    // Load banner image — only for live cyphers
    if (cypherId && cypher?.status === "live") {
      const banner = $("cypher-banner");
      try {
        const cover = await api.cypherCoverGet(cypherId);
        if (cover?.ok && cover.data_base64) {
          banner.style.backgroundImage = `url(data:${cover.content_type || "image/png"};base64,${cover.data_base64})`;
        } else {
          const title = cypher?.title || cypher?.slug || "";
          let h = 0;
          for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
          h = h >>> 0;
          const h1 = h % 360;
          const h2 = (h * 7 + 137) % 360;
          banner.style.backgroundImage = `linear-gradient(135deg, hsl(${h1},80%,40%) 0%, hsl(${h2},70%,25%) 100%)`;
        }
        banner.classList.remove("hidden");
      } catch { /* no cover */ }
      $("cypher-banner-toggle").addEventListener("click", () => {
        const collapsed = banner.classList.toggle("collapsed");
        $("cypher-banner-toggle").innerHTML = collapsed ? "&#x25BC;" : "&#x25B2;";
      });
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
            position: j.position || j.role || "jammer",
            parentId: j.parent_agent_id || null,
            status: "idle",
            input_tokens: Number(j.input_tokens) || 0,
            output_tokens: Number(j.output_tokens) || 0,
            turns: Number(j.turns) || 0,
          });
        }
        offset += 200;
      }
      try {
        workspacePath = await api.getCypherWorkspacePath(cypherId);
      } catch {}
      await showWrappedResults(cypher, allJammers);
      return;
    }

    // Ensure workspace is visible (may have been hidden by a previous wrapped view)
    $("workspace").classList.remove("hidden");
    $("wrapped-view").classList.add("hidden");

    // Add starting message to feed
    if (cypher?.status === "live" && feedItems.length === 0) {
      addFeedEntry({
        from: "yo",
        kind: "status",
        body: `Starting cypher "${cypher.title || "Untitled"}"...`,
        ts: Date.now(),
      });
    }

    // Only show close button for owner of a live cypher
    if (isOwner && cypher?.status === "live") {
      $("btn-close-cypher").classList.remove("hidden");
    } else {
      $("btn-close-cypher").classList.add("hidden");
    }

    await fetchJammerPage(0);

    try {
      const [ghEntries, wsPath] = await Promise.all([
        api.ghTree().catch(() => null),
        api.getCypherWorkspacePath(cypherId).catch(() => null),
      ]);
      const ghChildren = ghEntries && ghEntries.length > 0 ? buildGhFileTree(ghEntries) : [];
      if (ghChildren.length > 0) ghMode = true;
      workspacePath = wsPath;
      let sandboxChildren: FileNode[] = [];
      if (workspacePath) {
        sandboxChildren = await loadFileTree(workspacePath);
        for (const node of sandboxChildren) {
          if (node.isDir) { node.children = await loadFileTree(node.path, 1); node.expanded = false; }
        }
      }
      if (ghChildren.length > 0 || sandboxChildren.length > 0) {
        fileTree = buildCombinedTree(ghChildren, sandboxChildren);
        renderFileTree();
      }
    } catch { /* workspace IPC may not be ready */ }

    // Populate topbar repo link
    try {
      const info = await api.projectInfo(cypherId);
      if (info && info.linked_repos.length > 0) {
        const repoFullName = info.linked_repos[0];
        const httpsUrl = `https://github.com/${repoFullName}.git`;
        const repoEl = $("topbar-repo");
        repoEl.classList.remove("hidden");
        repoEl.innerHTML = `
          <a class="topbar-repo-link" href="#" title="Open on GitHub">${escapeHtml(repoFullName)}</a>
          <span class="topbar-repo-clone">
            <input class="topbar-repo-url" value="${escapeHtml(httpsUrl)}" readonly />
            <button class="topbar-repo-copy">Copy</button>
          </span>
        `;
        repoEl.querySelector(".topbar-repo-link")?.addEventListener("click", (e) => {
          e.preventDefault();
          api.openExternal(`https://github.com/${repoFullName}`);
        });
        repoEl.querySelector(".topbar-repo-copy")?.addEventListener("click", () => {
          const urlInput = repoEl.querySelector(".topbar-repo-url") as HTMLInputElement;
          navigator.clipboard.writeText(urlInput.value);
          const btn = repoEl.querySelector(".topbar-repo-copy")!;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = "Copy"; }, 1500);
        });
      }
    } catch { /* no project info */ }

    // Load persisted feed from local file (survives refresh). Clear first so
    // a re-init (e.g. on cypher_wrapped) can't double the list.
    feedItems.length = 0;
    feedLoadedUpTo = 0;
    seenFeedSeqs.clear();
    try {
      const entries = await api.loadFeed(cypherId, 200);
      for (const entry of entries) {
        feedItems.push({
          from: entry.from,
          kind: entry.kind,
          body: entry.body,
          ts: entry.ts,
        });
        if (entry.ts > feedLoadedUpTo) feedLoadedUpTo = entry.ts;
        const eseq = (entry as { seq?: number }).seq;
        if (typeof eseq === "number") seenFeedSeqs.add(eseq);
      }
      if (feedItems.length > MAX_FEED_ITEMS) feedItems.length = MAX_FEED_ITEMS;
      rebuildFeed();
    } catch { /* feed IPC may not be ready */ }

    // Start 3D viz if on the cypher tab (default)
    if (activeCenterTab === "cypher") {
      switchCenterTab("cypher");
    }

    subscribeEvents();
  } finally {
    initRunning = false;
  }
}

// Server `seq`s already rendered into the feed — the feed is single-sourced
// from the SSE stream, and this makes a duplicate render structurally
// impossible even across a reconnect replay.
const seenFeedSeqs = new Set<number>();

function subscribeEvents(): void {
  cleanup();

  unsubStatus = api.onAgentStatus((agentName, status) => {
    const jammer = jammers.find((j) => j.agent_local_id === agentName);
    if (jammer) {
      jammer.status = status as Jammer["status"];
      scheduleJammerRender();
      cypherCards?.updateStatus(agentName, status);
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
    }
  });

  unsubActivity = api.onJammerActivity((event) => {
    // Drop activity tagged for a different cypher.
    if (event.cypherId && event.cypherId !== cypherId) return;
    // Dedup on the server `seq` — the feed is single-sourced from the SSE
    // stream, so seeing a seq twice means a replay; render it once.
    if (typeof event.seq === "number" && Number.isFinite(event.seq)) {
      if (seenFeedSeqs.has(event.seq)) return;
      seenFeedSeqs.add(event.seq);
      if (seenFeedSeqs.size > 4000) seenFeedSeqs.clear();
    }
    if (!event.from || event.from === "orchestrator" || event.from === "unknown") return;
    if (!event.body?.trim()) return;
    const ts = event.ts || Date.now();
    addFeedEntry({
      from: event.from,
      to: event.to,
      kind: event.kind,
      body: event.body,
      ts,
      meta: event.meta,
    });
  });

  unsubLeaderDone = api.onLeaderDone((info) => {
    if (!cypherId || !isOwner) return;
    const banner = $("wrap-banner");
    const agentEl = $("wrap-banner-agent");
    const bodyEl = $("wrap-banner-body");
    const name = jammers.find((j) => j.agent_local_id === info.agentId)?.name || info.agentName;
    agentEl.textContent = name;
    bodyEl.textContent = info.body || "";
    banner.classList.remove("hidden");
  });

  fileTreeRefreshTimer = setInterval(async () => {
    if (!cypherId) return;
    try {
      const allNodes: FileNode[] = [];
      const collectAll = (nodes: FileNode[]) => {
        for (const n of nodes) { allNodes.push(n); if (n.children) collectAll(n.children); }
      };
      collectAll(fileTree);
      const expanded = new Set(allNodes.filter(n => n.isDir && n.expanded).map(n => n.path));

      const [ghEntries, wsPath] = await Promise.all([
        api.ghTree().catch(() => null),
        workspacePath ? Promise.resolve(workspacePath) : api.getCypherWorkspacePath(cypherId).catch(() => null),
      ]);

      const ghChildren = ghEntries && ghEntries.length > 0 ? buildGhFileTree(ghEntries) : [];
      if (ghChildren.length > 0) ghMode = true;
      if (wsPath) workspacePath = wsPath;

      let sandboxChildren: FileNode[] = [];
      if (workspacePath) {
        sandboxChildren = await loadFileTree(workspacePath);
        for (const node of sandboxChildren) {
          if (node.isDir) { node.children = await loadFileTree(node.path, 1); }
        }
      }

      if (ghChildren.length > 0 || sandboxChildren.length > 0) {
        const newTree = buildCombinedTree(ghChildren, sandboxChildren, expanded);
        restoreExpanded(newTree, expanded);
        const flatPaths = (nodes: FileNode[]): string[] => {
          const out: string[] = [];
          const walk = (ns: FileNode[]) => { for (const n of ns) { out.push(n.path); if (n.children) walk(n.children); } };
          walk(nodes);
          return out.sort();
        };
        const oldKey = flatPaths(fileTree).join("\n");
        const newKey = flatPaths(newTree).join("\n");
        if (newKey === oldKey) return;
        fileTree = newTree;
        const treeEl = $("file-tree");
        const scrollTop = treeEl.scrollTop;
        renderFileTree();
        treeEl.scrollTop = scrollTop;
      }
    } catch { /* not ready yet */ }
  }, 5000);

}

function cleanup(): void {
  unsubEvents?.();
  unsubStatus?.();
  unsubActivity?.();
  unsubLeaderDone?.();
  unsubEvents = null;
  unsubStatus = null;
  unsubActivity = null;
  unsubLeaderDone = null;
  if (fileTreeRefreshTimer) { clearInterval(fileTreeRefreshTimer); fileTreeRefreshTimer = null; }
}

// ── Boot ───────────────────────────────────────────────
function boot(): void {
  initSplitters();

  // Center tab switching
  document.querySelectorAll(".center-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = (btn as HTMLElement).dataset.ctab as CenterTab;
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

  $("jammer-stop-all").addEventListener("click", () => {
    for (const j of jammers) {
      if (j.status === "running" || j.status === "starting") {
        api.agentStop(j.agent_local_id);
        j.status = "idle";
      }
    }
    scheduleJammerRender();
  });
  $("jammer-start-all").addEventListener("click", () => {
    for (const j of jammers) {
      if (j.status === "idle") api.agentStart(j.agent_local_id);
    }
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

  $("wrap-banner-dismiss").addEventListener("click", () => {
    $("wrap-banner").classList.add("hidden");
  });
  $("wrap-banner-approve").addEventListener("click", () => {
    $("wrap-banner").classList.add("hidden");
    void closeCypher();
  });

  $("wrapped-back-btn").addEventListener("click", () => {
    api.leaveCypher();
  });

  $("btn-close-cypher").addEventListener("click", () => {
    void closeCypher();
  });

  $("btn-leave").addEventListener("click", () => {
    api.leaveCypher();
  });

  api.onContextReady(async () => {
    const incoming = await api.getCypherContext().catch(() => null);
    if (incoming?.cypherId && incoming.cypherId === cypherId && !initRunning) {
      return;
    }
    cleanup();
    cypherId = null;
    jammers = [];
    fileTree = [];
    ghMode = false;
    feedItems.length = 0;
    feedLoadedUpTo = 0;
    openTabs = [];
    activeFile = null;
    jammerPage = 0;
    if (monacoEditor) monacoEditor.setModel(null);
    if (cypherCards) { cypherCards.dispose(); cypherCards = null; }
    $("workspace").classList.remove("hidden");
    $("wrapped-view").classList.add("hidden");
    $("wrap-banner").classList.add("hidden");
    $("btn-close-cypher").classList.remove("hidden");
    $("file-tree").innerHTML = "";
    $("jammer-list").innerHTML = "";
    $("feed-list").innerHTML = `<div class="feed-empty" id="feed-empty">No activity yet</div>`;
    $("viewer-tabs").innerHTML = "";
    $("monaco-container").style.display = "none";
    $("media-viewer").style.display = "none";
    $("viewer-empty").classList.remove("hidden");
    switchCenterTab("cypher");
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
