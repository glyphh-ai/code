/**
 * Councils — saved council templates, run history, and scheduling.
 * Renders into #councils-root (list / editor / runs views).
 */

type Member = { provider: string; model: string; startup_prompt: string };
type Council = {
  id: string; name: string; council_prompt: string;
  style: "chained" | "free_for_all" | "debate";
  round_cap: number; members: Member[]; schedule?: string; paused?: boolean;
};

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

function root(): HTMLElement { return document.getElementById("councils-root")!; }

export async function loadCouncils(): Promise<void> {
  const el = root();
  el.innerHTML = "";
  const [councils] = await Promise.all([window.yo.councilsList() as Promise<Council[]>]);

  const toolbar = document.createElement("div");
  toolbar.className = "councils-toolbar";
  toolbar.innerHTML = `<h2 style="margin:0;flex:1;">Councils</h2>`;
  const newBtn = document.createElement("button");
  newBtn.className = "action-btn primary";
  newBtn.textContent = "New council";
  newBtn.addEventListener("click", () => openEditor(null));
  toolbar.appendChild(newBtn);
  el.appendChild(toolbar);

  const desc = document.createElement("p");
  desc.className = "section-desc";
  desc.textContent = "Saved panels of LLMs that debate a prompt. Run one live, review past runs, or schedule it to convene automatically.";
  el.appendChild(desc);

  if (councils.length === 0) {
    const empty = document.createElement("div");
    empty.className = "help-empty";
    empty.textContent = "No saved councils yet. Click “New council” to create one.";
    el.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "councils-list";
  for (const c of councils) list.appendChild(renderCard(c));
  el.appendChild(list);
}

function renderCard(c: Council): HTMLElement {
  const card = document.createElement("div");
  card.className = "council-card";
  card.style.cssText = "background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:10px;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;flex:1;";
  title.textContent = c.name;
  const sched = document.createElement("span");
  sched.style.cssText = "font-size:11px;padding:2px 8px;border-radius:4px;background:var(--surface-3);color:var(--text-2);";
  sched.textContent = c.schedule ? (c.paused ? `${cronToLabel(c.schedule)} (paused)` : cronToLabel(c.schedule)) : "Manual";
  head.appendChild(title);
  head.appendChild(sched);
  card.appendChild(head);

  const meta = document.createElement("div");
  meta.style.cssText = "font-size:12px;color:var(--text-3);margin-bottom:10px;";
  meta.textContent = `${c.members.length} members (${c.members.map((m) => m.provider).join(", ")}) · ${c.style} · ${c.round_cap} rounds`;
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
  const mk = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = `action-btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  actions.appendChild(mk("Run", "primary", async () => { await window.yo.councilsRun(c.id, true); }));
  actions.appendChild(mk("Edit", "", () => openEditor(c)));
  actions.appendChild(mk("History", "", () => openRuns(c)));
  if (c.schedule) {
    actions.appendChild(mk(c.paused ? "Resume" : "Pause", "", async () => {
      if (c.paused) await window.yo.councilsResumeSchedule(c.id);
      else await window.yo.councilsPauseSchedule(c.id);
      await loadCouncils();
    }));
  }
  actions.appendChild(mk("Delete", "danger", async () => {
    if (!confirm(`Delete council “${c.name}”?`)) return;
    await window.yo.councilsDelete(c.id);
    await loadCouncils();
  }));
  card.appendChild(actions);
  return card;
}

// ── Editor ──────────────────────────────────────────────────

async function openEditor(existing: Council | null): Promise<void> {
  const el = root();
  el.innerHTML = "";
  const configured = await (window.yo.providerKeysList() as Promise<Array<{ provider: string; configured: boolean }>>)
    .then((s) => s.filter((p) => p.configured).map((p) => p.provider))
    .catch(() => []);
  const providers = configured.length ? configured : ["anthropic", "openai", "google", "xai", "perplexity"];

  const members: Member[] = existing
    ? existing.members.map((m) => ({ ...m }))
    : [{ provider: providers[0], model: "", startup_prompt: "" }, { provider: providers[1] || providers[0], model: "", startup_prompt: "" }];

  const wrap = document.createElement("div");
  wrap.className = "council-editor settings-form";
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;max-width:680px;";

  const field = (label: string, control: HTMLElement) => {
    const row = document.createElement("div");
    row.innerHTML = `<label class="settings-label">${label}</label>`;
    row.appendChild(control);
    return row;
  };

  const nameInput = document.createElement("input");
  nameInput.className = "settings-input";
  nameInput.placeholder = "Council name";
  nameInput.value = existing?.name || "";

  const promptInput = document.createElement("textarea");
  promptInput.className = "settings-input";
  promptInput.style.minHeight = "70px";
  promptInput.placeholder = "What should the council debate?";
  promptInput.value = existing?.council_prompt || "";

  const styleSel = document.createElement("select");
  styleSel.className = "settings-input";
  for (const s of ["chained", "free_for_all", "debate"]) {
    const o = document.createElement("option"); o.value = s; o.textContent = s; styleSel.appendChild(o);
  }
  styleSel.value = existing?.style || "chained";

  const roundsInput = document.createElement("input");
  roundsInput.type = "number"; roundsInput.min = "1"; roundsInput.max = "20";
  roundsInput.className = "settings-input"; roundsInput.value = String(existing?.round_cap || 3);

  const membersWrap = document.createElement("div");
  membersWrap.style.cssText = "display:flex;flex-direction:column;gap:8px;";
  function renderMembers() {
    membersWrap.innerHTML = "";
    members.forEach((m, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;align-items:flex-start;background:var(--surface-2);padding:8px;border-radius:6px;";
      const pSel = document.createElement("select"); pSel.className = "settings-input"; pSel.style.maxWidth = "120px";
      for (const p of providers) { const o = document.createElement("option"); o.value = p; o.textContent = p; pSel.appendChild(o); }
      pSel.value = m.provider; pSel.addEventListener("change", () => { m.provider = pSel.value; });
      const modelInput = document.createElement("input"); modelInput.className = "settings-input"; modelInput.placeholder = "model id"; modelInput.value = m.model; modelInput.style.maxWidth = "160px";
      modelInput.addEventListener("input", () => { m.model = modelInput.value; });
      const sp = document.createElement("input"); sp.className = "settings-input"; sp.placeholder = "persona / startup prompt"; sp.value = m.startup_prompt; sp.style.flex = "1";
      sp.addEventListener("input", () => { m.startup_prompt = sp.value; });
      const rm = document.createElement("button"); rm.className = "action-btn danger"; rm.textContent = "×";
      rm.addEventListener("click", () => { members.splice(i, 1); renderMembers(); });
      row.append(pSel, modelInput, sp, rm);
      membersWrap.appendChild(row);
    });
  }
  renderMembers();
  const addMember = document.createElement("button");
  addMember.className = "action-btn"; addMember.textContent = "+ Add member";
  addMember.addEventListener("click", () => {
    if (members.length >= 10) return;
    members.push({ provider: providers[0], model: "", startup_prompt: "" });
    renderMembers();
  });

  // Schedule
  const freqSel = document.createElement("select");
  freqSel.className = "settings-input"; freqSel.style.maxWidth = "160px";
  for (const f of ["manual", "hourly", "daily", "weekdays", "weekly", "monthly"]) {
    const o = document.createElement("option"); o.value = f; o.textContent = f; freqSel.appendChild(o);
  }
  const timeInput = document.createElement("input");
  timeInput.type = "time"; timeInput.className = "settings-input"; timeInput.style.maxWidth = "120px"; timeInput.value = "09:00";
  // Preselect from existing schedule
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
  const schedRow = document.createElement("div");
  schedRow.style.cssText = "display:flex;gap:6px;align-items:center;";
  schedRow.append(freqSel, timeInput);

  const status = document.createElement("div");
  status.style.cssText = "color:#d44a4a;font-size:12px;min-height:16px;";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;";
  const saveBtn = document.createElement("button"); saveBtn.className = "action-btn primary"; saveBtn.textContent = "Save council";
  const cancelBtn = document.createElement("button"); cancelBtn.className = "action-btn"; cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => { void loadCouncils(); });
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name) { status.textContent = "Name required"; return; }
    if (!prompt) { status.textContent = "Prompt required"; return; }
    const validMembers = members.filter((m) => m.provider && m.model.trim());
    if (validMembers.length < 2) { status.textContent = "Need at least 2 members with a model id"; return; }
    const freq = freqSel.value;
    const schedule = freq === "manual" ? undefined : FREQ_TO_CRON[freq](timeInput.value || "09:00");
    const cfg: Council = {
      id: existing?.id || "",
      name, council_prompt: prompt,
      style: styleSel.value as Council["style"],
      round_cap: Math.max(1, Math.min(20, parseInt(roundsInput.value, 10) || 3)),
      members: validMembers.map((m) => ({ provider: m.provider, model: m.model.trim(), startup_prompt: m.startup_prompt.trim() })),
      schedule, paused: existing?.paused,
    };
    await window.yo.councilsSave(cfg as unknown as Record<string, unknown>);
    await loadCouncils();
  });
  btnRow.append(saveBtn, cancelBtn);

  wrap.append(
    field("Name", nameInput),
    field("Prompt", promptInput),
    field("Style", styleSel),
    field("Max rounds", roundsInput),
    field("Members", membersWrap),
    addMember,
    field("Schedule", schedRow),
    status, btnRow,
  );
  el.innerHTML = "";
  el.appendChild(wrap);
}

// ── Run history ─────────────────────────────────────────────

async function openRuns(c: Council): Promise<void> {
  const el = root();
  el.innerHTML = "";
  const back = document.createElement("button");
  back.className = "settings-nav-back"; back.innerHTML = "← Councils";
  back.addEventListener("click", () => { void loadCouncils(); });
  el.appendChild(back);
  const h = document.createElement("h2"); h.textContent = `${c.name} — runs`; el.appendChild(h);

  const runs = await (window.yo.councilsRuns(c.id) as Promise<Array<Record<string, unknown>>>);
  if (!runs.length) {
    const empty = document.createElement("div"); empty.className = "help-empty"; empty.textContent = "No runs yet.";
    el.appendChild(empty); return;
  }
  for (const r of runs) {
    const card = document.createElement("div");
    card.style.cssText = "background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;";
    const when = new Date(String(r.startedAt)).toLocaleString();
    card.innerHTML = `<div style="display:flex;gap:8px;"><span style="flex:1;font-weight:600;">${when}</span>`
      + `<span style="font-size:11px;color:var(--text-3);">${r.trigger} · ${r.status} · ${r.rounds} rounds</span></div>`;
    const body = document.createElement("div");
    body.style.cssText = "margin-top:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap;display:none;";
    body.textContent = (r.summary as string) || "(no summary)";
    card.appendChild(body);
    card.addEventListener("click", () => { body.style.display = body.style.display === "none" ? "block" : "none"; });
    el.appendChild(card);
  }
}

export function initCouncils(): void {
  // Rendering is lazy — loadCouncils() is called when the section opens.
}
