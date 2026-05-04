/**
 * Council — multi-LLM debate panel.
 *
 * Two views in one app:
 *  - form: configure a council (name, topic, style, round cap, members)
 *  - layout: spectator surface — left stream (chat-style transcript), right
 *    roster (badges + status). The user drives rounds + interjections from
 *    their .yo panel via substrate council tools; this app is read-only
 *    *for the council itself* (the form is editable until "Convene" fires).
 *
 * Stop button lives in the .yo, not here. `End council` on the topbar tears
 * the session down (releases members, returns to form view).
 */

import { formatMarkdown } from "./format-markdown";

interface CouncilEvent {
  council_id: string;
  kind: "member_ready" | "round_start" | "agent_turn_start" | "agent_token"
      | "agent_turn_end" | "round_end" | "moderator" | "stopped" | "error" | "summary";
  member_id?: string;
  round?: number;
  text?: string;
  error?: string;
}

interface Model {
  provider: string; model: string; display_name: string;
  yos_per_1k_input: number; yos_per_1k_output: number;
}

interface CouncilAPI {
  modelsList: () => Promise<{ models?: Model[]; error?: string }>;
  authMe: () => Promise<{ id?: string; email?: string; error?: string }>;
  councilCreate: (config: {
    name: string;
    council_prompt: string;
    style: "chained" | "free_for_all" | "debate";
    round_cap: number;
    members: Array<{ provider: string; model: string; startup_prompt: string }>;
  }) => Promise<{ ok: boolean; council_id?: string; error?: string }>;
  councilStop: (id: string) => Promise<{ ok: boolean; error?: string }>;
  councilEnd: (id: string) => Promise<{ ok: boolean; error?: string }>;
  councilSetCurrent: (id: string | null) => Promise<{ ok: boolean }>;
  onCouncilEvent: (cb: (event: CouncilEvent) => void) => () => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}
const council = (window as unknown as { council: CouncilAPI }).council;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const $i = (id: string) => document.getElementById(id) as HTMLInputElement;
const $t = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// ── State ──────────────────────────────────────────────

let modelsCache: Model[] = [];
const formState = {
  style: "chained" as "chained" | "free_for_all" | "debate",
  members: [] as Array<{ provider: string; model: string; startup_prompt: string }>,
};
const layoutState = {
  councilId: null as string | null,
  name: "",
  members: [] as Array<{ id: string; provider: string; model: string }>,
  focused: null as string | null,        // null = group view; else member id
  status: "configuring" as "configuring" | "ready" | "running" | "stopped" | "ended",
  unsubscribeEvents: null as (() => void) | null,
  /** Per-member running stream buffer keyed by member id. Used to render
   *  in-progress messages and persist the full transcript for replay. */
  members_status: new Map<string, "idle" | "engaging" | "done" | "error">(),
};
const memberRawText = new Map<string, string>();

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const memberSpinners = new Map<HTMLElement, ReturnType<typeof setInterval>>();

function startMemberSpinner(el: HTMLElement): void {
  let fi = 0;
  const iv = setInterval(() => { fi = (fi + 1) % BRAILLE.length; el.textContent = BRAILLE[fi]; }, 80);
  memberSpinners.set(el, iv);
}

function stopMemberSpinner(el: HTMLElement): void {
  const iv = memberSpinners.get(el);
  if (iv) { clearInterval(iv); memberSpinners.delete(el); }
  el.remove();
}

// Per-message DOM refs so token streams append to the right element
const messageEls = new Map<string, HTMLElement>();

// ── Form view ──────────────────────────────────────────

function brandFor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.startsWith("anthropic") || p === "claude") return "anthropic";
  if (p.startsWith("openai") || p === "gpt") return "openai";
  if (p.startsWith("google") || p === "gemini") return "google";
  if (p.startsWith("xai") || p === "grok") return "xai";
  if (p.startsWith("perplexity") || p === "pplx") return "perplexity";
  return "generic";
}

