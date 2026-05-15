/**
 * .Yo Editor (yo://files) — folder explorer + Monaco editor (with tabs) +
 * read-only git diff viewer. Left-top: file tree. Left-bottom: git changes
 * tree (working-tree changes or changes vs the default branch). Right: a
 * tabbed Monaco surface — a normal editor for files, a diff editor for changes.
 */

const w = window as any;
const filesApi = w.files as {
  pickFolder: () => Promise<string | null>;
  listDir: (p: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  readFile: (p: string) => Promise<{ content: string; binary: boolean; error?: boolean }>;
  saveFile: (p: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string; defaultBranch?: string }>;
  gitRepos: (root: string) => Promise<Array<{ name: string; path: string; branch: string }>>;
  gitChanges: (root: string, mode: GitMode) => Promise<Array<{ path: string; status: string }>>;
  gitDiff: (root: string, rel: string, mode: GitMode) => Promise<{ original: string; modified: string; binary: boolean }>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => void;
  getLastFolder: () => Promise<string | null>;
  setLastFolder: (p: string) => void;
  onExternalOpenFile: (cb: (filePath: string) => void) => void;
};

type GitMode = "working" | "main";

interface Tab {
  key: string;
  name: string;
  kind: "file" | "diff";
  path: string;           // file: absolute path · diff: repo-relative path
  mode?: GitMode;         // diff tabs only
  repo?: string;          // diff tabs only — the repo root path
  model?: any;            // file tab — ITextModel
  diffModels?: { original: any; modified: any };
  dirty?: boolean;        // file tab — has unsaved edits
}

// ── State ───────────────────────────────────────────────────
let rootPath: string | null = null;
let gitMode: GitMode = "working";
let theme: "light" | "dark" = "dark";
let monaco: any = null;
let editor: any = null;
let diffEditor: any = null;
let activeFileRow: HTMLElement | null = null;
let activeGitRow: HTMLElement | null = null;
let tabs: Tab[] = [];
let activeKey: string | null = null;

const $ = (id: string) => document.getElementById(id)!;

// ── Icons ───────────────────────────────────────────────────
const CHEVRON = `<svg viewBox="0 0 8 8"><path d="M2.5 1l3.5 3-3.5 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FOLDER = `<svg viewBox="0 0 16 16"><path d="M1.5 3.6a1 1 0 011-1h3.3l1.3 1.5h5.4a1 1 0 011 1v6.3a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7.8z" fill="#5b8fd9"/></svg>`;
const BRANCH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4" cy="3.4" r="1.7"/><circle cx="4" cy="12.6" r="1.7"/><circle cx="12" cy="3.4" r="1.7"/><path d="M4 5.1v5.8M12 5.1c0 3-3 3.5-6 4.4"/></svg>`;

function fileColor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "c", "h", "cpp", "rb", "php", "swift", "kt"].includes(ext)) return "#4fc1ff";
  if (["json", "yaml", "yml", "toml", "ini", "env", "lock"].includes(ext)) return "#cf9c4a";
  if (["md", "markdown", "txt", "rst"].includes(ext)) return "#9aa4ad";
  if (["html", "htm", "xml", "svg", "vue", "svelte"].includes(ext)) return "#e4774d";
  if (["css", "scss", "less", "sass"].includes(ext)) return "#56b6c2";
  if (["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"].includes(ext)) return "#c178dd";
  if (["sh", "bash", "zsh", "fish"].includes(ext)) return "#3fb950";
  return "#7d818c";
}
function fileIcon(name: string): string {
  const c = fileColor(name);
  return `<svg viewBox="0 0 16 16"><path d="M3.5 1.6h5.4L13 5.6v8.8a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5V2.1a.5.5 0 01.5-.5z" fill="${c}" opacity="0.92"/><path d="M8.9 1.6v3.5a.5.5 0 00.5.5H13z" fill="rgba(0,0,0,0.32)"/></svg>`;
}
const STATUS_LETTER: Record<string, string> = {
  added: "A", modified: "M", deleted: "D", untracked: "U", renamed: "R",
};

