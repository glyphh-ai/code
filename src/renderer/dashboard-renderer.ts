/**
 * Dashboard renderer — Chart.js powered usage dashboard.
 *
 * Displays token usage (doughnut by agent, line by day),
 * user-built apps, and active reminders.
 */

import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

declare global {
  interface Window {
    dashboardAPI: {
      getToday: () => Promise<any>;
      getHistory: (days?: number) => Promise<any[]>;
      getAllTime: () => Promise<{ agents: Record<string, any>; total: any }>;
      getApps: () => Promise<Array<{ name: string; path: string; modified: string }>>;
      openApp: (name: string) => void;
      deleteApp: (name: string) => Promise<boolean>;
      getReminders: () => Promise<Array<{ id: string; message: string; fireAt: number }>>;
      cancelReminder: (id: string) => Promise<boolean>;
      getLLMInfo: () => Promise<{ provider: string; model: string }>;
      onUsageUpdate: (cb: () => void) => void;
      onVisible: (cb: () => void) => void;
    };
  }
}

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "#25C75E",
  navigator: "#48dbfb",
  researcher: "#feca57",
  coder: "#ff6b6b",
  "skill-runner": "#cc5de8",
  manager: "#ff9f43",
};

const AGENT_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  navigator: "Navigator",
  researcher: "Researcher",
  coder: "Coder",
  "skill-runner": "Skill Runner",
  manager: "Manager",
};

function getColor(agent: string): string {
  return AGENT_COLORS[agent] || "#888";
}

function getLabel(agent: string): string {
  return AGENT_LABELS[agent] || agent;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeUntil(fireAt: number): string {
  const ms = fireAt - Date.now();
  if (ms <= 0) return "any moment";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Chart instances ─────────────────────────────────

let agentDoughnut: Chart | null = null;
let historyLine: Chart | null = null;
let rangeMode: "7" | "30" = "7";

// ── Render functions ────────────────────────────────

async function renderStats() {
  const [today, allTime, llmInfo] = await Promise.all([
    window.dashboardAPI.getToday(),
    window.dashboardAPI.getAllTime(),
    window.dashboardAPI.getLLMInfo(),
  ]);

  // Provider/model badge
  const providerEl = document.getElementById("stat-provider")!;
  providerEl.textContent = `${llmInfo.provider} / ${llmInfo.model}`;

  // Today stats
  const todayInput = today?.total?.input || 0;
  const todayOutput = today?.total?.output || 0;
  const todayCalls = today?.total?.calls || 0;
  document.getElementById("stat-today-input")!.textContent = formatTokens(todayInput);
  document.getElementById("stat-today-output")!.textContent = formatTokens(todayOutput);
  document.getElementById("stat-today-calls")!.textContent = String(todayCalls);

  // All-time stats
  document.getElementById("stat-alltime-input")!.textContent = formatTokens(allTime.total.input);
  document.getElementById("stat-alltime-output")!.textContent = formatTokens(allTime.total.output);
  document.getElementById("stat-alltime-calls")!.textContent = String(allTime.total.calls);
}

async function renderAgentChart() {
  const allTime = await window.dashboardAPI.getAllTime();
  const agents = Object.keys(allTime.agents);
  if (agents.length === 0) {
    if (agentDoughnut) { agentDoughnut.destroy(); agentDoughnut = null; }
    return;
  }

  const labels = agents.map(getLabel);
  const data = agents.map((a) => allTime.agents[a].input + allTime.agents[a].output);
  const colors = agents.map(getColor);

  const ctx = (document.getElementById("chart-agents") as HTMLCanvasElement).getContext("2d")!;
  if (agentDoughnut) agentDoughnut.destroy();

  agentDoughnut = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#aaa", font: { size: 12 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatTokens(ctx.parsed)} tokens`,
          },
        },
      },
    },
  });
}

