/**
 * yo://plan — Plan app. Five phases (requirements → architecture → design
 * → test → tasks), each backed by a markdown file at
 * <cwd>/.yo/plan/<phase>.md. The same Monaco editor instance is reused
 * for every phase; switching phases just swaps its model.
 *
 * Editing is writable and auto-saves on 800ms idle. The agent (yo://agent
 * in this workspace) is expected to also write these files, so we re-read
 * the active file on cwd change and on phase switch so external edits
 * surface immediately.
 *
 * Header chrome mirrors the Workbench: title left, workdir picker
 * inline, phase toggles on the far right (only one active at a time).
 */

type Phase = "requirements" | "design" | "tasks";

interface PlanApi {
  getCwd: () => Promise<string>;
  pickCwd: () => Promise<string | null>;
  setCwd: (dir: string) => Promise<string>;
  getCwdRecents: () => Promise<string[]>;
  gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
  onCwdChanged: (cb: (dir: string | null) => void) => () => void;
  onFileChanged: (cb: (absPath: string) => void) => () => void;
  readFile: (path: string) => Promise<{ content: string; error?: string }>;
  writeFile: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}
declare global { interface Window { plan: PlanApi } }

const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
const CHECK_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function basename(p: string): string { return p.replace(/\/+$/, "").split("/").pop() || p; }
function homeShorten(p: string): string { return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~"); }
function planPath(cwd: string, phase: Phase): string {
  // <cwd>/.yo/plan/<phase>.md — main process handles dir creation on write.
  return `${cwd.replace(/\/+$/, "")}/.yo/plan/${phase}.md`;
}

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
function monacoTheme(): string {
  return (document.documentElement.dataset.theme || document.body.dataset.theme) === "dark" ? "vs-dark" : "vs";
}

async function init(): Promise<void> {
  if (!window.plan) return;

  let cwd = await window.plan.getCwd().catch(() => "");
  let activePhase: Phase = "requirements";

  // ── Workdir bar (header) — mirrors workbench.ts wiring ──
  const workdirBtn = document.getElementById("workdir-btn") as HTMLButtonElement | null;
  const workdirName = document.getElementById("workdir-name");
  const workdirAdd = document.getElementById("workdir-add-btn") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("workdir-branch-wrap");
  const branchEl = document.getElementById("workdir-branch");

  const dropdown = document.createElement("div");
  dropdown.className = "yo-workdir-menu";
  document.body.appendChild(dropdown);
  const closeDropdown = () => dropdown.classList.remove("open");
  const isDropdownOpen = () => dropdown.classList.contains("open");

  async function paintWorkdirBar(): Promise<void> {
    if (workdirName) workdirName.textContent = cwd ? basename(cwd) : "Pick a folder";
    if (workdirBtn) workdirBtn.title = cwd ? `working directory: ${cwd}` : "Pick a folder";
    if (!cwd) {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
      return;
    }
    try {
      const info = await window.plan.gitInfo(cwd);
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
    const recents = await window.plan.getCwdRecents().catch(() => [] as string[]);
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
        if (dir !== cwd) await window.plan.setCwd(dir);
      });
      dropdown.appendChild(item);
    }
    const sep = document.createElement("div");
    sep.className = "yo-workdir-menu-sep";
    dropdown.appendChild(sep);
    const choose = document.createElement("button");
    choose.className = "yo-workdir-menu-item";
    choose.textContent = "Choose folder…";
    choose.addEventListener("click", async () => { closeDropdown(); await window.plan.pickCwd(); });
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
  workdirAdd?.addEventListener("click", (e) => { e.stopPropagation(); void window.plan.pickCwd(); });
  document.addEventListener("click", (e) => {
    if (!isDropdownOpen()) return;
    if (dropdown.contains(e.target as Node)) return;
    if (workdirBtn?.contains(e.target as Node)) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isDropdownOpen()) closeDropdown(); });

  // ── Phase toggles ──
  const phaseLabelEl = document.getElementById("plan-phase-label") as HTMLElement;
  const pathEl       = document.getElementById("plan-path") as HTMLElement;
  const saveStateEl  = document.getElementById("plan-savestate") as HTMLElement;
  const hostEl       = document.getElementById("plan-host") as HTMLElement;
  const emptyEl      = document.getElementById("plan-empty") as HTMLElement;

  function paintPhaseToggles(): void {
    document.querySelectorAll<HTMLButtonElement>(".wb-section-btn[data-phase]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.phase === activePhase);
    });
    phaseLabelEl.textContent = activePhase;
  }

  // ── Monaco editor (single instance, swap models per phase) ──
  // The model cache keys by phase so switching back doesn't refetch unless
  // cwd changed.
  let editor: any = null;
  let models: Partial<Record<Phase, any>> = {};
  let saveTimer: number | null = null;
  let suppressChange = false;

  function setSaveState(state: "saved" | "saving" | "dirty" | "error"): void {
    saveStateEl.textContent = state;
    saveStateEl.className = state === "saved" ? "plan-saved"
      : state === "dirty" ? "plan-dirty"
      : state === "saving" ? "plan-dirty"
      : "plan-dirty";
  }

  async function ensureEditor(): Promise<void> {
    if (editor) return;
    await ensureMonaco();
    const w = window as unknown as { monaco: any };
    editor = w.monaco.editor.create(hostEl, {
      value: "",
      language: "markdown",
      theme: monacoTheme(),
      readOnly: false,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
      minimap: { enabled: false },
      wordWrap: "on",
      automaticLayout: true,
      padding: { top: 12 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
    });
    editor.onDidChangeModelContent(() => {
      if (suppressChange) return;
      setSaveState("dirty");
      scheduleSave();
    });
  }

  function scheduleSave(): void {
    if (saveTimer != null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = null; void saveActive(); }, 800);
  }
  async function saveActive(): Promise<void> {
    if (!cwd || !editor) return;
    const m = models[activePhase];
    if (!m) return;
    setSaveState("saving");
    const res = await window.plan.writeFile(planPath(cwd, activePhase), m.getValue());
    setSaveState(res.ok ? "saved" : "error");
    if (!res.ok && res.error) saveStateEl.title = res.error;
  }
  // Cmd/Ctrl+S also forces a save without waiting for idle.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null; }
      void saveActive();
    }
  });

  async function loadActive(): Promise<void> {
    if (!cwd) {
      emptyEl.style.display = "";
      pathEl.textContent = "";
      return;
    }
    emptyEl.style.display = "none";
    await ensureEditor();
    const w = window as unknown as { monaco: any };
    const fpath = planPath(cwd, activePhase);
    pathEl.textContent = fpath;

    // Always re-read on phase switch / cwd change so writes from the agent
    // appear immediately. Cached model is replaced rather than reused.
    setSaveState("saved");
    const res = await window.plan.readFile(fpath);
    const text = res.error ? "" : (res.content || "");
    suppressChange = true;
    const model = w.monaco.editor.createModel(text, "markdown");
    models[activePhase] = model;
    editor.setModel(model);
    suppressChange = false;
  }

  function switchPhase(next: Phase): void {
    if (next === activePhase) return;
    // Flush any pending save for the OLD phase before switching.
    if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null; void saveActive(); }
    activePhase = next;
    paintPhaseToggles();
    void loadActive();
  }

  document.querySelectorAll<HTMLButtonElement>(".wb-section-btn[data-phase]").forEach((btn) => {
    btn.addEventListener("click", () => switchPhase(btn.dataset.phase as Phase));
  });

  // ── Initial paint + cwd change subscription ──
  paintPhaseToggles();
  void paintWorkdirBar();
  void loadActive();
  window.plan.onCwdChanged((dir) => {
    cwd = dir || "";
    // Reset model cache — different folder, different .yo/plan/ files.
    models = {};
    void paintWorkdirBar();
    void loadActive();
  });

  // Live file updates: when the agent (or anything else) writes to the
  // active phase's .md, re-read it silently so the user sees the change
  // as it streams in. Skip if the user has uncommitted edits (saveState
  // is "dirty" or "saving") to avoid clobbering their work.
  window.plan.onFileChanged(async (abs) => {
    if (!cwd || !editor) return;
    if (abs !== planPath(cwd, activePhase)) return;
    if (saveStateEl.textContent === "dirty" || saveStateEl.textContent === "saving") return;
    const res = await window.plan.readFile(abs);
    if (res.error) return;
    const newText = res.content || "";
    const m = models[activePhase];
    if (!m) return;
    if (m.getValue() === newText) return; // no-op when content hasn't changed
    suppressChange = true;
    // Preserve cursor + selection across the swap so a passive reader
    // isn't yanked back to the top while content streams in.
    const sel = editor.getSelections();
    m.setValue(newText);
    if (sel) editor.setSelections(sel);
    suppressChange = false;
    setSaveState("saved");
  });
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
