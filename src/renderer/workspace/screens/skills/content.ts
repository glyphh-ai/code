/**
 * content.ts — the explorer's right pane (read-only; editing is in VS Code).
 *
 * Three states, driven by the tree selection:
 *   • showSkill(name) — the skill overview: name + description + rendered
 *     SKILL.md, plus skill actions (Run, Open folder in VS Code, Delete).
 *   • showFile(name, rel) — a file: markdown renders by default (eye/`</>`
 *     per-file toggle); other files show read-only Monaco. Copy + open-file.
 *   • showCreate() — minimal new-skill form.
 *
 * Markdown is rendered with marked + DOMPurify (lib/markdown). Code uses
 * read-only Monaco (loader.js in workspace.html). Run streams to RunConsole.
 */

import { el, mount } from "../../lib/dom.js";
import { yo, hasBridge } from "../../lib/bridge.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { RunConsole } from "./run-console.js";

// ── Monaco (read-only) ──────────────────────────────────────
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
  const ext = rel.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", md: "markdown", mdx: "markdown",
    markdown: "markdown", yaml: "yaml", yml: "yaml", html: "html", htm: "html",
    css: "css", scss: "scss", less: "less", sh: "shell", bash: "shell", py: "python",
    rb: "ruby", go: "go", rs: "rust", toml: "ini", ini: "ini", xml: "xml", svg: "xml",
  };
  return map[ext] || "plaintext";
}
const monacoTheme = () => document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs";
const isMarkdown = (f: string) => /\.(md|mdx|markdown)$/i.test(f);

// ── Icons ───────────────────────────────────────────────────
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const CODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const VSCODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

const iconBtn = (icon: string, title: string) =>
  el("button", { class: "skill-icon-btn", html: icon, attrs: { title } });

const MIN_SKILL_MD = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc || "A new skill."}\n---\n\n# ${name}\n\n${desc || "Describe what this skill does."}\n`;

export interface SkillContentDeps {
  confirm: (msg: string) => Promise<boolean>;
  onChanged: () => void;   // refresh the tree (after create/delete)
  onSelectSkill: (name: string) => void; // re-select after create
}

export class SkillContent {
  readonly root: HTMLElement;
  private bar: HTMLElement;
  private body: HTMLElement;
  private monaco: any = null;
  private monacoHost: HTMLElement;
  private mdHost: HTMLElement;
  private runConsole = new RunConsole();
  private fileCache = new Map<string, string>();
  private mdMode = new Map<string, "rendered" | "code">(); // per "name/rel"

  constructor(private deps: SkillContentDeps) {
    this.bar = el("div", { class: "skill-content-bar" });
    this.monacoHost = el("div", { class: "skill-monaco hidden" });
    this.mdHost = el("div", { class: "skill-md-render yo-md hidden" });
    this.runConsole.root.classList.add("hidden");
    this.body = el("div", { class: "skill-content-body" }, [this.mdHost, this.monacoHost, this.runConsole.root]);
    this.root = el("div", { class: "skill-content" }, [this.bar, this.body]);
    this.showEmpty();
  }

  showEmpty(): void {
    this.bar.innerHTML = "";
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.mdHost.innerHTML = `<div class="skill-content-empty">Select a skill or a file.</div>`;
  }

  private hideAll(): void {
    this.mdHost.classList.add("hidden");
    this.monacoHost.classList.add("hidden");
    this.runConsole.root.classList.add("hidden");
  }

  // ── Skill overview ──
  async showSkill(name: string): Promise<void> {
    const run = iconBtn(PLAY, "Run");
    run.addEventListener("click", () => { this.hideAll(); this.runConsole.root.classList.remove("hidden"); void this.runConsole.run(name); });
    const open = iconBtn(VSCODE, "Open folder in VS Code");
    open.addEventListener("click", () => { if (yo) void yo.skillsOpenInEditor(name); });
    const del = iconBtn(TRASH, "Delete skill");
    del.classList.add("danger");
    del.addEventListener("click", async () => {
      if (!(await this.deps.confirm(`Delete skill "${name}"?`)) || !yo) return;
      try { await yo.skillsRemove(name); } catch { /* best-effort */ }
      this.deps.onChanged();
      this.showEmpty();
    });
    this.bar.innerHTML = "";
    this.bar.append(
      el("span", { class: "skill-content-title", text: name }),
      el("div", { class: "skill-content-actions" }, [run, open, del]),
    );

    this.hideAll();
    this.mdHost.classList.remove("hidden");
    if (!hasBridge() || !yo) { this.mdHost.innerHTML = `<div class="skill-content-empty">Open inside the app.</div>`; return; }
    const full = await yo.skillsGet(name).catch(() => null);
    const desc = (full?.manifest?.description as string) || "";
    const md = full?.prompt || "";
    this.mdHost.innerHTML =
      `<div class="skill-overview-head"><h1>${escapeHtml(name)}</h1>` +
      (desc ? `<p class="skill-overview-desc">${escapeHtml(desc)}</p>` : "") + `</div>` +
      renderMarkdown(md);
  }