async function renderHistoryChart() {
  const days = parseInt(rangeMode);
  const history = await window.dashboardAPI.getHistory(days);
  if (history.length === 0) {
    if (historyLine) { historyLine.destroy(); historyLine = null; }
    return;
  }

  // Build date labels and fill gaps
  const dateMap = new Map(history.map((d: any) => [d.date, d]));
  const labels: string[] = [];
  const inputData: number[] = [];
  const outputData: number[] = [];

  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    labels.push(label);
    const entry = dateMap.get(key);
    inputData.push(entry?.total?.input || 0);
    outputData.push(entry?.total?.output || 0);
  }

  const ctx = (document.getElementById("chart-history") as HTMLCanvasElement).getContext("2d")!;
  if (historyLine) historyLine.destroy();

  historyLine = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Input tokens",
          data: inputData,
          borderColor: "#25C75E",
          backgroundColor: "rgba(37, 199, 94, 0.1)",
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 10,
        },
        {
          label: "Output tokens",
          data: outputData,
          borderColor: "#48dbfb",
          backgroundColor: "rgba(72, 219, 251, 0.05)",
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: "#666", font: { size: 10 }, maxRotation: 0 },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          ticks: {
            color: "#666",
            font: { size: 10 },
            callback: (v) => formatTokens(v as number),
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
      plugins: {
        legend: {
          labels: { color: "#aaa", font: { size: 11 }, usePointStyle: true, pointStyleWidth: 8, padding: 16 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatTokens(ctx.parsed.y)}`,
          },
        },
      },
    },
  });
}

async function renderApps() {
  const apps = await window.dashboardAPI.getApps();
  const container = document.getElementById("apps-grid")!;
  if (apps.length === 0) {
    container.innerHTML = `<div class="empty-hint">No apps yet. Ask .yo to build one!</div>`;
    return;
  }

  container.innerHTML = apps.map((app) => `
    <div class="app-card" data-name="${app.name}">
      <div class="app-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#25C75E" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M3 9h18"/></svg>
      </div>
      <div class="app-info">
        <div class="app-name">${app.name}</div>
        <div class="app-date">${app.modified}</div>
      </div>
      <div class="app-actions">
        <button class="app-open" title="Open">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="app-delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".app-open").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const card = (e.currentTarget as HTMLElement).closest(".app-card") as HTMLElement;
      window.dashboardAPI.openApp(card.dataset.name!);
    });
  });

  container.querySelectorAll(".app-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const card = (e.currentTarget as HTMLElement).closest(".app-card") as HTMLElement;
      await window.dashboardAPI.deleteApp(card.dataset.name!);
      renderApps();
    });
  });
}

async function renderReminders() {
  const reminders = await window.dashboardAPI.getReminders();
  const container = document.getElementById("reminders-list")!;
  if (reminders.length === 0) {
    container.innerHTML = `<div class="empty-hint">No active reminders.</div>`;
    return;
  }

  container.innerHTML = reminders.map((r) => `
    <div class="reminder-row" data-id="${r.id}">
      <div class="reminder-msg">${r.message}</div>
      <div class="reminder-time">${timeUntil(r.fireAt)}</div>
      <button class="reminder-cancel" title="Cancel">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join("");

  container.querySelectorAll(".reminder-cancel").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const row = (e.currentTarget as HTMLElement).closest(".reminder-row") as HTMLElement;
      await window.dashboardAPI.cancelReminder(row.dataset.id!);
      renderReminders();
    });
  });
}

// ── Range toggle ────────────────────────────────────

document.getElementById("range-7")!.addEventListener("click", () => {
  rangeMode = "7";
  document.getElementById("range-7")!.classList.add("active");
  document.getElementById("range-30")!.classList.remove("active");
  renderHistoryChart();
});

document.getElementById("range-30")!.addEventListener("click", () => {
  rangeMode = "30";
  document.getElementById("range-30")!.classList.add("active");
  document.getElementById("range-7")!.classList.remove("active");
  renderHistoryChart();
});

// ── Init ────────────────────────────────────────────

async function init() {
  await Promise.all([
    renderStats(),
    renderAgentChart(),
    renderHistoryChart(),
    renderApps(),
    renderReminders(),
  ]);

  // Live updates
  window.dashboardAPI.onUsageUpdate(async () => {
    await Promise.all([renderStats(), renderAgentChart(), renderHistoryChart()]);
  });

  // Full refresh when dashboard panel becomes visible
  window.dashboardAPI.onVisible(async () => {
    await Promise.all([
      renderStats(),
      renderAgentChart(),
      renderHistoryChart(),
      renderApps(),
      renderReminders(),
    ]);
  });

  // Refresh reminders every 30s
  setInterval(renderReminders, 30000);
}

init();