function badgeLetterFor(provider: string, model: string): string {
  const b = brandFor(provider);
  if (b === "anthropic") return "C";
  if (b === "openai") return "G";
  if (b === "google") return "✦";
  if (b === "xai") return "X";
  if (b === "perplexity") return "P";
  return (model || provider || "?").charAt(0).toUpperCase();
}

function renderMembers(): void {
  const list = $("cf-members");
  list.innerHTML = "";

  // Group models by provider for the dropdowns
  const byProvider = new Map<string, Model[]>();
  for (const m of modelsCache) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }

  for (let i = 0; i < formState.members.length; i++) {
    const member = formState.members[i];
    const row = document.createElement("div");
    row.className = "member-row";

    // Provider select
    const providerSel = document.createElement("select");
    providerSel.innerHTML = `<option value="">Provider</option>` +
      Array.from(byProvider.keys()).map((p) =>
        `<option value="${escapeHtml(p)}" ${p === member.provider ? "selected" : ""}>${escapeHtml(p)}</option>`
      ).join("");
    providerSel.addEventListener("change", () => {
      formState.members[i] = { ...formState.members[i], provider: providerSel.value, model: "" };
      renderMembers();
    });
    row.appendChild(providerSel);

    // Model select (filtered to provider)
    const modelSel = document.createElement("select");
    const models = byProvider.get(member.provider) ?? [];
    modelSel.innerHTML = `<option value="">Model</option>` +
      models.map((m) =>
        `<option value="${escapeHtml(m.model)}" ${m.model === member.model ? "selected" : ""}>${escapeHtml(m.display_name)}</option>`
      ).join("");
    modelSel.addEventListener("change", () => {
      formState.members[i] = { ...formState.members[i], model: modelSel.value };
    });
    row.appendChild(modelSel);

    // Startup prompt textarea
    const prompt = document.createElement("textarea");
    prompt.placeholder = "System / startup prompt for this member (e.g. \"You're a database performance specialist. Argue from first principles.\")";
    prompt.value = member.startup_prompt;
    prompt.addEventListener("input", () => {
      formState.members[i] = { ...formState.members[i], startup_prompt: prompt.value };
    });
    row.appendChild(prompt);

    // Remove button
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "member-remove";
    remove.textContent = "×";
    remove.title = "Remove member";
    remove.addEventListener("click", () => {
      formState.members.splice(i, 1);
      renderMembers();
    });
    row.appendChild(remove);

    list.appendChild(row);
  }

  // Toggle add button enabled state
  ($("cf-add-member") as HTMLButtonElement).disabled = formState.members.length >= 10;
}

function setStyleChip(style: typeof formState.style): void {
  formState.style = style;
  document.querySelectorAll<HTMLElement>("#cf-style .chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.chip === style);
  });
}

function clearFormError(): void { const e = $("cf-error"); e.classList.add("hidden"); e.textContent = ""; }
function showFormError(msg: string): void { const e = $("cf-error"); e.textContent = msg; e.classList.remove("hidden"); }

async function convene(): Promise<void> {
  clearFormError();
  const name = $i("cf-name").value.trim();
  const prompt = $t("cf-prompt").value.trim();
  const roundCap = Math.max(1, Math.min(20, parseInt($i("cf-round-cap").value, 10) || 3));

  if (!name) { showFormError("Council name required"); return; }
  if (!prompt) { showFormError("Council prompt required"); return; }
  if (formState.members.length < 2) { showFormError("Need at least 2 members for a council"); return; }
  for (let i = 0; i < formState.members.length; i++) {
    const m = formState.members[i];
    if (!m.provider || !m.model) {
      showFormError(`Member ${i + 1}: provider and model required`);
      return;
    }
    if (!m.startup_prompt.trim()) {
      showFormError(`Member ${i + 1}: startup prompt required`);
      return;
    }
  }

  const r = await council.councilCreate({
    name, council_prompt: prompt, style: formState.style,
    round_cap: roundCap, members: formState.members,
  });
  if (!r.ok || !r.council_id) {
    showFormError(r.error || "Convene failed");
    return;
  }
  enterLayout(r.council_id, name);
}

