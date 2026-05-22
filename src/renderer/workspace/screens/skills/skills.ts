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
const SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>`;

export const skillsScreen: Screen = {
  id: "skills",
  label: "Skills",

  mount(host: HTMLElement, ctx: WorkspaceCtx) {
    const content = new SkillContent({
      confirm: (m) => (ctx.wsConfirm ? ctx.wsConfirm(m) : Promise.resolve(window.confirm(m))),
      onChanged: () => void load(),
      onSelectSkill: (name) => { tree.setActive({ skill: name }); void content.showSkill(name); },
    });

    const tree = createSkillTree({
      onSelectSkill: (name) => void content.showSkill(name),
      onSelectFile: (name, rel) => void content.showFile(name, rel),
    });

    // ── Tree panel: search + new + tree ──
    const searchInput = el("input", {
      class: "skill-search-input",
      attrs: { type: "text", placeholder: "Search skills…", spellcheck: "false", autocomplete: "off" },
    }) as HTMLInputElement;
    searchInput.addEventListener("input", () => tree.filter(searchInput.value));
    const newBtn = el("button", { class: "skill-new-btn", html: PLUS, attrs: { title: "New skill" } });
    newBtn.addEventListener("click", () => { tree.setActive(null); content.showCreate(); });

    const treePanel = el("div", { class: "skill-tree-panel" }, [
      el("div", { class: "skill-tree-toolbar" }, [
        el("span", { class: "skill-search", html: SEARCH }, [searchInput]),
        newBtn,
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
    };
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
      onMount: (slideEl: HTMLElement) => {
        const body = slideEl.querySelector<HTMLElement>(".ws-slide-body");
        if (body) skillsScreen.mount(body, ctx);
      },
    });
  });
}
