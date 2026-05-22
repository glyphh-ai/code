/**
 * viewer.ts — the Claude-artifact-style skill detail view.
 *
 * A READ-ONLY viewer + runner (editing happens in VS Code). Three tabs:
 *   • Markdown — the skill's SKILL.md rendered via formatMarkdown.
 *   • Code     — a file list + read-only Monaco editor of the selected file.
 *   • Preview  — a run console + sandboxed web preview (see run-console.ts).
 * Header actions: Open in VS Code, Run. Mounts into a host that already lives
 * inside the Skills slide; calls `onBack` to return to the list.
 */

import { el, mount } from "../../lib/dom.js";
import { yo, hasBridge } from "../../lib/bridge.js";
import { formatMarkdown } from "../../../format-markdown.js";
import { RunConsole } from "./run-console.js";

// ── Monaco (read-only) ──────────────────────────────────────
// Mirrors the help/skills.ts pattern: loader.js is in workspace.html <head>.
let monacoReady: Promise<void> | null = null;
function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as unknown as { monaco?: unknown; require: any };
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}

function languageForFile(rel: string): string {
  const lower = rel.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", json5: "json",
    md: "markdown", markdown: "markdown", mdx: "markdown", yaml: "yaml", yml: "yaml",
    html: "html", htm: "html", css: "css", scss: "scss", less: "less",
    sh: "shell", bash: "shell", zsh: "shell", py: "python", rb: "ruby",
    go: "go", rs: "rust", toml: "ini", ini: "ini", xml: "xml", svg: "xml",
    txt: "plaintext", log: "plaintext",
  };
  return map[ext] || "plaintext";
}

const monacoTheme = () =>
  document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs";

// ── Icons (segmented toggle) ────────────────────────────────
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const CODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const TERMINAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
const BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`;

type Tab = "markdown" | "code" | "preview";

const MIN_SKILL_MD = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc || "A new skill."}\n---\n\n# ${name}\n\n${desc || "Describe what this skill does."}\n`;

/**
 * Render the detail view into `host`. `name === null` means create mode.
 * `onBack` restores the list. `onChanged` lets the caller refresh the list
 * (e.g. after creating a skill) so it appears when the user returns.
 */
export function mountSkillViewer(
  host: HTMLElement,
  name: string | null,
  onBack: () => void,
  onChanged?: () => void,
): void {
  if (name === null) { mountCreate(host, onBack, onChanged); return; }
  mountDetail(host, name, onBack);
}

// ── Create mode: minimal inline form ────────────────────────
function mountCreate(host: HTMLElement, onBack: () => void, onChanged?: () => void): void {
  const nameInput = el("input", {
    class: "settings-input", attrs: { type: "text", placeholder: "skill-name", spellcheck: "false", autocomplete: "off" },
  }) as HTMLInputElement;
  const descInput = el("input", {
    class: "settings-input", attrs: { type: "text", placeholder: "Short description (optional)", spellcheck: "false", autocomplete: "off" },
  }) as HTMLInputElement;
  const err = el("div", { class: "skill-form-error hidden" });
  const create = el("button", { class: "action-btn primary", text: "Create skill" });

  const back = el("button", { class: "skill-back-link", html: `${BACK}<span>Skills</span>` });
  back.addEventListener("click", onBack);

  create.addEventListener("click", async () => {
    const raw = nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!raw) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
    if (!hasBridge() || !yo) { err.textContent = "Creating requires the app."; err.classList.remove("hidden"); return; }
    const desc = descInput.value.trim();
    const result = await yo.skillsWriteFull(raw, { name: raw, description: desc }, MIN_SKILL_MD(raw, desc), null);
    if (result && typeof result === "object" && "error" in result) {
      err.textContent = result.error; err.classList.remove("hidden"); return;
    }
    onChanged?.();
    mount(host, ""); mountDetail(host, raw, onBack);
  });

  const root = el("div", { class: "skill-viewer" }, [
    el("div", { class: "skill-viewer-head" }, [back]),
    el("div", { class: "skill-create-form" }, [
      el("label", { class: "skill-create-label", text: "Name" }), nameInput,
      el("label", { class: "skill-create-label", text: "Description" }), descInput,
      err,
      el("div", { class: "skill-create-actions" }, [create]),
      el("p", { class: "skill-create-hint", text: "Editing happens in VS Code — create it here, then open it to flesh out the SKILL.md." }),
    ]),
  ]);
  mount(host, root);
  nameInput.focus();
}