// ── Language detection ──────────────────────────────────────
const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", json: "json", html: "html", htm: "html",
  css: "css", scss: "scss", less: "less", md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "shell",
  bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", xml: "xml", svg: "xml",
  sql: "sql", swift: "swift", kt: "kotlin", toml: "ini", ini: "ini",
};
function langFor(name: string): string {
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  return LANG[name.toLowerCase().split(".").pop() || ""] || "plaintext";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// ── Theme ───────────────────────────────────────────────────
function applyTheme(t: string): void {
  theme = t === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  if (monaco) monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
}

// ── Monaco ──────────────────────────────────────────────────
function initMonaco(): Promise<void> {
  return new Promise((resolve) => {
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => {
      monaco = w.monaco;
      monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
      resolve();
    });
  });
}
function editorOpts(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    automaticLayout: true, fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
    minimap: { enabled: true }, smoothScrolling: true, scrollBeyondLastLine: false,
    renderLineHighlight: "all", padding: { top: 10 },
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    ...extra,
  };
}
function ensureEditor(): any {
  if (!editor) editor = monaco.editor.create($("mono-edit"), editorOpts({ readOnly: false }));
  return editor;
}
function ensureDiff(): any {
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor($("mono-diff"),
      editorOpts({ readOnly: true, originalEditable: false, renderSideBySide: true }));
  }
  return diffEditor;
}
function showPane(which: "edit" | "diff" | "empty"): void {
  $("mono-edit").style.display = which === "edit" ? "" : "none";
  $("mono-diff").style.display = which === "diff" ? "" : "none";
  $("empty").classList.toggle("hidden", which !== "empty");
}

// ── Tabs ────────────────────────────────────────────────────
function renderTabs(): void {
  const host = $("tabs");
  host.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "fx-tab" + (tab.key === activeKey ? " active" : "") + (tab.dirty ? " dirty" : "");
    const closer = tab.dirty
      ? `<span class="fx-tab-close fx-dirty" title="Unsaved changes — click to close">&#9679;</span>`
      : `<span class="fx-tab-close" title="Close">&times;</span>`;
    el.innerHTML =
      `<span class="fx-ico">${fileIcon(tab.name)}</span>` +
      `<span class="fx-tab-name">${esc(tab.name)}</span>` +
      (tab.kind === "diff"
        ? `<span class="fx-tab-mode">${tab.mode === "main" ? "vs main" : "diff"}</span>` : "") +
      closer;
    el.addEventListener("click", () => void activateTab(tab.key));
    el.querySelector(".fx-tab-close")!.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void closeTab(tab.key);
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      openTabMenu(ev.clientX, ev.clientY, tab.key);
    });
    host.appendChild(el);
  }
}

