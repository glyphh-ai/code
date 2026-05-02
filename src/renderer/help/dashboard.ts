/**
 * Dashboard section — charts, prompts, token stats.
 */

import {
  cssVar, formatTokens, formatBytes, relativeTime,
  buildPaginationBar, formatDuration, confirmAction,
} from "./shared.js";
import { loadData, closeDataDetail, deleteDataEntry, clearData, dataSearchDebounce } from "./data-store.js";

declare const Chart: any;

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "#25C75E", navigator: "#48dbfb", researcher: "#feca57",
  coder: "#ff6b6b", "skill-runner": "#cc5de8", manager: "#ff9f43",
};
const AGENT_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator", navigator: "Navigator", researcher: "Researcher",
  coder: "Coder", "skill-runner": "Skill Runner", manager: "Manager",
};

let dashAgentChart: any = null;
let dashHistoryChart: any = null;
let dashIntakeChart: any = null;
let dashFlowChart: any = null;
let dashRangeMode: "7" | "30" = "7";
let storeRangeMode: "7" | "30" = "7";

async function refreshDashboardYosCard(): Promise<void> {
  const amt = document.getElementById("dash-yos-amount");
  if (!amt) return;
  try {
    const r = await window.yo.yosBalance();
    amt.textContent = "error" in r ? "—" : new Intl.NumberFormat().format(r.balance);
  } catch { amt.textContent = "—"; }
}

export async function loadDashboard() {
  void refreshDashboardYosCard();
  const [today, allTime, llmInfo, captureStats] = await Promise.all([
    window.yo.dashboardToday(),
    window.yo.dashboardAllTime(),
    window.yo.dashboardLLMInfo(),
    window.yo.capturesStats(),
  ]);

  document.getElementById("dash-provider")!.textContent = `${llmInfo.provider} / ${llmInfo.model}`;

  const todayInput = today?.total?.input || 0;
  const todayOutput = today?.total?.output || 0;
  const todayCalls = today?.total?.calls || 0;
  document.getElementById("dash-today-input")!.textContent = formatTokens(todayInput);
  document.getElementById("dash-today-output")!.textContent = formatTokens(todayOutput);
  document.getElementById("dash-today-calls")!.textContent = String(todayCalls);

  document.getElementById("dash-alltime-input")!.textContent = formatTokens(allTime.total.input);
  document.getElementById("dash-alltime-output")!.textContent = formatTokens(allTime.total.output);
  document.getElementById("dash-alltime-calls")!.textContent = String(allTime.total.calls);

  document.getElementById("dash-captures")!.textContent = String(captureStats.count);
  document.getElementById("dash-embedded")!.textContent = String(captureStats.embeddedCount);
  document.getElementById("dash-sources")!.textContent = String(Object.keys(captureStats.sources).length);
  document.getElementById("dash-disk")!.textContent = formatBytes(captureStats.diskBytes);
  document.getElementById("dash-oldest")!.textContent = relativeTime(captureStats.oldestTs);
  document.getElementById("dash-newest")!.textContent = relativeTime(captureStats.newestTs);

  renderDashAgentChart(allTime);
  renderDashHistoryChart();
  renderDashFlowChart(captureStats);
  renderDashIntakeChart();
  renderDashPrompts();
  loadData();
}

function renderDashAgentChart(allTime: { agents: Record<string, any>; total: any }) {
  const agents = Object.keys(allTime.agents);
  const canvas = document.getElementById("dash-chart-agents") as HTMLCanvasElement | null;
  if (!canvas) return;
  if (agents.length === 0) {
    if (dashAgentChart) { dashAgentChart.destroy(); dashAgentChart = null; }
    return;
  }

  const labels = agents.map(a => AGENT_LABELS[a] || a);
  const data = agents.map(a => (allTime.agents[a].input || 0) + (allTime.agents[a].output || 0));
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

async function renderDashHistoryChart() {
  const days = parseInt(dashRangeMode);
  const history = await window.yo.dashboardHistory(days);
  const canvas = document.getElementById("dash-chart-history") as HTMLCanvasElement | null;
  if (!canvas) return;
  if (history.length === 0) {
    if (dashHistoryChart) { dashHistoryChart.destroy(); dashHistoryChart = null; }
    return;
  }

  const dateMap = new Map(history.map((d: any) => [d.date, d]));
  const labels: string[] = [];
  const inputData: number[] = [];
  const outputData: number[] = [];

  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    const entry = dateMap.get(key);
    inputData.push(entry?.total?.input || 0);
    outputData.push(entry?.total?.output || 0);
  }

  const ctx = canvas.getContext("2d")!;
  if (dashHistoryChart) dashHistoryChart.destroy();

  dashHistoryChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Input tokens", data: inputData, borderColor: "#25C75E", backgroundColor: "rgba(37,199,94,0.1)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0, pointHitRadius: 10 },
        { label: "Output tokens", data: outputData, borderColor: "#48dbfb", backgroundColor: "rgba(72,219,251,0.05)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0, pointHitRadius: 10 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: cssVar("--text-3"), font: { size: 10 }, maxRotation: 0 }, grid: { color: cssVar("--border") } },
        y: { ticks: { color: cssVar("--text-3"), font: { size: 10 }, callback: (v: string | number) => formatTokens(Number(v)) }, grid: { color: cssVar("--border") } },
      },
      plugins: {
        legend: { labels: { color: cssVar("--text-2"), font: { size: 11 }, usePointStyle: true, pointStyleWidth: 14, padding: 16 } },
        tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${formatTokens(c.parsed.y)}` } },
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
        { label: "Captures", data: countData, backgroundColor: "rgba(37,199,94,0.6)", borderRadius: 3, yAxisID: "y" },
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
        backgroundColor: hasData ? ["#25C75E", "#48dbfb", "#cc5de8"] : [cssVar("--border")],
        borderColor: hasData ? ["#1a8a40", "#2a9abf", "#8a3d9e"] : [cssVar("--border-3")],
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

  let entries: Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>;
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

    const tokSpan = document.createElement("span");
    tokSpan.style.cssText = "font-size:10px;color:var(--accent);flex-shrink:0;";
    tokSpan.textContent = `${formatTokens(e.inputTokens + e.outputTokens)}`;
    nameRow.appendChild(tokSpan);

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

  const items = [
    { label: "Input Tokens", value: formatTokens(entry.inputTokens) },
    { label: "Output Tokens", value: formatTokens(entry.outputTokens) },
    { label: "Model", value: entry.model },
    { label: "Provider", value: entry.provider },
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

async function openBuyYosOnPlatform(): Promise<void> {
  const r = await window.yo.yosBuyUrl();
  window.yo.openExternal(r.url);
}

export function initDashboardEvents() {
  document.getElementById("dash-refresh")?.addEventListener("click", () => loadDashboard());
  document.getElementById("dash-yos-buy-btn")?.addEventListener("click", () => { void openBuyYosOnPlatform(); });

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
