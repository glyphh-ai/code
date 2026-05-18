/**
 * Agents section — local agent registry CRUD.
 *
 * A flat list + search + inline editor, matching the Drips / Skills sections.
 * Agents are always local; they are the library a swarm draws from.
 */

import { $a, escapeHtml, slugify, paginate, renderPaginationBar, confirmAction } from "./shared.js";

interface AgentGuardrails {
  max_tokens_per_session?: number;
  max_turns?: number;
  auto_stop_idle_seconds?: number;
}

export interface AgentDef {
  id: string;
  name: string;
  type: "local";
  role?: string;
  systemPrompt?: string;
  apps?: string[];
  skills?: string[];
  model_provider?: string;
  model_name?: string;
  guardrails?: AgentGuardrails;
  meta?: { createdAt: string; updatedAt: string };
}

const EDIT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const DELETE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

let agentsCache: AgentDef[] = [];
let agentsPage = 1;
let current: AgentDef | null = null;     // agent being edited; null when not editing
let isNew = false;
let modelsCache: Array<{ provider: string; model: string; display_name: string }> = [];
let appsCache: Array<{ id: string; name: string }> = [];
let skillsCache: Array<{ name: string; description?: string }> = [];

// ── List ────────────────────────────────────────────────────

async function loadAgents(): Promise<void> {
  agentsCache = (await window.yo.agentsList() as AgentDef[]) || [];
  if (modelsCache.length === 0) {
    const mr = await window.yo.modelsList();
    if (!("error" in mr)) modelsCache = mr.models;
  }
  $a("agents-toolbar").classList.remove("hidden");
  $a("agents-list").classList.remove("hidden");
  $a("agent-editor").classList.add("hidden");
  current = null;
  renderAgentsList();
}

function renderAgentsList(): void {
  const list = $a("agents-list");
  const search = ($a<HTMLInputElement>("agent-search").value || "").toLowerCase().trim();
  list.innerHTML = "";

  if (agentsCache.length === 0) {
    list.innerHTML = `<div class="crud-empty">No agents yet. Click "+ New" to add one.</div>`;
    return;
  }
  const filtered = agentsCache.filter((a) =>
    !search || a.name.toLowerCase().includes(search) || a.id.toLowerCase().includes(search) || (a.role || "").toLowerCase().includes(search),
  );
  if (filtered.length === 0) {
    list.innerHTML = `<div class="crud-empty">No agents matching "${escapeHtml(search)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, agentsPage);
  agentsPage = state.page;

  for (const a of items) {
    const meta: string[] = [];
    if (a.role) meta.push(escapeHtml(a.role));
    meta.push(`<span style="font-family:var(--font-mono);">${escapeHtml(a.id)}</span>`);
    if (a.model_name) meta.push(escapeHtml(a.model_name));

    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${escapeHtml(a.name || a.id)}</span>
        <span class="crud-card-meta">${meta.join(" · ")}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Edit">${EDIT_ICON}</button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">${DELETE_ICON}</button>
      </div>`;
    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => { e.stopPropagation(); openEditor(a); });
    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await confirmAction(`Delete agent "${a.name || a.id}"?`))) return;
      await window.yo.agentsRemove(a.id);
      await loadAgents();
    });
    card.addEventListener("click", () => openEditor(a));
    list.appendChild(card);
  }

  list.appendChild(renderPaginationBar(state, (p) => { agentsPage = p; renderAgentsList(); }));
}

// ── Editor ──────────────────────────────────────────────────

async function openEditor(agent: AgentDef | null): Promise<void> {
  isNew = agent === null;
  current = agent
    ? JSON.parse(JSON.stringify(agent))
    : { id: "", name: "", type: "local", apps: [], skills: [], guardrails: {} };

  $a("agents-toolbar").classList.add("hidden");
  $a("agents-list").classList.add("hidden");
  $a("agent-editor").classList.remove("hidden");
  $a("agent-form-error").classList.add("hidden");

  $a<HTMLInputElement>("agent-name").value = current!.name || "";
  $a<HTMLInputElement>("agent-slug").value = current!.id || "";
  $a<HTMLInputElement>("agent-role").value = current!.role || "";
  $a<HTMLTextAreaElement>("agent-prompt").value = current!.systemPrompt || "";

  const g = current!.guardrails || {};
  $a<HTMLInputElement>("agent-guard-turns").value = g.max_turns != null ? String(g.max_turns) : "";
  $a<HTMLInputElement>("agent-guard-tokens").value = g.max_tokens_per_session != null ? String(g.max_tokens_per_session) : "";
  $a<HTMLInputElement>("agent-guard-idle").value = g.auto_stop_idle_seconds != null ? String(g.auto_stop_idle_seconds) : "";

  populateModelSelector(current!.model_provider, current!.model_name);
  ($a("agent-delete-btn") as HTMLElement).style.display = isNew ? "none" : "";

  await loadAgentApps();
  await loadAgentSkills();
}