// ── Tab right-click menu ────────────────────────────────────
let tabMenuEl: HTMLElement | null = null;
function closeTabMenu(): void {
  if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; }
}
function openTabMenu(x: number, y: number, key: string): void {
  closeTabMenu();
  const menu = document.createElement("div");
  menu.className = "fx-ctx-menu";
  const items: Array<[string, () => void]> = [
    ["Close", () => void closeTab(key)],
    ["Close Others", () => void closeMany(tabs.filter((t) => t.key !== key).map((t) => t.key))],
    ["Close All", () => void closeMany(tabs.map((t) => t.key))],
  ];
  for (const [label, action] of items) {
    const it = document.createElement("div");
    it.className = "fx-ctx-item";
    it.textContent = label;
    it.addEventListener("click", () => { closeTabMenu(); action(); });
    menu.appendChild(it);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  tabMenuEl = menu;
  setTimeout(() => {
    const onAway = (e: MouseEvent) => {
      if (tabMenuEl && !tabMenuEl.contains(e.target as Node)) {
        closeTabMenu();
        document.removeEventListener("mousedown", onAway);
      }
    };
    document.addEventListener("mousedown", onAway);
  }, 0);
}

async function activateTab(key: string): Promise<void> {
  const tab = tabs.find((t) => t.key === key);
  if (!tab) return;
  activeKey = key;
  renderTabs();
  if (tab.kind === "file") {
    if (!tab.model) {
      const r = await filesApi.readFile(tab.path);
      if (r.binary) {
        tab.model = monaco.editor.createModel(`// ${tab.name}\n// Binary file — cannot display.`, "plaintext");
      } else {
        tab.model = monaco.editor.createModel(r.content, langFor(tab.name));
        // Mark the tab dirty on the first edit.
        tab.model.onDidChangeContent(() => {
          if (!tab.dirty) { tab.dirty = true; renderTabs(); }
        });
      }
    }
    ensureEditor().setModel(tab.model);
    showPane("edit");
  } else {
    if (!tab.diffModels) {
      const r = await filesApi.gitDiff(tab.repo!, tab.path, tab.mode!);
      const lang = langFor(tab.name);
      tab.diffModels = r.binary
        ? { original: monaco.editor.createModel("Binary file — diff not shown.", "plaintext"),
            modified: monaco.editor.createModel("Binary file — diff not shown.", "plaintext") }
        : { original: monaco.editor.createModel(r.original, lang),
            modified: monaco.editor.createModel(r.modified, lang) };
    }
    ensureDiff().setModel(tab.diffModels);
    showPane("diff");
  }
}

function doCloseTab(key: string): void {
  const idx = tabs.findIndex((t) => t.key === key);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  try { tab.model?.dispose(); } catch { /* ignore */ }
  try { tab.diffModels?.original.dispose(); tab.diffModels?.modified.dispose(); } catch { /* ignore */ }
  if (activeKey === key) {
    const next = tabs[idx] || tabs[idx - 1];
    if (next) { void activateTab(next.key); }
    else { activeKey = null; renderTabs(); showPane("empty"); }
  } else {
    renderTabs();
  }
}

/** Write a file tab to disk. Returns false on failure. */
async function saveTab(tab: Tab): Promise<boolean> {
  if (tab.kind !== "file" || !tab.model) return true;
  const r = await filesApi.saveFile(tab.path, tab.model.getValue());
  if (r.ok) { tab.dirty = false; renderTabs(); return true; }
  return false;
}
async function saveActiveTab(): Promise<void> {
  const tab = tabs.find((t) => t.key === activeKey);
  if (tab && tab.kind === "file" && tab.dirty) await saveTab(tab);
}

/** Close one tab, prompting to save if it has unsaved changes. */
async function closeTab(key: string): Promise<void> {
  const tab = tabs.find((t) => t.key === key);
  if (tab && tab.kind === "file" && tab.dirty) {
    const choice = await confirmSave([tab]);
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveTab(tab))) return;
  }
  doCloseTab(key);
}

/** Close a set of tabs, prompting once for any unsaved files among them. */
async function closeMany(keys: string[]): Promise<void> {
  const targets = keys
    .map((k) => tabs.find((t) => t.key === k))
    .filter((t): t is Tab => !!t);
  const dirty = targets.filter((t) => t.kind === "file" && t.dirty);
  if (dirty.length > 0) {
    const choice = await confirmSave(dirty);
    if (choice === "cancel") return;
    if (choice === "save") {
      for (const t of dirty) { if (!(await saveTab(t))) return; }
    }
  }
  for (const t of targets) doCloseTab(t.key);
}

