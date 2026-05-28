/**
 * yo://workbench — Files + Terminal + Monaco + Preview + Diff cluster.
 *
 * Faithful port of the v4 right-rail tiling system as a standalone app.
 * Behavior matches v4 exactly:
 *   - Each rail column can hold up to 2 slots stacked vertically.
 *   - Opening a section appends to the first rail with <2 slots; once
 *     full, a new rail spawns to the right.
 *   - Click the section toggle in the header again to close ALL slots
 *     of that view.
 *   - Drag the left edge of a rail to resize its width; drag the vsep
 *     between two slots in a rail to adjust their relative heights.
 *
 * Folder picker is the same chrome as the Agent app (yo-workdir-bar) so
 * the two folder-bound apps feel identical.
 */

interface FileEntry { name: string; path: string; kind: "dir" | "file" }
interface TreeNode extends FileEntry {
  depth: number;
  open?: boolean;
  loaded?: boolean;
  children?: TreeNode[];
}

interface WbApi {
  getCwd: () => Promise<string>;
  pickCwd: () => Promise<string | null>;
  setCwd: (dir: string) => Promise<string>;
  getCwdRecents: () => Promise<string[]>;
  gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
  gitBranches: (root: string) => Promise<{ branches: string[]; current?: string; error?: string }>;
  gitCheckout: (root: string, branch: string) => Promise<{ ok: boolean; branch?: string; error?: string }>;
  onCwdChanged: (cb: (dir: string | null) => void) => () => void;
  listDir: (dir: string) => Promise<{ entries: FileEntry[]; error?: string }>;
  readFile: (filePath: string) => Promise<{ content: string; error?: string }>;
  gitDiff: (root: string) => Promise<{ text: string; error?: string }>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}
declare global { interface Window { wb: WbApi } }

type ViewKind = "files" | "terminal" | "diff" | "preview" | "monaco";

interface MonacoTab { name: string; path: string; content: string }
interface MonacoSlot { id: number; view: "monaco"; tabs: MonacoTab[]; activeIdx: number }
interface FilesSlot { id: number; view: "files"; root?: TreeNode | null }
interface TermSlot {
  id: number; view: "terminal";
  terminals: { id: number; shell: string; lines: string[] }[];
  activeId: number;
  nextId: number;
}
interface DiffSlot { id: number; view: "diff"; collapsed?: Set<string> }
interface PreviewSlot { id: number; view: "preview" }
type Slot = MonacoSlot | FilesSlot | TermSlot | DiffSlot | PreviewSlot;

interface Rail { id: number; slots: Slot[] }

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function homeShorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

