/**
 * Dashboard section — charts, prompts, token stats.
 */

import {
  cssVar, formatTokens, formatBytes, relativeTime,
  buildPaginationBar, formatDuration, confirmAction,
} from "./shared.js";
import { loadData, closeDataDetail, deleteDataEntry, clearData, dataSearchDebounce } from "./data-store.js";

declare const Chart: any;

async function getTimezone(): Promise<string> {
  const pref = await window.yo.getPreference("timezone", "auto") as string;
  return pref === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : pref;
}

function dateKeyInTz(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

let dashAgentChart: any = null;
let dashHistoryChart: any = null;
let dashIntakeChart: any = null;
let dashFlowChart: any = null;
let dashActivityChart: any = null;
let dashRangeMode: "7" | "30" = "7";
let dashActivityRange: "7" | "30" = "7";
let storeRangeMode: "7" | "30" = "7";

// Phase 7 of THE-PIVOT-BYOK rewires the dashboard's token stats to
// the local UsageTracker (yo-server's /api/usage/summary is gone).
// Daily granularity stays at UTC for now since the local tracker
// keys on the local-machine date.

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "#a855f7", navigator: "#48dbfb", researcher: "#feca57",
  coder: "#ff6b6b", "skill-runner": "#cc5de8", manager: "#ff9f43",
};
const AGENT_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator", navigator: "Navigator", researcher: "Researcher",
  coder: "Coder", "skill-runner": "Skill Runner", manager: "Manager",
};

export async function loadDashboard() {
  ensureDashTabs();
  void loadHome();
  const tz = await getTimezone();
  const todayKey = dateKeyInTz(new Date(), tz);
  const [usage, allTime, llmInfo, captureStats] = await Promise.all([
    window.yo.userUsage({ from: "2020-01-01", to: todayKey, tz }), // server-authoritative credits
    window.yo.dashboardAllTime(),                                  // still feeds the per-agent chart
    window.yo.dashboardLLMInfo(),
    window.yo.capturesStats(),
  ]);

  document.getElementById("dash-provider")!.textContent = `${llmInfo.provider} / ${llmInfo.model}`;

  // Usage shown to users is CREDITS, sourced from the server (authoritative
  // metered spend). Tokens are Glyphh-internal — only the super-admin platform
  // view surfaces them.
  let allCredits = 0, allRequests = 0, todayCredits = 0, todayRequests = 0;
  for (const d of (usage?.days || []) as Array<{ day: string; credits: number; requests: number }>) {
    allCredits += d.credits || 0;
    allRequests += d.requests || 0;
    if (d.day === todayKey) { todayCredits = d.credits || 0; todayRequests = d.requests || 0; }
  }
  const fmtCredits = (micro: number) => Math.round(micro / 1_000_000).toLocaleString();
  document.getElementById("dash-today-input")!.textContent = fmtCredits(todayCredits);
  document.getElementById("dash-today-calls")!.textContent = String(todayRequests);
  document.getElementById("dash-alltime-input")!.textContent = fmtCredits(allCredits);
  document.getElementById("dash-alltime-calls")!.textContent = String(allRequests);

  document.getElementById("dash-captures")!.textContent = String(captureStats.count);
  document.getElementById("dash-embedded")!.textContent = String(captureStats.embeddedCount);
  document.getElementById("dash-sources")!.textContent = String(Object.keys(captureStats.sources).length);
  document.getElementById("dash-disk")!.textContent = formatBytes(captureStats.diskBytes);
  document.getElementById("dash-oldest")!.textContent = relativeTime(captureStats.oldestTs);
  document.getElementById("dash-newest")!.textContent = relativeTime(captureStats.newestTs);

  renderDashActivityChart();
  renderDashAgentChart(allTime);
  renderDashHistoryChart();
  renderDashFlowChart(captureStats);
  renderDashIntakeChart();
}

// Modal-scoped lists load lazily on open, keeping the dashboard landing clean.
const MODAL_LOADERS: Record<string, () => void> = {
  "data-modal": () => loadData(),
  "dash-prompts-modal": () => { dashPromptsOffset = 0; renderDashPrompts(); },
};

function openDashModal(id: string) {
  document.getElementById(id)?.classList.remove("hidden");
  MODAL_LOADERS[id]?.();
}

function closeDashModal(id: string) {
  document.getElementById(id)?.classList.add("hidden");
}

function renderDashAgentChart(allTime: { agents: Record<string, { input: number; output: number; calls: number }>; total: any } | null) {
  const canvas = document.getElementById("dash-chart-agents") as HTMLCanvasElement | null;
  if (!canvas) return;
  const agents = allTime?.agents ? Object.keys(allTime.agents) : [];
  if (agents.length === 0) {
    if (dashAgentChart) { dashAgentChart.destroy(); dashAgentChart = null; }
    return;
  }
  const labels = agents.map(a => AGENT_LABELS[a] || a);
  const data = agents.map(a => (allTime!.agents[a].input || 0) + (allTime!.agents[a].output || 0));
  const colors = agents.map(a => AGENT_COLORS[a] || "#888");

  const ctx = canvas.getContext("2d")!;
  if (dashAgentChart) dashAgentChart.destroy();

  dashAgentChart = new Chart(ctx, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "65%",
      plugins: {
        legend: { position: "right", labels: { color: cssVar("--text-2"), font: { size: 11 }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
        tooltip: { callbacks: { label: (c: any) => `${c.label}: ${formatTokens(c.parsed)} tokens` } },
      },
    },
  });
}