function populateModelSelector(provider?: string, model?: string): void {
  const sel = $a<HTMLSelectElement>("agent-model");
  sel.innerHTML = `<option value="">Default (Claude Sonnet)</option>`;
  const grouped = new Map<string, typeof modelsCache>();
  for (const m of modelsCache) {
    if (!grouped.has(m.provider)) grouped.set(m.provider, []);
    grouped.get(m.provider)!.push(m);
  }
  for (const [prov, models] of grouped) {
    const group = document.createElement("optgroup");
    group.label = prov.charAt(0).toUpperCase() + prov.slice(1);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}::${m.model}`;
      opt.textContent = m.display_name;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  sel.value = provider && model ? `${provider}::${model}` : "";
}

// ── Apps / Skills multi-pick ────────────────────────────────

async function loadAgentApps(): Promise<void> {
  if (appsCache.length === 0) {
    try { appsCache = (await window.yo.appsList()).map((a) => ({ id: a.id, name: a.name })); }
    catch { appsCache = []; }
  }
  renderPickList("apps");
}

async function loadAgentSkills(): Promise<void> {
  if (skillsCache.length === 0) {
    try { skillsCache = (await window.yo.skillsListDetailed()).map((s) => ({ name: s.name, description: s.description })); }
    catch { skillsCache = []; }
  }
  renderPickList("skills");
}

function renderPickList(kind: "apps" | "skills"): void {
  if (!current) return;
  const list = $a(`agent-${kind}-list`);
  list.innerHTML = "";
  const selected = (kind === "apps" ? current.apps : current.skills) || [];
  for (const key of selected) {
    const label = kind === "apps"
      ? (appsCache.find((a) => a.id === key)?.name || key)
      : key;
    const row = document.createElement("div");
    row.className = "skill-row";
    row.innerHTML = `<span style="font-size:13px;">${escapeHtml(label)}</span><button class="skill-row-remove" title="Remove">×</button>`;
    row.querySelector(".skill-row-remove")!.addEventListener("click", () => {
      if (kind === "apps") current!.apps = (current!.apps || []).filter((k) => k !== key);
      else current!.skills = (current!.skills || []).filter((k) => k !== key);
      renderPickList(kind);
    });
    list.appendChild(row);
  }
}

function showPicker(kind: "apps" | "skills"): void {
  if (!current) return;
  const selected = new Set((kind === "apps" ? current.apps : current.skills) || []);
  const available = kind === "apps"
    ? appsCache.filter((a) => !selected.has(a.id)).map((a) => ({ key: a.id, label: a.name }))
    : skillsCache.filter((s) => !selected.has(s.name)).map((s) => ({ key: s.name, label: s.name }));
  if (available.length === 0) { alert(`No more ${kind} to add.`); return; }

  const menu = document.createElement("div");
  menu.className = "skill-row-picker";
  menu.style.cssText = "position:absolute;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px var(--shadow);max-height:200px;overflow-y:auto;width:240px;";
  for (const opt of available) {
    const item = document.createElement("div");
    item.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;";
    item.textContent = opt.label;
    item.addEventListener("click", () => {
      if (kind === "apps") current!.apps = [...(current!.apps || []), opt.key];
      else current!.skills = [...(current!.skills || []), opt.key];
      renderPickList(kind);
      menu.remove();
    });
    item.addEventListener("mouseenter", () => { item.style.background = "var(--hover)"; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; });
    menu.appendChild(item);
  }
  const btn = $a(`agent-${kind}-add`);
  btn.style.position = "relative";
  btn.parentElement!.appendChild(menu);
  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== btn) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

// ── Save ────────────────────────────────────────────────────

async function saveAgent(): Promise<void> {
  if (!current) return;
  const err = $a("agent-form-error");
  const name = $a<HTMLInputElement>("agent-name").value.trim();
  const slug = ($a<HTMLInputElement>("agent-slug").value.trim() || slugify(name));
  if (!name) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) { err.textContent = "Slug must be letters, digits, _ or -."; err.classList.remove("hidden"); return; }

  const idChanged = slug !== current.id;
  if ((isNew || idChanged) && !(await window.yo.agentsIdAvailable(slug))) {
    err.textContent = `Slug "${slug}" already exists.`; err.classList.remove("hidden"); return;
  }

  const modelVal = $a<HTMLSelectElement>("agent-model").value;
  const [mProvider, mName] = modelVal ? modelVal.split("::") : [undefined, undefined];
  const num = (id: string) => {
    const v = $a<HTMLInputElement>(id).value.trim();
    return v ? Math.max(0, Number(v)) : undefined;
  };

  const cfg: AgentDef = {
    ...current,
    id: slug,
    name,
    type: "local",
    role: $a<HTMLInputElement>("agent-role").value.trim() || undefined,
    systemPrompt: $a<HTMLTextAreaElement>("agent-prompt").value || undefined,
    model_provider: mProvider,
    model_name: mName,
    apps: current.apps || [],
    skills: current.skills || [],
    guardrails: {
      max_turns: num("agent-guard-turns"),
      max_tokens_per_session: num("agent-guard-tokens"),
      auto_stop_idle_seconds: num("agent-guard-idle"),
    },
  };
  if (!isNew && idChanged) await window.yo.agentsRemove(current.id);
  await window.yo.agentsSave(cfg);
  await loadAgents();
}

// ── Init ────────────────────────────────────────────────────

function initAgents(): void {
  const search = $a<HTMLInputElement>("agent-search");
  if (!search) return; // section not in this panel
  search.addEventListener("input", () => { agentsPage = 1; renderAgentsList(); });
  $a("agent-new-btn").addEventListener("click", () => { void openEditor(null); });
  $a("agent-back-link").addEventListener("click", () => { void loadAgents(); });
  $a("agent-cancel-btn").addEventListener("click", () => { void loadAgents(); });
  $a("agent-save-btn").addEventListener("click", () => { void saveAgent(); });
  $a("agent-delete-btn").addEventListener("click", async () => {
    if (!current || isNew) return;
    if (!(await confirmAction(`Delete agent "${current.name || current.id}"?`))) return;
    await window.yo.agentsRemove(current.id);
    await loadAgents();
  });
  $a("agent-apps-add").addEventListener("click", () => showPicker("apps"));
  $a("agent-skills-add").addEventListener("click", () => showPicker("skills"));
}

export { loadAgents, initAgents };
