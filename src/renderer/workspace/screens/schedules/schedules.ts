/**
 * schedules.ts — the Scheduled tasks screen.
 *
 * A scheduled task is a skill that runs on a cadence (or on demand). Tasks are
 * tracked in the `scheduledTasks` preference (array of skill names) so a Manual
 * task shows up even with no cron. Each task's manifest holds its description,
 * cron `schedule`, `model`, frequency label and ask-mode; the prompt holds the
 * instructions. Enable/disable maps to the scheduler's pause/resume.
 *
 * Opens from the left-rail "Schedules" item as a slide (toggle).
 */

import { el, mount } from "../../lib/dom.js";
import { yo, hasBridge } from "../../lib/bridge.js";
import type { Screen, WorkspaceCtx } from "../../lib/ctx.js";

/** Clock glyph — matches the left-rail Schedules icon (slide header). */
export const SCHEDULES_ICON =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;

const CLOCK_LG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const PLAY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8.5 12 11 14.5 15.5 9.5"/></svg>`;
const INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/></svg>`;
const X_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>`;
const SORT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v16M8 4l-3 3M8 4l3 3"/><path d="M16 20V4M16 20l-3-3M16 20l3 3"/></svg>`;
const CARET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

/** Frequency presets. `hasTime` controls whether the time picker applies. */
const FREQUENCIES: Array<{ value: string; label: string; hasTime: boolean }> = [
  { value: "manual",   label: "Manual",   hasTime: false },
  { value: "hourly",   label: "Hourly",   hasTime: false },
  { value: "daily",    label: "Daily",    hasTime: true },
  { value: "weekdays", label: "Weekdays", hasTime: true },
  { value: "weekly",   label: "Weekly",   hasTime: true },
  { value: "monthly",  label: "Monthly",  hasTime: true },
];
const ASK_MODES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Run automatically" },
  { value: "ask",  label: "Ask before running" },
];

const pad = (n: number | string) => String(n).padStart(2, "0");

/** Build a cron expression from a frequency value + "HH:MM" (24h) time. */
function buildCron(freq: string, time: string): string {
  const [h, m] = (time || "09:00").split(":").map((x) => parseInt(x, 10) || 0);
  switch (freq) {
    case "hourly":   return "0 * * * *";
    case "daily":    return `${m} ${h} * * *`;
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekly":   return `${m} ${h} * * 1`;
    case "monthly":  return `${m} ${h} 1 * *`;
    default:         return ""; // manual
  }
}

/** Reverse a cron expression back into a frequency value + "HH:MM" time. */
function parseCron(cron: string | undefined): { freq: string; time: string } {
  if (!cron) return { freq: "manual", time: "09:00" };
  const p = cron.trim().split(/\s+/);
  if (p.length < 5) return { freq: "manual", time: "09:00" };
  const [min, hour, dom, , dow] = p;
  if (hour === "*") return { freq: "hourly", time: "09:00" };
  const time = `${pad(hour)}:${pad(min)}`;
  if (dom === "1") return { freq: "monthly", time };
  if (dow === "1-5") return { freq: "weekdays", time };
  if (dow === "1") return { freq: "weekly", time };
  return { freq: "daily", time };
}