// ── Layout view ────────────────────────────────────────

function enterLayout(councilId: string, name: string): void {
  layoutState.councilId = councilId;
  layoutState.name = name;
  layoutState.status = "ready";
  layoutState.focused = null;
  layoutState.members = formState.members.map((m) => ({
    id: `${m.provider}/${m.model}`,
    provider: m.provider,
    model: m.model,
  }));
  layoutState.members_status.clear();
  for (const m of layoutState.members) layoutState.members_status.set(m.id, "idle");
  messageEls.clear();

  $("view-form").classList.add("hidden");
  $("view-layout").classList.remove("hidden");
  $("council-status").classList.remove("hidden");
  $("council-name-pill").classList.remove("hidden");
  $("council-name-pill").textContent = name;
  $("btn-end-council").classList.remove("hidden");

  setTopbarStatus("Ready");
  renderRoster();

  const prompt = $t("cf-prompt").value.trim();
  $("stream-body").innerHTML = "";
  if (prompt) {
    const topicEl = document.createElement("div");
    topicEl.className = "msg system council-topic";
    topicEl.innerHTML = `<div class="msg-head"><span class="who">Topic</span></div><div class="msg-body">${escapeHtml(prompt)}</div>`;
    $("stream-body").appendChild(topicEl);
  }

  // Subscribe to events from main
  if (layoutState.unsubscribeEvents) layoutState.unsubscribeEvents();
  layoutState.unsubscribeEvents = council.onCouncilEvent(handleCouncilEvent);

  // Tell main "this council is current" so .yo's council tools light up
  void council.councilSetCurrent(councilId);
}

async function endCouncil(): Promise<void> {
  if (!layoutState.councilId) return;
  if (!confirm("End this council? In-flight responses are stopped and the session terminates.")) return;
  await council.councilEnd(layoutState.councilId).catch(() => {});
  void council.councilSetCurrent(null);
  if (layoutState.unsubscribeEvents) layoutState.unsubscribeEvents();
  layoutState.unsubscribeEvents = null;
  layoutState.councilId = null;
  layoutState.status = "ended";

  $("view-layout").classList.add("hidden");
  $("view-form").classList.remove("hidden");
  $("council-status").classList.add("hidden");
  $("council-name-pill").classList.add("hidden");
  $("btn-end-council").classList.add("hidden");
}

function setTopbarStatus(text: string): void {
  $("council-status-text").textContent = text;
}

function renderRoster(): void {
  const body = $("roster-body");
  body.innerHTML = "";
  for (const m of layoutState.members) {
    const status = layoutState.members_status.get(m.id) ?? "idle";
    const tile = document.createElement("div");
    tile.className = "member-tile" + (m.id === layoutState.focused ? " active" : "");
    tile.innerHTML = `
      <div class="member-badge brand-${brandFor(m.provider)}">
        ${escapeHtml(badgeLetterFor(m.provider, m.model))}
        <span class="member-status-dot ${status}"></span>
      </div>
      <div class="member-meta">
        <div class="member-name">${escapeHtml(m.model)}</div>
        <div class="member-sub">${escapeHtml(m.provider)}</div>
      </div>
    `;
    tile.addEventListener("click", () => {
      layoutState.focused = layoutState.focused === m.id ? null : m.id;
      renderRoster();
      renderStream();
    });
    body.appendChild(tile);
  }
  $("roster-head-title").textContent = layoutState.focused
    ? `Member`
    : "Members";
  $("roster-back").classList.toggle("hidden", layoutState.focused === null);
}

function renderStream(): void {
  // When focused on a member, hide messages from others.
  const body = $("stream-body");
  for (const el of Array.from(body.children) as HTMLElement[]) {
    const memberId = el.dataset.member;
    if (!memberId) continue; // empty state / system rows always visible
    el.style.display = !layoutState.focused || layoutState.focused === memberId ? "" : "none";
  }
  $("stream-title").textContent = layoutState.focused
    ? layoutState.focused.split("/")[1]
    : "Group discussion";
}