async function renderDashActivityChart() {
  const days = parseInt(dashActivityRange);
  const tz = await getTimezone();
  const canvas = document.getElementById("dash-chart-activity") as HTMLCanvasElement | null;
  if (!canvas) return;

  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  const [usage, captures] = await Promise.all([
    window.yo.userUsage({ from: dateKeyInTz(fromDate, tz), to: dateKeyInTz(now, tz), tz }),
    window.yo.capturesDailyHistory(days),
  ]);
  const usageMap = new Map((usage?.days || []).map((d: any) => [d.day, d]));
  const capMap = new Map((captures || []).map((d: any) => [d.date, d]));

  const labels: string[] = [];
  const creditsData: number[] = [];
  const promptsData: number[] = [];
  const capturesData: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dateKeyInTz(d, tz);
    labels.push(d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" }));
    const u: any = usageMap.get(key);
    creditsData.push((u?.credits || 0) / 1_000_000); // micro-credits → credits
    promptsData.push(u?.requests || 0);
    capturesData.push((capMap.get(key) as any)?.count || 0);
  }

  const ctx = canvas.getContext("2d")!;
  if (dashActivityChart) dashActivityChart.destroy();

  const mkLine = (label: string, data: number[], axis: string, color: string, fillAlpha: number) => ({
    label, data, yAxisID: axis,
    borderColor: color,
    backgroundColor: fillAlpha ? color.replace("rgb", "rgba").replace(")", `,${fillAlpha})`) : "transparent",
    fill: fillAlpha > 0, tension: 0.35, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12,
  });

  dashActivityChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        mkLine("Credits", creditsData, "y", "rgb(168, 85, 247)", 0.12),
        mkLine("Prompts", promptsData, "y1", "rgb(72,219,251)", 0),
        mkLine("Captures", capturesData, "y1", "rgb(204,93,232)", 0),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: cssVar("--text-3"), font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: cssVar("--border") } },
        y: { position: "left", beginAtZero: true, ticks: { color: cssVar("--accent"), font: { size: 10 }, callback: (v: string | number) => Number(v).toLocaleString() }, grid: { color: cssVar("--border") }, title: { display: true, text: "Credits", color: cssVar("--text-3"), font: { size: 10 } } },
        y1: { position: "right", beginAtZero: true, ticks: { color: cssVar("--text-3"), font: { size: 10 }, precision: 0 }, grid: { drawOnChartArea: false }, title: { display: true, text: "Activity", color: cssVar("--text-3"), font: { size: 10 } } },
      },
      plugins: {
        legend: { labels: { color: cssVar("--text-2"), font: { size: 11 }, usePointStyle: true, pointStyleWidth: 14, padding: 16 } },
        tooltip: { callbacks: { label: (c: any) => c.dataset.label === "Credits" ? `Credits: ${Number(c.parsed.y).toLocaleString()}` : `${c.dataset.label}: ${c.parsed.y}` } },
      },
    },
  });
}

async function renderDashHistoryChart() {
  const days = parseInt(dashRangeMode);
  const tz = await getTimezone();
  const canvas = document.getElementById("dash-chart-history") as HTMLCanvasElement | null;
  if (!canvas) return;

  // Credits per day, sourced from the SERVER (authoritative metered usage), not
  // the local token tracker. Users see credits; tokens are Glyphh-internal.
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  const res = await window.yo.userUsage({ from: dateKeyInTz(fromDate, tz), to: dateKeyInTz(now, tz), tz });
  const serverDays = res?.days || [];
  if (serverDays.length === 0) {
    if (dashHistoryChart) { dashHistoryChart.destroy(); dashHistoryChart = null; }
    return;
  }

  const dateMap = new Map(serverDays.map((d: any) => [d.day, d]));
  const labels: string[] = [];
  const creditsData: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dateKeyInTz(d, tz);
    labels.push(d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" }));
    const entry: any = dateMap.get(key);
    creditsData.push((entry?.credits || 0) / 1_000_000); // micro-credits → credits
  }

  const ctx = canvas.getContext("2d")!;
  if (dashHistoryChart) dashHistoryChart.destroy();

  dashHistoryChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Credits", data: creditsData, borderColor: "#a855f7", backgroundColor: "rgba(168, 85, 247,0.12)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0, pointHitRadius: 10 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: cssVar("--text-3"), font: { size: 10 }, maxRotation: 0 }, grid: { color: cssVar("--border") } },
        y: { ticks: { color: cssVar("--text-3"), font: { size: 10 }, callback: (v: string | number) => Number(v).toLocaleString() }, grid: { color: cssVar("--border") } },
      },
      plugins: {
        legend: { labels: { color: cssVar("--text-2"), font: { size: 11 }, usePointStyle: true, pointStyleWidth: 14, padding: 16 } },
        tooltip: { callbacks: { label: (c: any) => `Credits: ${Number(c.parsed.y).toLocaleString()}` } },
      },
    },
  });
}