/** Compact relative time like "2h ago" / "just now" from an epoch ms. */
function relTime(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Human "9:00 AM" from "HH:MM" (24h). */
function fmtTime(time: string): string {
  const [h, m] = (time || "09:00").split(":").map((x) => parseInt(x, 10) || 0);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ampm}`;
}

/** Display label like "Manual", "Hourly", "Daily at 9:00 AM". */
function scheduleLabel(cron: string | undefined): string {
  const { freq, time } = parseCron(cron);
  const f = FREQUENCIES.find((x) => x.value === freq);
  if (!f) return "Manual";
  return f.hasTime ? `${f.label} at ${fmtTime(time)}` : f.label;
}

interface TaskRow {
  name: string;
  description: string;
  cron: string;
  scheduleLabel: string;
  model: string;
  ask: string;
  prompt: string;
  paused: boolean;
}

// Cross-module navigation: the live mount registers a handle so the rail /
// chat run-markers can jump straight to a task's detail; `pendingDetailName`
// covers the case where the slide isn't mounted yet.
let activeOpenByName: ((name: string) => void) | null = null;
let pendingDetailName: string | null = null;

export const schedulesScreen: Screen = {
  id: "schedules",
  label: "Scheduled tasks",

  mount(host: HTMLElement, ctx: WorkspaceCtx) {
    const confirm = (m: string) =>
      ctx.wsConfirm ? ctx.wsConfirm(m, { yes: "Delete", no: "Cancel" }) : Promise.resolve(window.confirm(m));

    // ── In-page header: title + subtitle + actions (sort · search · New task) ──
    const searchInput = el("input", {
      class: "sched-search-input",
      attrs: { type: "text", placeholder: "Search tasks…", spellcheck: "false", autocomplete: "off" },
    }) as HTMLInputElement;
    const searchRow = el("div", { class: "sched-searchrow", attrs: { style: "display:none" } }, [
      el("span", { class: "sched-search-wrap", html: SEARCH }, [searchInput]),
    ]);
    let sortMode: "recent" | "name" = "recent";
    const sortBtn = el("button", { class: "sched-icon-btn", html: SORT, attrs: { title: "Sort", "aria-label": "Sort" } });
    const searchBtn = el("button", { class: "sched-icon-btn", html: SEARCH, attrs: { title: "Search", "aria-label": "Search" } });
    const newBtn = el("button", { class: "ws-btn primary sched-new-btn", html: `${PLUS}<span>New task</span>${CARET}` });

    const header = el("div", { class: "sched-header" }, [
      el("div", { class: "sched-head-text" }, [
        el("h1", { class: "sched-title", text: "Scheduled tasks" }),
        el("p", { class: "sched-subtitle", text: "Run tasks on a schedule or whenever you need them. Type /schedule in any existing task to set one up." }),
      ]),
      el("div", { class: "sched-head-actions" }, [sortBtn, searchBtn, newBtn]),
    ]);
    sortBtn.addEventListener("click", () => { sortMode = sortMode === "recent" ? "name" : "recent"; render(); });
    searchBtn.addEventListener("click", () => {
      const open = searchRow.style.display === "none";
      searchRow.style.display = open ? "" : "none";
      if (open) searchInput.focus(); else { searchInput.value = ""; render(); }
    });

    // ── Info banner + keep-awake ──
    const keepAwake = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
    const banner = el("div", { class: "sched-banner" }, [
      el("span", { class: "sched-banner-icon", html: INFO }),
      el("span", { class: "sched-banner-text", text: "Scheduled tasks only run while your computer is awake." }),
      el("label", { class: "skill-toggle sched-awake" }, [
        keepAwake,
        el("span", { class: "skill-toggle-track" }, [el("span", { class: "skill-toggle-thumb" })]),
        el("span", { class: "sched-awake-label", text: "Keep awake" }),
      ]),
    ]);
    if (hasBridge() && yo) {
      void yo.getPreference<boolean>("schedulesKeepAwake", false).then((v) => { keepAwake.checked = !!v; });
    }
    keepAwake.addEventListener("change", () => { if (hasBridge() && yo) yo.setKeepAwake(keepAwake.checked); });

    const listEl = el("div", { class: "sched-list" });

    // "More ideas" — persistent suggestion chips below the list.
    const moreIdeas = el("div", { class: "sched-more" }, [
      el("div", { class: "sched-more-title", text: "More ideas" }),
      el("div", { class: "sched-chips" }, [
        makeChip("Daily brief", "Every weekday at 9am", "Summarize my unread email and today's calendar into a short morning brief."),
        makeChip("Weekly review", "Fridays at 5pm", "Compile what I shipped this week into a concise review with highlights and open items."),
      ]),
    ]);

    // Two views inside the screen: the task list and a single-task detail page.
    const listView = el("div", { class: "sched-view-list" }, [header, searchRow, banner, listEl, moreIdeas]);
    const detailHost = el("div", { class: "sched-view-detail", attrs: { style: "display:none" } });
    const root = el("div", { class: "ws-screen schedules" }, [listView, detailHost]);
    mount(host, root);

    function showList(): void {
      detailHost.style.display = "none";
      detailHost.innerHTML = "";
      listView.style.display = "";
      void load();
    }

    // ── Data ──
    let tasks: TaskRow[] = [];

    async function load(): Promise<void> {
      tasks = [];
      if (!hasBridge() || !yo) { render(); return; }
      let names: string[] = [];
      try { names = await yo.getPreference<string[]>("scheduledTasks", []); } catch { names = []; }
      let status: Array<{ name: string; schedule: string; paused: boolean }> = [];
      try { status = await yo.skillsScheduleStatus(); } catch { status = []; }
      const pausedByName = new Map(status.map((s) => [s.name, s.paused]));
      for (const name of names) {
        try {
          const s = await yo.skillsGet(name);
          if (!s) continue;
          const m = s.manifest as Record<string, unknown>;
          const cron = (m.schedule as string) || "";
          tasks.push({
            name,
            description: (m.description as string) || "",
            cron,
            scheduleLabel: scheduleLabel(cron),
            model: (m.model as string) || "",
            ask: (m.ask as string) || "auto",
            prompt: s.prompt || "",
            paused: pausedByName.get(name) ?? false,
          });
        } catch { /* skip missing */ }
      }
      render();
    }

    function makeChip(label: string, desc: string, instructions: string): HTMLElement {
      const c = el("button", { class: "sched-chip" }, [
        el("span", { class: "sched-chip-label", text: label }),
        el("span", { class: "sched-chip-desc", text: desc }),
      ]);
      c.addEventListener("click", () => openModal({ name: label, description: desc, prompt: instructions }));
      return c;
    }

    function render(): void {
      const q = searchInput.value.trim().toLowerCase();
      let shown = q
        ? tasks.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        : tasks.slice();
      if (sortMode === "name") shown = shown.sort((a, b) => a.name.localeCompare(b.name));
      listEl.innerHTML = "";

      // "More ideas" is hidden when there are no tasks (the empty state has its own chips).
      moreIdeas.style.display = tasks.length ? "" : "none";

      if (!tasks.length) { listEl.appendChild(emptyState()); return; }
      if (!shown.length) {
        listEl.appendChild(el("div", { class: "sched-empty-search", text: "No tasks match your search." }));
        return;
      }
      for (const t of shown) listEl.appendChild(taskCard(t));
    }

    function emptyState(): HTMLElement {
      return el("div", { class: "sched-empty" }, [
        el("div", { class: "sched-empty-icon", html: CLOCK_LG }),
        el("div", { class: "sched-empty-title", text: "Create your first scheduled task" }),
        el("div", { class: "sched-empty-sub", text: "Pick a skill or write instructions, choose how often it runs, and .Yo handles the rest." }),
        el("div", { class: "sched-chips" }, [
          makeChip("Daily brief", "Every weekday at 9am", "Summarize my unread email and today's calendar into a short morning brief."),
          makeChip("Weekly review", "Fridays at 5pm", "Compile what I shipped this week into a concise review with highlights and open items."),
        ]),
      ]);
    }

    function taskCard(t: TaskRow): HTMLElement {
      // Enable toggle (maps to scheduler pause/resume)
      const toggle = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
      toggle.checked = !t.paused;
      toggle.disabled = !t.cron; // Manual tasks have no schedule to enable
      toggle.addEventListener("change", async () => {
        if (!hasBridge() || !yo) return;
        try {
          if (toggle.checked) await yo.skillsResumeSchedule(t.name);
          else await yo.skillsPauseSchedule(t.name);
          t.paused = !toggle.checked;
        } catch { toggle.checked = !toggle.checked; }
      });

      const actionBtn = (icon: string, label: string, onClick: () => void, danger = false) => {
        const b = el("button", {
          class: "sched-action" + (danger ? " danger" : ""),
          html: icon,
          attrs: { title: label, "aria-label": label },
        });
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return b;
      };

      const meta = el("div", { class: "sched-card-meta" }, [
        el("span", { class: "sched-badge sched-badge-freq", text: t.scheduleLabel }),
        ...(t.model ? [el("span", { class: "sched-badge sched-badge-model", text: prettyModel(t.model) })] : []),
        el("span", { class: "sched-badge sched-badge-ask", text: t.ask === "ask" ? "Asks first" : "Automatic" }),
      ]);

      const title = el("div", { class: "sched-card-title", text: t.name });
      const main = el("div", { class: "sched-card-main" }, [
        title,
        ...(t.description ? [el("div", { class: "sched-card-desc", text: t.description })] : []),
        meta,
      ]);
      main.addEventListener("click", () => openDetail(t)); // clicking the card body opens its page

      return el("div", { class: "sched-card" }, [
        main,
        el("div", { class: "sched-card-side" }, [
          el("label", { class: "skill-toggle" }, [
            toggle,
            el("span", { class: "skill-toggle-track" }, [el("span", { class: "skill-toggle-thumb" })]),
          ]),
          el("div", { class: "sched-actions" }, [
            actionBtn(PLAY, "Run now", () => void runNow(t)),
            actionBtn(EDIT, "Edit", () => openDetail(t)),
            actionBtn(TRASH, "Delete", () => void removeTask(t), true),
          ]),
        ]),
      ]);
    }

    async function runNow(t: TaskRow): Promise<void> {
      if (!hasBridge() || !yo) return;
      // Snapshot existing runs so "View" opens THIS run, not the previous one
      // (the new run only persists once skillsRun resolves).
      const before = new Set((await yo.runsList(t.name)).map((r) => r.id));
      const p = yo.skillsRun(t.name, undefined);
      showToast(`Scheduled task "${t.name}" started.`, "View", () => void viewFreshRun(t, before, p));
      try { await p; } catch { /* surfaced in activity */ }
    }

    /** Open the run produced by `p` — wait for it, then pick the new run id. */
    async function viewFreshRun(t: TaskRow, before: Set<string>, p: Promise<unknown>): Promise<void> {
      if (!hasBridge() || !yo) return;
      await p.catch(() => {});
      const runs = await yo.runsList(t.name);
      const fresh = runs.find((r) => !before.has(r.id)) || runs[0];
      if (fresh) openRunInAgent(fresh.id);
    }
    async function removeTask(t: TaskRow): Promise<void> {
      const ok = await confirm(`Delete the scheduled task "${t.name}"? This removes the skill too.`);
      if (!ok || !hasBridge() || !yo) return;
      try { await yo.skillsRemove(t.name); } catch { /* ignore */ }
      const names = (await yo.getPreference<string[]>("scheduledTasks", [])).filter((n) => n !== t.name);
      yo.setPreference("scheduledTasks", names);
      window.dispatchEvent(new Event("scheduled-tasks-changed"));
      void load();
    }

    // ── Detail page (read-only view; edit happens via the modal) ──
    function openDetail(t: TaskRow): void {
      listView.style.display = "none";
      detailHost.style.display = "";
      detailHost.innerHTML = "";

      const statusActive = !!t.cron && !t.paused;
      const statusBadge = el("span", {
        class: "sched-badge sched-detail-status " + (t.cron ? (statusActive ? "is-active" : "is-paused") : "is-manual"),
        html: `${CLOCK_LG}<span>${t.cron ? (statusActive ? "Active" : "Paused") : "Manual only"}</span>`,
      });

      // Header: back link + title + actions
      const backLink = el("button", { class: "sched-back", html: `${BACK}<span>All scheduled tasks</span>` });
      backLink.addEventListener("click", showList);

      const editBtn = el("button", { class: "sched-action", html: EDIT, attrs: { title: "Edit", "aria-label": "Edit" } });
      editBtn.addEventListener("click", () => openModal(t, async () => {
        await load();
        const fresh = tasks.find((x) => x.name === t.name);
        if (fresh) openDetail(fresh); else showList();
      }));
      const delBtn = el("button", { class: "sched-action danger", html: TRASH, attrs: { title: "Delete", "aria-label": "Delete" } });
      delBtn.addEventListener("click", () => { void removeTask(t); /* removeTask returns to list */ });

      const runBtn = el("button", { class: "ws-btn primary sched-detail-run", html: `${PLAY}<span>Run now</span>` });
      runBtn.addEventListener("click", () => void runFromDetail());

      const historyCol = el("div", { class: "sched-detail-col" }, [
        el("div", { class: "sched-detail-h", text: "History" }),
        el("div", { class: "sched-history", text: "Loading…" }),
      ]);
      const historyHost = historyCol.querySelector(".sched-history") as HTMLElement;
      void loadHistory(t, historyHost);

      async function runFromDetail(): Promise<void> {
        if (!hasBridge() || !yo) return;
        runBtn.setAttribute("disabled", "1");
        runBtn.innerHTML = `<span class="sched-spin"></span><span>Starting…</span>`;
        const before = new Set((await yo.runsList(t.name)).map((r) => r.id));
        const p = yo.skillsRun(t.name, undefined);
        showToast(`Scheduled task "${t.name}" started.`, "View", () => void viewFreshRun(t, before, p));
        try { await p; } catch { /* failure shows in Activity */ }
        runBtn.removeAttribute("disabled");
        runBtn.innerHTML = `${PLAY}<span>Run now</span>`;
        void loadHistory(t, historyHost); // the new run now appears
      }

      const askLabel = ASK_MODES.find((a) => a.value === t.ask)?.label || "Run automatically";
      const detailCol = el("div", { class: "sched-detail-col" }, [
        el("div", { class: "sched-detail-h", text: "Instructions" }),
        el("div", { class: "sched-detail-value sched-detail-instr-text", text: t.prompt || "No instructions yet." }),
        el("div", { class: "sched-detail-h", text: "Repeats" }),
        el("div", { class: "sched-detail-value", text: scheduleLabel(t.cron) }),
        ...(t.model ? [
          el("div", { class: "sched-detail-h", text: "Model" }),
          el("div", { class: "sched-detail-value", text: prettyModel(t.model) }),
        ] : []),
        el("div", { class: "sched-detail-h sched-detail-h-ask", html: `Always allowed ${CHECK}` }),
        el("div", { class: "sched-detail-value", text: askLabel }),
      ]);

      detailHost.append(
        el("div", { class: "sched-detail" }, [
          // Breadcrumb alone at the very top.
          el("div", { class: "sched-detail-top" }, [backLink]),
          // Name + actions share a row; status pill sits under the description.
          el("div", { class: "sched-detail-titlerow" }, [
            el("div", { class: "sched-detail-title", text: t.name }),
            el("div", { class: "sched-detail-actions" }, [editBtn, delBtn, runBtn]),
          ]),
          ...(t.description ? [el("div", { class: "sched-detail-sub", text: t.description })] : []),
          el("div", { class: "sched-detail-status-row" }, [statusBadge]),
          el("div", { class: "sched-detail-grid" }, [historyCol, detailCol]),
        ]),
      );
    }

    // ── Toast (transient bottom/top notification) ──
    function showToast(message: string, actionLabel?: string, onAction?: () => void): void {
      const toast = el("div", { class: "sched-toast" }, [
        el("span", { class: "sched-toast-icon", html: INFO }),
        el("span", { class: "sched-toast-msg", text: message }),
      ]);
      if (actionLabel && onAction) {
        const a = el("button", { class: "sched-toast-action", text: actionLabel });
        a.addEventListener("click", () => { onAction(); dismiss(); });
        toast.appendChild(a);
      }
      const close = el("button", { class: "sched-toast-close", html: X_ICON, attrs: { "aria-label": "Dismiss" } });
      toast.appendChild(close);
      let timer: ReturnType<typeof setTimeout> | undefined;
      function dismiss(): void { clearTimeout(timer); toast.classList.remove("show"); setTimeout(() => toast.remove(), 200); }
      close.addEventListener("click", dismiss);
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add("show"));
      timer = setTimeout(dismiss, 6000);
    }

    async function loadHistory(t: TaskRow, host: HTMLElement): Promise<void> {
      host.innerHTML = "";
      let runs: Array<{ id: string; created: string; trigger: string; ok: boolean }> = [];
      if (hasBridge() && yo) { try { runs = await yo.runsList(t.name); } catch { runs = []; } }
      if (!runs.length) {
        host.appendChild(el("div", { class: "sched-history-empty", text: "No runs yet. Run it now to see output here." }));
        return;
      }
      for (const r of runs) {
        const when = r.created ? relTime(new Date(r.created).getTime()) : "";
        const row = el("button", { class: "sched-history-row" }, [
          el("span", { class: "sched-history-when", text: when }),
          el("span", { class: "sched-history-dot " + (r.ok ? "ok" : "err") }),
        ]);
        row.addEventListener("click", () => openRunInAgent(r.id));
        host.appendChild(row);
      }
    }

    // Open a past run's conversation in the yo agent panel.
    function openRunInAgent(runId: string): void {
      ctx.clearStack?.();
      const panel = (window as unknown as { __yoPanel?: { loadChat?: (id: string) => void } }).__yoPanel;
      panel?.loadChat?.(runId);
    }

    // ── Create / edit modal ──
    function openModal(seed?: Partial<TaskRow>, onSaved?: () => void): void {
      const isEdit = !!(seed && seed.name && tasks.some((t) => t.name === seed.name));
      const backdrop = el("div", { class: "ws-modal-backdrop open sched-modal-backdrop" });
      const closeBtn = el("button", { class: "ws-modal-close", html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>` });

      const nameInput = el("input", { class: "ws-form-input", attrs: { type: "text", placeholder: "e.g. Daily brief", spellcheck: "false", autocomplete: "off" } }) as HTMLInputElement;
      const descInput = el("input", { class: "ws-form-input", attrs: { type: "text", placeholder: "Short summary of what it does", spellcheck: "false", autocomplete: "off" } }) as HTMLInputElement;
      const instrInput = el("textarea", { class: "ws-form-input sched-textarea", attrs: { rows: "5", placeholder: "What should .Yo do each time this runs?", spellcheck: "false" } }) as HTMLTextAreaElement;
      nameInput.value = seed?.name || "";
      descInput.value = seed?.description || "";
      instrInput.value = seed?.prompt || "";
      if (isEdit) nameInput.disabled = true; // renaming = new skill; keep simple

      const seeded = parseCron(seed?.cron);
      const freqSelect = el("select", { class: "ws-form-input sched-select" }) as HTMLSelectElement;
      for (const f of FREQUENCIES) freqSelect.appendChild(el("option", { text: f.label, attrs: { value: f.value } }));
      freqSelect.value = seed?.cron !== undefined ? seeded.freq : "daily";

      const timeInput = el("input", { class: "ws-form-input sched-time", attrs: { type: "time" } }) as HTMLInputElement;
      timeInput.value = seeded.time;
      // The time picker only applies to time-based frequencies (Daily…Monthly).
      const syncTime = () => {
        const f = FREQUENCIES.find((x) => x.value === freqSelect.value);
        timeInput.disabled = !f?.hasTime;
      };
      freqSelect.addEventListener("change", syncTime);
      syncTime();

      const askSelect = el("select", { class: "ws-form-input sched-select" }) as HTMLSelectElement;
      for (const a of ASK_MODES) askSelect.appendChild(el("option", { text: a.label, attrs: { value: a.value } }));
      askSelect.value = seed?.ask || "auto";

      const modelSelect = el("select", { class: "ws-form-input sched-select" }) as HTMLSelectElement;
      modelSelect.appendChild(el("option", { text: "Loading models…", attrs: { value: "" } }));
      void populateModels(modelSelect, seed?.model);

      const errBox = el("div", { class: "ws-form-error", attrs: { style: "display:none" } });
      const saveBtn = el("button", { class: "ws-btn primary", text: isEdit ? "Save task" : "Create task" });

      const body = el("div", { class: "ws-modal-body" }, [
        errBox,
        el("label", { class: "ws-form-label", text: "Name" }), nameInput,
        el("label", { class: "ws-form-label", text: "Description" }), descInput,
        el("label", { class: "ws-form-label", text: "Instructions" }), instrInput,
        el("div", { class: "sched-form-grid" }, [
          el("div", {}, [el("label", { class: "ws-form-label", text: "Frequency" }), freqSelect]),
          el("div", {}, [el("label", { class: "ws-form-label", text: "Time" }), timeInput]),
        ]),
        el("div", { class: "sched-form-grid" }, [
          el("div", {}, [el("label", { class: "ws-form-label", text: "When it runs" }), askSelect]),
          el("div", {}, [el("label", { class: "ws-form-label", text: "Model" }), modelSelect]),
        ]),
      ]);

      const modal = el("div", { class: "ws-modal sched-modal" }, [
        el("div", { class: "ws-modal-header" }, [
          el("h2", { text: isEdit ? "Edit scheduled task" : "New scheduled task" }),
          closeBtn,
        ]),
        body,
        el("div", { class: "ws-modal-footer" }, [
          el("button", { class: "ws-btn", text: "Cancel", attrs: { "data-cancel": "1" } }),
          saveBtn,
        ]),
      ]);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      nameInput.focus();

      const close = () => backdrop.remove();
      closeBtn.addEventListener("click", close);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
      modal.querySelector("[data-cancel]")?.addEventListener("click", close);

      saveBtn.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        const instructions = instrInput.value.trim();
        if (!name) { showErr("Give the task a name."); return; }
        if (!instructions) { showErr("Add instructions describing what to do."); return; }
        if (!hasBridge() || !yo) { showErr("Not available in browser preview."); return; }

        const cron = buildCron(freqSelect.value, timeInput.value);
        const manifest: Record<string, unknown> = {
          name,
          description: descInput.value.trim(),
          schedule: cron,
          scheduleLabel: scheduleLabel(cron),
          model: modelSelect.value,
          ask: askSelect.value,
        };
        saveBtn.setAttribute("disabled", "1");
        const res = await yo.skillsWriteFull(name, manifest, instructions);
        if (res && typeof res === "object" && "error" in res) {
          saveBtn.removeAttribute("disabled");
          showErr((res as { error: string }).error || "Could not save the task.");
          return;
        }
        // Track membership so it lists here even when Manual.
        const names = await yo.getPreference<string[]>("scheduledTasks", []);
        if (!names.includes(name)) { names.push(name); yo.setPreference("scheduledTasks", names); }
        window.dispatchEvent(new Event("scheduled-tasks-changed"));
        close();
        if (onSaved) onSaved(); else void load();
      });

      function showErr(msg: string): void { errBox.textContent = msg; errBox.setAttribute("style", "display:block"); }
    }

    async function populateModels(select: HTMLSelectElement, current?: string): Promise<void> {
      if (!hasBridge() || !yo) { select.innerHTML = ""; select.appendChild(el("option", { text: "Default", attrs: { value: "" } })); return; }
      let presets: Record<string, { name: string; models: string[]; defaultModel: string }> = {};
      let cfg: { provider: string; model: string } | null = null;
      try { presets = await yo.getLLMPresets(); } catch { presets = {}; }
      try { cfg = await yo.getLLMConfig(); } catch { cfg = null; }
      select.innerHTML = "";
      // First option: follow the workspace default model.
      const def = el("option", { text: cfg?.model ? `Default (${prettyModel(cfg.model)})` : "Default", attrs: { value: "" } });
      select.appendChild(def);
      for (const key of Object.keys(presets)) {
        const group = presets[key];
        const og = el("optgroup", { attrs: { label: group.name } }) as HTMLOptGroupElement;
        for (const m of group.models) og.appendChild(el("option", { text: prettyModel(m), attrs: { value: m } }));
        select.appendChild(og);
      }
      if (current) select.value = current;
    }

    // Wire header
    newBtn.addEventListener("click", () => openModal());
    searchInput.addEventListener("input", render);

    // Let the rail / chat run-markers open a specific task's detail directly.
    activeOpenByName = (name: string) => {
      const t = tasks.find((x) => x.name === name);
      if (t) openDetail(t); else showList();
    };
    void load().then(() => {
      if (pendingDetailName) { const n = pendingDetailName; pendingDetailName = null; activeOpenByName?.(n); }
    });
  },
};

