// @ts-nocheck
/**
 * rails.ts — the right-rail multi-slot tiling system and every slot view
 * (Files, File viewer, Diff, Preview, Activity, Terminal), the header
 * view-picker dropdown, and per-rail/slot resizers.
 *
 * Registers ctx.placeView and ctx.viewIsOpen. Depends on nothing.
 */
export function initRails(ctx) {
  const $ = (id) => document.getElementById(id);

  let rails = [];
  let nextRailId = 1;
  let nextSlotId = 1;

  const FILE_TREE = [
    { kind: "dir",  depth: 0, name: "src",        path: "src",                          open: true },
    { kind: "dir",  depth: 1, name: "main",       path: "src/main",                     open: true },
    { kind: "file", depth: 2, name: "main.ts",          path: "src/main/main.ts" },
    { kind: "file", depth: 2, name: "yo-agent.ts",      path: "src/main/yo-agent.ts" },
    { kind: "file", depth: 2, name: "panel-manager.ts", path: "src/main/panel-manager.ts" },
    { kind: "dir",  depth: 1, name: "renderer",   path: "src/renderer",                 open: true },
    { kind: "file", depth: 2, name: "workspace.html",   path: "src/renderer/workspace.html" },
    { kind: "file", depth: 2, name: "renderer.ts",      path: "src/renderer/renderer.ts" },
    { kind: "file", depth: 2, name: "preload.ts",       path: "src/renderer/preload.ts" },
    { kind: "file", depth: 0, name: "README.md",        path: "README.md" },
    { kind: "file", depth: 0, name: "package.json",     path: "package.json" },
    { kind: "file", depth: 0, name: "tsconfig.json",    path: "tsconfig.json" },
  ];
  const FILE_CONTENT = {
    "README.md":        "# yo\n\nA workspace where the agent is the protagonist.\n",
    "package.json":     "{\n  \"name\": \"yo\",\n  \"version\": \"4.0.1\"\n}\n",
    "tsconfig.json":    "{\n  \"compilerOptions\": { \"target\": \"ES2022\", \"strict\": true }\n}\n",
    "main.ts":          "import { app } from \"electron\";\n\napp.whenReady().then(() => {\n  // boot the shell\n});\n",
    "yo-agent.ts":      "export class YoAgent {\n  // streaming chat + tool use\n}\n",
    "workspace.html":   "<!-- you're looking at this file's renderer right now -->\n",
    "renderer.ts":      "// boot, panels, IPC wiring\n",
    "preload.ts":       "// contextBridge exposes window.yo\n",
    "panel-manager.ts": "// BrowserView host\n",
  };

  const VIEW_META = {
    files:    { title: "Files",    icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>` },
    terminal: { title: "Terminal", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>` },
    diff:     { title: "Diff",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 4 11 8 15"/><polyline points="16 9 20 13 16 17"/></svg>` },
    preview:  { title: "Preview",  icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>` },
    activity: { title: "Activity", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>` },
  };

  function placeSlot(slot) {
    for (const rail of rails) {
      if (rail.slots.length < 2) { rail.slots.push(slot); renderRails(); return; }
    }
    rails.push({ id: nextRailId++, slots: [slot] });
    renderRails();
  }
  function placeView(view) {
    try { placeSlot(makeSlot(view)); }
    catch (err) { console.error("[rails] placeView failed:", err); }
  }
  function placeFileSlot(node) {
    placeSlot({
      id: nextSlotId++,
      view: "file",
      file: { name: node.name, path: node.path, content: FILE_CONTENT[node.name] || `// ${node.name}\n(no preview available)` },
    });
  }
  function closeAllOfView(view) {
    for (let i = rails.length - 1; i >= 0; i--) {
      rails[i].slots = rails[i].slots.filter((s) => s.view !== view);
      if (rails[i].slots.length === 0) rails.splice(i, 1);
    }
    renderRails();
  }
  function viewIsOpen(view) {
    return rails.some((r) => r.slots.some((s) => s.view === view));
  }
  function paintMenuChecks() {
    if (!rightRailMenu) return;
    rightRailMenu.querySelectorAll(".item").forEach((it) => {
      it.classList.toggle("visible", viewIsOpen(it.dataset.view));
    });
  }
  function makeSlot(view) {
    const id = nextSlotId++;
    if (view === "files") return { id, view };
    if (view === "terminal") {
      return { id, view, terminals: [{ id: 1, shell: "zsh", lines: ["welcome to yo terminal", ""] }], activeId: 1, nextId: 2 };
    }
    return { id, view };
  }
  function closeSlot(slotId) {
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      const idx = r.slots.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        r.slots.splice(idx, 1);
        if (r.slots.length === 0) rails.splice(i, 1);
        renderRails();
        return;
      }
    }
  }
  function renderRails() {
    const container = $("right-rails");
    if (!container) return;
    container.innerHTML = "";
    rails.forEach((rail) => container.appendChild(renderRail(rail)));
    const btn = $("right-rail-btn");
    if (btn) btn.classList.toggle("active", rails.length > 0);
    updateRailsWidthVar();
    paintMenuChecks();
  }
  function updateRailsWidthVar() {
    const container = $("right-rails");
    const w = container ? container.getBoundingClientRect().width : 0;
    document.documentElement.style.setProperty("--ws-rails-w", w + "px");
  }
  function renderRail(rail) {
    const railEl = document.createElement("aside");
    railEl.className = "ws-right-rail";
    railEl.dataset.railId = String(rail.id);
    const handle = document.createElement("div");
    handle.className = "ws-resize-v";
    handle.style.left = "0";
    railEl.appendChild(handle);
    wireRailWidthResize(handle, railEl);
    rail.slots.forEach((slot, idx) => {
      if (idx > 0) {
        const vsep = document.createElement("div");
        vsep.className = "ws-rail-vsep";
        railEl.appendChild(vsep);
        wireSlotVerticalResize(vsep, railEl);
      }
      railEl.appendChild(renderSlot(slot));
    });
    return railEl;
  }
  function renderSlot(slot) {
    let title, icon;
    if (slot.view === "file" && slot.file) {
      title = slot.file.name;
      icon = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    } else {
      const meta = VIEW_META[slot.view] || { title: slot.view, icon: "" };
      title = meta.title;
      icon = meta.icon;
    }
    const wrap = document.createElement("div");
    wrap.className = "ws-rail-slot";
    wrap.dataset.slotId = String(slot.id);
    wrap.innerHTML = `
      <div class="ws-rail-slot-header">
        ${icon}
        <span class="title"></span>
        <button class="ws-icon-btn slot-close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="ws-rail-slot-body"></div>
    `;
    wrap.querySelector(".title").textContent = title;
    if (slot.view === "file") wrap.querySelector(".title").title = slot.file.path;
    wrap.querySelector(".slot-close").addEventListener("click", () => closeSlot(slot.id));
    const body = wrap.querySelector(".ws-rail-slot-body");
    if (slot.view === "files")        renderFilesIntoSlot(body, slot);
    else if (slot.view === "terminal") renderTerminalIntoSlot(body, slot);
    else if (slot.view === "file")     renderFileIntoSlot(body, slot);
    else if (slot.view === "diff")     renderDiffIntoSlot(body, slot);
    else if (slot.view === "preview")  renderPreviewIntoSlot(body, slot);
    else if (slot.view === "activity") renderActivityIntoSlot(body, slot);
    else body.innerHTML = `<div style="color:var(--ws-text-faint);font-size:12px;padding:20px;text-align:center;">(${slot.view} view)</div>`;
    return wrap;
  }

  // ── Files view ─────────────
  function renderFilesIntoSlot(body, slot) {
    body.innerHTML = `
      <div class="ws-file-search">
        <input class="file-search-input" type="text" placeholder="Search files…" spellcheck="false" autocomplete="off" />
      </div>
      <div class="ws-files-tree"></div>
    `;
    const treeEl      = body.querySelector(".ws-files-tree");
    const searchInput = body.querySelector(".file-search-input");
    renderTreeRows(treeEl, slot);
    searchInput.addEventListener("input", (e) => {
      const q = (e.target.value || "").trim().toLowerCase();
      if (!q) { renderTreeRows(treeEl, slot); return; }
      treeEl.querySelectorAll(".ws-files-row").forEach((r) => {
        const idx = Number(r.dataset.idx);
        const node = FILE_TREE[idx];
        const matches = node && node.name.toLowerCase().includes(q);
        r.classList.toggle("hidden", !matches);
      });
    });
  }

  // ── File viewer ─────────────
  function renderFileIntoSlot(body, slot) {
    body.innerHTML = `
      <div class="ws-monaco-header">
        <span class="ws-monaco-filename"></span>
        <div class="ws-monaco-actions">
          <button class="ws-monaco-icon-btn monaco-search-toggle" title="Search in file">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>
          </button>
          <button class="ws-monaco-icon-btn monaco-open-vscode" title="Open in VS Code">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
          </button>
          <button class="ws-monaco-icon-btn monaco-copy" title="Copy contents">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>
      <div class="ws-monaco-search">
        <div class="ws-monaco-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>
          <input class="monaco-search-input" type="text" placeholder="Search in file…" spellcheck="false" autocomplete="off" />
        </div>
        <span class="match-count"></span>
        <button class="ws-monaco-icon-btn monaco-search-close" title="Close search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="ws-monaco-body"></div>
    `;
    const filenameEl       = body.querySelector(".ws-monaco-filename");
    const monacoBody       = body.querySelector(".ws-monaco-body");
    const searchBar        = body.querySelector(".ws-monaco-search");
    const searchInput      = body.querySelector(".monaco-search-input");
    const matchCount       = body.querySelector(".match-count");
    const searchToggleBtn  = body.querySelector(".monaco-search-toggle");
    const searchCloseBtn   = body.querySelector(".monaco-search-close");
    const copyBtn          = body.querySelector(".monaco-copy");
    const openVscodeBtn    = body.querySelector(".monaco-open-vscode");

    filenameEl.textContent = slot.file.path;
    monacoBody.textContent = slot.file.content;

    searchToggleBtn.addEventListener("click", () => {
      const isOpen = searchBar.classList.toggle("open");
      searchToggleBtn.classList.toggle("active", isOpen);
      if (isOpen) {
        searchInput.value = ""; matchCount.textContent = "";
        setTimeout(() => searchInput.focus(), 30);
      } else {
        monacoBody.textContent = slot.file.content;
      }
    });
    searchCloseBtn.addEventListener("click", () => {
      searchBar.classList.remove("open");
      searchToggleBtn.classList.remove("active");
      monacoBody.textContent = slot.file.content;
    });
    searchInput.addEventListener("input", (e) => {
      highlightMatchesIn(monacoBody, slot.file.content, (e.target.value || "").trim(), matchCount);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        searchBar.classList.remove("open");
        searchToggleBtn.classList.remove("active");
        monacoBody.textContent = slot.file.content;
      }
    });
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(slot.file.content);
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 900);
      } catch {}
    });
    openVscodeBtn.addEventListener("click", () => {
      if (window.yo && window.yo.openInVscode) window.yo.openInVscode(slot.file.path);
      else console.log("[monaco] open in vscode:", slot.file.path);
    });
  }

  function renderTreeRows(treeEl, slot) {
    treeEl.innerHTML = "";
    const closedAt = new Map();
    FILE_TREE.forEach((node, i) => {
      let visible = true;
      for (let d = 0; d < node.depth; d++) if (closedAt.get(d)) { visible = false; break; }
      if (node.kind === "dir") closedAt.set(node.depth, !node.open);
      const row = document.createElement("div");
      row.className = "ws-files-row" + (visible ? "" : " hidden");
      row.dataset.idx = i;
      row.style.paddingLeft = (8 + node.depth * 12) + "px";
      row.innerHTML = `
        <span class="ws-files-caret ${node.kind === "dir" ? (node.open ? "open" : "") : "leaf"}">▸</span>
        <svg class="ws-files-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${node.kind === "dir"
            ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'
            : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
        </svg>
        <span class="ws-files-name"></span>
      `;
      row.querySelector(".ws-files-name").textContent = node.name;
      row.addEventListener("click", () => {
        if (node.kind === "dir") { node.open = !node.open; renderTreeRows(treeEl, slot); return; }
        const alreadyOpen = rails.some((r) =>
          r.slots.some((s) => s.view === "file" && s.file && s.file.path === node.path));
        if (alreadyOpen) return;
        placeFileSlot(node);
      });
      treeEl.appendChild(row);
    });
  }

  function highlightMatchesIn(bodyEl, content, query, matchCountEl) {
    bodyEl.innerHTML = "";
    if (!query) { bodyEl.textContent = content || ""; matchCountEl.textContent = ""; return; }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    let lastIndex = 0, match, count = 0;
    while ((match = re.exec(content)) !== null) {
      if (match.index > lastIndex) bodyEl.appendChild(document.createTextNode(content.slice(lastIndex, match.index)));
      const mark = document.createElement("mark");
      mark.textContent = match[0];
      bodyEl.appendChild(mark);
      lastIndex = match.index + match[0].length;
      count++;
      if (match.index === re.lastIndex) re.lastIndex++;
    }
    if (lastIndex < content.length) bodyEl.appendChild(document.createTextNode(content.slice(lastIndex)));
    matchCountEl.textContent = count > 0 ? `${count} match${count === 1 ? "" : "es"}` : "no matches";
  }

  // ── Diff view ─────────────
  const DIFF_SEED_TEXT = [
    "diff --git a/src/renderer/workspace.html b/src/renderer/workspace.html",
    "index 1a2b3c4..5d6e7f8 100644",
    "--- a/src/renderer/workspace.html",
    "+++ b/src/renderer/workspace.html",
    "@@ -12,7 +12,9 @@ function placeView(view) {",
    " function placeView(view) {",
    "   try {",
    "-    for (const rail of rails) {",
    "-      if (rail.slots.length < 2) {",
    "+    placeSlot(makeSlot(view));",
    "   } catch (err) {",
    "     console.error(\"[rails] placeView failed:\", err);",
    "   }",
    " }",
    "diff --git a/src/main/yo-agent.ts b/src/main/yo-agent.ts",
    "index aaa..bbb 100644",
    "--- a/src/main/yo-agent.ts",
    "+++ b/src/main/yo-agent.ts",
    "@@ -42,6 +42,11 @@ export class YoAgent {",
    "   constructor() {",
    "     this.state = \"idle\";",
    "+    this.tools = new ToolRegistry();",
    "+    this.tools.register(\"git.diff\", gitDiffTool);",
    "+    this.tools.register(\"git.log\",  gitLogTool);",
    "   }",
    "@@ -88,4 +93,2 @@ export class YoAgent {",
    "-    // legacy single-shot path",
    "-    runOnce(prompt);",
    "   }",
    "diff --git a/README.md b/README.md",
    "index 0..1 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,3 +1,5 @@",
    " # yo",
    "+",
    "+A workspace where the agent is the protagonist.",
    " ",
  ].join("\n");

  function parseUnifiedDiff(text) {
    const files = [];
    let current = null;
    text.split("\n").forEach((line) => {
      if (line.startsWith("diff --git")) {
        const m = line.match(/diff --git a\/(.+?) b\/(.+)$/);
        const path = m ? m[2] : "(unknown)";
        current = { path, additions: 0, deletions: 0, lines: [] };
        files.push(current);
        return;
      }
      if (!current) return;
      if (line.startsWith("@@")) {
        current.lines.push({ kind: "hunk", text: line });
      } else if (
        line.startsWith("+++") || line.startsWith("---") ||
        line.startsWith("index ") || line.startsWith("new file") ||
        line.startsWith("deleted file") || line.startsWith("similarity ") ||
        line.startsWith("rename ") || line.startsWith("Binary ") ||
        line.startsWith("\\ No newline")
      ) {
        // metadata — skip
      } else if (line.startsWith("+")) {
        current.lines.push({ kind: "add", text: line });
        current.additions++;
      } else if (line.startsWith("-")) {
        current.lines.push({ kind: "del", text: line });
        current.deletions++;
      } else {
        current.lines.push({ kind: "context", text: line });
      }
    });
    return files;
  }

  async function loadDiffText() {
    if (window.yo && typeof window.yo.gitDiff === "function") {
      try { return await window.yo.gitDiff(); }
      catch (err) { console.warn("[diff] gitDiff failed, falling back:", err); }
    }
    return DIFF_SEED_TEXT;
  }

  function renderDiffIntoSlot(body, slot) {
    body.innerHTML = `
      <div class="ws-diff-toolbar">
        <span class="ws-diff-summary">loading…</span>
        <button class="ws-icon-btn ws-diff-refresh" title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
      <div class="ws-diff-files"></div>
    `;
    const summary = body.querySelector(".ws-diff-summary");
    const filesEl = body.querySelector(".ws-diff-files");
    const refreshBtn = body.querySelector(".ws-diff-refresh");
    if (!slot.collapsed) slot.collapsed = new Set();

    async function refresh() {
      summary.textContent = "loading…";
      const text = await loadDiffText();
      const files = parseUnifiedDiff(text);
      if (files.length === 0) {
        summary.textContent = "no changes";
        filesEl.innerHTML = `<div class="ws-diff-empty">Working tree is clean.</div>`;
        return;
      }
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      summary.innerHTML = "";
      summary.appendChild(document.createTextNode(`${files.length} file${files.length === 1 ? "" : "s"}`));
      const addEl = document.createElement("span");
      addEl.className = "add"; addEl.textContent = `+${totalAdd}`;
      const delEl = document.createElement("span");
      delEl.className = "del"; delEl.textContent = `−${totalDel}`;
      summary.appendChild(addEl);
      summary.appendChild(delEl);
      filesEl.innerHTML = "";
      files.forEach((f) => {
        const fileEl = document.createElement("div");
        fileEl.className = "ws-diff-file";
        if (slot.collapsed.has(f.path)) fileEl.classList.add("collapsed");
        fileEl.innerHTML = `
          <div class="ws-diff-file-header">
            <span class="ws-diff-caret">▸</span>
            <span class="ws-diff-file-name"></span>
            <span class="ws-diff-stat">
              <span class="add"></span>
              <span class="del"></span>
            </span>
          </div>
          <div class="ws-diff-file-body"></div>
        `;
        fileEl.querySelector(".ws-diff-file-name").textContent = f.path;
        fileEl.querySelector(".ws-diff-stat .add").textContent = `+${f.additions}`;
        fileEl.querySelector(".ws-diff-stat .del").textContent = `−${f.deletions}`;
        const header = fileEl.querySelector(".ws-diff-file-header");
        header.addEventListener("click", () => {
          const wasCollapsed = fileEl.classList.toggle("collapsed");
          if (wasCollapsed) slot.collapsed.add(f.path);
          else              slot.collapsed.delete(f.path);
        });
        const bodyEl = fileEl.querySelector(".ws-diff-file-body");
        f.lines.forEach((ln) => {
          const lineEl = document.createElement("div");
          lineEl.className = "ws-diff-line " + ln.kind;
          lineEl.textContent = ln.text;
          bodyEl.appendChild(lineEl);
        });
        filesEl.appendChild(fileEl);
      });
    }
    refreshBtn.addEventListener("click", refresh);
    refresh();
  }

  // ── Preview view ─────────────
  function renderPreviewIntoSlot(body, slot) {
    body.innerHTML = `
      <div class="ws-preview-url">
        <span class="dot"></span>
        <input class="ws-preview-input" type="text" value="http://localhost:3000" spellcheck="false" />
        <button class="ws-icon-btn ws-preview-reload" title="Reload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
      <div class="ws-preview-body">
        <div class="ws-preview-stub">
          <div class="ws-preview-stub-logo">⌁</div>
          <div class="ws-preview-stub-title">Preview</div>
          <div class="ws-preview-stub-sub">Hosts the live app or a rendered file.</div>
        </div>
      </div>
    `;
  }

  // ── Activity view ─────────────
  const ACTIVITY_SEED = [
    { id: 4, when: "12m ago", status: "ok",   source: "Email triage",  text: "Found 3 actionable threads. Drafted 2 replies." },
    { id: 3, when: "2h ago",  status: "ok",   source: "RPA workflow",  text: "Logged into ADP, pulled timesheets, posted to #ops." },
    { id: 2, when: "4h ago",  status: "fail", source: "RPA workflow",  text: "Auth expired on ADP. Skill paused — re-auth required." },
    { id: 1, when: "yesterday", status: "ok", source: "Weekly digest", text: "Compiled across Linear + Slack + Gmail (sent to inbox)." },
  ];
  function renderActivityIntoSlot(body, slot) {
    body.innerHTML = `
      <div class="ws-activity-toolbar">
        <span class="ws-activity-summary">${ACTIVITY_SEED.length} recent runs</span>
        <button class="ws-icon-btn ws-activity-clear" title="Clear">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
          </svg>
        </button>
      </div>
      <div class="ws-activity-list"></div>
    `;
    const list = body.querySelector(".ws-activity-list");
    ACTIVITY_SEED.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "ws-activity-row " + entry.status;
      row.innerHTML = `
        <div class="ws-activity-row-head">
          <span class="ws-activity-status-dot"></span>
          <span class="ws-activity-source"></span>
          <span class="ws-activity-when"></span>
        </div>
        <div class="ws-activity-row-body"></div>
      `;
      row.querySelector(".ws-activity-source").textContent = entry.source;
      row.querySelector(".ws-activity-when").textContent   = entry.when;
      row.querySelector(".ws-activity-row-body").textContent = entry.text;
      list.appendChild(row);
    });
  }

  // ── Terminal view ─────────────
  function renderTerminalIntoSlot(body, slot) {
    body.innerHTML = `
      <div class="ws-terminal">
        <div class="ws-terminal-tabs"></div>
        <div class="ws-terminal-body"></div>
      </div>
    `;
    const tabsEl = body.querySelector(".ws-terminal-tabs");
    const bodyEl = body.querySelector(".ws-terminal-body");
    renderTermTabs(tabsEl, bodyEl, slot);
    renderTermBody(bodyEl, slot);
  }
  function renderTermTabs(tabsEl, bodyEl, slot) {
    tabsEl.innerHTML = "";
    slot.terminals.forEach((t, i) => {
      const tab = document.createElement("div");
      tab.className = "ws-terminal-tab" + (t.id === slot.activeId ? " active" : "");
      tab.dataset.id = String(t.id);
      tab.innerHTML = `<span class="name"></span><button class="close" title="Close terminal">×</button>`;
      tab.querySelector(".name").textContent = `${i + 1}. ${t.shell}`;
      tab.addEventListener("click", (ev) => {
        if (ev.target.closest(".close")) {
          ev.stopPropagation();
          closeTermInSlot(t.id, slot, tabsEl, bodyEl);
        } else if (t.id !== slot.activeId) {
          slot.activeId = t.id;
          renderTermTabs(tabsEl, bodyEl, slot);
          renderTermBody(bodyEl, slot);
        }
      });
      tabsEl.appendChild(tab);
    });
    const add = document.createElement("button");
    add.className = "ws-terminal-new";
    add.title = "New terminal";
    add.textContent = "+";
    add.addEventListener("click", () => {
      const t = { id: slot.nextId++, shell: "zsh", lines: ["welcome to yo terminal", ""] };
      slot.terminals.push(t);
      slot.activeId = t.id;
      renderTermTabs(tabsEl, bodyEl, slot);
      renderTermBody(bodyEl, slot);
    });
    tabsEl.appendChild(add);
  }
  function renderTermBody(bodyEl, slot) {
    const t = slot.terminals.find((x) => x.id === slot.activeId);
    if (!t) { bodyEl.innerHTML = ""; return; }
    const history = t.lines.join("\n");
    bodyEl.innerHTML = `<span></span><span class="prompt-row"><span class="ps1">$</span><input type="text" autocomplete="off" spellcheck="false" /></span>`;
    bodyEl.firstElementChild.textContent = history;
    const input = bodyEl.querySelector("input");
    input.focus();
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const cmd = input.value;
        input.value = "";
        t.lines.push("$ " + cmd);
        if (cmd.trim()) t.lines.push(`yo: command not found: ${cmd.split(/\s+/)[0]}`);
        t.lines.push("");
        renderTermBody(bodyEl, slot);
        bodyEl.scrollTop = bodyEl.scrollHeight;
      }
    });
  }
  function closeTermInSlot(termId, slot, tabsEl, bodyEl) {
    const idx = slot.terminals.findIndex((x) => x.id === termId);
    if (idx < 0) return;
    slot.terminals.splice(idx, 1);
    if (slot.terminals.length === 0) {
      const t = { id: slot.nextId++, shell: "zsh", lines: ["welcome to yo terminal", ""] };
      slot.terminals.push(t);
      slot.activeId = t.id;
    } else if (slot.activeId === termId) {
      slot.activeId = slot.terminals[Math.max(0, idx - 1)].id;
    }
    renderTermTabs(tabsEl, bodyEl, slot);
    renderTermBody(bodyEl, slot);
  }

  // ── Per-rail and per-slot resizers ────────────────────
  function wireRailWidthResize(handle, railEl) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startW = railEl.getBoundingClientRect().width;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const w = Math.max(240, Math.min(window.innerWidth - 200, startW - dx));
        railEl.style.width = w + "px";
        updateRailsWidthVar();
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  function wireSlotVerticalResize(vsep, railEl) {
    vsep.addEventListener("mousedown", (e) => {
      e.preventDefault();
      vsep.classList.add("dragging");
      const rect = railEl.getBoundingClientRect();
      const topSlot = railEl.querySelector(".ws-rail-slot");
      const onMove = (ev) => {
        const h = Math.max(120, Math.min(rect.height - 120, ev.clientY - rect.top));
        topSlot.style.flex = `0 0 ${h}px`;
      };
      const onUp = () => {
        vsep.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ── Header dropdown wiring (right-rail picker) ────────
  const rightRailBtn  = $("right-rail-btn");
  const rightRailMenu = $("right-rail-menu");
  const isMenuOpen = () => rightRailMenu && rightRailMenu.classList.contains("open");
  const closeMenu  = () => rightRailMenu && rightRailMenu.classList.remove("open");
  const openMenu   = () => {
    if (!rightRailMenu) return;
    paintMenuChecks();
    rightRailMenu.classList.add("open");
  };
  if (rightRailBtn) {
    rightRailBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      isMenuOpen() ? closeMenu() : openMenu();
    });
  }
  if (rightRailMenu) {
    rightRailMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".item");
      if (!item) return;
      const view = item.dataset.view;
      if (viewIsOpen(view)) closeAllOfView(view);
      else placeView(view);
      closeMenu();
    });
  }
  document.addEventListener("click", (e) => {
    if (!isMenuOpen()) return;
    if (rightRailMenu.contains(e.target)) return;
    if (rightRailBtn && rightRailBtn.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMenuOpen()) closeMenu();
  });
  window.addEventListener("resize", updateRailsWidthVar);

  ctx.placeView = placeView;
  ctx.viewIsOpen = viewIsOpen;
}