async function renderDashIntakeChart() {
  const days = storeRangeMode === "30" ? 30 : 7;
  const canvas = document.getElementById("dash-chart-intake") as HTMLCanvasElement | null;
  if (!canvas) return;

  const history = await window.yo.capturesDailyHistory(days);

  const labels = history.map((d: any) => {
    const dt = new Date(d.date + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
  const countData = history.map((d: any) => d.count);
  const bytesData = history.map((d: any) => d.bytes);

  const ctx = canvas.getContext("2d")!;
  if (dashIntakeChart) dashIntakeChart.destroy();

  dashIntakeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Captures", data: countData, backgroundColor: "rgba(168, 85, 247,0.6)", borderRadius: 3, yAxisID: "y" },
        { label: "Bytes", data: bytesData, backgroundColor: "rgba(72,219,251,0.35)", borderRadius: 3, yAxisID: "y1" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: cssVar("--text-3"), font: { size: 10 }, maxRotation: 0 }, grid: { color: cssVar("--border") } },
        y: { position: "left", ticks: { color: cssVar("--accent"), font: { size: 10 }, stepSize: 1 }, grid: { color: cssVar("--border") }, title: { display: false } },
        y1: { position: "right", ticks: { color: "#48dbfb", font: { size: 10 }, callback: (v: string | number) => formatBytes(Number(v)) }, grid: { drawOnChartArea: false } },
      },
      plugins: {
        legend: { labels: { color: cssVar("--text-2"), font: { size: 11 }, usePointStyle: true, pointStyleWidth: 14, padding: 16 } },
        tooltip: { callbacks: { label: (c: any) => c.dataset.label === "Bytes" ? `${c.dataset.label}: ${formatBytes(c.parsed.y)}` : `${c.dataset.label}: ${c.parsed.y}` } },
      },
    },
  });
}