const VIEW_META: Record<string, { title: string; icon: string }> = {
  files:    { title: "Files",    icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>` },
  terminal: { title: "Terminal", icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>` },
  diff:     { title: "Diff",     icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 4 11 8 15"/><polyline points="16 9 20 13 16 17"/></svg>` },
  preview:  { title: "Preview",  icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>` },
  monaco:   { title: "Editor",   icon: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
};

// ── Monaco loader (AMD path: window.require + monaco/ assets in dist) ──
let monacoReady: Promise<void> | null = null;
function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as unknown as { monaco?: unknown; require: { config: (cfg: unknown) => void; (deps: string[], cb: () => void): void } };
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}
function languageForFile(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", md: "markdown", mdx: "markdown",
    markdown: "markdown", yaml: "yaml", yml: "yaml", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less", sh: "shell", bash: "shell", py: "python",
    rb: "ruby", go: "go", rs: "rust", toml: "ini", ini: "ini", xml: "xml", svg: "xml",
  };
  return map[ext] || "plaintext";
}
function monacoTheme(): string {
  return (document.documentElement.dataset.theme || document.body.dataset.theme) === "dark" ? "vs-dark" : "vs";
}

async function init(): Promise<void> {
  if (!window.wb) return;

  let cwd = await window.wb.getCwd().catch(() => "");

  // ── Workdir bar — mirrors agent.ts ──
  const workdirBtn = document.getElementById("workdir-btn") as HTMLButtonElement | null;
  const workdirName = document.getElementById("workdir-name");
  const workdirAdd = document.getElementById("workdir-add-btn") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("workdir-branch-wrap");
  const branchEl = document.getElementById("workdir-branch");

  const dropdown = document.createElement("div");
  dropdown.className = "yo-workdir-menu";
  dropdown.setAttribute("role", "menu");
  document.body.appendChild(dropdown);
  const closeDropdown = () => dropdown.classList.remove("open");
  const isDropdownOpen = () => dropdown.classList.contains("open");

  async function paintWorkdirBar(dir: string): Promise<void> {
    if (workdirName) workdirName.textContent = dir ? basename(dir) : "Pick a folder";
    if (workdirBtn) workdirBtn.title = dir ? `working directory: ${dir}` : "Pick a folder";
    if (!dir) {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
      return;
    }
    try {
      const info = await window.wb.gitInfo(dir);
      if (info.isRepo && info.branch && branchWrap && branchEl) {
        branchEl.textContent = info.branch;
        (branchWrap as HTMLElement).style.display = "";
      } else if (branchWrap) {
        (branchWrap as HTMLElement).style.display = "none";
      }
    } catch {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
    }
  }

  async function openDropdown(): Promise<void> {
    const recents = await window.wb.getCwdRecents().catch(() => [] as string[]);
    dropdown.innerHTML = "";
    const list = recents.length ? recents : (cwd ? [cwd] : []);
    for (const dir of list) {
      const item = document.createElement("button");
      item.className = "yo-workdir-menu-item";
      item.innerHTML =
        `<span class="check">${dir === cwd ? CHECK_SVG : ""}</span>` +
        `<span class="ic">${FOLDER_SVG}</span>` +
        `<span class="nm"></span>`;
      (item.querySelector(".nm") as HTMLElement).textContent = homeShorten(dir);
      item.title = dir;
      item.addEventListener("click", async () => {
        closeDropdown();
        if (dir !== cwd) await window.wb.setCwd(dir);
      });
      dropdown.appendChild(item);
    }
    const sep = document.createElement("div");
    sep.className = "yo-workdir-menu-sep";
    dropdown.appendChild(sep);
    const choose = document.createElement("button");
    choose.className = "yo-workdir-menu-item";
    choose.textContent = "Choose folder…";
    choose.addEventListener("click", async () => {
      closeDropdown();
      await window.wb.pickCwd();
    });
    dropdown.appendChild(choose);

    if (workdirBtn) {
      const r = workdirBtn.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      dropdown.style.top = `${r.bottom + 4}px`;
      dropdown.style.bottom = "auto";
    }
    dropdown.classList.add("open");
  }

  workdirBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    isDropdownOpen() ? closeDropdown() : void openDropdown();
  });
  workdirAdd?.addEventListener("click", (e) => {
    e.stopPropagation();
    void window.wb.pickCwd();
  });
  document.addEventListener("click", (e) => {
    if (!isDropdownOpen()) return;
    if (dropdown.contains(e.target as Node)) return;
    if (workdirBtn?.contains(e.target as Node)) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDropdownOpen()) closeDropdown();
  });

  // ── Rails state ──
  const rails: Rail[] = [];
  let nextRailId = 1;
  let nextSlotId = 1;

  // Drag state — set on dragstart, cleared on dragend/drop.
  let dragSlotId: number | null = null;

  // ── Layout persistence (per-cwd) ──
  // Persists the toggleable views' positions only (Files/Terminal/Diff/Preview).
  // Monaco is spawned on demand by clicking a file in the tree — its tabs are
  // runtime state and would feel surprising to restore.
  type SavedLayout = { rails: { width?: number; topSlotHeight?: number; views: ViewKind[] }[] };
  function layoutKey(): string { return `workbench:layout:${cwd || "__nohome__"}`; }
  function saveLayout(): void {
    try {
      const railEls = document.querySelectorAll<HTMLElement>(".ws-right-rail");
      const widthByIdx = new Map<number, number>();
      const topHeightByIdx = new Map<number, number>();
      railEls.forEach((el, i) => {
        const w = el.style.width ? parseInt(el.style.width, 10) : 0;
        if (w > 0) widthByIdx.set(i, w);
        // Top-slot height: pulled from the inline `flex: 0 0 Npx` we set on
        // vsep drag. parseFloat skips the leading "0 0 ".
        const topSlot = el.querySelector(".ws-rail-slot") as HTMLElement | null;
        if (topSlot && topSlot.style.flex) {
          const m = topSlot.style.flex.match(/0 0 (\d+(?:\.\d+)?)px/);
          if (m) topHeightByIdx.set(i, parseFloat(m[1]));
        }
      });
      const data: SavedLayout = {
        rails: rails.map((r, i) => ({
          width: widthByIdx.get(i),
          topSlotHeight: r.slots.length === 2 ? topHeightByIdx.get(i) : undefined,
          views: r.slots.filter((s) => s.view !== "monaco").map((s) => s.view),
        })).filter((r) => r.views.length > 0),
      };
      localStorage.setItem(layoutKey(), JSON.stringify(data));
    } catch { /* localStorage may be unavailable in some contexts */ }
  }
  function loadLayout(): void {
    rails.length = 0;
    let raw: string | null = null;
    try { raw = localStorage.getItem(layoutKey()); } catch { /* noop */ }
    if (!raw) { renderRails(); return; }
    let data: SavedLayout;
    try { data = JSON.parse(raw); } catch { renderRails(); return; }
    for (const savedRail of data.rails || []) {
      const slots: Slot[] = [];
      for (const v of (savedRail.views || []).slice(0, 2)) {
        if (v === "files" || v === "terminal" || v === "diff" || v === "preview") {
          slots.push(makeSlot(v));
        }
      }
      if (slots.length) rails.push({ id: nextRailId++, slots });
    }
    renderRails();
    // Apply saved widths + top-slot heights after the DOM is up.
    requestAnimationFrame(() => {
      const railEls = document.querySelectorAll<HTMLElement>(".ws-right-rail");
      (data.rails || []).forEach((r, i) => {
        if (r.width && railEls[i]) railEls[i].style.width = r.width + "px";
        if (r.topSlotHeight && railEls[i]) {
          const top = railEls[i].querySelector(".ws-rail-slot") as HTMLElement | null;
          if (top) top.style.flex = `0 0 ${r.topSlotHeight}px`;
        }
      });
    });
  }

  function placeSlot(slot: Slot): void {
    for (const rail of rails) {
      if (rail.slots.length < 2) { rail.slots.push(slot); renderRails(); saveLayout(); return; }
    }
    rails.push({ id: nextRailId++, slots: [slot] });
    renderRails();
    saveLayout();
  }
  function placeView(view: Exclude<ViewKind, "monaco">): void {
    placeSlot(makeSlot(view));
  }
  function findMonacoSlot(): MonacoSlot | null {
    for (const r of rails) {
      for (const s of r.slots) {
        if (s.view === "monaco") return s;
      }
    }
    return null;
  }
  /** Tree-click entry point — routes the file into the existing Monaco slot
   *  (as a new tab or focuses an existing one), otherwise spawns a new
   *  Monaco slot via the standard placeSlot path. */
  function openFileInMonaco(node: { name: string; path: string }, content: string): void {
    const existing = findMonacoSlot();
    if (existing) {
      const idx = existing.tabs.findIndex((t) => t.path === node.path);
      if (idx >= 0) existing.activeIdx = idx;
      else {
        existing.tabs.push({ name: node.name, path: node.path, content });
        existing.activeIdx = existing.tabs.length - 1;
      }
      renderRails();
      return;
    }
    placeSlot({
      id: nextSlotId++,
      view: "monaco",
      tabs: [{ name: node.name, path: node.path, content }],
      activeIdx: 0,
    });
  }
  function closeAllOfView(view: ViewKind): void {
    for (let i = rails.length - 1; i >= 0; i--) {
      rails[i].slots = rails[i].slots.filter((s) => s.view !== view);
      if (rails[i].slots.length === 0) rails.splice(i, 1);
    }
    renderRails();
    saveLayout();
  }
  function viewIsOpen(view: ViewKind): boolean {
    return rails.some((r) => r.slots.some((s) => s.view === view));
  }
  function makeSlot(view: Exclude<ViewKind, "monaco">): Slot {
    const id = nextSlotId++;
    if (view === "files") return { id, view, root: null };
    if (view === "terminal") {
      return {
        id, view,
        terminals: [{ id: 1, shell: "zsh", lines: ["welcome to yo terminal", ""] }],
        activeId: 1, nextId: 2,
      };
    }
    if (view === "diff") return { id, view };
    return { id, view: "preview" };
  }
  function closeSlot(slotId: number): void {
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      const idx = r.slots.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        r.slots.splice(idx, 1);
        if (r.slots.length === 0) rails.splice(i, 1);
        renderRails();
        saveLayout();
        return;
      }
    }
  }

  /** Locate a slot and remove it from its rail (without pruning empty rails).
   *  Used by drag-drop reorder; the caller re-inserts at the target position. */
  function detachSlot(slotId: number): { slot: Slot; railIdx: number; slotIdx: number } | null {
    for (let i = 0; i < rails.length; i++) {
      const idx = rails[i].slots.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        const [slot] = rails[i].slots.splice(idx, 1);
        return { slot, railIdx: i, slotIdx: idx };
      }
    }
    return null;
  }

  /** Insert a slot at the given rail/slot index. Honors the 2-slot-per-rail
   *  cap by spawning a new rail when the target rail is full and the source
   *  isn't the same rail (i.e. drag from one rail INTO a full rail spawns
   *  a fresh adjacent rail). */
  function insertSlotAt(slot: Slot, railIdx: number, slotIdx: number): void {
    if (railIdx >= rails.length) {
      rails.push({ id: nextRailId++, slots: [slot] });
      return;
    }
    const target = rails[railIdx];
    if (target.slots.length >= 2) {
      rails.splice(railIdx, 0, { id: nextRailId++, slots: [slot] });
      return;
    }
    target.slots.splice(Math.min(slotIdx, target.slots.length), 0, slot);
  }

  /** Drop handler: move dragSlotId into (railIdx, slotIdx). Cleans up the
   *  source rail if it becomes empty after detachment. */
  function moveSlotTo(railIdx: number, slotIdx: number): void {
    if (dragSlotId == null) return;
    const detached = detachSlot(dragSlotId);
    if (!detached) return;
    // If the source rail was the same and now empty, the target rail index
    // may have shifted left by one.
    let targetRailIdx = railIdx;
    if (detached.railIdx < railIdx && rails[detached.railIdx]?.slots.length === 0) {
      targetRailIdx = railIdx - 1;
    }
    // If we're inserting back into the same rail at a position past where we
    // detached from, the index also shifts left by one.
    let targetSlotIdx = slotIdx;
    if (rails[targetRailIdx] === rails[detached.railIdx] && slotIdx > detached.slotIdx) {
      targetSlotIdx = slotIdx - 1;
    }
    // Drop empty source rail BEFORE inserting to keep indexes consistent.
    if (rails[detached.railIdx]?.slots.length === 0) {
      rails.splice(detached.railIdx, 1);
      if (detached.railIdx < targetRailIdx) targetRailIdx--;
    }
    insertSlotAt(detached.slot, targetRailIdx, targetSlotIdx);
    renderRails();
    saveLayout();
  }

  /** "New rail" drop variant — inserts a new rail at the given index containing
   *  just the dragged slot. */
  function moveSlotToNewRail(railIdx: number): void {
    if (dragSlotId == null) return;
    const detached = detachSlot(dragSlotId);
    if (!detached) return;
    let target = railIdx;
    if (rails[detached.railIdx]?.slots.length === 0) {
      rails.splice(detached.railIdx, 1);
      if (detached.railIdx < target) target--;
    }
    rails.splice(Math.min(target, rails.length), 0, { id: nextRailId++, slots: [detached.slot] });
    renderRails();
    saveLayout();
  }

  function renderRails(): void {
    const container = document.getElementById("right-rails");
    if (!container) return;
    container.innerHTML = "";
    rails.forEach((rail, idx) => {
      container.appendChild(makeRailDropStrip(idx));
      container.appendChild(renderRail(rail, idx));
    });
    container.appendChild(makeRailDropStrip(rails.length));
    paintSectionToggles();
  }

  /** Vertical drop zone between rails (or at the far ends). Dropping a slot
   *  here creates a new rail at this index containing just the dropped slot. */
  function makeRailDropStrip(idx: number): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "ws-rail-dropstrip";
    strip.dataset.railIdx = String(idx);
    strip.addEventListener("dragover", (e) => {
      if (dragSlotId == null) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
      strip.classList.add("drag-over");
    });
    strip.addEventListener("dragleave", () => strip.classList.remove("drag-over"));
    strip.addEventListener("drop", (e) => {
      e.preventDefault();
      strip.classList.remove("drag-over");
      moveSlotToNewRail(idx);
    });
    return strip;
  }
  function paintSectionToggles(): void {
    const toggles = document.getElementById("wb-section-toggles");
    toggles?.querySelectorAll<HTMLButtonElement>(".wb-section-btn").forEach((btn) => {
      const v = btn.dataset.view as ViewKind;
      btn.classList.toggle("active", viewIsOpen(v));
    });
  }

  function renderRail(rail: Rail, railIdx: number): HTMLElement {
    const railEl = document.createElement("aside");
    railEl.className = "ws-right-rail";
    railEl.dataset.railId = String(rail.id);
    // Width drag handle on the RIGHT edge — drag right grows the rail, drag
    // left shrinks it. Intuitive for left-to-right rails.
    const handle = document.createElement("div");
    handle.className = "ws-resize-v";
    handle.style.right = "0";
    railEl.appendChild(handle);
    wireRailWidthResize(handle, railEl);
    rail.slots.forEach((slot, idx) => {
      if (idx > 0) {
        const vsep = document.createElement("div");
        vsep.className = "ws-rail-vsep";
        railEl.appendChild(vsep);
        wireSlotVerticalResize(vsep, railEl);
      }
      railEl.appendChild(renderSlot(slot, railIdx, idx));
    });
    return railEl;
  }

  function renderSlot(slot: Slot, railIdx: number, slotIdx: number): HTMLElement {
    const meta = VIEW_META[slot.view] || { title: slot.view, icon: "" };
    const title = meta.title;
    const icon = meta.icon;
    const wrap = document.createElement("div");
    wrap.className = "ws-rail-slot";
    wrap.dataset.slotId = String(slot.id);
    wrap.dataset.view = slot.view;
    wrap.innerHTML = `
      <div class="ws-rail-slot-header" draggable="true" title="Drag to rearrange">
        ${icon}
        <span class="title"></span>
        <button class="ws-icon-btn slot-close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="ws-rail-slot-body"></div>
    `;
    (wrap.querySelector(".title") as HTMLElement).textContent = title;
    wrap.querySelector(".slot-close")!.addEventListener("click", () => closeSlot(slot.id));

    // ── Drag-and-drop ──
    const header = wrap.querySelector(".ws-rail-slot-header") as HTMLElement;
    header.addEventListener("dragstart", (e) => {
      dragSlotId = slot.id;
      wrap.classList.add("dragging");
      (e as DragEvent).dataTransfer!.effectAllowed = "move";
      (e as DragEvent).dataTransfer!.setData("text/plain", String(slot.id));
    });
    header.addEventListener("dragend", () => {
      wrap.classList.remove("dragging");
      dragSlotId = null;
      document.querySelectorAll(".ws-rail-slot.drop-above, .ws-rail-slot.drop-below")
        .forEach((el) => el.classList.remove("drop-above", "drop-below"));
    });
    // The slot itself accepts above/below drops.
    wrap.addEventListener("dragover", (e) => {
      if (dragSlotId == null) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
      const rect = wrap.getBoundingClientRect();
      const isTop = (e as DragEvent).clientY < rect.top + rect.height / 2;
      wrap.classList.toggle("drop-above", isTop);
      wrap.classList.toggle("drop-below", !isTop);
    });
    wrap.addEventListener("dragleave", (e) => {
      // Only clear when leaving the slot (not when hovering a child).
      if (!wrap.contains(e.relatedTarget as Node)) {
        wrap.classList.remove("drop-above", "drop-below");
      }
    });
    wrap.addEventListener("drop", (e) => {
      if (dragSlotId == null) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const isTop = (e as DragEvent).clientY < rect.top + rect.height / 2;
      wrap.classList.remove("drop-above", "drop-below");
      moveSlotTo(railIdx, isTop ? slotIdx : slotIdx + 1);
    });

    const body = wrap.querySelector(".ws-rail-slot-body") as HTMLElement;
    if (slot.view === "files")         void renderFilesIntoSlot(body, slot);
    else if (slot.view === "terminal") renderTerminalIntoSlot(body, slot);
    else if (slot.view === "monaco")   void renderMonacoIntoSlot(body, slot);
    else if (slot.view === "diff")     void renderDiffIntoSlot(body, slot);
    else if (slot.view === "preview")  renderPreviewIntoSlot(body);
    return wrap;
  }

  // ── Files view ──
  async function renderFilesIntoSlot(body: HTMLElement, slot: FilesSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-file-search">
        <input class="file-search-input" type="text" placeholder="Search files…" spellcheck="false" autocomplete="off" />
      </div>
      <div class="ws-files-tree"></div>
    `;
    const treeEl = body.querySelector(".ws-files-tree") as HTMLElement;
    const searchInput = body.querySelector(".file-search-input") as HTMLInputElement;
    if (!cwd) {
      treeEl.innerHTML = `<div style="padding:14px;color:var(--text-faint);font-size:12px;">Pick a working folder to see files.</div>`;
      return;
    }
    if (!slot.root) {
      const res = await window.wb.listDir(cwd);
      slot.root = {
        name: basename(cwd), path: cwd, kind: "dir", depth: -1, open: true, loaded: true,
        children: res.entries.map((e) => ({ ...e, depth: 0 })),
      };
    }
    renderTreeRows(treeEl, slot.root);
    searchInput.addEventListener("input", (e) => {
      const q = ((e.target as HTMLInputElement).value || "").trim().toLowerCase();
      treeEl.querySelectorAll<HTMLElement>(".ws-files-row").forEach((r) => {
        const nm = r.querySelector(".ws-files-name")?.textContent?.toLowerCase() || "";
        r.classList.toggle("hidden", !!q && !nm.includes(q));
      });
    });
  }

  function renderTreeRows(treeEl: HTMLElement, root: TreeNode): void {
    treeEl.innerHTML = "";
    function walk(node: TreeNode): void {
      if (node.depth >= 0) treeEl.appendChild(renderTreeRow(node, treeEl, root));
      if ((node.open || node.depth < 0) && node.children) {
        for (const c of node.children) walk(c);
      }
    }
    walk(root);
  }

  function renderTreeRow(node: TreeNode, treeEl: HTMLElement, root: TreeNode): HTMLElement {
    const row = document.createElement("div");
    row.className = "ws-files-row";
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
    (row.querySelector(".ws-files-name") as HTMLElement).textContent = node.name;
    row.addEventListener("click", async () => {
      if (node.kind === "dir") {
        if (!node.loaded) {
          const res = await window.wb.listDir(node.path);
          node.children = res.entries.map((e) => ({ ...e, depth: node.depth + 1 }));
          node.loaded = true;
        }
        node.open = !node.open;
        renderTreeRows(treeEl, root);
        return;
      }
      const res = await window.wb.readFile(node.path);
      openFileInMonaco({ name: node.name, path: node.path }, res.error ? `// error: ${res.error}` : res.content);
    });
    return row;
  }

  // ── Monaco viewer (tabbed) ──
  // Tabs along the top, real Monaco editor below. Routes from the Files
  // tree's openFileInMonaco. Persists editor instance across re-renders by
  // keying off the slot id and re-attaching the DOM host.
  async function renderMonacoIntoSlot(body: HTMLElement, slot: MonacoSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-monaco-tabs"></div>
      <div class="ws-monaco-path"></div>
      <div class="ws-monaco-host"></div>
    `;
    const tabsEl = body.querySelector(".ws-monaco-tabs") as HTMLElement;
    const pathEl = body.querySelector(".ws-monaco-path") as HTMLElement;
    const host   = body.querySelector(".ws-monaco-host") as HTMLElement;

    function paintTabs(): void {
      tabsEl.innerHTML = "";
      slot.tabs.forEach((t, i) => {
        const tab = document.createElement("div");
        tab.className = "ws-monaco-tab" + (i === slot.activeIdx ? " active" : "");
        tab.title = t.path;
        tab.innerHTML = `<span class="nm"></span><button class="close" title="Close tab">×</button>`;
        (tab.querySelector(".nm") as HTMLElement).textContent = t.name;
        tab.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".close")) {
            ev.stopPropagation();
            slot.tabs.splice(i, 1);
            if (slot.tabs.length === 0) { closeSlot(slot.id); return; }
            if (slot.activeIdx >= slot.tabs.length) slot.activeIdx = slot.tabs.length - 1;
            paintTabs();
            void mountActive();
          } else if (i !== slot.activeIdx) {
            slot.activeIdx = i;
            paintTabs();
            void mountActive();
          }
        });
        tabsEl.appendChild(tab);
      });
    }

    async function mountActive(): Promise<void> {
      const tab = slot.tabs[slot.activeIdx];
      if (!tab) { pathEl.textContent = ""; host.innerHTML = ""; return; }
      pathEl.textContent = tab.path;
      await ensureMonaco();
      const w = window as unknown as { monaco: any };
      const existing = (host as unknown as { __editor?: any }).__editor;
      if (existing) {
        existing.setModel(w.monaco.editor.createModel(tab.content, languageForFile(tab.name)));
      } else {
        const editor = w.monaco.editor.create(host, {
          value: tab.content,
          language: languageForFile(tab.name),
          theme: monacoTheme(),
          readOnly: true,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
          minimap: { enabled: false },
          wordWrap: "on",
          automaticLayout: true,
          padding: { top: 8 },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        });
        (host as unknown as { __editor?: any }).__editor = editor;
      }
    }

    paintTabs();
    await mountActive();
  }

  // ── Diff view ──
  async function renderDiffIntoSlot(body: HTMLElement, slot: DiffSlot): Promise<void> {
    body.innerHTML = `
      <div class="ws-diff-toolbar">
        <span class="ws-diff-summary">loading…</span>
        <button class="ws-icon-btn ws-diff-refresh" title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
      <div class="ws-diff-files"></div>
    `;
    const summary = body.querySelector(".ws-diff-summary") as HTMLElement;
    const filesEl = body.querySelector(".ws-diff-files") as HTMLElement;
    const refreshBtn = body.querySelector(".ws-diff-refresh") as HTMLButtonElement;
    if (!slot.collapsed) slot.collapsed = new Set();

    async function refresh(): Promise<void> {
      summary.textContent = "loading…";
      const res = cwd ? await window.wb.gitDiff(cwd) : { text: "", error: "no folder" };
      if (res.error) {
        summary.textContent = "error";
        filesEl.innerHTML = `<div class="ws-diff-empty">${res.error}</div>`;
        return;
      }
      const files = parseUnifiedDiff(res.text);
      if (files.length === 0) {
        summary.textContent = "no changes";
        filesEl.innerHTML = `<div class="ws-diff-empty">Working tree is clean.</div>`;
        return;
      }
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      summary.innerHTML = "";
      summary.appendChild(document.createTextNode(`${files.length} file${files.length === 1 ? "" : "s"}`));
      const addEl = document.createElement("span"); addEl.className = "add"; addEl.textContent = `+${totalAdd}`;
      const delEl = document.createElement("span"); delEl.className = "del"; delEl.textContent = `−${totalDel}`;
      summary.appendChild(addEl); summary.appendChild(delEl);
      filesEl.innerHTML = "";
      for (const f of files) {
        const fileEl = document.createElement("div");
        fileEl.className = "ws-diff-file";
        if (slot.collapsed!.has(f.path)) fileEl.classList.add("collapsed");
        fileEl.innerHTML = `
          <div class="ws-diff-file-header">
            <span class="ws-diff-caret">▸</span>
            <span class="ws-diff-file-name"></span>
            <span class="ws-diff-stat"><span class="add"></span><span class="del"></span></span>
          </div>
          <div class="ws-diff-file-body"></div>
        `;
        (fileEl.querySelector(".ws-diff-file-name") as HTMLElement).textContent = f.path;
        (fileEl.querySelector(".ws-diff-stat .add") as HTMLElement).textContent = `+${f.additions}`;
        (fileEl.querySelector(".ws-diff-stat .del") as HTMLElement).textContent = `−${f.deletions}`;
        fileEl.querySelector(".ws-diff-file-header")!.addEventListener("click", () => {
          const collapsed = fileEl.classList.toggle("collapsed");
          if (collapsed) slot.collapsed!.add(f.path);
          else slot.collapsed!.delete(f.path);
        });
        const lineWrap = fileEl.querySelector(".ws-diff-file-body") as HTMLElement;
        for (const ln of f.lines) {
          const lineEl = document.createElement("div");
          lineEl.className = "ws-diff-line " + ln.kind;
          lineEl.textContent = ln.text;
          lineWrap.appendChild(lineEl);
        }
        filesEl.appendChild(fileEl);
      }
    }
    refreshBtn.addEventListener("click", refresh);
    void refresh();
  }

  function parseUnifiedDiff(text: string): Array<{ path: string; additions: number; deletions: number; lines: { kind: string; text: string }[] }> {
    const files: Array<{ path: string; additions: number; deletions: number; lines: { kind: string; text: string }[] }> = [];
    let current: typeof files[number] | null = null;
    text.split("\n").forEach((line) => {
      if (line.startsWith("diff --git")) {
        const m = line.match(/diff --git a\/(.+?) b\/(.+)$/);
        current = { path: m ? m[2] : "(unknown)", additions: 0, deletions: 0, lines: [] };
        files.push(current);
        return;
      }
      if (!current) return;
      if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line });
      else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") ||
               line.startsWith("new file") || line.startsWith("deleted file") ||
               line.startsWith("similarity ") || line.startsWith("rename ") ||
               line.startsWith("Binary ") || line.startsWith("\\ No newline")) {
        // metadata — skip
      } else if (line.startsWith("+")) { current.lines.push({ kind: "add", text: line }); current.additions++; }
      else if (line.startsWith("-")) { current.lines.push({ kind: "del", text: line }); current.deletions++; }
      else current.lines.push({ kind: "context", text: line });
    });
    return files;
  }

  // ── Preview view (stub — real dev-server preview can come later) ──
  function renderPreviewIntoSlot(body: HTMLElement): void {
    body.innerHTML = `
      <div class="ws-preview-url">
        <input class="ws-preview-input" type="text" value="http://localhost:3000" spellcheck="false" />
        <button class="ws-icon-btn ws-preview-reload" title="Reload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
      <div class="ws-preview-body">
        <div class="ws-preview-stub">
          <div class="ws-preview-stub-title">Preview</div>
          <div class="ws-preview-stub-sub">Hosts the live app or a rendered file.</div>
        </div>
      </div>
    `;
  }

  // ── Terminal view (stub session — drops a "command not found" line) ──
  function renderTerminalIntoSlot(body: HTMLElement, slot: TermSlot): void {
    body.innerHTML = `
      <div class="ws-terminal">
        <div class="ws-terminal-tabs"></div>
        <div class="ws-terminal-body"></div>
      </div>
    `;
    const tabsEl = body.querySelector(".ws-terminal-tabs") as HTMLElement;
    const bodyEl = body.querySelector(".ws-terminal-body") as HTMLElement;
    renderTermTabs(tabsEl, bodyEl, slot);
    renderTermBody(bodyEl, slot);
  }
  function renderTermTabs(tabsEl: HTMLElement, bodyEl: HTMLElement, slot: TermSlot): void {
    tabsEl.innerHTML = "";
    slot.terminals.forEach((t, i) => {
      const tab = document.createElement("div");
      tab.className = "ws-terminal-tab" + (t.id === slot.activeId ? " active" : "");
      tab.innerHTML = `<span class="name"></span><button class="close" title="Close terminal">×</button>`;
      (tab.querySelector(".name") as HTMLElement).textContent = `${i + 1}. ${t.shell}`;
      tab.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".close")) {
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
    add.textContent = "+";
    add.title = "New terminal";
    add.addEventListener("click", () => {
      const t = { id: slot.nextId++, shell: "zsh", lines: ["welcome to yo terminal", ""] };
      slot.terminals.push(t);
      slot.activeId = t.id;
      renderTermTabs(tabsEl, bodyEl, slot);
      renderTermBody(bodyEl, slot);
    });
    tabsEl.appendChild(add);
  }
  function renderTermBody(bodyEl: HTMLElement, slot: TermSlot): void {
    const t = slot.terminals.find((x) => x.id === slot.activeId);
    if (!t) { bodyEl.innerHTML = ""; return; }
    const history = t.lines.join("\n");
    bodyEl.innerHTML = `<span></span><span class="prompt-row"><span class="ps1">$</span><input type="text" autocomplete="off" spellcheck="false" /></span>`;
    (bodyEl.firstElementChild as HTMLElement).textContent = history;
    const input = bodyEl.querySelector("input") as HTMLInputElement;
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
  function closeTermInSlot(termId: number, slot: TermSlot, tabsEl: HTMLElement, bodyEl: HTMLElement): void {
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

  // ── Resizers ──
  function wireRailWidthResize(handle: HTMLElement, railEl: HTMLElement): void {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startW = railEl.getBoundingClientRect().width;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        // Handle is on the RIGHT edge: drag right (dx > 0) grows the rail.
        const w = Math.max(240, Math.min(window.innerWidth - 200, startW + dx));
        railEl.style.width = w + "px";
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveLayout();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  function wireSlotVerticalResize(vsep: HTMLElement, railEl: HTMLElement): void {
    vsep.addEventListener("mousedown", (e) => {
      e.preventDefault();
      vsep.classList.add("dragging");
      const rect = railEl.getBoundingClientRect();
      const topSlot = railEl.querySelector(".ws-rail-slot") as HTMLElement;
      const onMove = (ev: MouseEvent) => {
        const h = Math.max(120, Math.min(rect.height - 120, ev.clientY - rect.top));
        topSlot.style.flex = `0 0 ${h}px`;
      };
      const onUp = () => {
        vsep.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveLayout();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ── Section toggle wiring ──
  document.querySelectorAll<HTMLButtonElement>(".wb-section-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view as Exclude<ViewKind, "file">;
      if (viewIsOpen(v)) closeAllOfView(v);
      else placeView(v);
    });
  });

  // ── Initial paint + cwd change subscription ──
  void paintWorkdirBar(cwd);
  loadLayout();
  window.wb.onCwdChanged((dir) => {
    cwd = dir || "";
    void paintWorkdirBar(cwd);
    // Mid-session folder switch: keep the user's current layout structure,
    // but everything inside refers to the OLD folder. Drop Monaco slots
    // (their tabs are file paths from the old root) and force-refresh the
    // remaining views so Files re-roots and Diff re-fetches.
    for (let i = rails.length - 1; i >= 0; i--) {
      rails[i].slots = rails[i].slots.filter((s) => s.view !== "monaco");
      if (rails[i].slots.length === 0) rails.splice(i, 1);
    }
    for (const rail of rails) {
      for (const slot of rail.slots) {
        if (slot.view === "files") (slot as FilesSlot).root = null;
      }
    }
    renderRails();
    saveLayout();
  });
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