// ── Event handling ─────────────────────────────────────

function handleCouncilEvent(ev: CouncilEvent): void {
  if (!layoutState.councilId || ev.council_id !== layoutState.councilId) return;
  switch (ev.kind) {
    case "member_ready": {
      if (ev.member_id) layoutState.members_status.set(ev.member_id, "idle");
      renderRoster();
      break;
    }
    case "round_start": {
      setTopbarStatus(`Round ${ev.round ?? "?"} — running`);
      appendSystemMessage(`Round ${ev.round} begins`);
      // Reset all to idle (they're about to engage in turn)
      for (const m of layoutState.members) layoutState.members_status.set(m.id, "idle");
      renderRoster();
      break;
    }
    case "agent_turn_start": {
      if (!ev.member_id) break;
      layoutState.members_status.set(ev.member_id, "engaging");
      memberRawText.set(ev.member_id, "");
      renderRoster();
      const id = `${ev.member_id}-${ev.round ?? 0}-${Date.now()}`;
      const el = createMessageEl(id, ev.member_id, ev.round, "member");
      messageEls.set(id, el);
      messageEls.set(`current:${ev.member_id}`, el);
      break;
    }
    case "agent_token": {
      if (!ev.member_id || !ev.text) break;
      memberRawText.set(ev.member_id, (memberRawText.get(ev.member_id) ?? "") + ev.text);
      const el = messageEls.get(`current:${ev.member_id}`);
      if (!el) break;
      const bodyEl = el.querySelector(".msg-body");
      if (!bodyEl) break;
      const spinner = bodyEl.querySelector(".yo-ag-spinner");
      if (spinner) stopMemberSpinner(spinner as HTMLElement);
      bodyEl.appendChild(document.createTextNode(ev.text));
      const stream = $("stream-body");
      if (stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 50) {
        stream.scrollTop = stream.scrollHeight;
      }
      break;
    }
    case "agent_turn_end": {
      if (!ev.member_id) break;
      layoutState.members_status.set(ev.member_id, "done");
      const el = messageEls.get(`current:${ev.member_id}`);
      if (el) {
        const spinner = el.querySelector(".yo-ag-spinner");
        if (spinner) stopMemberSpinner(spinner as HTMLElement);
        const bodyEl = el.querySelector(".msg-body");
        if (bodyEl) {
          const raw = memberRawText.get(ev.member_id) || ev.text || "";
          if (raw.startsWith("[") && raw.includes("unavailable")) {
            bodyEl.textContent = raw;
            el.classList.add("msg-error");
          } else if (raw) {
            bodyEl.innerHTML = formatMarkdown(raw);
          }
        }
      }
      memberRawText.delete(ev.member_id);
      messageEls.delete(`current:${ev.member_id}`);
      renderRoster();
      break;
    }
    case "round_end": {
      setTopbarStatus(`Round ${ev.round ?? "?"} complete`);
      break;
    }
    case "moderator": {
      appendModeratorMessage(ev.text ?? "");
      break;
    }
    case "stopped": {
      setTopbarStatus("Stopped");
      for (const m of layoutState.members) {
        if (layoutState.members_status.get(m.id) === "engaging") {
          layoutState.members_status.set(m.id, "idle");
        }
      }
      renderRoster();
      break;
    }
    case "summary": {
      appendSystemMessage("─── Council summary ───");
      const el = createMessageEl("summary", null, undefined, "summary");
      const bodyEl = el.querySelector(".msg-body")!;
      bodyEl.innerHTML = formatMarkdown(ev.text ?? "");
      setTopbarStatus("Summarized");
      break;
    }
    case "error": {
      if (ev.member_id) {
        const el = messageEls.get(`current:${ev.member_id}`);
        if (el) {
          const bodyEl = el.querySelector(".msg-body");
          if (bodyEl) {
            const cursor = bodyEl.querySelector(".cursor");
            if (cursor) cursor.remove();
            const errSpan = document.createElement("span");
            errSpan.className = "inline-error";
            errSpan.textContent = ev.error ?? "unknown error";
            bodyEl.appendChild(errSpan);
          }
          el.classList.add("msg-error");
          layoutState.members_status.set(ev.member_id, "error");
          renderRoster();
        } else {
          appendSystemMessage(`${ev.member_id}: ${ev.error ?? "unknown"}`);
        }
      } else {
        appendSystemMessage(`Error: ${ev.error ?? "unknown"}`);
      }
      break;
    }
  }
}

