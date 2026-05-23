/**
 * Councils — saved council templates, run history, and scheduling.
 * Matches the standard help-page look (h2 + section-desc + crud-toolbar +
 * crud-cards + crud-inline-form). Renders into #councils-root.
 */

type Member = { provider: string; model: string; startup_prompt: string };
type Council = {
  id: string; name: string; council_prompt: string;
  style: "chained" | "free_for_all" | "debate";
  round_cap: number; members: Member[]; schedule?: string; paused?: boolean;
};

const RUN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
const EDIT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const HISTORY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>`;
const PAUSE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="4" x2="10" y2="20"/><line x1="14" y1="4" x2="14" y2="20"/></svg>`;
const RESUME_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const DELETE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

const FREQ_TO_CRON: Record<string, (t: string) => string> = {
  hourly: () => "0 * * * *",
  daily: (t) => { const [h, m] = t.split(":"); return `${+m} ${+h} * * *`; },
  weekdays: (t) => { const [h, m] = t.split(":"); return `${+m} ${+h} * * 1-5`; },
  weekly: (t) => { const [h, m] = t.split(":"); return `${+m} ${+h} * * 1`; },
  monthly: (t) => { const [h, m] = t.split(":"); return `${+m} ${+h} 1 * *`; },
};

function cronToLabel(cron?: string): string {
  if (!cron) return "Manual";
  if (cron === "0 * * * *") return "Hourly";
  const p = cron.split(/\s+/);
  if (p.length === 5) {
    const time = `${p[1].padStart(2, "0")}:${p[0].padStart(2, "0")}`;
    if (p[4] === "1-5") return `Weekdays ${time}`;
    if (p[4] === "1") return `Weekly (Mon) ${time}`;
    if (p[2] === "1") return `Monthly ${time}`;
    if (p[2] === "*" && p[4] === "*") return `Daily ${time}`;
  }
  return cron;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function root(): HTMLElement { return document.getElementById("councils-root")!; }

let allCouncils: Council[] = [];

export async function loadCouncils(): Promise<void> {
  const el = root();
  allCouncils = (await window.yo.councilsList().catch(() => [])) as Council[];
  el.innerHTML =
    `<h2>Councils</h2>` +
    `<p class="section-desc">Saved panels of LLMs that debate a prompt. Run one live, review past runs, or schedule it to convene automatically.</p>` +
    `<div class="crud-toolbar">` +
      `<input id="council-search" type="text" class="crud-search" placeholder="Search councils..." spellcheck="false" autocomplete="off" />` +
      `<button id="council-new-btn" class="action-btn primary">+ New</button>` +
    `</div>` +
    `<div id="councils-list" class="crud-cards"></div>`;

  document.getElementById("council-new-btn")!.addEventListener("click", () => openEditor(null));
  const search = document.getElementById("council-search") as HTMLInputElement;
  search.addEventListener("input", () => renderList(search.value.trim().toLowerCase()));
  renderList("");
}

function renderList(query: string): void {
  const list = document.getElementById("councils-list");
  if (!list) return;
  const items = query
    ? allCouncils.filter((c) => c.name.toLowerCase().includes(query) || c.council_prompt.toLowerCase().includes(query))
    : allCouncils;
  if (items.length === 0) {
    list.innerHTML = `<div class="crud-empty">${query ? `No councils matching "${escapeHtml(query)}"` : 'No saved councils yet. Click "+ New" to create one.'}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const c of items) list.appendChild(renderCard(c));
}

function renderCard(c: Council): HTMLElement {
  const card = document.createElement("div");
  card.className = "crud-card";
  const meta = [
    `${c.members.length} members`,
    c.style,
    `${c.round_cap} rounds`,
    c.schedule ? (c.paused ? `${cronToLabel(c.schedule)} (paused)` : cronToLabel(c.schedule)) : "Manual",
  ];
  card.innerHTML =
    `<div class="crud-card-info">` +
      `<span class="crud-card-name">${escapeHtml(c.name)}</span>` +
      `<span class="crud-card-meta">${meta.join(" · ")}</span>` +
    `</div>` +
    `<div class="crud-card-actions"></div>`;
  const actions = card.querySelector(".crud-card-actions")!;
  const mk = (icon: string, title: string, cls: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = `crud-card-btn ${cls}`.trim();
    b.title = title; b.innerHTML = icon;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  actions.appendChild(mk(RUN_ICON, "Run now", "", async () => { await window.yo.councilsRun(c.id, true); }));
  actions.appendChild(mk(HISTORY_ICON, "Run history", "", () => openRuns(c)));
  if (c.schedule) {
    actions.appendChild(mk(c.paused ? RESUME_ICON : PAUSE_ICON, c.paused ? "Resume schedule" : "Pause schedule", "", async () => {
      if (c.paused) await window.yo.councilsResumeSchedule(c.id); else await window.yo.councilsPauseSchedule(c.id);
      await loadCouncils();
    }));
  }
  actions.appendChild(mk(EDIT_ICON, "Edit", "", () => openEditor(c)));
  actions.appendChild(mk(DELETE_ICON, "Delete", "danger", async () => {
    if (!confirm(`Delete council "${c.name}"?`)) return;
    await window.yo.councilsDelete(c.id);
    await loadCouncils();
  }));
  card.addEventListener("click", () => openEditor(c));
  return card;
}

// ── Editor ──────────────────────────────────────────────────

async function openEditor(existing: Council | null): Promise<void> {
  const el = root();
  const configured = await (window.yo.providerKeysList() as Promise<Array<{ provider: string; configured: boolean }>>)
    .then((s) => s.filter((p) => p.configured).map((p) => p.provider))
    .catch(() => []);
  const providers = configured.length ? configured : ["anthropic", "openai", "google", "xai", "perplexity"];
  const modelCatalog = await window.yo.providerModelsGetAll().catch(() => ({} as Record<string, { default: string; models: string[] }>));
  const members: Member[] = existing
    ? existing.members.map((m) => ({ ...m }))
    : [{ provider: providers[0], model: "", startup_prompt: "" }, { provider: providers[1] || providers[0], model: "", startup_prompt: "" }];

  el.innerHTML =
    `<div class="crud-inline-form">` +
      `<div class="crud-inline-header"><a class="crud-breadcrumb-back" id="council-back">&larr; Councils</a><div class="crud-spacer"></div></div>` +
      `<div id="council-form-error" class="crud-form-error hidden"></div>` +
      `<label class="settings-label">Name</label>` +
      `<input id="cl-name" type="text" class="settings-input" placeholder="Council name" spellcheck="false" />` +
      `<label class="settings-label">Prompt</label>` +
      `<textarea id="cl-prompt" class="settings-input" style="min-height:70px;" placeholder="What should the council debate?"></textarea>` +
      `<label class="settings-label">Style</label>` +
      `<select id="cl-style" class="settings-input" style="width:auto;"><option value="chained">chained</option><option value="free_for_all">free_for_all</option><option value="debate">debate</option></select>` +
      `<label class="settings-label">Max rounds</label>` +
      `<input id="cl-rounds" type="number" min="1" max="20" class="settings-input" style="width:auto;" />` +
      `<label class="settings-label">Members</label>` +
      `<div id="cl-members" style="display:flex;flex-direction:column;gap:8px;"></div>` +
      `<button id="cl-add-member" class="action-btn" style="align-self:flex-start;">+ Add member</button>` +
      `<label class="settings-label">Schedule</label>` +
      `<div style="display:flex;gap:6px;align-items:center;">` +
        `<select id="cl-freq" class="settings-input" style="width:auto;"><option value="manual">manual</option><option value="hourly">hourly</option><option value="daily">daily</option><option value="weekdays">weekdays</option><option value="weekly">weekly</option><option value="monthly">monthly</option></select>` +
        `<input id="cl-time" type="time" class="settings-input" style="width:auto;" value="09:00" />` +
      `</div>` +
      `<div style="display:flex;gap:8px;margin-top:14px;"><button id="cl-save" class="action-btn primary">Save council</button></div>` +
    `</div>`;

  (document.getElementById("cl-name") as HTMLInputElement).value = existing?.name || "";
  (document.getElementById("cl-prompt") as HTMLTextAreaElement).value = existing?.council_prompt || "";
  (document.getElementById("cl-style") as HTMLSelectElement).value = existing?.style || "chained";
  (document.getElementById("cl-rounds") as HTMLInputElement).value = String(existing?.round_cap || 3);

  const freqSel = document.getElementById("cl-freq") as HTMLSelectElement;
  const timeInput = document.getElementById("cl-time") as HTMLInputElement;
  if (existing?.schedule) {
    const lbl = cronToLabel(existing.schedule).toLowerCase();
    if (lbl.startsWith("hourly")) freqSel.value = "hourly";
    else if (lbl.startsWith("weekdays")) freqSel.value = "weekdays";
    else if (lbl.startsWith("weekly")) freqSel.value = "weekly";
    else if (lbl.startsWith("monthly")) freqSel.value = "monthly";
    else if (lbl.startsWith("daily")) freqSel.value = "daily";
    const m = existing.schedule.split(/\s+/);
    if (m.length === 5 && m[0] !== "*" && m[1] !== "*") timeInput.value = `${m[1].padStart(2, "0")}:${m[0].padStart(2, "0")}`;
  }

  const membersWrap = document.getElementById("cl-members")!;
  function renderMembers() {
    membersWrap.innerHTML = "";
    members.forEach((m, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;align-items:flex-start;background:var(--surface-2);padding:8px;border-radius:6px;";
      const pSel = document.createElement("select"); pSel.className = "settings-input"; pSel.style.maxWidth = "120px";
      for (const p of providers) { const o = document.createElement("option"); o.value = p; o.textContent = p; pSel.appendChild(o); }
      pSel.value = m.provider;
      // Model dropdown sourced from the editable registry (valid ids per provider).
      const mSel = document.createElement("select"); mSel.className = "settings-input"; mSel.style.maxWidth = "190px";
      const fillModels = () => {
        const models = modelCatalog[m.provider]?.models || [];
        mSel.innerHTML = "";
        for (const mod of models) { const o = document.createElement("option"); o.value = mod; o.textContent = mod; mSel.appendChild(o); }
        // Preserve a custom/legacy model id that's not in the catalog.
        if (m.model && !models.includes(m.model)) { const o = document.createElement("option"); o.value = m.model; o.textContent = `${m.model} (custom)`; mSel.appendChild(o); }
        mSel.value = m.model || modelCatalog[m.provider]?.default || models[0] || "";
        m.model = mSel.value;
      };
      fillModels();
      pSel.addEventListener("change", () => { m.provider = pSel.value; m.model = ""; fillModels(); });
      mSel.addEventListener("change", () => { m.model = mSel.value; });
      const sp = document.createElement("input"); sp.className = "settings-input"; sp.placeholder = "persona / startup prompt"; sp.value = m.startup_prompt; sp.style.flex = "1";
      sp.addEventListener("input", () => { m.startup_prompt = sp.value; });
      const rm = document.createElement("button"); rm.className = "action-btn danger"; rm.textContent = "×";
      rm.addEventListener("click", () => { members.splice(i, 1); renderMembers(); });
      row.append(pSel, mSel, sp, rm);
      membersWrap.appendChild(row);
    });
  }
  renderMembers();

  document.getElementById("cl-add-member")!.addEventListener("click", () => {
    if (members.length >= 10) return;
    members.push({ provider: providers[0], model: "", startup_prompt: "" });
    renderMembers();
  });
  document.getElementById("council-back")!.addEventListener("click", () => { void loadCouncils(); });

  document.getElementById("cl-save")!.addEventListener("click", async () => {
    const err = document.getElementById("council-form-error")!;
    const showErr = (m: string) => { err.textContent = m; err.classList.remove("hidden"); };
    const name = (document.getElementById("cl-name") as HTMLInputElement).value.trim();
    const prompt = (document.getElementById("cl-prompt") as HTMLTextAreaElement).value.trim();
    if (!name) return showErr("Name required");
    if (!prompt) return showErr("Prompt required");
    const valid = members.filter((m) => m.provider && m.model.trim());
    if (valid.length < 2) return showErr("Need at least 2 members with a model id");
    const freq = freqSel.value;
    const schedule = freq === "manual" ? undefined : FREQ_TO_CRON[freq](timeInput.value || "09:00");
    const cfg: Council = {
      id: existing?.id || "",
      name, council_prompt: prompt,
      style: (document.getElementById("cl-style") as HTMLSelectElement).value as Council["style"],
      round_cap: Math.max(1, Math.min(20, parseInt((document.getElementById("cl-rounds") as HTMLInputElement).value, 10) || 3)),
      members: valid.map((m) => ({ provider: m.provider, model: m.model.trim(), startup_prompt: m.startup_prompt.trim() })),
      schedule, paused: existing?.paused,
    };
    await window.yo.councilsSave(cfg as unknown as Record<string, unknown>);
    await loadCouncils();
  });
}

// ── Run history ─────────────────────────────────────────────

async function openRuns(c: Council): Promise<void> {
  const el = root();
  el.innerHTML =
    `<div class="crud-inline-header"><a class="crud-breadcrumb-back" id="runs-back">&larr; Councils</a><div class="crud-spacer"></div></div>` +
    `<h2>${escapeHtml(c.name)} — runs</h2>` +
    `<div id="council-runs-list" class="crud-cards"></div>`;
  document.getElementById("runs-back")!.addEventListener("click", () => { void loadCouncils(); });

  const runs = await (window.yo.councilsRuns(c.id) as Promise<Array<Record<string, unknown>>>);
  const list = document.getElementById("council-runs-list")!;
  if (!runs.length) { list.innerHTML = `<div class="crud-empty">No runs yet.</div>`; return; }
  for (const r of runs) {
    const card = document.createElement("div");
    card.className = "crud-card";
    card.style.flexDirection = "column";
    card.style.alignItems = "stretch";
    const when = new Date(String(r.startedAt)).toLocaleString();
    card.innerHTML =
      `<div class="crud-card-info" style="flex-direction:row;justify-content:space-between;">` +
        `<span class="crud-card-name">${when}</span>` +
        `<span class="crud-card-meta">${r.trigger} · ${r.status} · ${r.rounds} rounds</span>` +
      `</div>`;
    const body = document.createElement("div");
    body.style.cssText = "margin-top:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap;display:none;";
    body.textContent = (r.summary as string) || "(no summary)";
    card.appendChild(body);
    card.addEventListener("click", () => { body.style.display = body.style.display === "none" ? "block" : "none"; });
    list.appendChild(card);
  }
}

export function initCouncils(): void { /* lazy — loadCouncils() renders on open */ }
