/**
 * skills.ts — the Skills screen, rebuilt as a FILE EXPLORER.
 *
 * Layout (full height): tree panel (search + new + skill tree) · draggable
 * divider · content pane. Each skill is a top-level folder; expanding shows
 * its files. Selecting a skill shows its overview (name + description +
 * rendered SKILL.md); selecting a file opens it (markdown rendered by default,
 * else read-only Monaco). Opens from the left-rail "Skills" item as a slide.
 */

import { el, mount } from "../../lib/dom.js";
import { yo, hasBridge } from "../../lib/bridge.js";
import { createSkillTree, type SkillMeta } from "./tree.js";
import { SkillContent } from "./content.js";
import type { Screen, WorkspaceCtx } from "../../lib/ctx.js";

/** Lightning glyph — matches the left-rail Skills icon (slide header). */
export const SKILLS_ICON =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

const PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const MENU_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const MENU_UPLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>`;

export const skillsScreen: Screen = {
  id: "skills",
  label: "Skills",

  mount(host: HTMLElement, ctx: WorkspaceCtx) {
    const content = new SkillContent({
      confirm: (m) => (ctx.wsConfirm ? ctx.wsConfirm(m) : Promise.resolve(window.confirm(m))),
      onChanged: () => void load(),
      onSelectSkill: (name) => { tree.setActive({ skill: name }); void content.showSkill(name); },
      buildWithAgent: (prompt) => handToAgent(prompt),
    });

    // Close the Skills slide and drop a build prompt into the yo agent input.
    function handToAgent(prompt: string): void {
      ctx.clearStack?.();
      const input = document.getElementById("yo-panel-input") as HTMLTextAreaElement | null;
      if (!input) return;
      input.value = prompt;
      input.dispatchEvent(new Event("input", { bubbles: true })); // trigger autogrow
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    const saveLastSelected = (name: string) => { if (hasBridge() && yo) yo.setPreference("skillsLastSelected", name); };
    const tree = createSkillTree({
      onSelectSkill: (name) => { saveLastSelected(name); void content.showSkill(name); },
      onSelectFile: (name, rel) => void content.showFile(name, rel),
    });

    // ── Tree panel: search + new + tree ──
    const searchInput = el("input", {
      class: "skill-search-input",
      attrs: { type: "text", placeholder: "Search skills…", spellcheck: "false", autocomplete: "off" },
    }) as HTMLInputElement;
    searchInput.addEventListener("input", () => tree.filter(searchInput.value));
    const newBtn = el("button", { class: "skill-new-btn", html: PLUS, attrs: { title: "New skill" } });
    newBtn.addEventListener("click", (e) => { e.stopPropagation(); openCreateMenu(newBtn); });

    const treePanel = el("div", { class: "skill-tree-panel" }, [
      el("div", { class: "skill-tree-toolbar" }, [
        el("span", { class: "skill-tree-title", text: "Skills" }),
        newBtn,
      ]),
      el("div", { class: "skill-tree-searchrow" }, [
        el("span", { class: "skill-search", html: SEARCH }, [searchInput]),
      ]),
      el("div", { class: "skill-tree-scroll" }, [tree.el]),
    ]);

    const divider = el("div", { class: "skill-explorer-divider", attrs: { title: "Drag to resize" } });
    const root = el("div", { class: "ws-screen skills skills-explorer" }, [treePanel, divider, content.root]);
    mount(host, root);
    wireDivider(divider, treePanel, () => content.relayout());

    const load = async () => {
      let skills: SkillMeta[] = [];
      if (hasBridge() && yo) { try { skills = await yo.skillsListDetailed(); } catch { skills = []; } }
      tree.setSkills(skills);
      // Open to the last-selected skill (persisted) or default to the first,
      // with its folder row selected.
      if (!skills.length) { content.showEmpty(); return; }
      let last = "";
      if (hasBridge() && yo) { try { last = await yo.getPreference<string>("skillsLastSelected", ""); } catch { last = ""; } }
      const pick = skills.find((s) => s.name === last) || skills[0];
      tree.setActive({ skill: pick.name });
      void content.showSkill(pick.name);
    };

    // ── "+" create menu ──
    let menu: HTMLElement | null = null;
    function closeMenu(): void { menu?.remove(); menu = null; document.removeEventListener("click", closeMenu); }
    function openCreateMenu(anchor: HTMLElement): void {
      if (menu) { closeMenu(); return; }
      const item = (icon: string, label: string, onClick: () => void) => {
        const b = el("button", { class: "ws-popover-item skill-menu-item" }, [
          el("span", { class: "skill-menu-icon", html: icon }),
          el("span", { class: "skill-menu-label", text: label }),
        ]);
        b.addEventListener("click", () => { closeMenu(); onClick(); });
        return b;
      };
      menu = el("div", { class: "ws-popover skill-create-menu open" }, [
        item(SKILLS_ICON, "Create with .Yo", () => handToAgent("Create a new .Yo skill that ")),
        item(MENU_EDIT, "Write instructions", () => { tree.setActive(null); content.showCreate(); }),
        item(MENU_UPLOAD, "Upload a skill", () => uploadSkill()),
      ]);
      document.body.append(menu);
      const r = anchor.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
      setTimeout(() => document.addEventListener("click", closeMenu), 0);
    }

    // ── Upload modal (dropzone + picker) ──
    function uploadSkill(): void {
      const status = el("div", { class: "skill-upload-status" });
      const fileInput = el("input", { attrs: { type: "file", accept: ".yo,.zip" } }) as HTMLInputElement;
      fileInput.style.display = "none";
      const drop = el("div", { class: "skill-upload-drop" }, [
        el("div", { class: "skill-upload-drop-title", text: "Drop a skill bundle here" }),
        el("div", { class: "skill-upload-drop-sub", text: "or click to choose a file" }),
      ]);
      const box = el("div", { class: "skill-upload-box" }, [
        el("div", { class: "skill-upload-head", text: "Upload a skill" }),
        drop, fileInput,
        el("ul", { class: "skill-upload-reqs" }, [
          el("li", { text: "A .yo or .zip bundle." }),
          el("li", { text: "Must contain a SKILL.md (name + description front-matter)." }),
          el("li", { text: "May include SKILL.js and supporting files." }),
        ]),
        status,
        el("div", { class: "skill-upload-actions" }, [
          (() => { const c = el("button", { class: "action-btn", text: "Cancel" }); c.addEventListener("click", close); return c; })(),
        ]),
      ]);
      const overlay = el("div", { class: "skill-upload-overlay" }, [box]);
      function close(): void { overlay.remove(); }
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      drop.addEventListener("click", () => fileInput.click());
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e: DragEvent) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer?.files[0]) void handleFile(e.dataTransfer.files[0]); });
      fileInput.addEventListener("change", () => { if (fileInput.files?.[0]) void handleFile(fileInput.files[0]); });
      async function handleFile(file: File): Promise<void> {
        if (!hasBridge() || !yo) { status.textContent = "Importing requires the app."; return; }
        status.textContent = "Importing…";
        const base64 = await new Promise<string>((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(",")[1] || "");
          fr.readAsDataURL(file);
        });
        const r = await yo.skillsImport(base64, false).catch(() => ({ imported: [], skipped: [], error: "import failed" }));
        if (r.error) { status.textContent = r.error; return; }
        close();
        await load();
      }
      document.body.append(overlay);
    }

    void load();
  },
};

function wireDivider(divider: HTMLElement, panel: HTMLElement, onResize: () => void): void {
  divider.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    divider.classList.add("dragging");
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(180, Math.min(480, startW + (ev.clientX - startX)));
      panel.style.width = `${w}px`;
      onResize();
    };
    const onUp = () => {
      divider.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** Wire the left-rail "Skills" item to open the screen as a slide (toggle). */
export function initSkills(ctx: WorkspaceCtx): void {
  const btn = document.getElementById("open-skills");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const stack = ctx.slideStack || [];
    const top = stack[stack.length - 1];
    if (top && top.app && top.app.id === "__skills") { ctx.popSlide?.(); return; }
    ctx.pushSlide?.({
      id: "__skills",
      name: "Skills",
      iconSvg: SKILLS_ICON,
      chromeless: true,
      onMount: (slideEl: HTMLElement) => {
        const body = slideEl.querySelector<HTMLElement>(".ws-slide-body");
        if (body) skillsScreen.mount(body, ctx);
      },
    });
  });
}
