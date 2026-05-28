/**
 * content.ts — the explorer's right pane (read-only).
 *   • showSkill(name) — overview: name + description + rendered SKILL.md +
 *     actions (Run, Export, Delete) + enabled toggle.
 *   • showFile(name, rel) — markdown renders by default (toggle to source);
 *     code → read-only <pre> block; media → player. Copy.
 *   • showCreate() — minimal new-skill form that hands off to the .Yo agent.
 */

import { el } from "./dom.js";
import { formatMarkdown } from "../../format-markdown.js";
import { RunConsole } from "./run-console.js";

const renderMarkdown = (src: string | null | undefined): string => formatMarkdown(src || "");

const isMarkdown = (f: string) => /\.(md|mdx|markdown)$/i.test(f);

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
const TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const KEBAB = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`;
const EXPORT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

const iconBtn = (icon: string, title: string) =>
  el("button", { class: "skill-icon-btn", html: icon, attrs: { title } });

export interface SkillContentDeps {
  confirm: (msg: string) => Promise<boolean>;
  onChanged: () => void;
  onSelectSkill: (name: string) => void;
  /** Hand a composed build-prompt to the yo agent. */
  buildWithAgent: (prompt: string) => void;
}

export class SkillContent {
  readonly root: HTMLElement;
  private bar: HTMLElement;
  private body: HTMLElement;
  private codeHost: HTMLElement;
  private mdHost: HTMLElement;
  private runConsole = new RunConsole();
  private fileCache = new Map<string, string>();
  private mdMode = new Map<string, "rendered" | "code">();

  constructor(private deps: SkillContentDeps) {
    this.bar = el("div", { class: "skill-content-bar" });
    this.codeHost = el("pre", { class: "skill-code hidden" });
    this.mdHost = el("div", { class: "skill-md-render yo-md hidden" });
    this.runConsole.root.classList.add("hidden");
    this.body = el("div", { class: "skill-content-body" }, [this.mdHost, this.codeHost, this.runConsole.root]);
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
    this.codeHost.classList.add("hidden");
    this.runConsole.root.classList.add("hidden");
  }

  // ── Skill overview ──
  async showSkill(name: string): Promise<void> {
    this.hideAll();
    this.mdHost.classList.remove("hidden");
    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-title", text: name }));

    const disabled = (await window.yo.getPreference("skillsDisabled", [])) as string[] || [];
    const cb = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = !disabled.includes(name);
    cb.addEventListener("change", () => void this.setEnabled(name, cb.checked));
    const toggle = el("label", { class: "skill-toggle", attrs: { title: "Enabled" } }, [
      cb, el("span", { class: "skill-toggle-track" }, [el("span", { class: "skill-toggle-thumb" })]),
    ]);
    const kebab = iconBtn(KEBAB, "More");
    kebab.addEventListener("click", (e) => { e.stopPropagation(); this.openSkillMenu(name, kebab); });
    this.bar.append(el("div", { class: "skill-content-actions" }, [toggle, kebab]));

    const full = await window.yo.skillsGet(name).catch(() => null);
    const desc = (full?.manifest?.description as string) || "";
    const sched = full?.manifest?.schedule as string | undefined;
    const trigger = sched ? `Scheduled · ${escapeHtml(sched)}` : "Manual";
    const body = full?.prompt || "";

    this.mdHost.innerHTML =
      `<div class="skill-meta-grid">` +
        `<div class="skill-meta-col"><div class="skill-meta-h">Added by</div><div class="skill-meta-v">You</div></div>` +
        `<div class="skill-meta-col"><div class="skill-meta-h">Trigger</div><div class="skill-meta-v">${trigger}</div></div>` +
      `</div>` +
      `<div class="skill-desc-block"><div class="skill-desc-label">Description` +
        `<button class="skill-desc-help" type="button" aria-label="About description">${INFO}</button>` +
        `<span class="skill-desc-tip hidden">.Yo uses this to help pick the right tool during chat</span>` +
      `</div>` +
      `<p class="skill-desc-text">${desc ? escapeHtml(desc) : "<em>No description.</em>"}</p></div>` +
      `<hr class="skill-divider"/>` +
      renderMarkdown(body);

    const help = this.mdHost.querySelector<HTMLElement>(".skill-desc-help");
    const tip = this.mdHost.querySelector<HTMLElement>(".skill-desc-tip");
    help?.addEventListener("click", (e) => { e.stopPropagation(); tip?.classList.toggle("hidden"); });
  }

  private async setEnabled(name: string, on: boolean): Promise<void> {
    const cur = (await window.yo.getPreference("skillsDisabled", [])) as string[] || [];
    const next = on ? cur.filter((n) => n !== name) : Array.from(new Set([...cur, name]));
    window.yo.setPreference("skillsDisabled", next);
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
      item(EXPORT, "Export", false, () => void this.exportSkill(name)),
      item(TRASH, "Delete", true, async () => {
        if (!(await this.deps.confirm(`Delete skill "${name}"?`))) return;
        try { await window.yo.skillsRemove(name); } catch { /* best-effort */ }
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
    const b64 = await window.yo.skillsExport(name).catch(() => null);
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
      window.yo.copyToClipboard(this.fileCache.get(key) || "");
      copy.innerHTML = CHECK; setTimeout(() => { copy.innerHTML = COPY; }, 1200);
    });

    const toggleBtn = el("button", { class: "skill-icon-btn skill-md-toggle", html: CODE, attrs: { title: "View source" } });
    toggleBtn.addEventListener("click", () => {
      const cur = this.mdMode.get(key) || "rendered";
      this.mdMode.set(key, cur === "rendered" ? "code" : "rendered");
      void this.renderFile(name, rel);
    });

    this.bar.innerHTML = "";
    this.bar.append(el("span", { class: "skill-content-filename", text: rel }));
    const actions = el("div", { class: "skill-content-actions" }, [copy]);
    if (md) actions.prepend(toggleBtn);
    this.bar.append(actions);

    await this.renderFile(name, rel);
  }

  private async renderFile(name: string, rel: string): Promise<void> {
    const media = mediaKind(rel);
    if (media) {
      this.hideAll();
      this.mdHost.classList.remove("hidden");
      this.mdHost.innerHTML = "";
      const src = await window.yo.skillsFileUrl(name, rel).catch(() => "");
      if (!src) { this.mdHost.innerHTML = `<div class="skill-content-empty">Preview unavailable.</div>`; return; }
      const node = media === "image" ? el("img", { class: "skill-media skill-media-img", attrs: { src } })
        : media === "audio" ? el("audio", { class: "skill-media skill-media-audio", attrs: { src, controls: "" } })
        : el("video", { class: "skill-media skill-media-video", attrs: { src, controls: "" } });
      this.mdHost.append(el("div", { class: "skill-media-wrap" }, [node]));
      return;
    }
    const key = `${name}/${rel}`;
    if (!this.fileCache.has(key)) this.fileCache.set(key, (await window.yo.skillsReadFile(name, rel)) || "");
    const text = this.fileCache.get(key) || "";
    const md = isMarkdown(rel);
    const mode = md ? (this.mdMode.get(key) || "rendered") : "code";
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
      this.codeHost.classList.remove("hidden");
      this.codeHost.textContent = text;
    }
  }

  relayout(): void { /* no-op — plain <pre> needs no layout */ }

  // ── Create mode ──
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