/** Trim provider prefixes / dates for a friendlier model label. */
function prettyModel(model: string): string {
  return model
    .replace(/^.*\//, "")
    .replace(/-(\d{8})$/, "")
    .replace(/claude-/, "Claude ")
    .replace(/-/g, " ");
}

/** True when the Schedules slide is the current top slide. */
function schedulesSlideOpen(ctx: WorkspaceCtx): boolean {
  const stack = ctx.slideStack || [];
  const top = stack[stack.length - 1];
  return !!(top && top.app && top.app.id === "__schedules");
}

/** Push the Schedules slide (mounting the screen into its body). */
function pushSchedulesSlide(ctx: WorkspaceCtx): void {
  ctx.pushSlide?.({
    id: "__schedules",
    name: "Scheduled tasks",
    iconSvg: SCHEDULES_ICON,
    chromeless: true,
    onMount: (slideEl: HTMLElement) => {
      const body = slideEl.querySelector<HTMLElement>(".ws-slide-body");
      if (body) schedulesScreen.mount(body, ctx);
    },
  });
}

/**
 * Open a specific task's detail page (slides in left→right). If the slide is
 * already mounted, navigate live; otherwise push it with a pending target.
 */
export function openScheduleTask(ctx: WorkspaceCtx, name: string): void {
  if (schedulesSlideOpen(ctx)) { activeOpenByName?.(name); return; }
  pendingDetailName = name;
  pushSchedulesSlide(ctx);
}

/**
 * Open a schedule's most recent run in the agent panel — rendered exactly like
 * any other conversation (loadChat). When it has never run, fall back to a
 * fresh new message rather than a blank view.
 */
export async function openLastRun(ctx: WorkspaceCtx, name: string): Promise<void> {
  const panel = (window as unknown as {
    __yoPanel?: { loadChat?: (id: string) => void; newChat?: () => void };
  }).__yoPanel;
  ctx.clearStack?.();
  if (hasBridge() && yo) {
    let runs: Array<{ id: string }> = [];
    try { runs = await yo.runsList(name); } catch { runs = []; }
    if (runs[0]) { panel?.loadChat?.(runs[0].id); return; }
  }
  // No runs yet — land on a clean new message.
  panel?.newChat?.();
}

/** Wire the left-rail "Schedules" item to open the screen as a slide (toggle). */
export function initSchedules(ctx: WorkspaceCtx): void {
  const btn = document.getElementById("open-schedules");
  if (btn) {
    btn.addEventListener("click", () => {
      if (schedulesSlideOpen(ctx)) { ctx.popSlide?.(); return; }
      pendingDetailName = null;
      pushSchedulesSlide(ctx);
    });
  }
  // Chat run-markers ("Ran scheduled task") slide open the owning task.
  window.addEventListener("open-schedule-task", (e: Event) => {
    const name = (e as CustomEvent<{ name?: string }>).detail?.name;
    if (name) openScheduleTask(ctx, name);
  });
}

/**
 * Render + maintain the left-rail SCHEDULED section (above Recents). Lists the
 * persisted scheduled tasks; clicking one slides open its detail page.
 */
export function initScheduledRail(ctx: WorkspaceCtx): void {
  const listEl = document.getElementById("scheduled-list");
  if (!listEl) return;

  async function render(): Promise<void> {
    if (!hasBridge() || !yo) return;            // browser preview: keep placeholder
    let names: string[] = [];
    try { names = await yo.getPreference<string[]>("scheduledTasks", []); } catch { names = []; }
    listEl!.innerHTML = "";
    if (!names.length) {
      listEl!.appendChild(el("div", { class: "ws-list-empty", text: "No scheduled tasks" }));
      return;
    }
    for (const name of names) {
      const row = el("div", { class: "ws-list-item ws-sched-item", attrs: { "data-name": name } }, [
        el("span", { class: "ws-sched-dot" }),
        el("span", { class: "label", text: name }),
      ]);
      // Clicking opens the schedule's most recent run in the agent; if it has
      // never run, fall back to its detail page.
      row.addEventListener("click", () => void openLastRun(ctx, name));
      listEl!.appendChild(row);
    }
  }

  window.addEventListener("scheduled-tasks-changed", () => void render());
  void render();
}