function renderDashFlowChart(captureStats: { ingestCount: number; searchCount: number; ingestBytes: number; count: number; embeddedCount: number }) {
  const canvas = document.getElementById("dash-chart-flow") as HTMLCanvasElement | null;
  if (!canvas) return;

  const ctx = canvas.getContext("2d")!;
  if (dashFlowChart) dashFlowChart.destroy();

  const supVal = captureStats.ingestCount || captureStats.count || 0;
  const yoVal = captureStats.searchCount || 0;
  const embedded = captureStats.embeddedCount || 0;

  const hasData = supVal > 0 || yoVal > 0;

  dashFlowChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: hasData ? [".sup  (captures in)", ".yo  (searches out)", "Embedded"] : ["No activity yet"],
      datasets: [{
        data: hasData ? [supVal, yoVal, embedded] : [1],
        backgroundColor: hasData ? ["#a855f7", "#48dbfb", "#cc5de8"] : [cssVar("--border")],
        borderColor: hasData ? ["#7e22ce", "#2a9abf", "#8a3d9e"] : [cssVar("--border-3")],
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "60%",
      plugins: {
        legend: {
          position: "right",
          labels: { color: cssVar("--text-2"), font: { size: 11 }, usePointStyle: true, pointStyleWidth: 10, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (c: any) => {
              if (!hasData) return "No data yet";
              const total = (c.dataset.data as number[]).reduce((a: number, b: number) => a + b, 0);
              const pct = total > 0 ? ((c.parsed / total) * 100).toFixed(0) : "0";
              return `${c.label}: ${c.parsed} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

let dashPromptsOffset = 0;
const PROMPTS_PAGE_SIZE = 20;

async function renderDashPrompts() {
  const query = (document.getElementById("dash-prompts-search") as HTMLInputElement)?.value.trim() || "";
  const container = document.getElementById("dash-prompts-list")!;

  let entries: Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; model: string; provider: string; mode: string; toolsUsed: string[] }>;
  let total = 0;

  if (query) {
    entries = await window.yo.promptsSearch(query, 200);
    total = entries.length;
    entries = entries.slice(dashPromptsOffset, dashPromptsOffset + PROMPTS_PAGE_SIZE);
  } else {
    [entries, total] = await Promise.all([
      window.yo.promptsList(dashPromptsOffset, PROMPTS_PAGE_SIZE),
      window.yo.promptsCount(),
    ]);
  }

  container.innerHTML = "";
  if (entries.length === 0) {
    container.innerHTML = `<div class="dash-empty-hint">${query ? "No prompts matching search." : "No prompts yet."}</div>`;
    return;
  }

  for (const e of entries) {
    const card = document.createElement("div");
    card.className = "crud-card";
    card.style.cursor = "pointer";

    const info = document.createElement("div");
    info.className = "crud-card-info";
    info.style.cssText = "min-width:0;";

    const nameRow = document.createElement("div");
    nameRow.style.cssText = "display:flex;gap:6px;align-items:center;";

    const promptSnip = document.createElement("span");
    promptSnip.className = "crud-card-name";
    promptSnip.textContent = e.prompt.slice(0, 80).replace(/\n/g, " ");
    nameRow.appendChild(promptSnip);

    const timeSpan = document.createElement("span");
    timeSpan.style.cssText = "font-size:10px;color:var(--text-muted);flex-shrink:0;";
    timeSpan.textContent = relativeTime(e.startTs);
    nameRow.appendChild(timeSpan);
    // No per-prompt token chip — tokens are Glyphh-internal, not shown to users.

    info.appendChild(nameRow);

    const meta = document.createElement("span");
    meta.className = "crud-card-meta";
    meta.textContent = e.response.slice(0, 120).replace(/\n/g, " ");
    meta.style.cssText = "display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;";
    info.appendChild(meta);

    card.appendChild(info);
    card.addEventListener("click", () => openDashPromptDetail(e.id));
    container.appendChild(card);
  }

  if (total > PROMPTS_PAGE_SIZE) {
    container.appendChild(buildPaginationBar(dashPromptsOffset, PROMPTS_PAGE_SIZE, total, (newOffset) => {
      dashPromptsOffset = newOffset;
      renderDashPrompts();
    }));
  }
}

async function openDashPromptDetail(id: string) {
  const entry = await window.yo.promptsGet(id);
  if (!entry) return;

  const detail = document.getElementById("dash-prompt-detail")!;
  const list = document.getElementById("dash-prompts-list")!;
  const toolbar = document.getElementById("dash-prompts-toolbar")!;

  list.classList.add("hidden");
  toolbar.classList.add("hidden");
  detail.classList.remove("hidden");

  const metaGrid = document.getElementById("dash-prompt-meta")!;
  const duration = entry.endTs - entry.startTs;

  // Tokens (in/out/cache) are Glyphh-internal and intentionally NOT shown here —
  // users reason in credits. Per-prompt credit cost isn't surfaced to the client
  // yet (it's computed server-side after the stream), so the detail omits cost.
  const items = [
    { label: "Model", value: entry.model },
    { label: "Mode", value: entry.mode },
    { label: "Duration", value: formatDuration(duration) },
    { label: "Start", value: new Date(entry.startTs).toLocaleString() },
    { label: "End", value: new Date(entry.endTs).toLocaleString() },
  ];
  if (entry.toolsUsed.length > 0) {
    items.push({ label: "Tools", value: entry.toolsUsed.join(", ") });
  }

  metaGrid.innerHTML = items.map(i =>
    `<div class="dash-meta-item"><div class="dash-meta-label">${i.label}</div><div class="dash-meta-value">${i.value}</div></div>`
  ).join("");

  document.getElementById("dash-prompt-text")!.textContent = entry.prompt;
  document.getElementById("dash-prompt-response")!.textContent = entry.response;
}

export function closeDashPromptDetail() {
  document.getElementById("dash-prompt-detail")!.classList.add("hidden");
  document.getElementById("dash-prompts-list")!.classList.remove("hidden");
  document.getElementById("dash-prompts-toolbar")!.classList.remove("hidden");
}

let dashPromptSearchTimer: ReturnType<typeof setTimeout> | null = null;

export function initDashboardEvents() {
  document.getElementById("dash-refresh")?.addEventListener("click", () => loadDashboard());

  // Delegated modal open/close — triggers carry data-modal-open / data-modal-close.
  document.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement)?.closest("[data-modal-open],[data-modal-close]") as HTMLElement | null;
    if (!target) return;
    const openId = target.getAttribute("data-modal-open");
    const closeId = target.getAttribute("data-modal-close");
    if (openId) openDashModal(openId);
    if (closeId) closeDashModal(closeId);
  });

  document.getElementById("dash-range-7")?.addEventListener("click", () => {
    dashRangeMode = "7";
    document.getElementById("dash-range-7")!.classList.add("active");
    document.getElementById("dash-range-30")!.classList.remove("active");
    renderDashHistoryChart();
  });
  document.getElementById("dash-range-30")?.addEventListener("click", () => {
    dashRangeMode = "30";
    document.getElementById("dash-range-30")!.classList.add("active");
    document.getElementById("dash-range-7")!.classList.remove("active");
    renderDashHistoryChart();
  });

  document.getElementById("dash-activity-range-7")?.addEventListener("click", () => {
    dashActivityRange = "7";
    document.getElementById("dash-activity-range-7")!.classList.add("active");
    document.getElementById("dash-activity-range-30")!.classList.remove("active");
    renderDashActivityChart();
  });
  document.getElementById("dash-activity-range-30")?.addEventListener("click", () => {
    dashActivityRange = "30";
    document.getElementById("dash-activity-range-30")!.classList.add("active");
    document.getElementById("dash-activity-range-7")!.classList.remove("active");
    renderDashActivityChart();
  });

  document.getElementById("store-range-7")?.addEventListener("click", () => {
    storeRangeMode = "7";
    document.getElementById("store-range-7")!.classList.add("active");
    document.getElementById("store-range-30")!.classList.remove("active");
    renderDashIntakeChart();
  });
  document.getElementById("store-range-30")?.addEventListener("click", () => {
    storeRangeMode = "30";
    document.getElementById("store-range-30")!.classList.add("active");
    document.getElementById("store-range-7")!.classList.remove("active");
    renderDashIntakeChart();
  });

  const promptSearch = document.getElementById("dash-prompts-search") as HTMLInputElement;
  promptSearch?.addEventListener("input", () => {
    if (dashPromptSearchTimer) clearTimeout(dashPromptSearchTimer);
    dashPromptSearchTimer = setTimeout(() => { dashPromptsOffset = 0; renderDashPrompts(); }, 300);
  });

  document.getElementById("dash-prompt-back")?.addEventListener("click", closeDashPromptDetail);
  document.getElementById("dash-prompt-cancel")?.addEventListener("click", closeDashPromptDetail);

  // Data store (right column)
  document.getElementById("data-back-link")?.addEventListener("click", () => closeDataDetail());
  document.getElementById("data-delete-btn")?.addEventListener("click", () => deleteDataEntry());
  document.getElementById("data-clear-btn")?.addEventListener("click", () => clearData());
  const dataSearchInput = document.getElementById("data-search") as HTMLInputElement;
  dataSearchInput?.addEventListener("input", () => dataSearchDebounce());
}

// ── Home tab (cowork landing) ───────────────────────────────────────────────
// Two-tab dashboard: Home (credits + per-user usage from the server + cowork
// quick-links) and Dashboard (the detailed local telemetry above).

let dashTabsBound = false;

function ensureDashTabs(): void {
  if (dashTabsBound) return;
  dashTabsBound = true;

  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".dash-tab"));
  const panes = Array.from(document.querySelectorAll<HTMLElement>(".dash-pane"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const which = tab.getAttribute("data-dash-tab");
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panes.forEach((p) => p.classList.toggle("active", p.getAttribute("data-dash-pane") === which));
    });
  }

  // Cowork quick-links jump to the matching help section by clicking its nav
  // item. (The HOME landing no longer renders cowork cards, but the Dashboard
  // pane may still carry data-goto triggers — keep this delegation harmless.)
  for (const card of Array.from(document.querySelectorAll<HTMLElement>(".dash-cowork-card"))) {
    card.addEventListener("click", () => {
      const sec = card.getAttribute("data-goto");
      if (sec) (document.querySelector(`.help-nav-item[data-section="${sec}"]`) as HTMLElement | null)?.click();
    });
  }
}

// HOME landing = a faithful replica of the Glyphh agent composer plus two
// lists (Chat history / Scheduled Tasks). The composer's pickers write the
// SAME shared state the panel composer writes (via the same IPC setters), so
// submitting is simply `yoPanelOpen(folded)` — main opens the panel and runs
// the prompt with whatever model/effort/working-dir is in shared state.

const MICRO = 1_000_000;
const OPEN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

let homeComposerWired = false;
// Files dropped on the home textarea, folded into the prompt on submit as
// `[Attached file: <path>]` lines (mirrors the panel composer).
const homeAttachments: string[] = [];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
function isoToMs(iso: string): number {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
}
function prettyHomeModel(model: string): string {
  if (!model) return "Default";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
  }
  return model;
}

async function loadHome(): Promise<void> {
  wireHomeComposer();
  await renderHomeLists();
}

// ── Home composer wiring ────────────────────────────────────────────────────
// Each control calls the SAME IPC setter the panel composer uses; we can't
// reach the panel's live JS (separate BrowserView), so we replicate the markup
// + setters. Submit reuses `yoPanelOpen`, which clears to a new chat, opens the
// panel, and runs the prompt with the shared model/effort/working-dir/drips.

function wireHomeComposer(): void {
  if (homeComposerWired) return;
  const composer = document.getElementById("home-composer");
  if (!composer) return;
  homeComposerWired = true;

  wireHomePerm();
  void wireHomeModel();
  wireHomeEffort();
  wireHomeWorkdir();
  wireHomeDrip();
  wireHomeInput();

  // Close all open menus on outside click.
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    for (const id of ["home-perm-dropdown", "home-model-dropdown", "home-effort-dropdown"]) {
      const dd = document.getElementById(id);
      const menu = dd?.querySelector(".yo-mode-menu");
      if (dd && menu && !dd.contains(t)) menu.classList.add("hidden");
    }
  });
}

const HOME_PERM_ICONS: Record<string, string> = {
  default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  plan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
  acceptEdits: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  bypassPermissions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};
const HOME_PERM_LABELS: Record<string, string> = {
  default: "ask", plan: "plan", acceptEdits: "auto", bypassPermissions: "bypass",
};

function wireHomePerm(): void {
  const trigger = document.getElementById("home-perm-trigger");
  const menu = document.getElementById("home-perm-menu");
  if (!trigger || !menu) return;
  const options = menu.querySelectorAll<HTMLElement>(".yo-perm-option");
  const paint = (perm: string) => {
    const icon = trigger.querySelector(".yo-perm-icon");
    const label = trigger.querySelector(".yo-perm-label");
    if (icon) icon.innerHTML = HOME_PERM_ICONS[perm] || HOME_PERM_ICONS.default;
    if (label) label.textContent = HOME_PERM_LABELS[perm] || perm;
    options.forEach((o) => o.classList.toggle("active", o.dataset.value === perm));
  };
  // Seed from shared agent-mode state (same source the panel reads).
  void window.yo.getAgentMode().then(({ perm }) => paint(perm || "default")).catch(() => paint("default"));
  trigger.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
  options.forEach((o) => o.addEventListener("click", () => {
    const value = o.dataset.value || "default";
    paint(value);
    window.yo.setAgentMode(value);   // shared setter — same as the panel
    menu.classList.add("hidden");
  }));
  window.yo.onAgentModeChanged?.((mode: string) => paint(mode));
}

async function wireHomeModel(): Promise<void> {
  const trigger = document.getElementById("home-model-trigger");
  const menu = document.getElementById("home-model-menu");
  if (!trigger || !menu) return;
  let currentModel = "";
  try {
    const cfg = await window.yo.getLLMConfig();
    currentModel = (cfg?.model && cfg.provider === "anthropic") ? cfg.model : "";
  } catch { currentModel = ""; }

  const paintLabel = () => {
    const label = trigger.querySelector(".yo-model-label");
    if (label) label.textContent = prettyHomeModel(currentModel);
  };
  trigger.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });

  const wireOption = (opt: HTMLElement) => {
    opt.addEventListener("click", async () => {
      if (opt.classList.contains("disabled")) return;
      const newModel = opt.dataset.value || "";
      menu.classList.add("hidden");
      currentModel = newModel;
      menu.querySelectorAll<HTMLElement>(".yo-model-option").forEach((o) => o.classList.toggle("active", o === opt));
      paintLabel();
      // Shared setter — writes the workspace LLM config the panel + agent read.
      await window.yo.saveLLMConfig({ provider: "anthropic", model: newModel || "claude-haiku-4-5-20251001" });
    });
  };

  // Replace the static list with the server-filtered model list for THIS user.
  try {
    const data = await window.yo.agentModels();
    if (data && Array.isArray(data.models) && data.models.length > 0) {
      // Capability order: Opus → Sonnet → Haiku, newest version first.
      const familyRank = (m: string): number => {
        const s = m.toLowerCase();
        return s.includes("opus") ? 0 : s.includes("sonnet") ? 1 : s.includes("haiku") ? 2 : 3;
      };
      const versionRank = (m: string): number => {
        const vm = m.toLowerCase().match(/(\d+)[-.](\d+)/);
        return vm ? parseInt(vm[1], 10) + parseInt(vm[2], 10) / 100 : 0;
      };
      const models = [...data.models].sort((a, b) => {
        const fa = familyRank(a.model), fb = familyRank(b.model);
        if (fa !== fb) return fa - fb;
        return versionRank(b.model) - versionRank(a.model);
      });
      const check = '<span class="yo-mode-opt-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
      menu.innerHTML = '<div class="yo-model-section-header">Models</div>' + models.map((m) =>
        `<div class="yo-model-option" data-provider="${esc(m.provider)}" data-value="${esc(m.model)}"><div class="yo-mode-opt-text"><span class="yo-mode-opt-label">${esc(prettyHomeModel(m.model))}</span></div>${check}</div>`
      ).join("");
    }
  } catch { /* offline — keep the static Default option */ }
  menu.querySelectorAll<HTMLElement>(".yo-model-option").forEach(wireOption);
  menu.querySelectorAll<HTMLElement>(".yo-model-option").forEach((o) => o.classList.toggle("active", (o.dataset.value || "") === currentModel));
  paintLabel();
}

function wireHomeEffort(): void {
  const trigger = document.getElementById("home-effort-trigger");
  const menu = document.getElementById("home-effort-menu");
  const slider = document.getElementById("home-effort-input") as HTMLInputElement | null;
  const valueEl = document.getElementById("home-effort-value");
  const triggerLabel = document.getElementById("home-effort-trigger-label");
  if (!trigger || !menu || !slider) return;
  const NAMES = ["Faster", "Balanced", "Smarter", "Ultracode"];
  const paint = (lvl: number, save: boolean) => {
    const v = Math.max(0, Math.min(3, Math.round(lvl) || 0));
    slider.value = String(v);
    slider.style.setProperty("--effort-fill", `${(v / 3) * 100}%`);
    slider.classList.toggle("is-ultra", v === 3);
    if (valueEl) valueEl.textContent = NAMES[v];
    if (triggerLabel) triggerLabel.textContent = NAMES[v];
    if (save) window.yo.setPreference("effortLevel", v);   // shared pref
  };
  void (async () => {
    try { const saved = Number(await window.yo.getPreference("effortLevel", 1)); paint(Number.isFinite(saved) ? saved : 1, false); }
    catch { paint(1, false); }
  })();
  slider.addEventListener("input", () => paint(Number(slider.value), false));
  slider.addEventListener("change", () => paint(Number(slider.value), true));
  trigger.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
}

function homeBasename(p: string): string { return p.replace(/\/+$/, "").split("/").pop() || p; }

function wireHomeWorkdir(): void {
  const btn = document.getElementById("home-workdir-btn") as HTMLButtonElement | null;
  const nameEl = document.getElementById("home-workdir-name");
  const addBtn = document.getElementById("home-workdir-add-btn") as HTMLButtonElement | null;
  if (!btn || !nameEl) return;
  const paint = (dir: string) => {
    nameEl.textContent = dir ? homeBasename(dir) : "Pick a folder";
    btn.title = dir ? `working directory: ${dir}` : "Pick a folder";
  };
  // Folder picker uses the SAME working-dir IPC the panel's #workdir-btn uses.
  btn.addEventListener("click", (e) => { e.stopPropagation(); void window.yo.pickWorkingDir().then((d) => { if (d) paint(d); }); });
  addBtn?.addEventListener("click", (e) => { e.stopPropagation(); void window.yo.pickWorkingDir().then((d) => { if (d) paint(d); }); });
  window.yo.onWorkingDirChanged?.((dir) => paint(dir || ""));
  void window.yo.getWorkingDir().then((d) => paint(d || "")).catch(() => paint(""));
}

const HOME_EFFECT_EMOJI: Record<string, string> = {
  fireworks: "🎆", hearts: "❤️", confetti: "🎊", stars: "⭐", rain: "🌧️",
  bubbles: "🫧", sparkle: "✨", spiral: "🌀", emoji: "😀", wave: "🌊",
  thumbsup: "👍", peace: "✌️", cat: "🐱", matrix: "🟩", aurora: "🌌",
  nebula: "💜", plasma: "🔮", fireflies: "🪲", starfield: "🌠",
};

function wireHomeDrip(): void {
  const picker = document.getElementById("home-drip-picker");
  const builtinEl = document.getElementById("home-drip-picker-builtin");
  const customEl = document.getElementById("home-drip-picker-custom");
  const dividerEl = document.getElementById("home-drip-picker-custom-divider");
  const btn = document.getElementById("home-panel-drip");
  if (!picker || !builtinEl || !customEl || !dividerEl || !btn) return;
  let open = false;

  const tile = (name: string, recipe: string, emoji: string): HTMLButtonElement => {
    const t = document.createElement("button");
    t.className = "drip-picker-tile";
    t.innerHTML = `<span class="drip-tile-icon">${emoji}</span><span class="drip-tile-label">${esc(name)}</span>`;
    t.addEventListener("click", () => { void window.yo.dripsPreview(recipe); close(); });
    return t;
  };
  const populate = async () => {
    builtinEl.innerHTML = "";
    customEl.innerHTML = "";
    const [builtins, customs] = await Promise.all([
      window.yo.dripsBuiltinEffects().catch(() => [] as string[]),
      window.yo.dripsList().catch(() => [] as Array<{ name: string; recipe: string }>),
    ]);
    for (const name of builtins) builtinEl.appendChild(tile(name, name, HOME_EFFECT_EMOJI[name] || "🎨"));
    if (customs.length > 0) {
      dividerEl.style.display = "";
      for (const c of customs) customEl.appendChild(tile(c.name, c.recipe, "🎨"));
    } else {
      dividerEl.style.display = "none";
    }
  };
  function openPicker(): void {
    void populate();
    const wrap = document.querySelector("#home-composer .yo-panel-input-wrap") as HTMLElement | null;
    const controls = document.querySelector("#home-composer .yo-panel-controls") as HTMLElement | null;
    const offset = (wrap?.offsetHeight || 70) + (controls?.offsetHeight || 30) + 6;
    picker!.style.bottom = offset + "px";
    picker!.style.top = "auto";
    picker!.classList.remove("hidden");
    requestAnimationFrame(() => picker!.classList.add("visible"));
    open = true;
  }
  function close(): void {
    picker!.classList.remove("visible");
    open = false;
    setTimeout(() => { if (!open) picker!.classList.add("hidden"); }, 150);
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (open) close(); else openPicker(); });
  document.addEventListener("click", (e) => {
    if (open && !picker.contains(e.target as Node) && e.target !== btn) close();
  });
}

function wireHomeInput(): void {
  const textarea = document.getElementById("home-panel-input") as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById("home-panel-send");
  if (!textarea || !sendBtn) return;

  const submit = () => {
    const typed = textarea.value.trim();
    const folded = homeAttachments.length
      ? homeAttachments.map((a) => `[Attached file: ${a}]`).join("\n") + (typed ? "\n\n" + typed : "")
      : typed;
    if (!folded) return;
    // yoPanelOpen clears to a new chat, opens the panel, and runs the prompt
    // using the shared model/effort/working-dir/drips this composer just set.
    window.yo.yoPanelOpen(folded);
    textarea.value = "";
    homeAttachments.length = 0;
  };
  sendBtn.addEventListener("click", submit);
  textarea.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+Enter submits (plain Enter inserts a newline in this taller box).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  // Drag & drop files → fold as [Attached file: <path>] lines on submit.
  textarea.addEventListener("dragover", (e) => { e.preventDefault(); });
  textarea.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (const f of Array.from(files)) {
      const path = window.yo.getPathForFile(f);
      if (path && !homeAttachments.includes(path)) homeAttachments.push(path);
    }
    // Reflect attachments inline so the user sees what they dropped.
    const lines = homeAttachments.map((a) => `[Attached file: ${a}]`).join("\n");
    const existing = textarea.value;
    textarea.value = lines + (existing ? "\n\n" + existing.replace(/^\[Attached file: [^\]]+\]\n?/gm, "") : "");
    textarea.focus();
  });
}

// ── Home lists (Chat history + Scheduled Tasks) ─────────────────────────────

async function renderHomeLists(): Promise<void> {
  const chatsEl = document.getElementById("home-chats-list");
  const tasksEl = document.getElementById("home-tasks-list");
  if (!chatsEl || !tasksEl) return;

  let chats: Array<{ id: string; title: string; created: string; messageCount: number }> = [];
  let byChat: Record<string, { credits: number; requests: number }> = {};
  try {
    const [c, usage] = await Promise.all([window.yo.yoChatsList(), window.yo.usageByChat()]);
    chats = c || [];
    byChat = usage?.byChat || {};
  } catch { /* offline — render whatever we have */ }

  renderHomeChats(chatsEl, chats.slice(0, 8), byChat);
  await renderHomeTasks(tasksEl, byChat);
}

/** A two-row card: row1 = title + open icon; row2 = credits + relative time. */
function homeCard(title: string, creditsLabel: string, rightMeta: string, onOpen: () => void): HTMLElement {
  const card = document.createElement("div");
  card.className = "crud-card home-list-card";
  card.innerHTML =
    `<div class="home-card-body">` +
      `<div class="home-card-row">` +
        `<span class="crud-card-name">${esc(title)}</span>` +
        `<button class="crud-card-btn crud-open-btn home-card-open" title="Open">${OPEN_ICON}</button>` +
      `</div>` +
      `<div class="home-card-row home-card-row-meta">` +
        `<span class="crud-card-meta">${esc(creditsLabel)}</span>` +
        `<span class="crud-card-meta">${esc(rightMeta)}</span>` +
      `</div>` +
    `</div>`;
  card.addEventListener("click", onOpen);
  return card;
}

function renderHomeChats(
  host: HTMLElement,
  chats: Array<{ id: string; title: string; created: string; messageCount: number }>,
  byChat: Record<string, { credits: number; requests: number }>,
): void {
  host.innerHTML = "";
  if (chats.length === 0) {
    host.innerHTML = `<div class="dash-empty-hint">No chats yet. Start one above.</div>`;
    return;
  }
  for (const chat of chats) {
    const credits = Math.round((byChat[chat.id]?.credits || 0) / MICRO);
    const card = homeCard(
      chat.title || "Untitled chat",
      `${credits.toLocaleString()} credits`,
      relativeTime(isoToMs(chat.created)),
      () => window.yo.openYoChat(chat.id),
    );
    host.appendChild(card);
  }
}

async function renderHomeTasks(
  host: HTMLElement,
  byChat: Record<string, { credits: number; requests: number }>,
): Promise<void> {
  host.innerHTML = "";
  let schedules: Array<Record<string, unknown>> = [];
  try { schedules = (await window.yo.schedulesList()) || []; } catch { /* offline */ }
  if (schedules.length === 0) {
    host.innerHTML = `<div class="dash-empty-hint">No scheduled tasks yet.</div>`;
    return;
  }
  for (const s of schedules.slice(0, 8)) {
    const name = String(s.name || "Untitled task");
    const cron = String(s.cron || "");
    let runs: Array<{ id: string; created: string }> = [];
    try { runs = (await window.yo.runsList(name)) || []; } catch { /* no runs */ }
    // Runs come newest-first; sum credits over them and open the latest.
    const totalCredits = runs.reduce((sum, r) => sum + (byChat[r.id]?.credits || 0), 0);
    const latest = runs[0];
    const creditsLabel = runs.length ? `${Math.round(totalCredits / MICRO).toLocaleString()} credits` : "—";
    const rightMeta = latest ? relativeTime(isoToMs(latest.created)) : (cron || "manual");
    const card = homeCard(name, creditsLabel, rightMeta, () => {
      if (latest) window.yo.openYoChat(latest.id);
      else (document.querySelector('.help-nav-item[data-section="schedules"]') as HTMLElement | null)?.click();
    });
    host.appendChild(card);
  }
}