function createMessageEl(
  id: string,
  memberId: string | null,
  round: number | undefined,
  variant: "member" | "moderator" | "system" | "summary",
): HTMLElement {
  const body = $("stream-body");
  // Clear empty state
  const empty = body.querySelector(".stream-empty");
  if (empty) empty.remove();

  const wrap = document.createElement("div");
  wrap.className = "msg" + (variant === "moderator" ? " moderator" : variant === "system" ? " system" : "");
  if (memberId) wrap.dataset.member = memberId;
  wrap.dataset.id = id;

  const head = document.createElement("div");
  head.className = "msg-head";
  if (memberId) {
    const member = layoutState.members.find((m) => m.id === memberId);
    head.innerHTML = `
      <span class="who">${escapeHtml(member?.model || memberId)}</span>
      <span class="role">${escapeHtml(member?.provider || "")}</span>
      ${round ? `<span class="round">round ${round}</span>` : ""}
    `;
  } else {
    head.innerHTML = `<span class="who">${variant === "moderator" ? "Moderator" : variant === "summary" ? "Summary" : "System"}</span>`;
  }
  wrap.appendChild(head);

  const bodyEl = document.createElement("div");
  bodyEl.className = "msg-body";
  if (variant === "member") {
    const spinner = document.createElement("span");
    spinner.className = "yo-ag-spinner";
    spinner.textContent = "⠋";
    bodyEl.appendChild(spinner);
    startMemberSpinner(spinner);
  }
  wrap.appendChild(bodyEl);

  // Respect current focus filter
  if (layoutState.focused && memberId && memberId !== layoutState.focused) {
    wrap.style.display = "none";
  }

  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
  return wrap;
}

function appendModeratorMessage(text: string): void {
  const id = `mod-${Date.now()}`;
  const el = createMessageEl(id, null, undefined, "moderator");
  el.querySelector(".msg-body")!.textContent = text;
}

function appendSystemMessage(text: string): void {
  const id = `sys-${Date.now()}`;
  const el = createMessageEl(id, null, undefined, "system");
  el.querySelector(".msg-body")!.textContent = text;
}

// ── Init ──────────────────────────────────────────────

async function init(): Promise<void> {
  // Load models for the picker
  try {
    const r = await council.modelsList();
    if (r && "models" in r && Array.isArray(r.models)) modelsCache = r.models;
  } catch { modelsCache = []; }

  // Two starter members so the form isn't empty
  formState.members = [
    { provider: "", model: "", startup_prompt: "" },
    { provider: "", model: "", startup_prompt: "" },
  ];
  setStyleChip("chained");
  renderMembers();

  // Form events
  $("cf-add-member").addEventListener("click", () => {
    if (formState.members.length >= 10) return;
    formState.members.push({ provider: "", model: "", startup_prompt: "" });
    renderMembers();
  });
  document.querySelectorAll<HTMLElement>("#cf-style .chip").forEach((el) => {
    el.addEventListener("click", () => setStyleChip(el.dataset.chip as typeof formState.style));
  });
  $("cf-save").addEventListener("click", () => { void convene(); });

  // Layout events
  $("btn-end-council").addEventListener("click", () => { void endCouncil(); });
  $("roster-back").addEventListener("click", () => {
    layoutState.focused = null;
    renderRoster();
    renderStream();
  });
}

void init();