// ── Detail mode: tabs + Monaco + run console ────────────────
function mountDetail(host: HTMLElement, name: string, onBack: () => void): void {
  let tab: Tab = "markdown";
  let files: string[] = [];
  let selectedFile = "SKILL.md";
  let monacoEditor: any = null;
  const fileCache = new Map<string, string>();
  const runConsole = new RunConsole();

  // Header
  const back = el("button", { class: "skill-back-link", html: `${BACK}<span>Skills</span>` });
  back.addEventListener("click", onBack);
  const title = el("span", { class: "skill-viewer-title", text: name });

  const seg = (t: Tab, icon: string, label: string) => {
    const b = el("button", { class: "skill-seg-btn", html: icon, attrs: { title: label, "data-tab": t } });
    b.addEventListener("click", () => setTab(t));
    return b;
  };
  const segMd = seg("markdown", EYE, "Markdown");
  const segCode = seg("code", CODE, "Code");
  const segPrev = seg("preview", TERMINAL, "Preview");
  const toggle = el("div", { class: "skill-seg", attrs: { role: "tablist" } }, [segMd, segCode, segPrev]);

  const openBtn = el("button", { class: "action-btn", text: "Open in VS Code" });
  openBtn.addEventListener("click", () => { if (yo) void yo.skillsOpenInEditor(name); });
  const runBtn = el("button", { class: "action-btn primary", text: "Run" });
  runBtn.addEventListener("click", () => { setTab("preview"); void runConsole.run(name); });

  const head = el("div", { class: "skill-viewer-head" }, [
    back, title,
    el("div", { class: "skill-viewer-head-right" }, [toggle, openBtn, runBtn]),
  ]);

  // Panes
  const mdPane = el("div", { class: "skill-md-pane yo-md" });
  const fileList = el("div", { class: "skill-code-tree" });
  const monacoHost = el("div", { class: "skill-monaco" });
  const copyBtn = el("button", { class: "action-btn", text: "Copy" });
  const codeOpenBtn = el("button", { class: "action-btn", text: "Open in VS Code" });
  codeOpenBtn.addEventListener("click", () => { if (yo) void yo.skillsOpenInEditor(name); });
  copyBtn.addEventListener("click", () => {
    if (yo) yo.copyToClipboard(fileCache.get(selectedFile) || "");
    copyBtn.textContent = "Copied"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
  });
  const codePane = el("div", { class: "skill-code-pane hidden" }, [
    fileList,
    el("div", { class: "skill-code-main" }, [
      el("div", { class: "skill-code-bar" }, [
        el("span", { class: "skill-code-filename", attrs: { id: "skill-code-filename" } }),
        el("div", { class: "skill-code-bar-actions" }, [copyBtn, codeOpenBtn]),
      ]),
      monacoHost,
    ]),
  ]);
  const prevPane = el("div", { class: "skill-preview-pane hidden" }, [runConsole.root]);

  const body = el("div", { class: "skill-viewer-body" }, [mdPane, codePane, prevPane]);
  mount(host, el("div", { class: "skill-viewer" }, [head, body]));

  // ── Tab switching ──
  function setTab(t: Tab): void {
    tab = t;
    for (const b of [segMd, segCode, segPrev]) {
      b.classList.toggle("active", b.getAttribute("data-tab") === t);
    }
    mdPane.classList.toggle("hidden", t !== "markdown");
    codePane.classList.toggle("hidden", t !== "code");
    prevPane.classList.toggle("hidden", t !== "preview");
    if (t === "code") void initCode();
  }

  // ── Markdown ──
  async function loadMarkdown(): Promise<void> {
    if (!hasBridge() || !yo) { mdPane.innerHTML = `<p class="skill-md-empty">Open inside the app to view this skill.</p>`; return; }
    const full = await yo.skillsGet(name).catch(() => null);
    mdPane.innerHTML = formatMarkdown(full?.prompt || "*(empty SKILL.md)*");
  }

  // ── Code ──
  let codeInited = false;
  async function initCode(): Promise<void> {
    if (codeInited || !hasBridge() || !yo) return;
    codeInited = true;
    files = await yo.skillsListFiles(name).catch(() => [] as string[]);
    if (!files.length) files = ["SKILL.md"];
    selectedFile = files.includes("SKILL.md") ? "SKILL.md" : files[0];
    renderFileList();
    await openFile(selectedFile);
  }

  function renderFileList(): void {
    fileList.innerHTML = "";
    const sorted = [...files].sort((a, b) => {
      const core = (f: string) => (f === "SKILL.md" ? 0 : f === "SKILL.js" ? 1 : 2);
      return core(a) - core(b) || a.localeCompare(b);
    });
    for (const f of sorted) {
      const item = el("div", {
        class: `skill-code-file${f === selectedFile ? " active" : ""}`,
        text: f,
      });
      item.addEventListener("click", () => void openFile(f));
      fileList.append(item);
    }
  }

  async function openFile(rel: string): Promise<void> {
    selectedFile = rel;
    renderFileList();
    const nameEl = monacoHost.ownerDocument.getElementById("skill-code-filename");
    if (nameEl) nameEl.textContent = rel;
    if (!fileCache.has(rel) && yo) {
      fileCache.set(rel, (await yo.skillsReadFile(name, rel)) || "");
    }
    const content = fileCache.get(rel) || "";
    await ensureMonaco();
    const w = window as unknown as { monaco: any };
    if (monacoEditor) {
      monacoEditor.setModel(w.monaco.editor.createModel(content, languageForFile(rel)));
    } else {
      monacoEditor = w.monaco.editor.create(monacoHost, {
        value: content,
        language: languageForFile(rel),
        theme: monacoTheme(),
        readOnly: true,
        fontSize: 12,
        fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
        minimap: { enabled: false },
        wordWrap: "on",
        automaticLayout: true,
        padding: { top: 8 },
        scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      });
    }
  }

  setTab("markdown");
  void loadMarkdown();
}
