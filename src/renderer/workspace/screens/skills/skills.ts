/**
 * skills.ts — the Skills screen (first-class workspace feature).
 *
 * Opens from the left-rail "Skills" item as a center slide (the slide header
 * already shows the "Skills" title + green icon, so the screen body has no
 * duplicate heading). Cards reuse the original page's shared classes
 * (.crud-toolbar / .crud-card / .skill-pill / .action-btn) from styles.css so
 * the look & feel matches; only the container layout is ours.
 */

import { el, mount } from "../../lib/dom.js";
import { yo, hasBridge } from "../../lib/bridge.js";
import { paginate, renderPaginationBar } from "../../../help/shared.js";
import { mountSkillViewer } from "./viewer.js";
import type { Screen, WorkspaceCtx } from "../../lib/ctx.js";

/** Lightning glyph — matches the left-rail Skills icon (used for the slide header). */
export const SKILLS_ICON =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

const EDIT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const DELETE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

type SkillRow = {
  name: string; description?: string;
  hasRunner: boolean; hasApp: boolean; scheduled: boolean; scheduleExpr?: string;
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function pills(s: SkillRow): string {
  const out = [s.hasRunner
    ? '<span class="skill-pill skill-pill-js">JS</span>'
    : '<span class="skill-pill skill-pill-prompt">Prompt</span>'];
  if (s.scheduled) out.push(`<span class="skill-pill skill-pill-scheduled" title="${esc(s.scheduleExpr || "")}">Scheduled</span>`);
  return out.join(" ");
}

export const skillsScreen: Screen = {
  id: "skills",
  label: "Skills",

  mount(host: HTMLElement, ctx: WorkspaceCtx) {
    const list = el("div", { class: "crud-cards", attrs: { id: "ws-skills-list" } });
    const search = el("input", {
      class: "crud-search",
      attrs: { type: "text", placeholder: "Search skills…", spellcheck: "false", autocomplete: "off" },
    }) as HTMLInputElement;
    const newBtn = el("button", {
      class: "action-btn primary",
      text: "+ New skill",
      on: { click: () => openViewer(null) },
    });

    // The list view; the viewer replaces it within the same slide body and a
    // back affordance returns here.
    const listView = el("div", { class: "ws-screen skills" }, [
      el("div", { class: "crud-toolbar" }, [search, newBtn]),
      el("div", { class: "ws-screen__body" }, [list]),
    ]);
    const root = el("div", { class: "skills-root" }, [listView]);
    mount(host, root);

    const showList = () => { mount(root, listView); void load(); };
    const openViewer = (name: string | null) => {
      const viewerHost = el("div", { class: "ws-screen skills" });
      mount(root, viewerHost);
      mountSkillViewer(viewerHost, name, showList, () => { void load(); });
    };

    let all: SkillRow[] = [];
    let page = 0;

    const render = () => {
      const q = search.value.trim().toLowerCase();
      const rows = q ? all.filter((s) => s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q)) : all;
      if (!all.length) { mount(list, el("div", { class: "crud-empty", text: 'No skills yet. Click "+ New skill" to create one.' })); return; }
      if (!rows.length) { mount(list, el("div", { class: "crud-empty", text: `No skills matching "${q}"` })); return; }
      const { items, state } = paginate(rows, page);
      page = state.page;
      list.innerHTML = "";
      for (const s of items) list.append(card(s));
      list.append(renderPaginationBar(state, (p: number) => { page = p; render(); }));
    };

    const card = (s: SkillRow): HTMLElement => {
      const c = el("div", { class: "crud-card" });
      c.innerHTML = `
        <div class="crud-card-info">
          <span class="crud-card-name">${esc(s.name)} ${pills(s)}</span>
          ${s.description ? `<span class="crud-card-meta">${esc(s.description)}</span>` : ""}
        </div>
        <div class="crud-card-actions">
          <button class="crud-card-btn crud-edit-btn" title="Edit">${EDIT_SVG}</button>
          <button class="crud-card-btn danger crud-delete-btn" title="Delete">${DELETE_SVG}</button>
        </div>`;
      c.addEventListener("click", () => openViewer(s.name));
      c.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
        e.stopPropagation();
        openViewer(s.name);
      });
      c.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = ctx.wsConfirm ? await ctx.wsConfirm(`Delete skill "${s.name}"?`) : window.confirm(`Delete skill "${s.name}"?`);
        if (!ok || !yo) return;
        try { await yo.skillsRemove(s.name); } catch { /* best-effort */ }
        await load();
      });
      return c;
    };

    const load = async () => {
      if (!hasBridge() || !yo) { mount(list, el("div", { class: "crud-empty", text: "Skills load inside the app." })); return; }
      try { all = await yo.skillsListDetailed(); } catch { all = []; }
      render();
    };

    search.addEventListener("input", () => { page = 0; render(); });
    void load();
  },
};

/**
 * Wire the left-rail "Skills" item to open the screen as a center slide,
 * with the same toggle mechanic as the other rail items (re-click closes).
 */
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