/** The save-before-closing modal. Handles one or many unsaved files. */
function confirmSave(dirty: Tab[]): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    const overlay = $("save-modal");
    const body = $("save-modal-body");
    const saveBtn = $("save-modal-save");
    if (dirty.length === 1) {
      body.textContent = `"${dirty[0].name}" has unsaved changes.`;
      saveBtn.textContent = "Save";
    } else {
      body.innerHTML = `${dirty.length} files have unsaved changes:<br>` +
        `<span class="fx-modal-files">${dirty.map((t) => esc(t.name)).join(", ")}</span>`;
      saveBtn.textContent = "Save All";
    }
    overlay.classList.remove("hidden");
    const finish = (r: "save" | "discard" | "cancel") => {
      overlay.classList.add("hidden");
      saveBtn.removeEventListener("click", onSave);
      $("save-modal-discard").removeEventListener("click", onDiscard);
      $("save-modal-cancel").removeEventListener("click", onCancel);
      resolve(r);
    };
    const onSave = () => finish("save");
    const onDiscard = () => finish("discard");
    const onCancel = () => finish("cancel");
    saveBtn.addEventListener("click", onSave);
    $("save-modal-discard").addEventListener("click", onDiscard);
    $("save-modal-cancel").addEventListener("click", onCancel);
  });
}

function openFileTab(abs: string, name: string): void {
  const key = `file:${abs}`;
  if (!tabs.some((t) => t.key === key)) {
    tabs.push({ key, name, kind: "file", path: abs });
  }
  void activateTab(key);
}
function openDiffTab(repo: string, rel: string, name: string): void {
  const key = `diff:${gitMode}:${repo}:${rel}`;
  if (!tabs.some((t) => t.key === key)) {
    tabs.push({ key, name, kind: "diff", path: rel, mode: gitMode, repo });
  }
  void activateTab(key);
}

// ── File tree ───────────────────────────────────────────────
async function buildDirChildren(dirPath: string, depth: number): Promise<HTMLElement> {
  const box = document.createElement("div");
  const entries = await filesApi.listDir(dirPath);
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fx-row"; empty.style.paddingLeft = `${10 + depth * 14}px`;
    empty.innerHTML = `<span class="fx-dim" style="font-style:italic">empty</span>`;
    box.appendChild(empty);
    return box;
  }
  for (const e of entries) {
    const abs = `${dirPath}/${e.name}`;
    const row = document.createElement("div");
    row.className = "fx-row" + (e.isDir ? " is-dir" : "");
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.innerHTML =
      `<span class="fx-chev">${e.isDir ? CHEVRON : ""}</span>` +
      `<span class="fx-ico">${e.isDir ? FOLDER : fileIcon(e.name)}</span>` +
      `<span class="fx-name">${esc(e.name)}</span>`;
    box.appendChild(row);
    if (e.isDir) {
      let open = false;
      let childBox: HTMLElement | null = null;
      row.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        open = !open;
        row.classList.toggle("open", open);
        if (open) {
          if (!childBox) { childBox = await buildDirChildren(abs, depth + 1); row.after(childBox); }
          else { childBox.style.display = ""; }
        } else if (childBox) { childBox.style.display = "none"; }
      });
    } else {
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (activeFileRow) activeFileRow.classList.remove("active");
        row.classList.add("active");
        activeFileRow = row;
        openFileTab(abs, e.name);
      });
    }
  }
  return box;
}

async function renderFileTree(): Promise<void> {
  const host = $("file-tree");
  host.innerHTML = `<div class="fx-empty-msg">Loading…</div>`;
  if (!rootPath) return;
  const tree = await buildDirChildren(rootPath, 0);
  host.innerHTML = "";
  host.appendChild(tree);
}

