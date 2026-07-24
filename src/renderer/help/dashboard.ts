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
  orchestrator: "#f59e0b", navigator: "#48dbfb", researcher: "#feca57",
  coder: "#ff6b6b", "skill-runner": "#cc5de8", manager: "#ff9f43",
};
const AGENT_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator", navigator: "Navigator", researcher: "Researcher",
  coder: "Coder", "skill-runner": "Skill Runner", manager: "Manager",
};

export async function loadDashboard() {
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
        mkLine("Credits", creditsData, "y", "rgb(251, 146, 60)", 0.12),
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
        { label: "Credits", data: creditsData, borderColor: "#f59e0b", backgroundColor: "rgba(251, 146, 60,0.12)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0, pointHitRadius: 10 },
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
        { label: "Captures", data: countData, backgroundColor: "rgba(251, 146, 60,0.6)", borderRadius: 3, yAxisID: "y" },
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
        backgroundColor: hasData ? ["#f59e0b", "#48dbfb", "#cc5de8"] : [cssVar("--border")],
        borderColor: hasData ? ["#b45309", "#2a9abf", "#8a3d9e"] : [cssVar("--border-3")],
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

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
function isoToMs(iso: string): number {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
}
