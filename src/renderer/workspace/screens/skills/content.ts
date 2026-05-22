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

/** Media files preview in a player instead of the code editor. */
function mediaKind(rel: string): "image" | "audio" | "video" | null {
  const ext = rel.toLowerCase().split(".").pop() || "";
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext)) return "image";
  if (/^(wav|mp3|ogg|m4a|aac|flac|opus)$/.test(ext)) return "audio";
  if (/^(mp4|webm|mov|m4v|ogv|mkv)$/.test(ext)) return "video";
  return null;
}

// ── Icons ───────────────────────────────────────────────────
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const CODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const VSCODE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const KEBAB = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`;
const EXPORT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const iconBtn = (icon: string, title: string) =>
  el("button", { class: "skill-icon-btn", html: icon, attrs: { title } });

export interface SkillContentDeps {
  confirm: (msg: string) => Promise<boolean>;
  onChanged: () => void;   // refresh the tree (after create/delete)
  onSelectSkill: (name: string) => void; // re-select after create
  /** Hand a composed build-prompt to the yo agent (closes the slide + fills input). */
  buildWithAgent: (prompt: string) => void;
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
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: name }));
    if (!hasBridge() || !yo) { this.mdHost.innerHTML = `<div class="skill-content-empty">Open inside the app.</div>`; return; }

    // Enabled state lives in yo preferences (NOT SKILL.md → keeps it Claude-spec-valid).
    const disabled = (await yo.getPreference<string[]>("skillsDisabled", [])) || [];
    const cb = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = !disabled.includes(name);
    cb.addEventListener("change", () => void this.setEnabled(name, cb.checked));
    const toggle = el("label", { class: "skill-toggle", attrs: { title: "Enabled" } }, [
      cb, el("span", { class: "skill-toggle-track" }, [el("span", { class: "skill-toggle-thumb" })]),
    ]);
    const kebab = iconBtn(KEBAB, "More");
    kebab.addEventListener("click", (e) => { e.stopPropagation(); this.openSkillMenu(name, kebab); });
    this.bar.append(el("div", { class: "skill-content-actions" }, [toggle, kebab]));

    const full = await yo.skillsGet(name).catch(() => null);
    const desc = (full?.manifest?.description as string) || "";
    const sched = full?.manifest?.schedule as string | undefined;
    const trigger = sched ? `Scheduled · ${escapeHtml(sched)}` : "Manual";
    const body = full?.prompt || "";

    this.mdHost.innerHTML =
      `<div class="skill-meta">Added by <strong>You</strong> · ${trigger}</div>` +
      `<div class="skill-desc-block"><div class="skill-desc-label">Description` +
      `<span class="skill-desc-help" title="The .Yo agent reads this description to decide when to use the skill during chat. Make it clear and specific.">?</span></div>` +
      `<p class="skill-desc-text">${desc ? escapeHtml(desc) : "<em>No description.</em>"}</p></div>` +
      `<hr class="skill-divider"/>` +
      renderMarkdown(body);
  }

  private async setEnabled(name: string, on: boolean): Promise<void> {
    if (!yo) return;
    const cur = (await yo.getPreference<string[]>("skillsDisabled", [])) || [];
    const next = on ? cur.filter((n) => n !== name) : Array.from(new Set([...cur, name]));
    yo.setPreference("skillsDisabled", next);
  }

  private openSkillMenu(name: string, anchor: HTMLElement): void {
    document.querySelector(".skill-kebab-menu")?.remove();
    const item = (icon: string, label: string, danger: boolean, onClick: () => void) => {
      const b = el("button", { class: `ws-popover-item${danger ? " danger" : ""}` }, [
        el("span", { class: "skill-menu-icon", html: icon }), el("span", { text: label }),
      ]);
      b.addEventListener("click", () => { menu.remove(); onClick(); });
      return b;
    };
    const menu = el("div", { class: "ws-popover skill-kebab-menu open" }, [
      item(PLAY, "Run", false, () => { this.hideAll(); this.runConsole.root.classList.remove("hidden"); void this.runConsole.run(name); }),
      item(VSCODE, "Open in VS Code", false, () => { if (yo) void yo.skillsOpenInEditor(name); }),
      item(EXPORT, "Export", false, () => void this.exportSkill(name)),
      item(TRASH, "Delete", true, async () => {
        if (!(await this.deps.confirm(`Delete skill "${name}"?`)) || !yo) return;
        try { await yo.skillsRemove(name); } catch { /* best-effort */ }
        this.deps.onChanged(); this.showEmpty();
      }),
    ]);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - 200)}px`;
    const close = () => { menu.remove(); document.removeEventListener("click", close); };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  private async exportSkill(name: string): Promise<void> {
    if (!yo) return;
    const b64 = await yo.skillsExport(name).catch(() => null);
    if (!b64) return;
    const a = document.createElement("a");
    a.href = `data:application/octet-stream;base64,${b64}`;
    a.download = `${name}.yo`;
    a.click();
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

    // per-file view↔source toggle (single button; markdown files only)
    const toggleBtn = el("button", { class: "skill-icon-btn skill-md-toggle", html: CODE, attrs: { title: "View source" } });
    toggleBtn.addEventListener("click", () => {
      const cur = this.mdMode.get(key) || "rendered";
      this.mdMode.set(key, cur === "rendered" ? "code" : "rendered");
      void this.renderFile(name, rel);
    });

    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-filename", text: rel }));
    const actions = el("div", { class: "skill-content-actions" }, [copy, openFile]);
    if (md) actions.prepend(toggleBtn);
    this.bar.append(actions);

    await this.renderFile(name, rel);
  }

  private async renderFile(name: string, rel: string): Promise<void> {
    // Media files (audio/video/images) preview in a player, not Monaco.
    const media = mediaKind(rel);
    if (media) {
      this.hideAll();
      this.mdHost.classList.remove("hidden");
      this.mdHost.innerHTML = "";
      const src = (hasBridge() && yo) ? await yo.skillsFileUrl(name, rel).catch(() => "") : "";
      if (!src) { this.mdHost.innerHTML = `<div class="skill-content-empty">Preview unavailable.</div>`; return; }
      const node = media === "image" ? el("img", { class: "skill-media skill-media-img", attrs: { src } })
        : media === "audio" ? el("audio", { class: "skill-media skill-media-audio", attrs: { src, controls: "" } })
        : el("video", { class: "skill-media skill-media-video", attrs: { src, controls: "" } });
      this.mdHost.append(el("div", { class: "skill-media-wrap" }, [node]));
      return;
    }
    const key = `${name}/${rel}`;
    if (!this.fileCache.has(key) && yo) this.fileCache.set(key, (await yo.skillsReadFile(name, rel)) || "");
    const text = this.fileCache.get(key) || "";
    const md = isMarkdown(rel);
    const mode = md ? (this.mdMode.get(key) || "rendered") : "code"; // markdown defaults to rendered
    // reflect the single toggle: show the icon for what clicking switches TO.
    const tbtn = this.bar.querySelector<HTMLElement>(".skill-md-toggle");
    if (tbtn) {
      const rendered = mode === "rendered";
      tbtn.innerHTML = rendered ? CODE : EYE;
      tbtn.title = rendered ? "View source" : "View rendered";
      tbtn.classList.toggle("active", !rendered);
    }
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

  // ── Create mode: name + description + instructions → yo agent builds it ──
  showCreate(): void {
    const nameInput = el("input", { class: "settings-input", attrs: { type: "text", placeholder: "skill-name", spellcheck: "false" } }) as HTMLInputElement;
    const descInput = el("input", { class: "settings-input", attrs: { type: "text", placeholder: "Short description", spellcheck: "false" } }) as HTMLInputElement;
    const instrInput = el("textarea", { class: "settings-input skill-create-instr", attrs: { rows: "8", placeholder: "Describe what the skill should do — steps, tools/apps it uses, inputs, outputs. The .Yo agent turns this into a working skill." } }) as HTMLTextAreaElement;
    const err = el("div", { class: "skill-form-error hidden" });
    const build = el("button", { class: "action-btn primary", text: "Build with .Yo" });
    build.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const instr = instrInput.value.trim();
      if (!name) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
      if (!instr) { err.textContent = "Instructions are required."; err.classList.remove("hidden"); return; }
      const desc = descInput.value.trim();
      const prompt =
        `Build a new .Yo skill (not a plain Claude skill) named "${name}".\n` +
        (desc ? `Description: ${desc}\n` : "") +
        `\nInstructions:\n${instr}\n\n` +
        `Create the skill folder under ~/.claude/skills with a SKILL.md, and add a SKILL.js runner if it needs to execute code or call tools. Wire any tools/apps it needs.`;
      this.deps.buildWithAgent(prompt);
    });
    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: "New skill" }));
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.mdHost.innerHTML = "";
    this.mdHost.append(el("div", { class: "skill-create-form" }, [
      el("label", { class: "skill-create-label", text: "Name" }), nameInput,
      el("label", { class: "skill-create-label", text: "Description" }), descInput,
      el("label", { class: "skill-create-label", text: "Instructions" }), instrInput,
      err, el("div", { class: "skill-create-actions" }, [build]),
      el("p", { class: "skill-create-hint", text: "Your instructions go through the .Yo agent loop, which builds the skill for you. You can refine the prompt before sending." }),
    ]));
    nameInput.focus();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