  // ── File view ──
  async showFile(name: string, rel: string): Promise<void> {
    const key = `${name}/${rel}`;
    const md = isMarkdown(rel);
    const copy = iconBtn(COPY, "Copy");
    copy.addEventListener("click", () => {
      if (yo) yo.copyToClipboard(this.fileCache.get(key) || "");
      copy.innerHTML = CHECK; setTimeout(() => { copy.innerHTML = COPY; }, 1200);
    });
    const openFile = iconBtn(VSCODE, "Open in VS Code");
    openFile.addEventListener("click", () => { if (yo) void yo.skillsOpenFileInEditor?.(name, rel); });

    // per-file markdown toggle (rendered vs source)
    const eye = el("button", { class: "skill-seg-btn", html: EYE, attrs: { title: "Rendered" } });
    const code = el("button", { class: "skill-seg-btn", html: CODE, attrs: { title: "Source" } });
    const toggle = el("div", { class: "skill-seg" }, [eye, code]);
    eye.addEventListener("click", () => { this.mdMode.set(key, "rendered"); void this.renderFile(name, rel); });
    code.addEventListener("click", () => { this.mdMode.set(key, "code"); void this.renderFile(name, rel); });

    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-filename", text: rel }));
    const actions = el("div", { class: "skill-content-actions" }, [copy, openFile]);
    if (md) actions.prepend(toggle);
    this.bar.append(actions);

    await this.renderFile(name, rel);
  }

  private async renderFile(name: string, rel: string): Promise<void> {
    const key = `${name}/${rel}`;
    if (!this.fileCache.has(key) && yo) this.fileCache.set(key, (await yo.skillsReadFile(name, rel)) || "");
    const text = this.fileCache.get(key) || "";
    const md = isMarkdown(rel);
    const mode = md ? (this.mdMode.get(key) || "rendered") : "code"; // markdown defaults to rendered
    // reflect toggle state
    this.bar.querySelectorAll<HTMLElement>(".skill-seg-btn").forEach((b, i) => {
      b.classList.toggle("active", (i === 0 && mode === "rendered") || (i === 1 && mode === "code"));
    });
    this.hideAll();
    if (mode === "rendered") {
      this.mdHost.classList.remove("hidden");
      this.mdHost.innerHTML = renderMarkdown(text);
    } else {
      this.monacoHost.classList.remove("hidden");
      await this.showSource(text, languageForFile(rel));
    }
  }

  private async showSource(text: string, lang: string): Promise<void> {
    await ensureMonaco();
    const w = window as unknown as { monaco: any };
    if (this.monaco) {
      this.monaco.setModel(w.monaco.editor.createModel(text, lang));
    } else {
      this.monaco = w.monaco.editor.create(this.monacoHost, {
        value: text, language: lang, theme: monacoTheme(), readOnly: true,
        fontSize: 12, fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
        minimap: { enabled: false }, wordWrap: "on", automaticLayout: true,
        padding: { top: 8 }, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      });
    }
    setTimeout(() => this.monaco?.layout?.(), 0);
  }

  relayout(): void { this.monaco?.layout?.(); }

  // ── Create mode ──
  showCreate(): void {
    const nameInput = el("input", { class: "settings-input", attrs: { type: "text", placeholder: "skill-name", spellcheck: "false" } }) as HTMLInputElement;
    const descInput = el("input", { class: "settings-input", attrs: { type: "text", placeholder: "Short description (optional)", spellcheck: "false" } }) as HTMLInputElement;
    const err = el("div", { class: "skill-form-error hidden" });
    const create = el("button", { class: "action-btn primary", text: "Create skill" });
    create.addEventListener("click", async () => {
      const raw = nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
      if (!raw) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
      if (!hasBridge() || !yo) { err.textContent = "Creating requires the app."; err.classList.remove("hidden"); return; }
      const desc = descInput.value.trim();
      const res = await yo.skillsWriteFull(raw, { name: raw, description: desc }, MIN_SKILL_MD(raw, desc), null);
      if (res && typeof res === "object" && "error" in res) { err.textContent = res.error; err.classList.remove("hidden"); return; }
      this.deps.onChanged();
      this.deps.onSelectSkill(raw);
    });
    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: "New skill" }));
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.mdHost.innerHTML = "";
    this.mdHost.append(el("div", { class: "skill-create-form" }, [
      el("label", { class: "skill-create-label", text: "Name" }), nameInput,
      el("label", { class: "skill-create-label", text: "Description" }), descInput,
      err, el("div", { class: "skill-create-actions" }, [create]),
      el("p", { class: "skill-create-hint", text: "Editing happens in VS Code — create it here, then open the folder to flesh out SKILL.md." }),
    ]));
    nameInput.focus();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