// ── Git changes — per-repo folder header + flat changed-file list ───────────
async function loadGit(): Promise<void> {
  const host = $("git-tree");
  if (!rootPath) return;
  host.innerHTML = `<div class="fx-empty-msg">Loading…</div>`;
  // The opened folder may itself be a repo, or be a folder of repos.
  const repos = await filesApi.gitRepos(rootPath);
  if (repos.length === 0) {
    host.innerHTML = `<div class="fx-empty-msg">No git repository here.</div>`;
    return;
  }
  host.innerHTML = "";
  for (const repo of repos) {
    // Collapsible folder header: <chevron> <folder-name> ...... <branch>
    const head = document.createElement("div");
    head.className = "fx-repo-head open";
    head.innerHTML =
      `<span class="fx-repo-chev">${CHEVRON}</span>` +
      `<span class="fx-repo-name">${esc(repo.name)}</span>` +
      `<span class="fx-repo-branch">${BRANCH}<span>${esc(repo.branch)}</span></span>`;
    host.appendChild(head);
    const body = document.createElement("div");
    body.className = "fx-repo-body";
    host.appendChild(body);
    head.addEventListener("click", () => {
      const open = head.classList.toggle("open");
      body.style.display = open ? "" : "none";
    });

    const changes = await filesApi.gitChanges(repo.path, gitMode);
    if (changes.length === 0) {
      const e = document.createElement("div");
      e.className = "fx-empty-msg";
      e.style.padding = "1px 10px 8px 14px";
      e.textContent = gitMode === "main" ? "No changes vs default branch." : "Working tree clean.";
      body.appendChild(e);
      continue;
    }
    // Flat list of changed files only: <file BOLD>  <dir path, right-justified>
    for (const ch of changes) {
      const slash = ch.path.lastIndexOf("/");
      const fileName = slash >= 0 ? ch.path.slice(slash + 1) : ch.path;
      const dir = slash >= 0 ? ch.path.slice(0, slash) : "";
      const st = ch.status;
      const row = document.createElement("div");
      row.className = "fx-change-row";
      row.innerHTML =
        `<span class="fx-badge st-${st}">${STATUS_LETTER[st] || "M"}</span>` +
        `<span class="fx-change-name">${esc(fileName)}</span>` +
        `<span class="fx-change-path">${esc(dir)}</span>`;
      row.title = `${ch.path} — ${st}`;
      row.addEventListener("click", () => {
        if (activeGitRow) activeGitRow.classList.remove("active");
        row.classList.add("active");
        activeGitRow = row;
        openDiffTab(repo.path, ch.path, fileName);
      });
      body.appendChild(row);
    }
  }
}

// ── Folder open flow ────────────────────────────────────────
async function setRoot(p: string): Promise<void> {
  rootPath = p;
  filesApi.setLastFolder(p);
  $("root-name").textContent = p.split("/").filter(Boolean).pop() || p;
  $("root-name").setAttribute("title", p);
  // Replace the "Open Folder" button with the theme-aware .Yo mark.
  const btn = $("open-folder");
  btn.classList.add("fx-yomark");
  btn.innerHTML = `<span class="dot">.</span>Yo`;
  btn.title = "Switch folder";
  await Promise.all([renderFileTree(), loadGit()]);
}
async function openFolder(): Promise<void> {
  const p = await filesApi.pickFolder();
  if (p) await setRoot(p);
}

// ── Wire up ─────────────────────────────────────────────────
function wireResize(): void {
  const handle = $("resize");
  const left = document.querySelector(".fx-left") as HTMLElement | null;
  if (!left) return;
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    left.style.width = `${Math.max(200, Math.min(560, e.clientX))}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
  });
}

function wire(): void {
  wireResize();
  // Cmd/Ctrl+S saves the active file tab.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveActiveTab();
    }
  });
  $("open-folder").addEventListener("click", () => void openFolder());
  $("git-mode").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as GitMode;
      if (mode === gitMode) return;
      gitMode = mode;
      $("git-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
      void loadGit();
    });
  });
}

async function main(): Promise<void> {
  wire();
  try {
    applyTheme(await filesApi.getTheme());
  } catch { /* theme IPC may not be ready */ }
  filesApi.onThemeChanged(applyTheme);
  await initMonaco();
  // The .yo agent can push files it's working on into the editor.
  filesApi.onExternalOpenFile((p) => {
    openFileTab(p, p.split("/").filter(Boolean).pop() || p);
  });
  // Restore the last opened folder — no file picker on launch.
  try {
    const last = await filesApi.getLastFolder();
    if (last) await setRoot(last);
  } catch { /* ignore */ }
}

void main();

export {};
