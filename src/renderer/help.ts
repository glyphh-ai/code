/**
 * Help overlay — combined docs + settings (layouts, panels, apps).
 */

import { showOnboarding } from "./onboarding.js";

declare const Chart: any;

// ── Confirm modal ──────────────────────────────────────────

function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-modal")!;
    document.getElementById("confirm-message")!.textContent = message;
    overlay.classList.remove("hidden");

    const yesBtn = document.getElementById("confirm-yes")!;
    const noBtn = document.getElementById("confirm-no")!;

    function cleanup() {
      overlay.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
    }
    function onYes() { cleanup(); resolve(true); }
    function onNo() { cleanup(); resolve(false); }

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
  });
}

function clearInvalid(el: HTMLElement) {
  el.addEventListener("input", () => el.classList.remove("invalid"), { once: true });
}

/** Simple prompt modal (Electron BrowserViews don't support window.prompt). */
function promptAction(message: string, defaultValue = "", placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("skill-ask-user-modal");
    const qEl = document.getElementById("skill-ask-user-question");
    const ansEl = document.getElementById("skill-ask-user-answer") as HTMLTextAreaElement | null;
    const submitBtn = document.getElementById("skill-ask-user-submit");
    const cancelBtn = document.getElementById("skill-ask-user-cancel");
    if (!overlay || !qEl || !ansEl || !submitBtn || !cancelBtn) {
      resolve(null);
      return;
    }
    qEl.textContent = message;
    ansEl.value = defaultValue;
    ansEl.placeholder = placeholder;
    overlay.classList.remove("hidden");
    ansEl.focus();

    function cleanup() {
      overlay!.classList.add("hidden");
      submitBtn!.removeEventListener("click", onSubmit);
      cancelBtn!.removeEventListener("click", onCancel);
      ansEl!.removeEventListener("keydown", onKey);
    }
    function onSubmit() { const v = ansEl!.value; cleanup(); resolve(v); }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    ansEl.addEventListener("keydown", onKey);
  });
}

// ── Pagination utility ──────────────────────────────────────
const PAGE_SIZE = 50;

interface PaginationState {
  page: number;
  totalPages: number;
  total: number;
}

function renderPaginationBar(state: PaginationState, onPage: (page: number) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pagination-bar";
  if (state.totalPages <= 1) return bar;

  const info = document.createElement("span");
  info.className = "pagination-info";
  const start = state.page * PAGE_SIZE + 1;
  const end = Math.min((state.page + 1) * PAGE_SIZE, state.total);
  info.textContent = `${start}–${end} of ${state.total}`;

  const nav = document.createElement("div");
  nav.className = "pagination-nav";

  const prev = document.createElement("button");
  prev.className = "pagination-btn";
  prev.textContent = "‹ Prev";
  prev.disabled = state.page === 0;
  prev.addEventListener("click", () => onPage(state.page - 1));

  // Page buttons — show max 7 with ellipsis
  const pages: (number | "...")[] = [];
  const tp = state.totalPages;
  const cp = state.page;
  if (tp <= 7) {
    for (let i = 0; i < tp; i++) pages.push(i);
  } else {
    pages.push(0);
    if (cp > 2) pages.push("...");
    for (let i = Math.max(1, cp - 1); i <= Math.min(tp - 2, cp + 1); i++) pages.push(i);
    if (cp < tp - 3) pages.push("...");
    pages.push(tp - 1);
  }

  const next = document.createElement("button");
  next.className = "pagination-btn";
  next.textContent = "Next ›";
  next.disabled = state.page >= state.totalPages - 1;
  next.addEventListener("click", () => onPage(state.page + 1));

  nav.appendChild(prev);
  for (const p of pages) {
    if (p === "...") {
      const ell = document.createElement("span");
      ell.className = "pagination-ellipsis";
      ell.textContent = "…";
      nav.appendChild(ell);
    } else {
      const btn = document.createElement("button");
      btn.className = "pagination-btn" + (p === state.page ? " active" : "");
      btn.textContent = String(p + 1);
      btn.addEventListener("click", () => onPage(p));
      nav.appendChild(btn);
    }
  }
  nav.appendChild(next);

  bar.appendChild(info);
  bar.appendChild(nav);
  return bar;
}

function paginate<T>(items: T[], page: number): { items: T[]; state: PaginationState } {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  return {
    items: items.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    state: { page: safePage, totalPages, total: items.length },
  };
}

const overlay = document.getElementById("help-overlay")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-item");
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");
const navSubItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-sub-item");

// ── Open / close ─────────────────────────────────────────

let helpTransitioning = false;

export function openHelp() {
  if (helpTransitioning) return;
  helpTransitioning = true;
  setTimeout(() => { helpTransitioning = false; }, 300);
  window.yo.panelsHide();
  overlay.classList.remove("hidden");
  // Refresh auth so tier gates reflect any recent upgrade
  window.yo.refreshAuth().catch(() => {});
  loadActiveSection();
}

export function openSettings(sub?: string) {
  switchToSection("settings");
  if (sub) {
    // Activate the specific settings sub-panel
    const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
    const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
    settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === sub));
    settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
    // Also highlight the sub-item in sidebar
    navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === sub));
  }
  openHelp();
}

export function closeHelp() {
  if (helpTransitioning) return;
  helpTransitioning = true;
  setTimeout(() => { helpTransitioning = false; }, 300);
  overlay.classList.add("hidden");
  window.yo.panelsShow();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

// ── Navigation ───────────────────────────────────────────

function resetEditors() {
  // Dashboard prompt detail
  const pd = document.getElementById("dash-prompt-detail");
  if (pd && !pd.classList.contains("hidden")) {
    closeDashPromptDetail();
  }
  // Data Store (inside dashboard split)
  const sd = document.getElementById("data-detail");
  if (sd && !sd.classList.contains("hidden")) {
    closeDataDetail();
  }
  // Skills
  const se = document.getElementById("skill-editor");
  if (se && !se.classList.contains("hidden")) {
    se.classList.add("hidden");
    document.getElementById("skills-list")?.classList.remove("hidden");
    document.getElementById("skills-toolbar")?.classList.remove("hidden");
  }
  // Layouts
  const le = document.getElementById("layout-editor");
  if (le && !le.classList.contains("hidden")) {
    le.classList.add("hidden");
    document.getElementById("layouts-list")?.classList.remove("hidden");
    document.getElementById("layouts-toolbar")?.classList.remove("hidden");
  }
  // Rips
  const re = document.getElementById("rip-editor");
  if (re && !re.classList.contains("hidden")) {
    re.classList.add("hidden");
    document.getElementById("rips-list")?.classList.remove("hidden");
    document.getElementById("rips-toolbar")?.classList.remove("hidden");
  }
  // Drips
  const de = document.getElementById("drip-editor");
  if (de && !de.classList.contains("hidden")) {
    de.classList.add("hidden");
    document.getElementById("drips-list")?.classList.remove("hidden");
    document.getElementById("drips-toolbar")?.classList.remove("hidden");
  }
  // Apps
  const ad = document.getElementById("app-detail");
  if (ad && !ad.classList.contains("hidden")) {
    ad.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
    const preview = document.getElementById("app-preview") as HTMLElement & { src: string } | null;
    if (preview) preview.src = "about:blank";
  }
  const af = document.getElementById("app-add-form");
  if (af && !af.classList.contains("hidden")) {
    af.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
  }
  // MCP add form
  document.getElementById("mcp-add-form")?.classList.add("hidden");
}

function switchToSection(sectionId: string) {
  resetEditors();
  navItems.forEach((n) => n.classList.remove("active"));
  sections.forEach((s) => s.classList.remove("active"));
  const navItem = document.querySelector(`.help-nav-item[data-section="${sectionId}"]`) as HTMLElement;
  const section = document.querySelector(`.help-section[data-section="${sectionId}"]`) as HTMLElement;
  if (navItem) navItem.classList.add("active");
  if (section) section.classList.add("active");
}

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    if (item.classList.contains("has-sub")) {
      // Toggle dropdown expand/collapse — don't switch section
      item.classList.toggle("expanded");
    } else {
      // Regular nav item — switch section, collapse all dropdowns
      collapseAllDropdowns();
      navSubItems.forEach((s) => s.classList.remove("active"));
      switchToSection(item.dataset.section!);
      loadActiveSection();
    }
  });
});

function collapseAllDropdowns() {
  navItems.forEach((n) => n.classList.remove("expanded"));
}

// ── Sidebar sub-navigation (dropdown items) ──────────────

navSubItems.forEach((sub) => {
  sub.addEventListener("click", () => {
    const sectionId = sub.dataset.section!;
    const subId = sub.dataset.sub!;

    // Collapse the dropdown after selection
    collapseAllDropdowns();

    // Activate the parent section
    switchToSection(sectionId);

    // Highlight this sub-item
    navSubItems.forEach((s) => s.classList.remove("active"));
    sub.classList.add("active");

    if (sectionId === "docs") {
      loadDocs();
      showDocPanel(subId);
    } else if (sectionId === "settings") {
      loadActiveSection();
      // Switch to specific settings sub-panel
      const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
      const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
      settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === subId));
      settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === subId));
    }
  });
});

// ── Settings inner sub-navigation ────────────────────────

const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");

settingsSubNav.forEach((btn) => {
  btn.addEventListener("click", () => {
    settingsSubNav.forEach((n) => n.classList.remove("active"));
    settingsSubPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const target = document.querySelector(`.help-section[data-section='settings'] .settings-panel[data-sub="${btn.dataset.sub}"]`);
    if (target) target.classList.add("active");
    // Sync sidebar sub-item highlight
    navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === btn.dataset.sub));
  });
});

// ── Docs inner sub-navigation ────────────────────────────

const docsSubNav = document.querySelectorAll<HTMLButtonElement>(".docs-nav .settings-nav-item");
const docsPanels = document.querySelectorAll<HTMLDivElement>(".docs-panel");

function showDocPanel(docId: string) {
  docsSubNav.forEach((n) => n.classList.toggle("active", n.dataset.doc === docId));
  docsPanels.forEach((p) => p.classList.toggle("active", p.dataset.doc === docId));
  // Sync sidebar sub-item highlight
  navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "docs" && s.dataset.sub === docId));
  // Scroll to top
  const container = document.querySelector(".docs-panels");
  if (container) container.scrollTop = 0;
}

docsSubNav.forEach((btn) => {
  btn.addEventListener("click", () => {
    showDocPanel(btn.dataset.doc!);
  });
});

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement)?.dataset.section || "guide";
}

export function loadActiveSection() {
  const sec = activeSection();
  if (sec === "dashboard") loadDashboard();
  else if (sec === "skills") loadSkills();
  else if (sec === "drips") loadDrips();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "settings") loadSettings();
  else if (sec === "docs") loadDocs();
  // MCP merged into Apps
  else if (sec === "support") loadSupport();
  else if (sec === "about") loadAbout();
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  // help-close button only exists in index.html (legacy); in home.html it's removed
  document.getElementById("help-close")?.addEventListener("click", closeHelp);

  // User menu (bottom of help nav)
  document.getElementById("user-menu-platform")!.addEventListener("click", () => {
    closeHelp();
    window.yo.execCommand(`dip ${window.yo.platformUrl}`);
  });
  document.getElementById("user-menu-logout")!.addEventListener("click", async () => {
    await window.yo.logout();
    // Hide help overlay without restoring panels (they should stay hidden for onboarding)
    overlay.classList.add("hidden");
    window.yo.panelsHide();
    showOnboarding(true);
  });

  // Settings
  initSettings();

  // Apps (unified: local apps + connections)
  initApps();

  // Dashboard (includes prompts + data store)
  initDashboardEvents();

  // Layouts
  document.getElementById("layout-new-btn")!.addEventListener("click", newLayout);
  document.getElementById("layout-save-btn")!.addEventListener("click", saveLayout);
  document.getElementById("layout-cancel-btn")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-back-link")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-delete-btn")!.addEventListener("click", deleteLayout);
  layoutSearchInput.addEventListener("input", () => { layoutsPage = 0; renderLayoutsList(); });

  // Grid builder dimension controls
  gridColsSelect.addEventListener("change", () => {
    builderCols = parseInt(gridColsSelect.value, 10);
    initBuilderCells();
    renderGridPreview();
  });
  gridRowsSelect.addEventListener("change", () => {
    builderRows = parseInt(gridRowsSelect.value, 10);
    initBuilderCells();
    renderGridPreview();
  });
  mergeRightBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doMergeRight(builderSelected);
      renderGridPreview();
    }
  });
  mergeDownBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doMergeDown(builderSelected);
      renderGridPreview();
    }
  });
  splitBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doSplit(builderSelected);
      renderGridPreview();
    }
  });

  // Drips
  document.getElementById("drip-new-btn")!.addEventListener("click", () => openDripEditor("", ""));
  document.getElementById("drip-save-btn")!.addEventListener("click", saveDrip);
  document.getElementById("drip-cancel-btn")!.addEventListener("click", closeDripEditor);
  document.getElementById("drip-back-link")!.addEventListener("click", closeDripEditor);
  document.getElementById("drip-delete-btn")!.addEventListener("click", deleteDrip);
  document.getElementById("drip-preview-btn")!.addEventListener("click", () => {
    const recipe = buildDripRecipe();
    if (recipe) window.yo.dripsPreview(recipe);
  });
  dripModeSelect.addEventListener("change", () => {
    dripCountInput.classList.toggle("hidden", dripModeSelect.value !== "counted");
    updateDripRecipePreview();
  });
  dripCountInput.addEventListener("input", updateDripRecipePreview);
  document.getElementById("drip-add-effect")!.addEventListener("click", () => addEffectRow());
  dripSearchInput.addEventListener("input", () => { dripsPage = 0; renderDripsList(); });

  // Skills
  document.getElementById("skill-new-btn")!.addEventListener("click", () => openSkillEditor(null));
  document.getElementById("skill-save")!.addEventListener("click", saveSkill);
  document.getElementById("skill-cancel")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-back-link")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-delete")!.addEventListener("click", deleteSkill);
  document.getElementById("skill-run")!.addEventListener("click", runSkillFromEditor);
  document.getElementById("skill-tools-add")!.addEventListener("click", () => addToolRow());
  document.getElementById("skill-requires-add")!.addEventListener("click", () => addRequiresRow());
  document.getElementById("skill-schedule-freq")!.addEventListener("change", updateScheduleOpts);
  document.querySelectorAll("#sched-days-row .sched-day-chip").forEach(chip => {
    chip.addEventListener("click", () => { chip.classList.toggle("active"); updateSchedulePreview(); });
  });
  for (const id of ["sched-hour", "sched-minute", "sched-dom", "sched-interval"]) {
    document.getElementById(id)?.addEventListener("change", updateSchedulePreview);
  }
  document.getElementById("skill-schedule-cron")!.addEventListener("input", updateSchedulePreview);
  document.getElementById("skill-export")!.addEventListener("click", exportSkill);
  document.getElementById("skill-new-file-btn")!.addEventListener("click", addSkillFile);
  document.getElementById("skill-new-folder-btn")!.addEventListener("click", addSkillFolder);
  document.getElementById("skill-upload-file-btn")!.addEventListener("click", () => {
    (document.getElementById("skill-upload-input") as HTMLInputElement).click();
  });
  document.getElementById("skill-upload-input")!.addEventListener("change", uploadSkillFiles);
  initSkillTreeResize();
  // Drag-and-drop .yo import onto the skills list
  skillsListEl.addEventListener("dragover", (e) => { e.preventDefault(); });
  skillsListEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && (file.name.endsWith(".yo") || file.name.endsWith(".zip"))) {
      await importSkill(file);
    }
  });
  skillSearchInput.addEventListener("input", () => { skillsPage = 0; renderSkillsList(); });

  // Apps (MCP merged into app tabs)
  document.getElementById("app-detail-close")!.addEventListener("click", closeAppDetail);

  // DOM Picker
  document.getElementById("app-pick-btn")!.addEventListener("click", pickElement);
  document.getElementById("map-save-btn")!.addEventListener("click", saveMapping);
  document.getElementById("map-cancel-btn")!.addEventListener("click", () => {
    appMapCommand.classList.add("hidden");
  });
  const mapKeySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  mapKeySelect.addEventListener("change", () => {
    document.getElementById("map-custom-key")!.classList.toggle("hidden", mapKeySelect.value !== "__custom__");
  });
  document.getElementById("app-preview-refresh")!.addEventListener("click", () => {
    appPreview.reload();
  });
}

// ── Dashboard ─────────────────────────────────────────────

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "#25C75E", navigator: "#48dbfb", researcher: "#feca57",
  coder: "#ff6b6b", "skill-runner": "#cc5de8", manager: "#ff9f43",
};
const AGENT_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator", navigator: "Navigator", researcher: "Researcher",
  coder: "Coder", "skill-runner": "Skill Runner", manager: "Manager",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

let dashAgentChart: any = null;
let dashHistoryChart: any = null;
let dashIntakeChart: any = null;
let dashFlowChart: any = null;
let dashRangeMode: "7" | "30" = "7";
let storeRangeMode: "7" | "30" = "7";

async function loadDashboard() {
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

  const labels = history.map((d) => {
    const dt = new Date(d.date + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
  const countData = history.map((d) => d.count);
  const bytesData = history.map((d) => d.bytes);

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

function buildPaginationBar(offset: number, pageSize: number, total: number, onNavigate: (newOffset: number) => void): HTMLElement {
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.ceil(total / pageSize);
  const bar = document.createElement("div");
  bar.className = "pagination-bar";

  const prev = document.createElement("button");
  prev.className = "action-btn";
  prev.textContent = "←";
  prev.disabled = page <= 1;
  prev.addEventListener("click", () => onNavigate(Math.max(0, offset - pageSize)));
  bar.appendChild(prev);

  const label = document.createElement("span");
  label.className = "pagination-label";
  label.textContent = `${page} / ${pages}`;
  bar.appendChild(label);

  const next = document.createElement("button");
  next.className = "action-btn";
  next.textContent = "→";
  next.disabled = page >= pages;
  next.addEventListener("click", () => onNavigate(offset + pageSize));
  bar.appendChild(next);

  return bar;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
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

function closeDashPromptDetail() {
  document.getElementById("dash-prompt-detail")!.classList.add("hidden");
  document.getElementById("dash-prompts-list")!.classList.remove("hidden");
  document.getElementById("dash-prompts-toolbar")!.classList.remove("hidden");
}

let dashPromptSearchTimer: ReturnType<typeof setTimeout> | null = null;

function initDashboardEvents() {
  document.getElementById("dash-refresh")?.addEventListener("click", () => loadDashboard());

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
  document.getElementById("data-back-link")?.addEventListener("click", closeDataDetail);
  document.getElementById("data-delete-btn")?.addEventListener("click", deleteDataEntry);
  document.getElementById("data-clear-btn")?.addEventListener("click", clearData);
  dataSearchInput?.addEventListener("input", () => { dataSearchDebounce(); });
}

// ── Data Store ────────────────────────────────────────────

const dataListEl = document.getElementById("data-list")!;
const dataToolbar = document.getElementById("data-toolbar")!;
const dataDetail = document.getElementById("data-detail")!;
const dataSearchInput = document.getElementById("data-search") as HTMLInputElement;
const dataDetailMeta = document.getElementById("data-detail-meta")!;
const dataDetailContent = document.getElementById("data-detail-content")!;
const dataSourcesBar = document.getElementById("data-sources-bar")!;
let dataOffset = 0;
const DATA_PAGE_SIZE = 20;
let viewingEntryId: string | null = null;
let dataSearchTimer: ReturnType<typeof setTimeout> | null = null;

function dataSearchDebounce() {
  if (dataSearchTimer) clearTimeout(dataSearchTimer);
  dataSearchTimer = setTimeout(() => { dataOffset = 0; renderDataList(); }, 300);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function relativeTime(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function loadData() {
  dataDetail.classList.add("hidden");
  dataListEl.classList.remove("hidden");
  dataToolbar.classList.remove("hidden");

  const stats = await window.yo.capturesStats();

  dataSourcesBar.innerHTML = "";
  const sorted = Object.entries(stats.sources).sort((a, b) => b[1] - a[1]);
  for (const [source, count] of sorted) {
    const chip = document.createElement("span");
    chip.className = "store-source-chip";
    chip.innerHTML = `${source} <span class="chip-count">${count}</span>`;
    chip.title = `Click to delete all captures from ${source}`;
    chip.addEventListener("click", async () => {
      const confirmed = await confirmAction(`Delete all ${count} captures from "${source}"?`);
      if (!confirmed) return;
      await window.yo.capturesDeleteBySource(source);
      loadData();
    });
    dataSourcesBar.appendChild(chip);
  }

  renderDataList();
}

async function renderDataList() {
  const query = dataSearchInput.value.trim();

  if (query) {
    const results = await window.yo.capturesSearch(query, 200);
    const total = results.length;
    const page = results.slice(dataOffset, dataOffset + DATA_PAGE_SIZE);
    dataListEl.innerHTML = "";
    if (page.length === 0) {
      dataListEl.innerHTML = `<div class="crud-empty">No captures matching "${query}"</div>`;
      return;
    }
    for (const r of page) {
      dataListEl.appendChild(makeDataCard(r.meta.id, r.meta.source, r.meta.created, r.content.slice(0, 200), r.score));
    }
    if (total > DATA_PAGE_SIZE) {
      dataListEl.appendChild(buildPaginationBar(dataOffset, DATA_PAGE_SIZE, total, (newOffset) => {
        dataOffset = newOffset;
        renderDataList();
      }));
    }
    return;
  }

  const [entries, stats] = await Promise.all([
    window.yo.capturesList(dataOffset, DATA_PAGE_SIZE),
    window.yo.capturesStats(),
  ]);
  const total = stats.count;
  dataListEl.innerHTML = "";
  if (entries.length === 0 && dataOffset === 0) {
    dataListEl.innerHTML = `<div class="crud-empty">No captures yet. Use .sup to capture panel content.</div>`;
    return;
  }

  for (const e of entries) {
    dataListEl.appendChild(makeDataCard(e.meta.id, e.meta.source, e.meta.created, e.snippet, undefined, e.size));
  }

  if (total > DATA_PAGE_SIZE) {
    dataListEl.appendChild(buildPaginationBar(dataOffset, DATA_PAGE_SIZE, total, (newOffset) => {
      dataOffset = newOffset;
      renderDataList();
    }));
  }
}

function makeDataCard(id: string, source: string, created: number, snippet: string, score?: number, size?: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "crud-card";
  const info = document.createElement("div");
  info.className = "crud-card-info";
  info.style.cssText = "min-width:0;";

  const nameRow = document.createElement("div");
  nameRow.style.cssText = "display:flex;gap:6px;align-items:center;";
  const srcSpan = document.createElement("span");
  srcSpan.className = "crud-card-name";
  srcSpan.textContent = source;
  nameRow.appendChild(srcSpan);
  const timeSpan = document.createElement("span");
  timeSpan.style.cssText = "font-size:10px;color:var(--text-muted);";
  timeSpan.textContent = relativeTime(created);
  nameRow.appendChild(timeSpan);
  if (size !== undefined && size > 0) {
    const sizeSpan = document.createElement("span");
    sizeSpan.style.cssText = "font-size:10px;color:#48dbfb;flex-shrink:0;";
    sizeSpan.textContent = formatBytes(size);
    nameRow.appendChild(sizeSpan);
  }
  if (score !== undefined) {
    const scoreSpan = document.createElement("span");
    scoreSpan.style.cssText = "font-size:10px;color:var(--accent);";
    scoreSpan.textContent = `${(score * 100).toFixed(0)}%`;
    nameRow.appendChild(scoreSpan);
  }
  info.appendChild(nameRow);

  const meta = document.createElement("span");
  meta.className = "crud-card-meta";
  meta.textContent = snippet;
  meta.style.cssText = "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
  info.appendChild(meta);
  card.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "crud-card-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "crud-card-btn danger crud-delete-btn";
  delBtn.title = "Delete";
  delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await window.yo.capturesDelete(id);
    loadData();
  });
  actions.appendChild(delBtn);
  card.appendChild(actions);

  card.addEventListener("click", () => openDataDetail(id, source, created));
  return card;
}

async function openDataDetail(id: string, source: string, created: number) {
  viewingEntryId = id;
  const [content, size] = await Promise.all([
    window.yo.capturesRead(id),
    window.yo.capturesEntrySize(id),
  ]);
  dataDetailMeta.textContent = `${source} · ${new Date(created).toLocaleString()} · ${formatBytes(size)} · ${id}`;
  dataDetailContent.textContent = content || "(empty)";

  dataListEl.classList.add("hidden");
  dataToolbar.classList.add("hidden");
  dataSourcesBar.classList.add("hidden");
  dataDetail.classList.remove("hidden");
}

function closeDataDetail() {
  dataDetail.classList.add("hidden");
  dataListEl.classList.remove("hidden");
  dataToolbar.classList.remove("hidden");
  dataSourcesBar.classList.remove("hidden");
  viewingEntryId = null;
  loadData();
}

async function deleteDataEntry() {
  if (!viewingEntryId) return;
  const confirmed = await confirmAction("Delete this capture?");
  if (!confirmed) return;
  await window.yo.capturesDelete(viewingEntryId);
  closeDataDetail();
}

async function clearData() {
  const confirmed = await confirmAction("Delete ALL captures? This cannot be undone.");
  if (!confirmed) return;
  await window.yo.capturesClear();
  loadData();
}

// ── Layouts (Grid Builder) ──────────────────────────────────

let layoutsPage = 0;
let allLayouts: Array<{ name: string; splits: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }> }> = [];
const layoutsList = document.getElementById("layouts-list")!;
const layoutEditor = document.getElementById("layout-editor")!;
const layoutsToolbar = document.getElementById("layouts-toolbar")!;
const layoutSearchInput = document.getElementById("layout-search") as HTMLInputElement;
const layoutNameInput = document.getElementById("layout-new-name") as HTMLInputElement;
const layoutFormError = document.getElementById("layout-form-error")!;
const layoutDeleteBtn = document.getElementById("layout-delete-btn") as HTMLButtonElement;
const layoutEditorTitle: HTMLElement | null = document.getElementById("layout-editor-title");
let editingLayoutName: string | null = null;
const gridPreview = document.getElementById("grid-preview")!;
const gridColsSelect = document.getElementById("grid-cols") as HTMLSelectElement;
const gridRowsSelect = document.getElementById("grid-rows") as HTMLSelectElement;
const mergeRightBtn = document.getElementById("grid-merge-right") as HTMLButtonElement;
const mergeDownBtn = document.getElementById("grid-merge-down") as HTMLButtonElement;
const splitBtn = document.getElementById("grid-split-btn") as HTMLButtonElement;

interface BuilderCell {
  panelId: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

let builderCols = 2;
let builderRows = 1;
let builderCells: BuilderCell[] = [];
let builderSelected = -1;

function initBuilderCells() {
  builderCells = [];
  for (let r = 0; r < builderRows; r++) {
    for (let c = 0; c < builderCols; c++) {
      builderCells.push({ panelId: "", col: c, row: r, colSpan: 1, rowSpan: 1 });
    }
  }
  builderSelected = -1;
}

function cellAt(col: number, row: number): number {
  return builderCells.findIndex(
    (c) => col >= c.col && col < c.col + c.colSpan && row >= c.row && row < c.row + c.rowSpan,
  );
}

function canMergeRight(idx: number): boolean {
  const cell = builderCells[idx];
  if (cell.col + cell.colSpan >= builderCols) return false;
  // All cells in the column to the right (within this cell's row range) must be one cell with matching span
  const rightIdx = cellAt(cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return false;
  const right = builderCells[rightIdx];
  return right.col === cell.col + cell.colSpan &&
    right.row === cell.row && right.rowSpan === cell.rowSpan;
}

function canMergeDown(idx: number): boolean {
  const cell = builderCells[idx];
  if (cell.row + cell.rowSpan >= builderRows) return false;
  const belowIdx = cellAt(cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return false;
  const below = builderCells[belowIdx];
  return below.row === cell.row + cell.rowSpan &&
    below.col === cell.col && below.colSpan === cell.colSpan;
}

function doMergeRight(idx: number) {
  const cell = builderCells[idx];
  const rightIdx = cellAt(cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return;
  cell.colSpan += builderCells[rightIdx].colSpan;
  builderCells.splice(rightIdx, 1);
  builderSelected = builderCells.indexOf(cell);
}

function doMergeDown(idx: number) {
  const cell = builderCells[idx];
  const belowIdx = cellAt(cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return;
  cell.rowSpan += builderCells[belowIdx].rowSpan;
  builderCells.splice(belowIdx, 1);
  builderSelected = builderCells.indexOf(cell);
}

function doSplit(idx: number) {
  const cell = builderCells[idx];
  if (cell.colSpan === 1 && cell.rowSpan === 1) return;
  const newCells: BuilderCell[] = [];
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      newCells.push({
        panelId: r === cell.row && c === cell.col ? cell.panelId : "",
        col: c, row: r, colSpan: 1, rowSpan: 1,
      });
    }
  }
  builderCells.splice(idx, 1, ...newCells);
  builderSelected = -1;
}

function updateMergeButtons() {
  if (builderSelected < 0) {
    mergeRightBtn.disabled = true;
    mergeDownBtn.disabled = true;
    splitBtn.disabled = true;
    return;
  }
  const cell = builderCells[builderSelected];
  mergeRightBtn.disabled = !canMergeRight(builderSelected);
  mergeDownBtn.disabled = !canMergeDown(builderSelected);
  splitBtn.disabled = cell.colSpan === 1 && cell.rowSpan === 1;
}

function renderGridPreview() {
  gridPreview.style.gridTemplateColumns = `repeat(${builderCols}, 1fr)`;
  gridPreview.style.gridTemplateRows = `repeat(${builderRows}, 1fr)`;

  gridPreview.innerHTML = builderCells
    .map((cell, i) => {
      const cls = ["grid-cell"];
      if (cell.panelId) cls.push("assigned");
      if (i === builderSelected) cls.push("selected");
      return `<div class="${cls.join(" ")}" data-index="${i}"
        style="grid-column: ${cell.col + 1} / span ${cell.colSpan}; grid-row: ${cell.row + 1} / span ${cell.rowSpan}">
        ${cell.panelId || "\u2014"}
      </div>`;
    })
    .join("");

  gridPreview.querySelectorAll(".grid-cell").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt((el as HTMLElement).dataset.index!, 10);
      showCellPicker(idx, el as HTMLElement);
    });
  });

  updateMergeButtons();
}

async function showCellPicker(cellIndex: number, anchor: HTMLElement) {
  document.querySelectorAll(".cell-panel-picker").forEach((el) => el.remove());
  // Capture position before re-render destroys the anchor element
  const rect = anchor.getBoundingClientRect();
  builderSelected = cellIndex;
  renderGridPreview();

  const apps = await window.yo.appsList();

  const picker = document.createElement("div");
  picker.className = "cell-panel-picker";
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  picker.innerHTML = [
    `<input class="cell-panel-search" placeholder="Search…" autocomplete="off" spellcheck="false" />`,
    `<div class="cell-panel-options">`,
    `<div class="cell-panel-option empty" data-id="">Empty</div>`,
    ...apps.map((a) => `<div class="cell-panel-option" data-id="${a.id}">${a.name}</div>`),
    `</div>`,
  ].join("");

  document.body.appendChild(picker);

  const closePicker = (ev: MouseEvent) => {
    if (!(ev.target as HTMLElement).closest(".cell-panel-picker")) {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  };

  const searchInput = picker.querySelector(".cell-panel-search") as HTMLInputElement;
  searchInput.focus();

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    picker.querySelectorAll<HTMLElement>(".cell-panel-option:not(.empty)").forEach((opt) => {
      opt.style.display = (opt.textContent || "").toLowerCase().includes(q) ? "" : "none";
    });
  });

  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  });

  picker.querySelectorAll(".cell-panel-option").forEach((opt) => {
    opt.addEventListener("click", (ev) => {
      ev.stopPropagation();
      builderCells[cellIndex].panelId = (opt as HTMLElement).dataset.id!;
      picker.remove();
      renderGridPreview();
    });
  });

  setTimeout(() => document.addEventListener("click", closePicker), 0);
}

async function loadLayouts() {
  layoutEditor.classList.add("hidden");
  layoutFormError.classList.add("hidden");
  allLayouts = await window.yo.layoutsList();

  // Check layout limit for free tier
  const limitMsg = document.getElementById("layouts-limit-msg")!;
  const newBtn = document.getElementById("layout-new-btn") as HTMLButtonElement;
  try {
    const auth = await window.yo.getAuthStatus();
    const atLimit = auth.tier !== "basic" && auth.tier !== "advanced" && allLayouts.length >= 5;
    limitMsg.classList.toggle("hidden", !atLimit);
    newBtn.disabled = atLimit;
    if (atLimit) {
      document.getElementById("layouts-upgrade-link")!.onclick = (e) => {
        e.preventDefault();
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
    }
  } catch { /* fall through */ }

  renderLayoutsList();
}

function renderLayoutsList() {
  const query = layoutSearchInput.value.trim().toLowerCase();
  const filtered = query ? allLayouts.filter((l) => l.name.toLowerCase().includes(query)) : allLayouts;

  if (allLayouts.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts matching "${query}"</div>`;
    return;
  }

  const { items: layouts, state } = paginate(filtered, layoutsPage);
  layoutsPage = state.page;
  layoutsList.innerHTML = "";

  for (const layout of layouts) {
    const card = document.createElement("div");
    card.className = "crud-card";
    const panels = layout.splits.map((s) => s.panelId).filter(Boolean).join(" | ");
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${layout.name}</span>
        <span class="crud-card-meta">${panels || "empty"}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      editLayout(layout.name);
    });

    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete layout "${layout.name}"?`);
      if (!confirmed) return;
      await window.yo.layoutsDelete(layout.name);
      loadLayouts();
    });

    card.addEventListener("click", () => editLayout(layout.name));
    layoutsList.appendChild(card);
  }

  layoutsList.appendChild(renderPaginationBar(state, (p) => { layoutsPage = p; renderLayoutsList(); }));
}

async function editLayout(name: string) {
  editingLayoutName = name;
  const layouts = await window.yo.layoutsList();
  const layout = layouts.find((l) => l.name === name);
  if (layout) {
    builderCols = layout.cols || 2;
    builderRows = layout.rows || 1;
    initBuilderCells();
    for (const s of layout.splits) {
      const cell = builderCells.find((c) => c.col === s.col && c.row === s.row);
      if (cell) {
        cell.panelId = s.panelId;
        cell.colSpan = s.colSpan ?? 1;
        cell.rowSpan = s.rowSpan ?? 1;
      }
    }
  } else {
    builderCols = 2;
    builderRows = 1;
    initBuilderCells();
  }
  gridColsSelect.value = String(builderCols);
  gridRowsSelect.value = String(builderRows);
  layoutNameInput.value = name;
  layoutDeleteBtn.style.display = "";
  if (layoutEditorTitle) layoutEditorTitle.textContent = name;
  layoutFormError.classList.add("hidden");
  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  renderGridPreview();
}

async function newLayout() {
  editingLayoutName = null;
  builderCols = 2;
  builderRows = 1;
  initBuilderCells();
  gridColsSelect.value = "2";
  gridRowsSelect.value = "1";
  layoutNameInput.value = "";
  layoutDeleteBtn.style.display = "none";
  if (layoutEditorTitle) layoutEditorTitle.textContent = "New Layout";
  layoutFormError.classList.add("hidden");
  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  layoutNameInput.focus();
  renderGridPreview();
}

function cancelLayout() {
  layoutEditor.classList.add("hidden");
  layoutsList.classList.remove("hidden");
  layoutsToolbar.classList.remove("hidden");
  editingLayoutName = null;
  loadLayouts();
}

async function saveLayout() {
  const name = layoutNameInput.value.trim();
  if (!name) {
    layoutNameInput.classList.add("invalid");
    clearInvalid(layoutNameInput);
    layoutFormError.textContent = "Layout name is required.";
    layoutFormError.classList.remove("hidden");
    return;
  }
  const assignedCells = builderCells.filter((c) => c.panelId);
  if (assignedCells.length < 1) {
    layoutFormError.textContent = "Assign at least one panel to the grid.";
    layoutFormError.classList.remove("hidden");
    return;
  }

  if (editingLayoutName && editingLayoutName !== name) {
    await window.yo.layoutsDelete(editingLayoutName);
  }

  await window.yo.layoutsSaveGrid({
    name,
    cols: builderCols,
    rows: builderRows,
    colWidths: Array(builderCols).fill(1 / builderCols),
    rowHeights: Array(builderRows).fill(1 / builderRows),
    cells: assignedCells,
  });
  cancelLayout();
}

async function deleteLayout() {
  if (!editingLayoutName) return;
  const confirmed = await confirmAction(`Delete layout "${editingLayoutName}"?`);
  if (!confirmed) return;
  await window.yo.layoutsDelete(editingLayoutName);
  cancelLayout();
}

// ── Apps (unified: apps + MCP + connections) ────────────

let appsPage = 0;
const appsList = document.getElementById("apps-list")!;
const appDetail = document.getElementById("app-detail")!;
const appAddForm = document.getElementById("app-add-form")!;
const mcpAddForm = document.getElementById("mcp-add-form")!;
const appDetailId = document.getElementById("app-detail-id") as HTMLInputElement;
const appDetailName = document.getElementById("app-detail-name") as HTMLInputElement;
const appDetailUrl = document.getElementById("app-detail-url") as HTMLInputElement;
const appForceWeb = document.getElementById("app-detail-force-web") as HTMLInputElement;
const appDoNotRecord = document.getElementById("app-detail-do-not-record") as HTMLInputElement;
const appSearchInput = document.getElementById("app-search") as HTMLInputElement;
const appConnectStatus = document.getElementById("app-connect-status")!;
const appCommandsList = document.getElementById("app-commands-list")!;
const appMapCommand = document.getElementById("app-map-command")!;
const appPreview = document.getElementById("app-preview") as HTMLElement & {
  src: string;
  partition: string;
  getWebContentsId: () => number;
  reload: () => void;
};
const appsToolbar = document.getElementById("apps-toolbar")!;
const appFormError = document.getElementById("app-form-error")!;
const appDetailHeading = document.getElementById("app-detail-heading")!;

let currentAppId = "";
let activeAppTab: "dashboard" | "panel" | "connection" | "mcp" = "dashboard";
let connectorSearchOffset = 0;

interface PanelApp {
  id: string;
  name: string;
  url?: string;
  connectedSlug?: string;
  forceWeb?: boolean;
  doNotRecord?: boolean;
  commands?: Record<string, { selector: string; action: string; description: string }>;
  connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
  mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; enabled: boolean };
}

let panelApps: PanelApp[] = [];

async function loadApps() {
  appDetail.classList.add("hidden");
  appAddForm.classList.add("hidden");
  mcpAddForm.classList.add("hidden");

  document.getElementById("apps-pro-gate")!.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");

  try {
    const apps = await window.yo.appsList();
    // Hide internal yo:// apps (browser, terminal, vscode, monaco, home) from the management list
    panelApps = apps
      .filter((a) => !a.url?.startsWith("yo://"))
      .map((a) => ({
        id: a.id, name: a.name, url: a.url,
        connectedSlug: a.connectedSlug, forceWeb: a.forceWeb, doNotRecord: a.doNotRecord,
        commands: a.commands, connection: a.connection, mcp: a.mcp,
      }));
  } catch { panelApps = []; }

  // Check app limit for free tier
  const appsLimitMsg = document.getElementById("apps-limit-msg")!;
  const appsAddBtn = document.getElementById("apps-add-btn") as HTMLButtonElement;
  try {
    const auth = await window.yo.getAuthStatus();
    const userApps = panelApps.filter(a => a.url && !a.url.startsWith("yo://"));
    const atLimit = auth.tier !== "basic" && auth.tier !== "advanced" && userApps.length >= 10;
    appsLimitMsg.classList.toggle("hidden", !atLimit);
    appsAddBtn.disabled = atLimit;
    if (atLimit) {
      document.getElementById("apps-upgrade-link")!.onclick = (e) => {
        e.preventDefault();
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
    }
  } catch { /* fall through */ }

  renderAppsList();
}

function renderAppsList() {
  const query = appSearchInput.value.trim().toLowerCase();

  const filtered = query
    ? panelApps.filter((a) => a.name.toLowerCase().includes(query) || (a.url || "").toLowerCase().includes(query))
    : panelApps;

  appsList.className = "app-grid";

  if (panelApps.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps yet. Click "+ New" to add one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps matching "${query}"</div>`;
    return;
  }

  const { items: pageApps, state } = paginate(filtered, appsPage);
  appsPage = state.page;
  appsList.innerHTML = "";

  for (const app of pageApps) {
    const isInternal = app.url?.startsWith("yo://");
    const hasUrl = app.url && !isInternal;
    const faviconUrl = hasUrl
      ? `https://www.google.com/s2/favicons?domain=${new URL(app.url!).hostname}&sz=64`
      : "";
    const initial = app.name.charAt(0).toUpperCase();

    const badges: string[] = [];
    if (app.mcp && !app.url) badges.push(`<span class="app-card-badge">MCP</span>`);
    if (app.connection?.accountId) badges.push(`<span class="app-card-badge badge-connection">API</span>`);

    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      ${badges.join("")}
      <div class="app-card-icon">
        ${faviconUrl
          ? `<img src="${faviconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="app-card-initial" style="display:none">${initial}</span>`
          : `<span class="app-card-initial">${initial}</span>`}
      </div>
      <div class="app-card-name">${app.name}</div>
      <div class="app-card-id">${app.id}</div>`;

    card.addEventListener("click", () => openPanelAppDetail(app));
    appsList.appendChild(card);
  }

  appsList.appendChild(renderPaginationBar(state, (p) => { appsPage = p; renderAppsList(); }));
}

// ── Tab switching ────────────────────────────────────────

function switchAppTab(tab: string) {
  activeAppTab = tab as typeof activeAppTab;
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".app-tab-left").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".app-tab-right").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  if (tab === "dashboard") loadDashboardTab();
  if (tab === "panel") loadPanelTab();
  if (tab === "connection") loadConnectionTab();
  if (tab === "mcp") loadMcpTab();
}

// ── Dashboard tab ────────────────────────────────────────

let appDashIntakeChart: any = null;
let appDashRangeMode: "7" | "30" = "7";
let appDashDataOffset = 0;
const APP_DASH_PAGE_SIZE = 20;
let appDashViewingId: string | null = null;
// search not yet wired — placeholder for future use

async function loadDashboardTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  const icon = document.getElementById("app-dash-icon")!;
  const dashName = document.getElementById("app-dash-name")!;
  dashName.textContent = app.name;

  if (app.url && !app.url.startsWith("yo://")) {
    try {
      icon.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=${new URL(app.url).hostname}&sz=64" onerror="this.outerHTML='${app.name.charAt(0).toUpperCase()}'" style="width:100%;height:100%;object-fit:contain;" />`;
    } catch { icon.textContent = app.name.charAt(0).toUpperCase(); }
  } else {
    icon.textContent = app.name.charAt(0).toUpperCase();
  }

  appDashDataOffset = 0;
  appDashViewingId = null;

  const stats = await window.yo.capturesStatsForSource(app.id);

  document.getElementById("app-dash-captures")!.textContent = String(stats.count);
  document.getElementById("app-dash-embedded")!.textContent = String(stats.embeddedCount);
  document.getElementById("app-dash-disk")!.textContent = formatBytes(stats.diskBytes);
  document.getElementById("app-dash-oldest")!.textContent = relativeTime(stats.oldestTs);
  document.getElementById("app-dash-newest")!.textContent = relativeTime(stats.newestTs);

  renderAppDashIntakeChart();
  renderAppDashDataList();
}

async function renderAppDashIntakeChart() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;
  const canvas = document.getElementById("app-dash-chart-intake") as HTMLCanvasElement | null;
  if (!canvas) return;

  const days = appDashRangeMode === "30" ? 30 : 7;
  const history: Array<{ date: string; count: number; bytes: number }> = await window.yo.capturesDailyHistoryForSource(app.id, days);

  const labels = history.map((d) => {
    const dt = new Date(d.date + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
  const countData = history.map((d) => d.count);
  const bytesData = history.map((d) => d.bytes);

  const ctx = canvas.getContext("2d")!;
  if (appDashIntakeChart) appDashIntakeChart.destroy();

  appDashIntakeChart = new Chart(ctx, {
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

async function renderAppDashDataList() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  const listEl = document.getElementById("app-dash-data-list")!;
  const toolbarEl = document.getElementById("app-dash-data-toolbar")!;
  const detailEl = document.getElementById("app-dash-data-detail")!;

  detailEl.classList.add("hidden");
  listEl.classList.remove("hidden");
  toolbarEl.classList.remove("hidden");

  const entries = await window.yo.capturesListForSource(app.id, appDashDataOffset, APP_DASH_PAGE_SIZE);
  const stats = await window.yo.capturesStatsForSource(app.id);
  const total = stats.count;

  listEl.innerHTML = "";
  if (entries.length === 0 && appDashDataOffset === 0) {
    listEl.innerHTML = `<div class="crud-empty">No captures yet. Use .sup on this app to start capturing.</div>`;
    return;
  }

  for (const e of entries) {
    const card = document.createElement("div");
    card.className = "crud-card";
    const info = document.createElement("div");
    info.className = "crud-card-info";
    info.style.cssText = "min-width:0;";

    const nameRow = document.createElement("div");
    nameRow.style.cssText = "display:flex;gap:6px;align-items:center;";
    const timeSpan = document.createElement("span");
    timeSpan.className = "crud-card-name";
    timeSpan.textContent = relativeTime(e.meta.created);
    nameRow.appendChild(timeSpan);
    if (e.size > 0) {
      const sizeSpan = document.createElement("span");
      sizeSpan.style.cssText = "font-size:10px;color:#48dbfb;flex-shrink:0;";
      sizeSpan.textContent = formatBytes(e.size);
      nameRow.appendChild(sizeSpan);
    }
    info.appendChild(nameRow);

    const meta = document.createElement("span");
    meta.className = "crud-card-meta";
    meta.textContent = e.snippet;
    meta.style.cssText = "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
    info.appendChild(meta);
    card.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "crud-card-actions";
    const delBtn = document.createElement("button");
    delBtn.className = "crud-card-btn danger crud-delete-btn";
    delBtn.title = "Delete";
    delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await window.yo.capturesDelete(e.meta.id);
      renderAppDashDataList();
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);

    card.addEventListener("click", () => openAppDashDataDetail(e.meta.id, e.meta.created));
    listEl.appendChild(card);
  }

  if (total > APP_DASH_PAGE_SIZE) {
    listEl.appendChild(buildPaginationBar(appDashDataOffset, APP_DASH_PAGE_SIZE, total, (newOffset) => {
      appDashDataOffset = newOffset;
      renderAppDashDataList();
    }));
  }
}

async function openAppDashDataDetail(id: string, created: number) {
  appDashViewingId = id;
  const [content, size] = await Promise.all([
    window.yo.capturesRead(id),
    window.yo.capturesEntrySize(id),
  ]);
  const detailEl = document.getElementById("app-dash-data-detail")!;
  const listEl = document.getElementById("app-dash-data-list")!;
  const toolbarEl = document.getElementById("app-dash-data-toolbar")!;
  document.getElementById("app-dash-data-meta")!.textContent = `${new Date(created).toLocaleString()} · ${formatBytes(size)} · ${id}`;
  document.getElementById("app-dash-data-content")!.textContent = content || "(empty)";

  listEl.classList.add("hidden");
  toolbarEl.classList.add("hidden");
  detailEl.classList.remove("hidden");
}

function closeAppDashDataDetail() {
  document.getElementById("app-dash-data-detail")!.classList.add("hidden");
  document.getElementById("app-dash-data-list")!.classList.remove("hidden");
  document.getElementById("app-dash-data-toolbar")!.classList.remove("hidden");
  appDashViewingId = null;
  renderAppDashDataList();
}

async function deleteAppDashDataEntry() {
  if (!appDashViewingId) return;
  const confirmed = await confirmAction("Delete this capture?");
  if (!confirmed) return;
  await window.yo.capturesDelete(appDashViewingId);
  closeAppDashDataDetail();
  loadDashboardTab();
}

// ── Panel tab ────────────────────────────────────────────

let panelLoaded = false;

function loadPanelTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;
  if (!app.url) {
    document.getElementById("app-commands-list")!.innerHTML = `<div class="inline-empty">No URL configured for this app. Add a URL on the Dashboard tab to enable panel features.</div>`;
    return;
  }
  if (!panelLoaded) {
    appPreview.partition = "persist:yo";
    appPreview.src = app.url;
    panelLoaded = true;
  }
  refreshCommands();
}

// ── Connection tab ───────────────────────────────────────

async function loadConnectionTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  const gate = document.getElementById("connection-upgrade-gate")!;
  const statusEl = document.getElementById("app-connection-status")!;
  const listEl = document.getElementById("app-connected-list")!;
  const toolsEl = document.getElementById("app-connection-tools")!;
  const noToolsEl = document.getElementById("app-connection-no-tools")!;
  const browseEl = document.querySelector<HTMLElement>(".connection-browse")!;

  // Gate behind Advanced tier
  try {
    const auth = await window.yo.getAuthStatus();
    if (auth.tier !== "advanced") {
      gate.classList.remove("hidden");
      statusEl.innerHTML = "";
      listEl.innerHTML = "";
      browseEl.classList.add("hidden");
      toolsEl.innerHTML = "";
      noToolsEl.classList.add("hidden");
      gate.querySelector<HTMLButtonElement>(".tab-upgrade-btn")!.onclick = () => {
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
      return;
    }
  } catch { /* fall through */ }
  gate.classList.add("hidden");

  // Left: this app's connection
  listEl.innerHTML = "";
  const isConnected = !!app.connection?.accountId;

  if (app.connection && isConnected) {
    // Connected — show status + disconnect, hide browse grid
    browseEl.classList.add("hidden");
    statusEl.innerHTML = `
      <div class="connection-status">
        <span class="connection-status-dot connected"></span>
        <div class="connection-status-info">
          <div class="connection-status-name">${app.connection.pipedreamSlug}</div>
          <div class="connection-status-meta">Connected${app.connection.healthy === false ? " (unhealthy)" : ""}</div>
        </div>
        <button class="action-btn danger" id="app-conn-disconnect" style="height:28px;font-size:12px;">Disconnect</button>
      </div>`;

    document.getElementById("app-conn-disconnect")?.addEventListener("click", async () => {
      if (!app.connection?.accountId) return;
      const btn = document.getElementById("app-conn-disconnect") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Disconnecting...";
      await window.yo.connectorsDisconnect(app.connection.accountId);
      // Also remove the connection from the app so it clears properly
      await window.yo.appsRemoveConnection(app.id);
      const apps = await window.yo.appsList();
      reloadPanelApps(apps);
      loadConnectionTab();
    });
  } else {
    // Not connected — show browse grid to pick an app
    statusEl.innerHTML = "";
    browseEl.classList.remove("hidden");
    connectorSearchOffset = 0;
    const searchInput = document.getElementById("app-connector-search") as HTMLInputElement;
    if (searchInput) searchInput.value = "";
    loadConnectorGrid();
  }

  // Right: tools for this app's connection
  toolsEl.innerHTML = "";
  noToolsEl.classList.add("hidden");
  if (isConnected && app.connection?.pipedreamSlug) {
    await loadConnectionTools(app.id);
  } else {
    noToolsEl.textContent = "Connect an app to see its tools.";
    noToolsEl.classList.remove("hidden");
  }
}

async function loadConnectionTools(appId: string) {
  const toolsEl = document.getElementById("app-connection-tools")!;
  const noToolsEl = document.getElementById("app-connection-no-tools")!;
  toolsEl.innerHTML = "";

  const servers = await window.yo.mcpGetServers();
  const pdServer = servers.find((s) => s.config.id === appId);

  if (!pdServer) {
    noToolsEl.textContent = "Connecting...";
    noToolsEl.classList.remove("hidden");
    console.log(`[connection-tools] No server "${appId}" found. Available:`, servers.map(s => s.config.id));

    try {
      const refreshResult = await window.yo.connectorsRefreshMcp();
      console.log("[connection-tools] refreshMcp result:", refreshResult);
      const retryServers = await window.yo.mcpGetServers();
      console.log("[connection-tools] After refresh, servers:", retryServers.map(s => `${s.config.id} (${s.status}, ${s.tools.length} tools)`));
      const retryPd = retryServers.find((s) => s.config.id === appId);
      if (retryPd) {
        noToolsEl.classList.add("hidden");
        return loadConnectionTools(appId);
      }
    } catch (err) {
      console.error("[connection-tools] refreshMcp error:", err);
    }
    noToolsEl.textContent = "Tools not available for this app.";
    return;
  }

  if (pdServer.status !== "connected") {
    noToolsEl.textContent = `Server: ${pdServer.status}${pdServer.error ? " — " + pdServer.error : ""}. Reconnecting...`;
    noToolsEl.classList.remove("hidden");

    try {
      const result = await window.yo.connectorsRefreshMcp();
      if (result.ok) {
        noToolsEl.classList.add("hidden");
        return loadConnectionTools(appId);
      }
      noToolsEl.textContent = `Server: ${pdServer.status}${result.error ? " — " + result.error : ""}`;
    } catch { /* ignore */ }
    return;
  }

  if (pdServer.tools.length === 0) {
    noToolsEl.textContent = "Server connected but no tools discovered.";
    noToolsEl.classList.remove("hidden");
    return;
  }

  const toolsToShow = pdServer.tools;

  noToolsEl.classList.add("hidden");
  for (const tool of toolsToShow) {
    const row = document.createElement("div");
    row.className = "crud-card";
    row.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name" style="font-family:var(--font-mono);font-size:11px;">${tool.name}</span>
        <span class="crud-card-meta">${tool.description || ""}</span>
      </div>`;
    toolsEl.appendChild(row);
  }
}

async function loadConnectorGrid(search?: string) {
  const grid = document.getElementById("app-connector-grid")!;
  const loadMore = document.getElementById("app-connector-load-more")!;

  try {
    const { apps, hasMore } = await window.yo.connectorsGetApps(search, connectorSearchOffset);
    if (connectorSearchOffset === 0) grid.innerHTML = "";

    for (const app of apps) {
      const card = document.createElement("div");
      card.className = "connector-card";
      const initial = app.name.charAt(0).toUpperCase();
      card.innerHTML = `
        ${app.icon
          ? `<img class="connector-card-icon" src="${app.icon}" onerror="this.outerHTML='<span class=\\'connector-card-initial\\'>${initial}</span>'" />`
          : `<span class="connector-card-initial">${initial}</span>`}
        <div class="connector-card-info">
          <div class="connector-card-name">${app.name}</div>
        </div>`;
      card.addEventListener("click", async () => {
        const nameEl = card.querySelector(".connector-card-name")!;
        nameEl.textContent = "Connecting...";
        // Set the pipedream slug on the current app FIRST so syncAccountsToApps can find it
        const currentApp = panelApps.find((a) => a.id === currentAppId);
        if (currentApp) {
          await window.yo.appsSetConnection(currentApp.id, app.id);
        }
        const result = await window.yo.connectorsConnect(app.id);
        if (!result.ok) {
          nameEl.textContent = result.error || "Connection failed";
          // Remove the connection we just set since connect failed
          if (currentApp) await window.yo.appsRemoveConnection(currentApp.id);
          setTimeout(() => { nameEl.textContent = app.name; }, 3000);
          return;
        }
        const allApps = await window.yo.appsList();
        reloadPanelApps(allApps);
        loadConnectionTab();
      });
      grid.appendChild(card);
    }

    loadMore.classList.toggle("hidden", !hasMore);
  } catch {
    if (connectorSearchOffset === 0) grid.innerHTML = `<div class="crud-empty" style="grid-column:1/-1;">Could not load apps. Check your connection.</div>`;
  }
}

// ── MCP tab ──────────────────────────────────────────────

async function loadMcpTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  const mcpGate = document.getElementById("mcp-tab-upgrade-gate")!;
  const statusRow = document.getElementById("app-mcp-status-row")!;

  // Gate behind Advanced tier
  try {
    const auth = await window.yo.getAuthStatus();
    if (auth.tier !== "advanced") {
      mcpGate.classList.remove("hidden");
      statusRow.classList.add("hidden");
      // Hide all MCP form fields
      document.querySelectorAll<HTMLElement>(".app-tab-left[data-tab='mcp'] > :not(#mcp-tab-upgrade-gate)").forEach(el => {
        if (el.id !== "mcp-tab-upgrade-gate") el.classList.add("hidden");
      });
      document.getElementById("app-mcp-tools-table")?.classList.add("hidden");
      document.getElementById("app-mcp-no-tools")?.classList.add("hidden");
      mcpGate.querySelector<HTMLButtonElement>(".tab-upgrade-btn")!.onclick = () => {
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
      return;
    }
  } catch { /* fall through */ }
  mcpGate.classList.add("hidden");
  // Restore visibility of MCP form fields
  document.querySelectorAll<HTMLElement>(".app-tab-left[data-tab='mcp'] > :not(#mcp-tab-upgrade-gate)").forEach(el => {
    el.classList.remove("hidden");
  });

  const statusBadge = document.getElementById("app-mcp-status")!;
  const connectBtn = document.getElementById("app-mcp-connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("app-mcp-disconnect") as HTMLButtonElement;
  const transportSelect = document.getElementById("app-mcp-transport") as HTMLSelectElement;
  const commandInput = document.getElementById("app-mcp-command") as HTMLInputElement;
  const argsInput = document.getElementById("app-mcp-args") as HTMLInputElement;
  const envInput = document.getElementById("app-mcp-env") as HTMLTextAreaElement;
  const urlInput = document.getElementById("app-mcp-url") as HTMLInputElement;

  if (!app.mcp) {
    statusBadge.className = "mcp-status-badge status-disconnected";
    statusBadge.textContent = "not configured";
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.add("hidden");
    transportSelect.value = "stdio";
    commandInput.value = "";
    argsInput.value = "";
    envInput.value = "";
    urlInput.value = "";
    updateMcpFields();

    const toolsTable = document.getElementById("app-mcp-tools-table")!;
    const noTools = document.getElementById("app-mcp-no-tools")!;
    toolsTable.classList.add("hidden");
    noTools.classList.remove("hidden");
    noTools.textContent = "Configure and save an MCP server to discover tools.";
    return;
  }

  // Get live status from MCP manager
  const servers = await window.yo.mcpGetServers();
  const server = servers.find((s) => s.config.id === currentAppId);
  const status = server?.status || "disconnected";

  statusBadge.className = `mcp-status-badge status-${status}`;
  statusBadge.textContent = status + (server?.error ? `: ${server.error}` : "");
  connectBtn.classList.toggle("hidden", status === "connected" || status === "connecting");
  disconnectBtn.classList.toggle("hidden", status !== "connected");

  // Populate config form
  transportSelect.value = app.mcp.transport;
  commandInput.value = app.mcp.command || "";
  argsInput.value = (app.mcp.args || []).join(" ");
  envInput.value = app.mcp.env ? Object.entries(app.mcp.env).map(([k, v]) => `${k}=${v}`).join("\n") : "";
  urlInput.value = app.mcp.url || "";
  updateMcpFields();

  // Tools table (right panel)
  const toolsBody = document.getElementById("app-mcp-tools-body")!;
  const toolsTable = document.getElementById("app-mcp-tools-table")!;
  const noTools = document.getElementById("app-mcp-no-tools")!;
  const tools = server?.tools || [];

  if (tools.length === 0) {
    toolsTable.classList.add("hidden");
    noTools.classList.remove("hidden");
  } else {
    toolsTable.classList.remove("hidden");
    noTools.classList.add("hidden");
    toolsBody.innerHTML = "";

    for (const tool of tools) {
      const tr = document.createElement("tr");
      tr.className = "tool-row";
      const currentOverride = await window.yo.mcpGetToolOverride(currentAppId, tool.name);
      tr.innerHTML = `
        <td class="tool-td-name">${tool.name}</td>
        <td class="tool-td-desc">${tool.description || ""}</td>
        <td class="tool-td-perm">
          <select class="tool-perm-select" data-tool="${tool.name}">
            <option value="default"${currentOverride === "default" ? " selected" : ""}>Default</option>
            <option value="auto"${currentOverride === "auto" ? " selected" : ""}>Auto</option>
            <option value="ask"${currentOverride === "ask" ? " selected" : ""}>Ask</option>
          </select>
        </td>`;
      toolsBody.appendChild(tr);
    }

    toolsBody.querySelectorAll<HTMLSelectElement>(".tool-perm-select").forEach(sel => {
      sel.addEventListener("change", () => {
        window.yo.mcpSetToolOverride(currentAppId, sel.dataset.tool!, sel.value);
      });
    });
  }
}

function updateMcpFields() {
  const transport = (document.getElementById("app-mcp-transport") as HTMLSelectElement).value;
  document.getElementById("app-mcp-stdio-fields")!.classList.toggle("hidden", transport !== "stdio");
  document.getElementById("app-mcp-sse-fields")!.classList.toggle("hidden", transport !== "sse");
}

async function saveMcpConfig() {
  const transport = (document.getElementById("app-mcp-transport") as HTMLSelectElement).value as "stdio" | "sse";
  const statusEl = document.getElementById("app-mcp-save-status")!;

  const config: Record<string, unknown> = { transport, enabled: false };
  if (transport === "stdio") {
    const command = (document.getElementById("app-mcp-command") as HTMLInputElement).value.trim();
    if (!command) { statusEl.textContent = "Command required"; return; }
    config.command = command;
    const args = (document.getElementById("app-mcp-args") as HTMLInputElement).value.trim();
    if (args) config.args = args.split(/\s+/);
    const envText = (document.getElementById("app-mcp-env") as HTMLTextAreaElement).value.trim();
    if (envText) {
      const env: Record<string, string> = {};
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      config.env = env;
    }
  } else {
    const url = (document.getElementById("app-mcp-url") as HTMLInputElement).value.trim();
    if (!url) { statusEl.textContent = "URL required"; return; }
    config.url = url;
  }

  const app = panelApps.find((a) => a.id === currentAppId);
  await window.yo.appsSetMcp(currentAppId, config as any);
  if (app?.mcp) {
    await window.yo.mcpUpdateServer(currentAppId, config);
  } else {
    await window.yo.mcpAddServer({ id: currentAppId, name: app?.name || currentAppId, ...config });
  }
  if (app) app.mcp = config as any;
  statusEl.textContent = "Saved";
  setTimeout(() => { statusEl.textContent = ""; loadMcpTab(); }, 1000);
}


const policySelect = document.getElementById("app-detail-capture-policy") as HTMLSelectElement;
const policyParam = document.getElementById("app-detail-policy-param") as HTMLInputElement;
const policyDesc = document.getElementById("app-detail-policy-desc")!;

const POLICY_DESCRIPTIONS: Record<string, string> = {
  append: "Every capture is stored as-is. Best for chat streams and logs.",
  versioned: "Keeps the last N versions of the content. Older versions are pruned automatically.",
  deduplicate: "Skips if content is identical to last capture. Replaces if changed.",
  incremental: "Diffs against the last capture and only stores new lines. Ideal for conversations.",
  "sliding-window": "Auto-prunes captures older than N hours. Good for ephemeral feeds.",
  manual: "No automatic capture. Only explicit .sup commands are stored.",
};

const POLICY_PARAM_LABELS: Record<string, string> = {
  versioned: "Versions",
  "sliding-window": "Hours",
  incremental: "Min chars",
};

function updatePolicyUI() {
  const type = policySelect.value;
  policyDesc.textContent = POLICY_DESCRIPTIONS[type] || "";
  const paramLabel = POLICY_PARAM_LABELS[type];
  if (paramLabel) {
    policyParam.style.display = "";
    policyParam.placeholder = paramLabel;
    policyParam.title = paramLabel;
  } else {
    policyParam.style.display = "none";
    policyParam.value = "";
  }
}

async function openPanelAppDetail(app: PanelApp) {
  currentAppId = app.id;
  panelLoaded = false;
  connectorSearchOffset = 0;

  // Populate dashboard fields
  appDetailId.value = app.id;
  appDetailName.value = app.name;
  appDetailUrl.value = app.url || "";
  appForceWeb.checked = !!app.forceWeb;
  appDoNotRecord.checked = !!app.doNotRecord;
  appConnectStatus.textContent = "";
  appMapCommand.classList.add("hidden");
  appDetailHeading.textContent = app.name;

  const policy = await window.yo.appsGetCapturePolicy(app.id);
  policySelect.value = policy.type;
  const paramVal = policy.maxVersions ?? policy.windowHours ?? policy.minDeltaChars;
  policyParam.value = paramVal ? String(paramVal) : "";
  updatePolicyUI();

  // All tabs always visible
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.remove("tab-hidden");
  });

  // Show detail, hide grid
  appsList.classList.add("hidden");
  appsToolbar.classList.add("hidden");
  appAddForm.classList.add("hidden");
  mcpAddForm.classList.add("hidden");
  appDetail.classList.remove("hidden");

  switchAppTab("dashboard");
}

async function refreshCommands() {
  const apps = await window.yo.appsList();
  const app = apps.find((a) => a.id === currentAppId);
  const commands = app?.commands || {};
  const keys = Object.keys(commands);

  if (keys.length === 0) {
    appCommandsList.innerHTML = `<div class="inline-empty">No commands mapped. Click "Pick Element" to add one.</div>`;
    return;
  }

  appCommandsList.innerHTML = keys.map((key) => {
    const cmd = commands[key];
    return `<div class="command-row" data-key="${key}">
      <span class="command-key">${key}</span>
      <span class="command-desc">${cmd.description || cmd.action}</span>
      <span class="command-selector" title="${cmd.selector}">${cmd.selector.length > 40 ? cmd.selector.slice(0, 40) + "…" : cmd.selector}</span>
      <div class="command-actions">
        <button class="action-btn command-edit-btn" title="Edit">Edit</button>
        <button class="action-btn command-test-btn" title="Test">Test</button>
        <button class="action-btn danger command-remove-btn" title="Remove">×</button>
      </div>
    </div>`;
  }).join("");

  appCommandsList.querySelectorAll(".command-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const cmd = commands[key];
      if (!cmd) return;
      openMappingForm(key, cmd.selector, cmd.action, cmd.description || "", (cmd as any).text);
    });
  });

  appCommandsList.querySelectorAll(".command-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      await window.yo.appsRemoveCommand(currentAppId, key);
      refreshCommands();
    });
  });

  appCommandsList.querySelectorAll(".command-test-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const wcId = getPreviewWebContentsId();
      const result = await window.yo.appsTestCommand(currentAppId, key, wcId);
      appConnectStatus.textContent = result ? `Test ${key}: ${result.slice(0, 80)}` : `Test ${key}: executed`;
      setTimeout(() => { appConnectStatus.textContent = ""; }, 3000);
    });
  });
}

function getPreviewWebContentsId(): number | undefined {
  try { return appPreview.getWebContentsId(); } catch { return undefined; }
}

async function pickElement() {
  if (!currentAppId) return;
  const wcId = getPreviewWebContentsId();
  if (!wcId) {
    appConnectStatus.textContent = "Preview not loaded yet.";
    return;
  }

  appConnectStatus.textContent = "Click an element in the preview...";

  const helpCloseBtn = document.getElementById("help-close") as HTMLButtonElement;
  const detailCloseBtn = document.getElementById("app-detail-close") as HTMLButtonElement;
  helpCloseBtn.disabled = true;
  detailCloseBtn.disabled = true;
  helpCloseBtn.style.opacity = "0.3";
  detailCloseBtn.style.opacity = "0.3";

  const picked = await new Promise<{
    selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean;
  } | null>((resolve) => {
    window.yo.onPickerResult((result) => {
      resolve(result);
    });
    window.yo.startPicker(wcId);
  });

  helpCloseBtn.disabled = false;
  detailCloseBtn.disabled = false;
  helpCloseBtn.style.opacity = "";
  detailCloseBtn.style.opacity = "";

  if (!picked) {
    appConnectStatus.textContent = "";
    appMapCommand.classList.add("hidden");
    return;
  }

  appConnectStatus.textContent = "";

  const action = picked.isEditable ? "setValue" : picked.isClickable ? "click" : "extractText";
  const info = `<${picked.tag}>` +
    `${picked.text ? ' "' + picked.text.slice(0, 60) + '"' : ""}` +
    `${picked.isEditable ? " [editable]" : ""}${picked.isClickable ? " [clickable]" : ""}`;

  document.getElementById("map-element-info")!.textContent = info;
  openMappingForm("", picked.selector, action, "", picked.text);
}

let mappingText = "";

function openMappingForm(key: string, selector: string, action: string, description: string, text?: string) {
  document.getElementById("map-selector")!.textContent = selector;
  mappingText = text ?? "";

  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;

  // Check if key matches a preset option
  const presetOption = keySelect.querySelector(`option[value="${key}"]`);
  if (key && presetOption) {
    keySelect.value = key;
    customKeyInput.classList.add("hidden");
  } else if (key) {
    keySelect.value = "__custom__";
    customKeyInput.value = key;
    customKeyInput.classList.remove("hidden");
  } else {
    keySelect.value = "";
    customKeyInput.value = "";
    customKeyInput.classList.add("hidden");
  }

  actionSelect.value = action;
  descInput.value = description;
  appMapCommand.classList.remove("hidden");
}

async function saveMapping() {
  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;
  const selector = document.getElementById("map-selector")!.textContent || "";

  let key = keySelect.value;
  if (key === "__custom__") {
    key = customKeyInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!key) { customKeyInput.focus(); return; }
  }
  if (!key || !selector) return;

  const mapping: Record<string, string> = {
    selector,
    action: actionSelect.value,
    description: descInput.value.trim() || key,
  };
  if (mappingText) mapping.text = mappingText;
  await window.yo.appsSetCommand(currentAppId, key, mapping as any);

  appMapCommand.classList.add("hidden");
  appConnectStatus.textContent = `Mapped: ${key}`;
  setTimeout(() => { appConnectStatus.textContent = ""; }, 2000);
  refreshCommands();
}


function closeAppDetail() {
  appPreview.src = "about:blank";
  panelLoaded = false;
  appMapCommand.classList.add("hidden");
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");
  if (appDashIntakeChart) { appDashIntakeChart.destroy(); appDashIntakeChart = null; }
  loadApps();
}

function reloadPanelApps(apps: Array<PanelApp>) {
  panelApps = apps.map((a) => ({
    id: a.id, name: a.name, url: a.url,
    connectedSlug: a.connectedSlug, forceWeb: a.forceWeb, doNotRecord: a.doNotRecord,
    commands: a.commands, connection: a.connection, mcp: a.mcp,
  }));
}

function initApps() {
  const addNameInput = document.getElementById("app-add-name") as HTMLInputElement;
  const addUrlInput = document.getElementById("app-add-url") as HTMLInputElement;
  const addForceWeb = document.getElementById("app-add-force-web") as HTMLInputElement;
  const addDoNotRecord = document.getElementById("app-add-do-not-record") as HTMLInputElement;

  // + New dropdown
  document.getElementById("apps-add-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("apps-add-menu")!.classList.toggle("hidden");
  });
  document.addEventListener("click", () => {
    document.getElementById("apps-add-menu")?.classList.add("hidden");
  });

  // Add App
  document.getElementById("apps-add-app")!.addEventListener("click", () => {
    document.getElementById("apps-add-menu")!.classList.add("hidden");
    addNameInput.value = "";
    addUrlInput.value = "";
    addForceWeb.checked = false;
    addDoNotRecord.checked = false;
    appFormError.classList.add("hidden");
    appsList.classList.add("hidden");
    appsToolbar.classList.add("hidden");
    appAddForm.classList.remove("hidden");
    addNameInput.focus();
  });

  // Add MCP Server
  document.getElementById("apps-add-mcp")!.addEventListener("click", () => {
    document.getElementById("apps-add-menu")!.classList.add("hidden");
    (document.getElementById("mcp-add-name") as HTMLInputElement).value = "";
    (document.getElementById("mcp-add-transport") as HTMLSelectElement).value = "stdio";
    (document.getElementById("mcp-add-command") as HTMLInputElement).value = "";
    (document.getElementById("mcp-add-args") as HTMLInputElement).value = "";
    (document.getElementById("mcp-add-env") as HTMLTextAreaElement).value = "";
    (document.getElementById("mcp-add-url") as HTMLInputElement).value = "";
    document.getElementById("mcp-form-error")!.classList.add("hidden");
    document.getElementById("mcp-add-stdio-fields")!.classList.remove("hidden");
    document.getElementById("mcp-add-sse-fields")!.classList.add("hidden");
    appsList.classList.add("hidden");
    appsToolbar.classList.add("hidden");
    mcpAddForm.classList.remove("hidden");
    (document.getElementById("mcp-add-name") as HTMLInputElement).focus();
  });

  // MCP add form transport toggle
  document.getElementById("mcp-add-transport")!.addEventListener("change", () => {
    const transport = (document.getElementById("mcp-add-transport") as HTMLSelectElement).value;
    document.getElementById("mcp-add-stdio-fields")!.classList.toggle("hidden", transport !== "stdio");
    document.getElementById("mcp-add-sse-fields")!.classList.toggle("hidden", transport !== "sse");
  });

  // MCP add form save
  document.getElementById("mcp-add-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("mcp-add-name") as HTMLInputElement).value.trim();
    const transport = (document.getElementById("mcp-add-transport") as HTMLSelectElement).value as "stdio" | "sse";
    const errEl = document.getElementById("mcp-form-error")!;

    if (!name) { errEl.textContent = "Name required"; errEl.classList.remove("hidden"); return; }

    const mcpConfig: Record<string, unknown> = { transport, enabled: false };
    if (transport === "stdio") {
      const command = (document.getElementById("mcp-add-command") as HTMLInputElement).value.trim();
      if (!command) { errEl.textContent = "Command required"; errEl.classList.remove("hidden"); return; }
      mcpConfig.command = command;
      const args = (document.getElementById("mcp-add-args") as HTMLInputElement).value.trim();
      if (args) mcpConfig.args = args.split(/\s+/);
      const envText = (document.getElementById("mcp-add-env") as HTMLTextAreaElement).value.trim();
      if (envText) {
        const env: Record<string, string> = {};
        for (const line of envText.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        mcpConfig.env = env;
      }
    } else {
      const url = (document.getElementById("mcp-add-url") as HTMLInputElement).value.trim();
      if (!url) { errEl.textContent = "URL required"; errEl.classList.remove("hidden"); return; }
      mcpConfig.url = url;
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    await window.yo.appsAdd(id, name);
    await window.yo.appsSetMcp(id, mcpConfig as any);
    await window.yo.mcpAddServer({ id, name, ...mcpConfig } as any);

    mcpAddForm.classList.add("hidden");
    const apps = await window.yo.appsList();
    reloadPanelApps(apps);
    const created = panelApps.find((a) => a.id === id);
    if (created) openPanelAppDetail(created);
    else loadApps();
  });

  // MCP add form cancel
  document.getElementById("mcp-add-cancel")!.addEventListener("click", () => loadApps());
  document.getElementById("mcp-add-cancel-btn")!.addEventListener("click", () => loadApps());

  // App add form save
  document.getElementById("app-add-save")!.addEventListener("click", async () => {
    let valid = true;
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    if (!name) { addNameInput.classList.add("invalid"); clearInvalid(addNameInput); valid = false; }
    if (!url) { addUrlInput.classList.add("invalid"); clearInvalid(addUrlInput); valid = false; }
    if (!valid) {
      appFormError.textContent = "Name and URL are required.";
      appFormError.classList.remove("hidden");
      return;
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    await window.yo.appsAdd(id, name, url);
    if (addForceWeb.checked) await window.yo.appsUpdateForceWeb(id, true);
    if (addDoNotRecord.checked) await window.yo.appsUpdateDoNotRecord(id, true);
    appAddForm.classList.add("hidden");
    const apps = await window.yo.appsList();
    reloadPanelApps(apps);
    const created = panelApps.find((a) => a.id === id);
    if (created) openPanelAppDetail(created);
    else loadApps();
  });

  // App add form cancel
  document.getElementById("app-add-cancel")!.addEventListener("click", () => loadApps());
  document.getElementById("app-add-cancel-btn")!.addEventListener("click", () => loadApps());

  policySelect.addEventListener("change", updatePolicyUI);

  // Tab buttons
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.addEventListener("click", () => switchAppTab(btn.dataset.tab!));
  });

  // Dashboard save
  document.getElementById("app-dash-save")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const newId = appDetailId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (newId && newId !== currentAppId) {
      const ok = await window.yo.appsUpdateId(currentAppId, newId);
      if (ok) currentAppId = newId;
    }
    const name = appDetailName.value.trim();
    const url = appDetailUrl.value.trim();
    if (name) await window.yo.appsUpdateName(currentAppId, name);
    if (url) await window.yo.appsUpdateUrl(currentAppId, url);
    await window.yo.appsUpdateForceWeb(currentAppId, appForceWeb.checked);
    await window.yo.appsUpdateDoNotRecord(currentAppId, appDoNotRecord.checked);

    const pType = policySelect.value;
    const pVal = parseInt(policyParam.value, 10) || undefined;
    const policy: Record<string, unknown> = { type: pType };
    if (pType === "versioned" && pVal) policy.maxVersions = pVal;
    if (pType === "sliding-window" && pVal) policy.windowHours = pVal;
    if (pType === "incremental" && pVal) policy.minDeltaChars = pVal;
    await window.yo.appsUpdateCapturePolicy(currentAppId, policy as any);

    closeAppDetail();
  });

  // Dashboard cancel
  document.getElementById("app-dash-cancel")!.addEventListener("click", () => closeAppDetail());

  // App dashboard range toggle
  document.getElementById("app-dash-range-7")?.addEventListener("click", () => {
    appDashRangeMode = "7";
    document.getElementById("app-dash-range-7")!.classList.add("active");
    document.getElementById("app-dash-range-30")!.classList.remove("active");
    renderAppDashIntakeChart();
  });
  document.getElementById("app-dash-range-30")?.addEventListener("click", () => {
    appDashRangeMode = "30";
    document.getElementById("app-dash-range-30")!.classList.add("active");
    document.getElementById("app-dash-range-7")!.classList.remove("active");
    renderAppDashIntakeChart();
  });

  // App dashboard data detail
  document.getElementById("app-dash-data-back")?.addEventListener("click", closeAppDashDataDetail);
  document.getElementById("app-dash-data-delete")?.addEventListener("click", deleteAppDashDataEntry);

  // Delete
  document.getElementById("app-detail-delete")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const confirmed = await confirmAction(`Delete app "${appDetailName.value}"?`);
    if (!confirmed) return;
    await window.yo.appsRemove(currentAppId);
    closeAppDetail();
  });

  // MCP tab: transport toggle, save, connect, disconnect
  document.getElementById("app-mcp-transport")!.addEventListener("change", updateMcpFields);
  document.getElementById("app-mcp-save")!.addEventListener("click", saveMcpConfig);

  document.getElementById("app-mcp-connect")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const btn = document.getElementById("app-mcp-connect") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Connecting...";
    const result = await window.yo.mcpConnectServer(currentAppId);
    btn.disabled = false;
    btn.textContent = "Connect";
    if (result.ok) loadMcpTab();
    else {
      const badge = document.getElementById("app-mcp-status")!;
      badge.className = "mcp-status-badge status-error";
      badge.textContent = `error: ${result.error}`;
    }
  });

  document.getElementById("app-mcp-disconnect")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    await window.yo.mcpDisconnectServer(currentAppId);
    loadMcpTab();
  });

  document.getElementById("app-mcp-server-override")!.addEventListener("change", (e) => {
    if (!currentAppId) return;
    window.yo.mcpSetServerOverride(currentAppId, (e.target as HTMLSelectElement).value);
    loadMcpTab();
  });

  // Connection tab: connector search
  document.getElementById("app-connector-search")!.addEventListener("input", (e) => {
    connectorSearchOffset = 0;
    loadConnectorGrid((e.target as HTMLInputElement).value.trim() || undefined);
  });

  document.getElementById("app-connector-load-more")!.addEventListener("click", () => {
    connectorSearchOffset += 20;
    const search = (document.getElementById("app-connector-search") as HTMLInputElement).value.trim() || undefined;
    loadConnectorGrid(search);
  });

  appSearchInput.addEventListener("input", () => { appsPage = 0; renderAppsList(); });

  // MCP changed event — refresh MCP tab if viewing
  window.yo.onMcpChanged(() => {
    if (!appDetail.classList.contains("hidden") && activeAppTab === "mcp" && currentAppId) {
      loadMcpTab();
    }
  });

  // Connectors changed event — refresh connection tab if viewing
  window.yo.onConnectorsChanged(async () => {
    if (!appDetail.classList.contains("hidden") && activeAppTab === "connection" && currentAppId) {
      const apps = await window.yo.appsList();
      reloadPanelApps(apps);
      loadConnectionTab();
    }
  });

  // Draggable split divider
  const divider = document.getElementById("app-builder-divider")!;
  const controls = document.querySelector(".app-builder-controls") as HTMLElement;
  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = controls.offsetWidth;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(800, startW + (e.clientX - startX)));
    controls.style.width = w + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ── Settings ─────────────────────────────────────────────

const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModelSelect = document.getElementById("settings-model-select") as HTMLSelectElement;
const settingsModelCustom = document.getElementById("settings-model-custom") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-api-key") as HTMLInputElement;
const settingsBaseUrl = document.getElementById("settings-base-url") as HTMLInputElement;
const settingsBaseUrlLabel = document.getElementById("settings-base-url-label")!;
const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")!;

const toggleVoiceInput = document.getElementById("toggle-voice-input") as HTMLInputElement;
const voiceKeyWrap = document.getElementById("voice-key-wrap")!;
const settingsVoiceKey = document.getElementById("settings-voice-key") as HTMLInputElement;
const toggleRemote = document.getElementById("toggle-remote") as HTMLInputElement;
const toggleVscodeServer = document.getElementById("toggle-vscode-server") as HTMLInputElement;
const toggleShowTabs = document.getElementById("toggle-show-tabs") as HTMLInputElement;
const toggleShowUrlBar = document.getElementById("toggle-show-url-bar") as HTMLInputElement;
const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const toggleMcpExpose = document.getElementById("toggle-mcp-expose") as HTMLInputElement;
const mcpExposeSettings = document.getElementById("mcp-expose-settings")!;
const mcpExposeStatus = document.getElementById("mcp-expose-status")!;
const mcpExposePort = document.getElementById("mcp-expose-port") as HTMLInputElement;
const mcpExposeTokensEl = document.getElementById("mcp-expose-tokens")!;
const settingsContextWindow = document.getElementById("settings-context-window") as HTMLInputElement;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;
const settingsAgentMode = document.getElementById("settings-agent-mode") as HTMLSelectElement;
const settingsSubagentModel = document.getElementById("settings-subagent-model") as HTMLSelectElement;
const toolOverridesBody = document.getElementById("tool-overrides-body")!;

let settingsPresets: Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }> = {};

async function refreshMcpExposeStatus() {
  const status = await window.yo.mcpExposeStatus();
  const port = status.port || parseInt(mcpExposePort.value, 10) || 7860;
  if (status.running) {
    mcpExposeStatus.textContent = `Running on http://127.0.0.1:${port}`;
    mcpExposeStatus.style.color = "var(--accent)";
  } else {
    mcpExposeStatus.textContent = "Stopped";
    mcpExposeStatus.style.color = "var(--text-2)";
  }
  // Update example config
  const configEl = document.getElementById("mcp-expose-config-example");
  if (configEl) {
    configEl.textContent = `{
  "mcpServers": {
    "yo": {
      "url": "http://127.0.0.1:${port}/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}`;
  }
}

async function renderMcpTokens() {
  const tokens = await window.yo.mcpExposeGetTokens();
  mcpExposeTokensEl.innerHTML = "";
  if (tokens.length === 0) {
    mcpExposeTokensEl.innerHTML = '<span style="font-size:11px;color:var(--text-2);">No tokens yet. Generate one to connect an external tool.</span>';
    return;
  }
  for (const t of tokens) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 10px;background:var(--surface-2);border-radius:6px;";

    const label = document.createElement("span");
    label.style.cssText = "flex:1;font-size:12px;color:var(--text);";
    label.textContent = t.label || "Untitled";

    const created = document.createElement("span");
    created.style.cssText = "font-size:11px;color:var(--text-2);font-family:'SF Mono','Fira Code',monospace;";
    created.textContent = new Date(t.createdAt).toLocaleDateString();

    const daysLeft = Math.ceil((new Date(t.expiresAt).getTime() - Date.now()) / 86400000);
    const expires = document.createElement("span");
    expires.style.cssText = `font-size:11px;font-family:'SF Mono','Fira Code',monospace;color:${daysLeft <= 7 ? "var(--danger)" : "var(--text-2)"};`;
    expires.textContent = `Expires ${new Date(t.expiresAt).toLocaleDateString()}`;

    const revoke = document.createElement("button");
    revoke.className = "action-btn danger";
    revoke.style.cssText = "font-size:10px;padding:2px 8px;";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      await window.yo.mcpExposeRevokeToken(t.token);
      await renderMcpTokens();
    });

    row.appendChild(label);
    row.appendChild(created);
    row.appendChild(expires);
    row.appendChild(revoke);
    mcpExposeTokensEl.appendChild(row);
  }
}

function initSettings() {
  settingsProvider.addEventListener("change", () => updateSettingsUI());
  settingsSaveBtn.addEventListener("click", saveSettings);

  // Theme picker
  const themePicker = document.getElementById("theme-picker");
  if (themePicker) {
    window.yo.getTheme().then((theme) => {
      themePicker.querySelectorAll(".theme-option").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-theme") === theme);
      });
    });
    themePicker.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".theme-option") as HTMLElement | null;
      if (!btn) return;
      const theme = btn.getAttribute("data-theme")!;
      const resolved = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : theme;
      document.documentElement.setAttribute("data-theme", resolved);
      window.yo.setTheme(theme);
      themePicker.querySelectorAll(".theme-option").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  }

  // Service toggles — show relaunch bar when changed
  const showRelaunch = () => {
    const bar = document.getElementById("settings-relaunch")!;
    if (bar) bar.classList.remove("hidden");
  };
  // Voice input toggle + key
  toggleVoiceInput.addEventListener("change", () => {
    window.yo.setPreference("voiceEnabled", toggleVoiceInput.checked);
    voiceKeyWrap.classList.toggle("hidden", !toggleVoiceInput.checked);
    // Show/hide mic button immediately
    const micBtn = document.getElementById("yo-panel-mic");
    if (micBtn) micBtn.style.display = toggleVoiceInput.checked ? "" : "none";
  });
  const voiceKeySaveBtn = document.getElementById("voice-key-save")!;
  const voiceKeyStatus = document.getElementById("voice-key-status")!;
  voiceKeySaveBtn.addEventListener("click", () => {
    window.yo.setPreference("voiceApiKey", settingsVoiceKey.value.trim());
    voiceKeyStatus.textContent = "Saved";
    voiceKeyStatus.className = "settings-success";
    setTimeout(() => { voiceKeyStatus.textContent = ""; }, 2000);
  });

  toggleRemote.addEventListener("change", () => {
    window.yo.setPreference("remoteEnabled", toggleRemote.checked);
  });

  toggleVscodeServer.addEventListener("change", () => {
    window.yo.setPreference("enableVscodeServer", toggleVscodeServer.checked);
    showRelaunch();
  });
  toggleAutoUpdate.addEventListener("change", () => {
    window.yo.setPreference("autoUpdate", toggleAutoUpdate.checked);
    showRelaunch();
  });

  // MCP Expose toggle
  toggleMcpExpose.addEventListener("change", async () => {
    const enabled = toggleMcpExpose.checked;
    window.yo.setPreference("mcpExposeEnabled", enabled);
    mcpExposeSettings.classList.toggle("hidden", !enabled);
    if (enabled) {
      const result = await window.yo.mcpExposeStart();
      if (!result.ok) {
        mcpExposeStatus.textContent = `Error: ${result.error}`;
        mcpExposeStatus.style.color = "var(--danger)";
      } else {
        await refreshMcpExposeStatus();
      }
    } else {
      await window.yo.mcpExposeStop();
      mcpExposeStatus.textContent = "Stopped";
      mcpExposeStatus.style.color = "var(--text-2)";
    }
  });
  document.getElementById("mcp-expose-port-save")!.addEventListener("click", async () => {
    const port = parseInt(mcpExposePort.value, 10);
    if (port >= 1024 && port <= 65535) {
      window.yo.setPreference("mcpExposePort", port);
      if (toggleMcpExpose.checked) {
        await window.yo.mcpExposeStop();
        const result = await window.yo.mcpExposeStart();
        if (!result.ok) {
          mcpExposeStatus.textContent = `Error: ${result.error}`;
          mcpExposeStatus.style.color = "var(--danger)";
        } else {
          await refreshMcpExposeStatus();
        }
      }
    }
  });
  document.getElementById("mcp-expose-gen-token")!.addEventListener("click", async () => {
    const labelInput = document.getElementById("mcp-expose-token-label") as HTMLInputElement;
    const label = labelInput.value.trim() || "default";
    const result = await window.yo.mcpExposeGenToken(label);
    labelInput.value = "";
    // Show the new token in the highlighted box
    const newTokenBox = document.getElementById("mcp-expose-new-token")!;
    const newTokenValue = document.getElementById("mcp-expose-new-token-value")!;
    newTokenValue.textContent = result.token;
    newTokenBox.classList.remove("hidden");
    await renderMcpTokens();
  });

  // Copy new token
  document.getElementById("mcp-expose-copy-token")!.addEventListener("click", () => {
    const val = document.getElementById("mcp-expose-new-token-value")!.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("mcp-expose-copy-token") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  // Copy config example
  document.getElementById("mcp-expose-copy-config")!.addEventListener("click", () => {
    const val = document.getElementById("mcp-expose-config-example")!.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("mcp-expose-copy-config") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  settingsContextWindow.addEventListener("change", () => {
    const val = parseInt(settingsContextWindow.value, 10);
    if (val >= 10 && val <= 200) {
      window.yo.setPreference("yoContextWindow", val);
    }
  });

  // Agent mode
  settingsAgentMode.addEventListener("change", () => {
    window.yo.setAgentMode(settingsAgentMode.value);
    // Sync the yo panel dropdown too
    const yoModeEl = document.getElementById("yo-mode-select") as HTMLSelectElement;
    if (yoModeEl) yoModeEl.value = settingsAgentMode.value;
  });

  // Sub-agent model
  settingsSubagentModel.addEventListener("change", () => {
    window.yo.setPreference("subAgentModel", settingsSubagentModel.value);
  });

  toggleShowTabs.addEventListener("change", () => {
    window.yo.setPreference("showTabs", toggleShowTabs.checked);
    // Immediately refresh tab visibility
    window.yo.tabList().then((state) => {
      const tabBar = document.getElementById("tab-bar");
      const tabNewBtn = document.getElementById("tab-new-btn");
      if (tabBar) tabBar.style.display = toggleShowTabs.checked ? "flex" : "none";
      if (tabNewBtn) tabNewBtn.style.display = toggleShowTabs.checked ? "" : "none";
    });
  });

  toggleShowUrlBar.addEventListener("change", () => {
    const show = toggleShowUrlBar.checked;
    window.yo.urlBarToggle(show);
    const urlBar = document.getElementById("url-bar");
    if (urlBar) urlBar.classList.toggle("hidden", !show);
    document.body.style.setProperty("--content-top", show ? "72px" : "38px");
  });

  // Browser homepage
  settingsBrowserHome.addEventListener("change", () => {
    const val = settingsBrowserHome.value;
    browserHomeCustomRow.classList.toggle("hidden", val !== "custom");
    if (val !== "custom") {
      window.yo.setPreference("browserHomepage", val);
    }
  });
  settingsBrowserHomeUrl.addEventListener("change", () => {
    const url = settingsBrowserHomeUrl.value.trim();
    if (url) {
      window.yo.setPreference("browserHomepage", "custom");
      window.yo.setPreference("browserHomepageUrl", url);
    }
  });

  // Relaunch button
  document.getElementById("settings-relaunch-btn")?.addEventListener("click", () => {
    window.yo.relaunch();
  });

  // Account dashboard — opens platform in a browser tab
  document.getElementById("account-dashboard-btn")?.addEventListener("click", () => {
    closeHelp();
    window.yo.openExternal(window.yo.platformUrl);
  });

  // Sign out
  document.getElementById("account-logout-btn")?.addEventListener("click", async () => {
    await window.yo.logout();
    // Hide help overlay without restoring panels (they should stay hidden for onboarding)
    overlay.classList.add("hidden");
    window.yo.panelsHide();
    showOnboarding(true);
  });
}

function updateSettingsUI(currentModel?: string) {
  const provider = settingsProvider.value;
  const preset = settingsPresets[provider];

  // API key placeholder
  if (preset) {
    settingsApiKey.placeholder = `${preset.keyPlaceholder}`;
  }

  // Model dropdown vs custom input
  if (preset && preset.models.length > 0) {
    settingsModelSelect.innerHTML = preset.models.map((m) =>
      `<option value="${m}" ${m === currentModel ? "selected" : ""}>${m}</option>`
    ).join("");
    settingsModelSelect.classList.remove("hidden");
    settingsModelCustom.classList.add("hidden");
  } else {
    settingsModelSelect.classList.add("hidden");
    settingsModelCustom.classList.remove("hidden");
    if (currentModel) settingsModelCustom.value = currentModel;
  }

  // Base URL — show for custom and providers with base URLs
  const showBaseUrl = provider === "custom" || provider === "openai" || provider === "google";
  settingsBaseUrl.classList.toggle("hidden", !showBaseUrl);
  settingsBaseUrlLabel.classList.toggle("hidden", !showBaseUrl);
  if (preset?.baseUrl && !settingsBaseUrl.value) {
    settingsBaseUrl.placeholder = preset.baseUrl;
  }
}

async function loadSettings() {
  settingsStatus.textContent = "";
  const [config, presets, accountInfo, authStatus] = await Promise.all([
    window.yo.getLLMConfig(),
    window.yo.getLLMPresets(),
    window.yo.getAccountInfo(),
    window.yo.getAuthStatus(),
  ]);
  settingsPresets = presets;

  settingsProvider.value = config.provider;
  settingsApiKey.value = config.apiKey;
  settingsBaseUrl.value = config.baseUrl || "";

  updateSettingsUI(config.model);

  // Account info
  const emailEl = document.getElementById("account-email")!;
  const nameEl = document.getElementById("account-name")!;
  const orgEl = document.getElementById("account-org")!;
  const tierEl = document.getElementById("account-tier")!;
  const statusEl = document.getElementById("account-status")!;

  if (accountInfo) {
    emailEl.textContent = accountInfo.email;
    nameEl.textContent = `${accountInfo.firstName} ${accountInfo.lastName}`;
    orgEl.textContent = accountInfo.orgName;
    tierEl.textContent = accountInfo.tier || "free";
    tierEl.className = `license-value ${accountInfo.tier !== "free" ? "active" : ""}`;

    const billingStatus = accountInfo.billingStatus || authStatus.status;
    if (billingStatus === "active") {
      statusEl.textContent = "Active";
      statusEl.className = "license-value active";
    } else if (billingStatus === "expired" || authStatus.status === "expired") {
      statusEl.textContent = "Expired";
      statusEl.className = "license-value expired";
    } else {
      statusEl.textContent = billingStatus === "none" ? "Free" : billingStatus;
      statusEl.className = "license-value";
    }
  } else {
    emailEl.textContent = "Not signed in";
    nameEl.textContent = "—";
    orgEl.textContent = "—";
    tierEl.textContent = "—";
    statusEl.textContent = "—";
  }

  // Load toggle states
  toggleShowTabs.checked = await window.yo.getPreference("showTabs", true) as boolean;
  toggleShowUrlBar.checked = await window.yo.getPreference("showUrlBar", true) as boolean;
  toggleVoiceInput.checked = await window.yo.getPreference("voiceEnabled", false) as boolean;
  voiceKeyWrap.classList.toggle("hidden", !toggleVoiceInput.checked);
  settingsVoiceKey.value = await window.yo.getPreference("voiceApiKey", "") as string;
  toggleRemote.checked = await window.yo.getPreference("remoteEnabled", false) as boolean;
  toggleVscodeServer.checked = await window.yo.getPreference("enableVscodeServer", false) as boolean;
  toggleAutoUpdate.checked = await window.yo.getPreference("autoUpdate", true) as boolean;
  settingsContextWindow.value = String(await window.yo.getPreference("yoContextWindow", 40));

  // MCP Expose — gate behind Advanced tier
  const mcpSectionWrap = document.getElementById("mcp-section-wrap")!;
  const mcpProGate = document.getElementById("mcp-pro-gate")!;
  if (authStatus.tier !== "advanced") {
    mcpSectionWrap.classList.add("hidden");
    mcpExposeSettings.classList.add("hidden");
    mcpProGate.classList.remove("hidden");
    const mcpUpgradeBtn = document.getElementById("mcp-upgrade-btn");
    if (mcpUpgradeBtn) {
      mcpUpgradeBtn.onclick = () => {
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
    }
  } else {
    mcpSectionWrap.classList.remove("hidden");
    mcpProGate.classList.add("hidden");
    document.getElementById("mcp-expose-new-token")?.classList.add("hidden");
    const mcpEnabled = await window.yo.getPreference("mcpExposeEnabled", false) as boolean;
    toggleMcpExpose.checked = mcpEnabled;
    mcpExposeSettings.classList.toggle("hidden", !mcpEnabled);
    mcpExposePort.value = String(await window.yo.getPreference("mcpExposePort", 7860));
    if (mcpEnabled) {
      await refreshMcpExposeStatus();
      await renderMcpTokens();
    }
  }

  // Agent mode
  const currentMode = await window.yo.getAgentMode();
  settingsAgentMode.value = currentMode;

  // Sub-agent model — populate from current provider's preset
  const currentProvider = config.provider;
  const currentPreset = presets[currentProvider];
  settingsSubagentModel.innerHTML = '<option value="auto">Auto (cheapest)</option>';
  if (currentPreset) {
    for (const m of currentPreset.models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m.replace(/^claude-|^gpt-|^gemini-/i, "").replace(/-\d{8}$/, "");
      settingsSubagentModel.appendChild(opt);
    }
  }
  // Also allow "same as orchestrator"
  const sameOpt = document.createElement("option");
  sameOpt.value = "orchestrator";
  sameOpt.textContent = "Same as orchestrator";
  settingsSubagentModel.appendChild(sameOpt);

  const savedSubModel = await window.yo.getPreference("subAgentModel", "auto") as string;
  settingsSubagentModel.value = savedSubModel;

  // Tool overrides table
  const tools = await window.yo.getToolRegistry();
  toolOverridesBody.innerHTML = "";
  for (const tool of tools) {
    const tr = document.createElement("tr");
    tr.className = "tool-row";

    const tdName = document.createElement("td");
    tdName.className = "tool-td-name";
    tdName.textContent = tool.label;

    const tdDesc = document.createElement("td");
    tdDesc.className = "tool-td-desc";
    tdDesc.textContent = tool.description;

    const tdTier = document.createElement("td");
    tdTier.className = "tool-td-tier";
    const tierBadge = document.createElement("span");
    tierBadge.className = `tool-tier-badge tier-${tool.tier}`;
    tierBadge.textContent = tool.tier;
    tdTier.appendChild(tierBadge);

    const tdPerm = document.createElement("td");
    tdPerm.className = "tool-td-perm";
    const select = document.createElement("select");
    select.className = "tool-perm-select";
    select.innerHTML =
      `<option value="default"${tool.override === "default" ? " selected" : ""}>Default</option>` +
      `<option value="auto"${tool.override === "auto" ? " selected" : ""}>Auto</option>` +
      `<option value="ask"${tool.override === "ask" ? " selected" : ""}>Ask</option>` +
      `<option value="off"${tool.override === "off" ? " selected" : ""}>Off</option>`;
    select.addEventListener("change", () => {
      window.yo.setToolOverride(tool.name, select.value);
    });
    tdPerm.appendChild(select);

    tr.appendChild(tdName);
    tr.appendChild(tdDesc);
    tr.appendChild(tdTier);
    tr.appendChild(tdPerm);
    toolOverridesBody.appendChild(tr);
  }

  // Browser homepage
  const homePref = await window.yo.getPreference("browserHomepage", "claude") as string;
  settingsBrowserHome.value = homePref === "custom" ? "custom" : homePref;
  browserHomeCustomRow.classList.toggle("hidden", homePref !== "custom");
  if (homePref === "custom") {
    settingsBrowserHomeUrl.value = await window.yo.getPreference("browserHomepageUrl", "") as string;
  }
}

async function saveSettings() {
  const provider = settingsProvider.value;
  const preset = settingsPresets[provider];
  const model = (preset && preset.models.length > 0)
    ? settingsModelSelect.value
    : settingsModelCustom.value.trim();
  // Use existing key if the field wasn't changed
  const currentConfig = await window.yo.getLLMConfig();
  const apiKey = settingsApiKey.value.trim() || currentConfig.apiKey;

  if (!apiKey) {
    settingsStatus.textContent = "API key is required";
    settingsStatus.className = "settings-error";
    return;
  }

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving...";
  settingsStatus.textContent = "";

  const config: { provider: string; model: string; apiKey: string; baseUrl?: string } = {
    provider,
    model,
    apiKey,
  };
  const baseUrl = settingsBaseUrl.value.trim();
  if (baseUrl) config.baseUrl = baseUrl;

  const result = await window.yo.saveLLMConfig(config);
  settingsSaveBtn.disabled = false;
  settingsSaveBtn.textContent = "Save";

  if (result.ok) {
    settingsStatus.textContent = "Saved!";
    settingsStatus.className = "settings-success";
  } else {
    settingsStatus.textContent = result.error || "Validation failed";
    settingsStatus.className = "settings-error";
  }
}

// ── App Mapping ─────────────────────────────────────────


// ── Skills ────────────────────────────────────────────────
// Folder-based skills: SKILL.md (frontmatter + prompt) + SKILL.js (optional runner) + arbitrary files.

let skillsPage = 0;
let allSkillsDetailed: Array<{ name: string; description?: string; hasRunner: boolean; scheduled: boolean; scheduleExpr?: string }> = [];
const skillsListEl = document.getElementById("skills-list")!;
const skillsToolbar = document.getElementById("skills-toolbar")!;
const skillEditor = document.getElementById("skill-editor")!;
const skillNameInput = document.getElementById("skill-name") as HTMLInputElement;
const skillDescInput = document.getElementById("skill-desc") as HTMLTextAreaElement;
const skillDeleteBtn = document.getElementById("skill-delete") as HTMLButtonElement;
const skillSearchInput = document.getElementById("skill-search") as HTMLInputElement;
const skillFormError = document.getElementById("skill-form-error")!;
let editingSkillName: string | null = null;
let editingSkillFiles: string[] = [];
let editingSelectedFile: string = "SKILL.md";
let editingFileContents: Map<string, string> = new Map();
let monacoEditor: any = null;
let monacoReady: Promise<void> | null = null;
let cachedToolGroups: Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }> = [];
let collapsedFolders = new Set<string>();

function ensureMonaco(): Promise<void> {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise<void>((resolve) => {
    const w = window as any;
    if (w.monaco) { resolve(); return; }
    w.require.config({ paths: { vs: "monaco" } });
    w.require(["vs/editor/editor.main"], () => resolve());
  });
  return monacoReady;
}

function initSkillTreeResize() {
  const handle = document.getElementById("skill-tree-resize");
  const tree = document.getElementById("skill-code-tree");
  if (!handle || !tree) return;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  // Restore saved width
  window.yo.getPreference?.("skillTreeWidth", 200).then((w) => {
    const num = typeof w === "number" ? w : 200;
    tree.style.width = `${Math.max(120, Math.min(500, num))}px`;
  }).catch(() => {});

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = tree.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const next = Math.max(120, Math.min(500, startWidth + (e.clientX - startX)));
    tree.style.width = `${next}px`;
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = tree.getBoundingClientRect().width;
    window.yo.setPreference?.("skillTreeWidth", w);
  });
}

function languageForFile(relPath: string): string {
  const lower = relPath.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  // Special filenames
  if (lower.endsWith("dockerfile") || lower === "dockerfile") return "dockerfile";
  if (lower.endsWith("makefile") || lower === "makefile") return "makefile";
  if (lower.endsWith(".gitignore") || lower.endsWith(".env") || lower.endsWith(".keep")) return "plaintext";
  // Map extensions to Monaco language IDs
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", json5: "json",
    md: "markdown", markdown: "markdown", mdx: "markdown",
    yaml: "yaml", yml: "yaml",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cxx: "cpp",
    cs: "csharp", php: "php",
    sql: "sql", graphql: "graphql", gql: "graphql",
    xml: "xml", svg: "xml",
    toml: "ini", ini: "ini",
    txt: "plaintext", log: "plaintext",
  };
  return map[ext] || "plaintext";
}

// ── Tool row list (allowed-tools) ────────────────────────

async function ensureToolGroups() {
  if (cachedToolGroups.length) return;
  try { cachedToolGroups = await window.yo.skillsAvailableTools(); } catch { /* empty */ }
}

function addToolRow(ns?: string, tool?: string) {
  const list = document.getElementById("skill-tools-list")!;
  const row = document.createElement("div");
  row.className = "skill-row";

  const appSel = document.createElement("select");
  appSel.innerHTML = `<option value="">App...</option>` +
    cachedToolGroups.map(g => `<option value="${g.namespace}"${g.namespace === ns ? " selected" : ""}>${g.label}</option>`).join("");

  const toolSel = document.createElement("select");
  const populateTools = (selectedNs: string) => {
    const group = cachedToolGroups.find(g => g.namespace === selectedNs);
    toolSel.innerHTML = `<option value="">Tool...</option>` +
      (group ? group.tools.map(t => `<option value="${t.name}"${t.name === tool ? " selected" : ""}>${t.name}</option>`) : []).join("");
  };
  if (ns) populateTools(ns);
  else toolSel.innerHTML = `<option value="">Tool...</option>`;

  appSel.addEventListener("change", () => { tool = undefined; populateTools(appSel.value); });

  const removeBtn = document.createElement("button");
  removeBtn.className = "skill-row-remove";
  removeBtn.type = "button";
  removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(appSel);
  row.appendChild(toolSel);
  row.appendChild(removeBtn);
  list.appendChild(row);
}

function getToolEntries(): string[] {
  const rows = document.querySelectorAll("#skill-tools-list .skill-row");
  const entries: string[] = [];
  rows.forEach(row => {
    const selects = row.querySelectorAll("select");
    const ns = (selects[0] as HTMLSelectElement)?.value;
    const tool = (selects[1] as HTMLSelectElement)?.value;
    if (ns && tool) entries.push(`${ns}.${tool}`);
  });
  return entries;
}

function clearToolRows() {
  document.getElementById("skill-tools-list")!.innerHTML = "";
}

// ── Requires row list (dependent skills) ─────────────────

function addRequiresRow(skillName?: string) {
  const list = document.getElementById("skill-requires-list")!;
  const row = document.createElement("div");
  row.className = "skill-row";

  const sel = document.createElement("select");
  sel.innerHTML = `<option value="">Select skill...</option>` +
    allSkillsDetailed
      .filter(s => s.name !== editingSkillName)
      .map(s => `<option value="${s.name}"${s.name === skillName ? " selected" : ""}>${s.name}${s.description ? " — " + s.description : ""}</option>`)
      .join("");

  const removeBtn = document.createElement("button");
  removeBtn.className = "skill-row-remove";
  removeBtn.type = "button";
  removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(sel);
  row.appendChild(removeBtn);
  list.appendChild(row);
}

function getRequiresEntries(): string[] {
  const rows = document.querySelectorAll("#skill-requires-list .skill-row");
  const entries: string[] = [];
  rows.forEach(row => {
    const val = (row.querySelector("select") as HTMLSelectElement)?.value;
    if (val) entries.push(val);
  });
  return entries;
}

function clearRequiresRows() {
  document.getElementById("skill-requires-list")!.innerHTML = "";
}

// ── Schedule builder ─────────────────────────────────────

const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function initScheduleSelects() {
  const hourSel = document.getElementById("sched-hour") as HTMLSelectElement;
  const minSel = document.getElementById("sched-minute") as HTMLSelectElement;
  const domSel = document.getElementById("sched-dom") as HTMLSelectElement;
  const intSel = document.getElementById("sched-interval") as HTMLSelectElement;
  if (hourSel && hourSel.options.length === 0) {
    for (let h = 0; h < 24; h++) {
      const ampm = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
      hourSel.add(new Option(ampm, String(h)));
    }
    hourSel.value = "9";
  }
  if (minSel && minSel.options.length === 0) {
    for (let m = 0; m < 60; m += 5) minSel.add(new Option(String(m).padStart(2, "0"), String(m)));
    minSel.value = "0";
  }
  if (domSel && domSel.options.length === 0) {
    for (let d = 1; d <= 31; d++) {
      const suffix = d === 1 || d === 21 || d === 31 ? "st" : d === 2 || d === 22 ? "nd" : d === 3 || d === 23 ? "rd" : "th";
      domSel.add(new Option(`${d}${suffix}`, String(d)));
    }
  }
  if (intSel && intSel.options.length === 0) {
    for (const n of [5, 10, 15, 20, 30, 45]) intSel.add(new Option(String(n), String(n)));
    intSel.value = "15";
  }
}

function getSelectedDays(): number[] {
  const chips = document.querySelectorAll("#sched-days-row .sched-day-chip.active");
  return Array.from(chips).map(c => Number((c as HTMLElement).dataset.dow));
}

function setSelectedDays(dows: number[]) {
  const set = new Set(dows);
  document.querySelectorAll("#sched-days-row .sched-day-chip").forEach(c => {
    const dow = Number((c as HTMLElement).dataset.dow);
    c.classList.toggle("active", set.has(dow));
  });
}

function updateScheduleOpts() {
  const freq = (document.getElementById("skill-schedule-freq") as HTMLSelectElement).value;
  const cronInput = document.getElementById("skill-schedule-cron") as HTMLInputElement;
  const daysRow = document.getElementById("sched-days-row")!;
  const timeRow = document.getElementById("sched-time-row")!;
  const domRow = document.getElementById("sched-dom-row")!;
  const intervalRow = document.getElementById("sched-interval-row")!;
  const preview = document.getElementById("sched-preview")!;

  initScheduleSelects();

  cronInput.classList.toggle("hidden", freq !== "custom");
  daysRow.classList.add("hidden");
  timeRow.classList.add("hidden");
  domRow.classList.add("hidden");
  intervalRow.classList.add("hidden");
  preview.classList.toggle("hidden", !freq);

  // Reset hourly-specific style overrides
  const hourEl = document.getElementById("sched-hour") as HTMLSelectElement;
  hourEl.style.display = "";
  const colonEl = timeRow.querySelector("span") as HTMLElement;
  if (colonEl) colonEl.style.display = "";
  const labelEl = timeRow.querySelector("label") as HTMLElement;
  if (labelEl) labelEl.textContent = "at";

  if (freq === "minutes") {
    intervalRow.classList.remove("hidden");
  } else if (freq === "hourly") {
    timeRow.classList.remove("hidden");
    // For hourly, only minute matters — hide hour selector
    const hourEl = document.getElementById("sched-hour") as HTMLSelectElement;
    hourEl.style.display = "none";
    (timeRow.querySelector("span") as HTMLElement).style.display = "none";
    (timeRow.querySelector("label") as HTMLElement).textContent = "at minute";
  } else if (freq === "daily") {
    timeRow.classList.remove("hidden");
  } else if (freq === "weekly") {
    daysRow.classList.remove("hidden");
    timeRow.classList.remove("hidden");
  } else if (freq === "weekdays") {
    timeRow.classList.remove("hidden");
  } else if (freq === "monthly") {
    domRow.classList.remove("hidden");
    timeRow.classList.remove("hidden");
  }

  updateSchedulePreview();
}

function updateSchedulePreview() {
  const preview = document.getElementById("sched-preview")!;
  const cron = getScheduleCron();
  if (!cron) { preview.classList.add("hidden"); return; }
  preview.classList.remove("hidden");
  preview.textContent = describeCron(cron);
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `cron: ${cron}`;
  const [min, hr, dom, , dow] = parts;

  const fmtTime = (h: string, m: string) => {
    const hi = parseInt(h); const mi = parseInt(m);
    const ampm = hi < 12 ? "AM" : "PM";
    const h12 = hi === 0 ? 12 : hi > 12 ? hi - 12 : hi;
    return mi === 0 ? `${h12} ${ampm}` : `${h12}:${String(mi).padStart(2, "0")} ${ampm}`;
  };

  if (min.includes("/")) {
    const step = min.split("/")[1];
    return `Runs every ${step} minutes`;
  }
  if (hr === "*" && dom === "*" && dow === "*") {
    return `Runs every hour at :${min.padStart(2, "0")}`;
  }
  if (dom === "*" && dow === "*") {
    return `Runs daily at ${fmtTime(hr, min)}`;
  }
  if (dom === "*" && dow === "1-5") {
    return `Runs weekdays (Mon-Fri) at ${fmtTime(hr, min)}`;
  }
  if (dom === "*" && dow !== "*") {
    const days = dow.split(",").map(d => DAYS_FULL[parseInt(d)] || d).join(", ");
    return `Runs every ${days} at ${fmtTime(hr, min)}`;
  }
  if (dow === "*" && dom !== "*") {
    const suffix = (d: number) => d === 1 || d === 21 || d === 31 ? "st" : d === 2 || d === 22 ? "nd" : d === 3 || d === 23 ? "rd" : "th";
    return `Runs on the ${parseInt(dom)}${suffix(parseInt(dom))} of each month at ${fmtTime(hr, min)}`;
  }
  return `cron: ${cron}`;
}

function getScheduleCron(): string {
  const freq = (document.getElementById("skill-schedule-freq") as HTMLSelectElement).value;
  if (!freq) return "";
  if (freq === "custom") return (document.getElementById("skill-schedule-cron") as HTMLInputElement).value.trim();

  const minute = (document.getElementById("sched-minute") as HTMLSelectElement)?.value || "0";
  const hour = (document.getElementById("sched-hour") as HTMLSelectElement)?.value || "9";
  const interval = (document.getElementById("sched-interval") as HTMLSelectElement)?.value || "15";
  const dom = (document.getElementById("sched-dom") as HTMLSelectElement)?.value || "1";

  if (freq === "minutes") return `*/${interval} * * * *`;
  if (freq === "hourly") return `${minute} * * * *`;
  if (freq === "daily") return `${minute} ${hour} * * *`;
  if (freq === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (freq === "weekly") {
    const days = getSelectedDays();
    const dowStr = days.length > 0 ? days.sort((a, b) => a - b).join(",") : "1";
    return `${minute} ${hour} * * ${dowStr}`;
  }
  if (freq === "monthly") return `${minute} ${hour} ${dom} * *`;
  return "";
}

function setScheduleFromCron(cron: string) {
  const freqSel = document.getElementById("skill-schedule-freq") as HTMLSelectElement;
  const cronInput = document.getElementById("skill-schedule-cron") as HTMLInputElement;
  if (!cron) { freqSel.value = ""; updateScheduleOpts(); return; }

  const shorthand: Record<string, string> = { "@hourly": "hourly", "@daily": "daily", "@weekly": "weekly", "@monthly": "monthly" };
  if (shorthand[cron]) { freqSel.value = shorthand[cron]; updateScheduleOpts(); return; }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) { freqSel.value = "custom"; updateScheduleOpts(); cronInput.value = cron; return; }

  const [min, hr, dom, , dow] = parts;

  // Every N minutes
  if (min.startsWith("*/") && hr === "*" && dom === "*" && dow === "*") {
    freqSel.value = "minutes"; updateScheduleOpts();
    const el = document.getElementById("sched-interval") as HTMLSelectElement;
    if (el) el.value = min.split("/")[1];
    updateSchedulePreview();
    return;
  }
  // Hourly at minute N
  if (min !== "*" && !min.includes("/") && hr === "*" && dom === "*" && dow === "*") {
    freqSel.value = "hourly"; updateScheduleOpts();
    const el = document.getElementById("sched-minute") as HTMLSelectElement;
    if (el) el.value = min;
    updateSchedulePreview();
    return;
  }
  // Weekdays
  if (hr !== "*" && dom === "*" && dow === "1-5") {
    freqSel.value = "weekdays"; updateScheduleOpts();
    setTimeFromCron(hr, min);
    updateSchedulePreview();
    return;
  }
  // Weekly with specific days
  if (hr !== "*" && dom === "*" && dow !== "*") {
    freqSel.value = "weekly"; updateScheduleOpts();
    const days = dow.split(",").map(d => parseInt(d));
    setSelectedDays(days);
    setTimeFromCron(hr, min);
    updateSchedulePreview();
    return;
  }
  // Daily
  if (hr !== "*" && dom === "*" && dow === "*") {
    freqSel.value = "daily"; updateScheduleOpts();
    setTimeFromCron(hr, min);
    updateSchedulePreview();
    return;
  }
  // Monthly
  if (hr !== "*" && dom !== "*" && dow === "*") {
    freqSel.value = "monthly"; updateScheduleOpts();
    setTimeFromCron(hr, min);
    const el = document.getElementById("sched-dom") as HTMLSelectElement;
    if (el) el.value = dom;
    updateSchedulePreview();
    return;
  }

  freqSel.value = "custom"; updateScheduleOpts();
  cronInput.value = cron;
}

function setTimeFromCron(hr: string, min: string) {
  const hEl = document.getElementById("sched-hour") as HTMLSelectElement;
  const mEl = document.getElementById("sched-minute") as HTMLSelectElement;
  if (hEl) hEl.value = hr;
  if (mEl) mEl.value = min;
}

async function loadSkills() {
  skillEditor.classList.add("hidden");
  skillFormError.classList.add("hidden");
  allSkillsDetailed = await window.yo.skillsListDetailed();

  const limitMsg = document.getElementById("skills-limit-msg")!;
  const newBtn = document.getElementById("skill-new-btn") as HTMLButtonElement;
  try {
    const auth = await window.yo.getAuthStatus();
    const atLimit = auth.tier !== "basic" && auth.tier !== "advanced" && allSkillsDetailed.length >= 5;
    limitMsg.classList.toggle("hidden", !atLimit);
    newBtn.disabled = atLimit;
    if (atLimit) {
      document.getElementById("skills-upgrade-link")!.onclick = (e) => {
        e.preventDefault();
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
    }
  } catch { /* fall through */ }

  renderSkillsList();
}

function renderSkillsList() {
  const query = skillSearchInput.value.trim().toLowerCase();
  const filtered = query
    ? allSkillsDetailed.filter((s) => s.name.toLowerCase().includes(query) || (s.description || "").toLowerCase().includes(query))
    : allSkillsDetailed;

  if (allSkillsDetailed.length === 0) {
    skillsListEl.innerHTML = `<div class="crud-empty">No skills yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    skillsListEl.innerHTML = `<div class="crud-empty">No skills matching "${query}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, skillsPage);
  skillsPage = state.page;
  skillsListEl.innerHTML = "";

  for (const skill of items) {
    const badges: string[] = [];
    if (skill.hasRunner) badges.push('<span class="app-card-badge" style="font-size:9px;padding:1px 5px;">JS</span>');
    if (skill.scheduled) badges.push(`<span class="app-card-badge" style="background:rgba(74,158,255,0.15);color:#4A9EFF;font-size:9px;padding:1px 5px;" title="${skill.scheduleExpr || ''}">⏰</span>`);
    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${skill.name}${badges.length ? " " + badges.join(" ") : ""}</span>
        ${skill.description ? `<span class="crud-card-meta">${skill.description}</span>` : ""}
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-edit-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      openSkillEditor(skill.name);
    });
    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete skill "${skill.name}"?`);
      if (!confirmed) return;
      await window.yo.skillsRemove(skill.name);
      loadSkills();
    });
    card.addEventListener("click", () => openSkillEditor(skill.name));
    skillsListEl.appendChild(card);
  }
  skillsListEl.appendChild(renderPaginationBar(state, (p) => { skillsPage = p; renderSkillsList(); }));
}

async function openSkillEditor(name: string | null) {
  editingSkillName = name;
  editingFileContents = new Map();
  collapsedFolders.clear();

  await ensureToolGroups();

  const newSkill = !name;
  clearToolRows();
  clearRequiresRows();

  if (newSkill) {
    skillNameInput.value = "";
    editingSkillFiles = ["SKILL.md"];
    editingSelectedFile = "SKILL.md";
    editingFileContents.set("SKILL.md", "");
    skillDescInput.value = "";
    setScheduleFromCron("");
    skillDeleteBtn.style.display = "none";
  } else {
    skillNameInput.value = name!;
    const full = await window.yo.skillsGet(name!);
    if (full) {
      skillDescInput.value = full.manifest?.description || "";
      const tools: string[] = full.manifest?.["allowed-tools"] || [];
      for (const entry of tools) {
        const dot = entry.indexOf(".");
        if (dot > 0) addToolRow(entry.slice(0, dot), entry.slice(dot + 1));
      }
      const requires: string[] = full.manifest?.requires || [];
      for (const r of requires) addRequiresRow(r);
      setScheduleFromCron(full.manifest?.schedule || "");
      editingFileContents.set("SKILL.md", full.prompt || "");
      if (full.runnerCode != null) {
        editingFileContents.set("SKILL.js", full.runnerCode);
      }
    }
    editingSkillFiles = await window.yo.skillsListFiles(name!);
    if (editingSkillFiles.length === 0) editingSkillFiles = ["SKILL.md"];
    editingSelectedFile = editingSkillFiles.includes("SKILL.md") ? "SKILL.md" : editingSkillFiles[0];
    skillDeleteBtn.style.display = "";
  }
  skillFormError.classList.add("hidden");
  skillsListEl.classList.add("hidden");
  skillsToolbar.classList.add("hidden");
  skillEditor.classList.remove("hidden");

  renderSkillFileTree();
  await openSkillFile(editingSelectedFile);

  if (name) loadSkillRunHistory(name);
  else renderRunList([]);

  skillNameInput.focus();
}

function renderSkillFileTree() {
  const list = document.getElementById("skill-file-list")!;
  list.innerHTML = "";

  const sorted = [...editingSkillFiles].sort();
  const core = sorted.filter((f) => f === "SKILL.md" || f === "SKILL.js");
  const rest = sorted.filter((f) => f !== "SKILL.md" && f !== "SKILL.js");
  const ordered = [...core, ...rest];

  const renderedFolders = new Set<string>();

  const renderFolder = (folderPath: string, depth: number) => {
    if (renderedFolders.has(folderPath)) return;
    renderedFolders.add(folderPath);
    const name = folderPath.split("/").pop()!;
    const isCollapsed = collapsedFolders.has(folderPath);
    const item = document.createElement("div");
    item.className = `skill-file-item folder collapsible${isCollapsed ? " collapsed" : ""}`;
    item.style.paddingLeft = (10 + depth * 14) + "px";
    item.innerHTML = `
      <svg class="skill-folder-chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 1l3 3-3 3"/></svg>
      <svg class="skill-file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h4l1 1h7v8H2V4z"/></svg>
      <span class="skill-file-item-label">${name}</span>`;
    item.addEventListener("click", () => {
      if (collapsedFolders.has(folderPath)) collapsedFolders.delete(folderPath);
      else collapsedFolders.add(folderPath);
      renderSkillFileTree();
    });
    list.appendChild(item);
  };

  const renderFile = (file: string) => {
    const parts = file.split("/");
    const depth = parts.length - 1;
    const name = parts[parts.length - 1];
    const isCore = file === "SKILL.md" || file === "SKILL.js";

    // Skip files inside collapsed parent folders
    for (let i = 1; i <= depth; i++) {
      if (collapsedFolders.has(parts.slice(0, i).join("/"))) return;
    }

    const item = document.createElement("div");
    item.className = "skill-file-item" + (file === editingSelectedFile ? " active" : "");
    item.style.paddingLeft = (10 + depth * 14) + "px";
    item.innerHTML = `
      <svg class="skill-file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2h6l3 3v9H3V2z"/></svg>
      <span class="skill-file-item-label">${name}</span>
      ${!isCore ? `<button class="skill-file-item-delete" title="Delete">×</button>` : ""}`;
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".skill-file-item-delete")) return;
      captureCurrentEditorContent();
      openSkillFile(file);
    });
    const delBtn = item.querySelector(".skill-file-item-delete");
    if (delBtn) {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await confirmAction(`Remove file "${file}"?`);
        if (!confirmed) return;
        editingFileContents.delete(file);
        editingSkillFiles = editingSkillFiles.filter((f) => f !== file);
        if (editingSelectedFile === file) editingSelectedFile = editingSkillFiles[0];
        if (editingSkillName) await window.yo.skillsDeleteFile(editingSkillName, file);
        renderSkillFileTree();
        openSkillFile(editingSelectedFile);
      });
    }
    list.appendChild(item);
  };

  for (const file of ordered) {
    const parts = file.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join("/");
      const parentCollapsed = Array.from({ length: i }, (_, j) =>
        collapsedFolders.has(parts.slice(0, j + 1).join("/"))
      ).some(Boolean);
      if (!parentCollapsed) renderFolder(folderPath, i);
    }
    renderFile(file);
  }
}

async function openSkillFile(relPath: string) {
  editingSelectedFile = relPath;
  renderSkillFileTree();

  const container = document.getElementById("skill-monaco-container")!;
  const status = document.getElementById("skill-editor-status")!;
  status.textContent = relPath;

  // Lazy-load file content if we don't have it cached yet
  if (!editingFileContents.has(relPath) && editingSkillName) {
    const content = await window.yo.skillsReadFile(editingSkillName, relPath);
    editingFileContents.set(relPath, content || "");
  }
  const content = editingFileContents.get(relPath) || "";

  await ensureMonaco();
  const w = window as any;
  if (monacoEditor) {
    const model = w.monaco.editor.createModel(content, languageForFile(relPath));
    monacoEditor.setModel(model);
  } else {
    monacoEditor = w.monaco.editor.create(container, {
      value: content,
      language: languageForFile(relPath),
      theme: document.documentElement.getAttribute("data-theme") === "dark" ? "vs-dark" : "vs",
      fontSize: 12,
      fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
      minimap: { enabled: false },
      wordWrap: "on",
      automaticLayout: true,
      padding: { top: 8 },
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
    });
  }
}

function captureCurrentEditorContent() {
  if (!monacoEditor) return;
  editingFileContents.set(editingSelectedFile, monacoEditor.getValue());
}

function closeSkillEditor() {
  captureCurrentEditorContent();
  skillEditor.classList.add("hidden");
  skillsListEl.classList.remove("hidden");
  skillsToolbar.classList.remove("hidden");
  editingSkillName = null;
  editingFileContents = new Map();
  loadSkills();
}

async function saveSkill() {
  captureCurrentEditorContent();
  const name = skillNameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!name) {
    skillFormError.textContent = "Name is required.";
    skillFormError.classList.remove("hidden");
    return;
  }

  const description = skillDescInput.value.trim();
  const allowedTools = getToolEntries();
  const requires = getRequiresEntries();
  const schedule = getScheduleCron();

  const manifest: any = { name, description };
  if (allowedTools.length) manifest["allowed-tools"] = allowedTools;
  if (requires.length) manifest.requires = requires;
  if (schedule) manifest.schedule = schedule;

  const prompt = editingFileContents.get("SKILL.md") ?? "";
  const runnerCode = editingFileContents.has("SKILL.js") ? editingFileContents.get("SKILL.js") ?? "" : null;

  if (editingSkillName && editingSkillName !== name) {
    await window.yo.skillsRemove(editingSkillName);
  }

  const result = await window.yo.skillsWriteFull(name, manifest, prompt, runnerCode);
  if (typeof result === "object" && "error" in result) {
    skillFormError.textContent = result.error;
    skillFormError.classList.remove("hidden");
    return;
  }

  // Also write arbitrary files that aren't SKILL.md or SKILL.js
  for (const [file, content] of editingFileContents) {
    if (file === "SKILL.md" || file === "SKILL.js") continue;
    await window.yo.skillsWriteFile(name, file, content);
  }

  editingSkillName = name;
  closeSkillEditor();
}

async function deleteSkill() {
  if (!editingSkillName) return;
  const confirmed = await confirmAction(`Delete skill "${editingSkillName}"?`);
  if (!confirmed) return;
  await window.yo.skillsRemove(editingSkillName);
  closeSkillEditor();
}



// ── New file / Run / Export / Import ──────────────────────

function addSkillFile() {
  const list = document.getElementById("skill-file-list")!;
  const placeholder = "new-file.md";
  const item = document.createElement("div");
  item.className = "skill-file-item active";
  item.style.paddingLeft = "10px";
  const icon = `<svg class="skill-file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2h6l3 3v9H3V2z"/></svg>`;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "skill-file-rename-input";
  input.value = placeholder;
  item.innerHTML = icon;
  item.appendChild(input);
  list.appendChild(item);
  input.focus();
  input.setSelectionRange(0, placeholder.lastIndexOf("."));

  const commit = () => {
    const val = input.value.trim().replace(/^\/+/, "").replace(/\/+/g, "/");
    if (!val || val === "SKILL.md" || val === "SKILL.js" || editingSkillFiles.includes(val)) {
      item.remove();
      return;
    }
    editingSkillFiles.push(val);
    editingFileContents.set(val, "");
    captureCurrentEditorContent();
    openSkillFile(val);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { item.remove(); }
  });
  input.addEventListener("blur", commit);
}

function addSkillFolder() {
  const list = document.getElementById("skill-file-list")!;
  const item = document.createElement("div");
  item.className = "skill-file-item folder";
  item.style.paddingLeft = "10px";
  const icon = `<svg class="skill-file-item-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h4l1 1h7v8H2V4z"/></svg>`;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "skill-file-rename-input";
  input.value = "new-folder";
  item.innerHTML = icon;
  item.appendChild(input);
  list.appendChild(item);
  input.focus();
  input.select();

  const commit = () => {
    const val = input.value.trim().replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
    if (!val) { item.remove(); return; }
    const placeholder = `${val}/.keep`;
    if (editingSkillFiles.includes(placeholder)) { item.remove(); return; }
    editingSkillFiles.push(placeholder);
    editingFileContents.set(placeholder, "");
    renderSkillFileTree();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { item.remove(); }
  });
  input.addEventListener("blur", commit);
}

async function uploadSkillFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    // Use webkitRelativePath if user picked a folder, else just the filename
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const safePath = path.replace(/^\/+/, "").replace(/\/+/g, "/");
    if (safePath === "SKILL.md" || safePath === "SKILL.js") continue;
    const text = await file.text();
    if (!editingSkillFiles.includes(safePath)) {
      editingSkillFiles.push(safePath);
    }
    editingFileContents.set(safePath, text);
  }
  // Reset input so the same file can be picked again
  input.value = "";
  captureCurrentEditorContent();
  renderSkillFileTree();
}

async function runSkillFromEditor() {
  if (!editingSkillName) return;
  captureCurrentEditorContent();

  // Save first
  await saveSkillInline();

  const runBtn = document.getElementById("skill-run") as HTMLButtonElement;
  runBtn.disabled = true;
  runBtn.textContent = "Running...";
  try {
    const input = (await promptAction("Input for this run (leave blank for none):", "", "e.g. summarize this conversation")) ?? "";
    const result = await window.yo.skillsRun(editingSkillName, input);
    if (!result.ok) {
      skillFormError.textContent = `Run error: ${result.error}`;
      skillFormError.classList.remove("hidden");
    } else {
      skillFormError.classList.add("hidden");
    }
    if (editingSkillName) await loadSkillRunHistory(editingSkillName);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "▶ Run";
  }
}

// Save without closing the editor
async function saveSkillInline() {
  captureCurrentEditorContent();
  const name = skillNameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!name) return;
  const description = skillDescInput.value.trim();
  const allowedTools = getToolEntries();
  const requires = getRequiresEntries();
  const schedule = getScheduleCron();
  const manifest: any = { name, description };
  if (allowedTools.length) manifest["allowed-tools"] = allowedTools;
  if (requires.length) manifest.requires = requires;
  if (schedule) manifest.schedule = schedule;
  const promptBody = editingFileContents.get("SKILL.md") ?? "";
  const runnerCode = editingFileContents.has("SKILL.js") ? editingFileContents.get("SKILL.js") ?? "" : null;
  await window.yo.skillsWriteFull(name, manifest, promptBody, runnerCode);
  for (const [file, content] of editingFileContents) {
    if (file === "SKILL.md" || file === "SKILL.js") continue;
    await window.yo.skillsWriteFile(name, file, content);
  }
  editingSkillName = name;
}

async function exportSkill() {
  if (!editingSkillName) return;
  const base64 = await window.yo.skillsExport(editingSkillName);
  if (!base64) return;
  // Trigger download via data URI
  const a = document.createElement("a");
  a.href = `data:application/zip;base64,${base64}`;
  a.download = `${editingSkillName}.yo`;
  a.click();
}

async function importSkill(file: File) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const result = await window.yo.skillsImport(base64, true);
  if (result.imported.length) {
    await loadSkills();
  }
  if (result.error) {
    skillFormError.textContent = `Import error: ${result.error}`;
    skillFormError.classList.remove("hidden");
  }
}

// ── Run history ──────────────────────────────────────────

async function loadSkillRunHistory(name: string) {
  const runs = await window.yo.skillsRunHistory(name);
  renderRunList(runs || []);
}

function renderRunList(runs: any[]) {
  const list = document.getElementById("skill-runs-list")!;
  const count = document.getElementById("skill-runs-count")!;
  count.textContent = runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : "";
  list.innerHTML = "";
  if (runs.length === 0) {
    list.innerHTML = `<div style="color:var(--text-2);font-size:11px;padding:4px 0;">No runs yet.</div>`;
    return;
  }
  for (const run of runs) {
    const item = document.createElement("div");
    item.className = "skill-run-item";
    const statusCls = run.error ? "skill-run-status-error" : "skill-run-status-success";
    const when = new Date(run.startedAt).toLocaleString();
    const dur = run.durationMs ? `${(run.durationMs / 1000).toFixed(2)}s` : "—";
    item.innerHTML = `
      <div class="skill-run-item-header">
        <span>${when} · ${run.trigger} · ${dur}</span>
        <span class="skill-run-item-status ${statusCls}">${run.error ? "error" : "ok"}</span>
      </div>
      <div class="skill-run-item-details hidden"></div>
    `;
    item.addEventListener("click", () => {
      const det = item.querySelector(".skill-run-item-details") as HTMLElement;
      if (det.classList.contains("hidden")) {
        det.innerHTML = renderRunDetails(run);
        det.classList.remove("hidden");
      } else {
        det.classList.add("hidden");
      }
    });
    list.appendChild(item);
  }
}

function renderRunDetails(run: any): string {
  const parts: string[] = [];
  if (run.input) parts.push(`<b>Input:</b> ${typeof run.input === "string" ? escapeHtml(run.input.slice(0, 300)) : escapeHtml(JSON.stringify(run.input).slice(0, 300))}`);
  if (run.error) parts.push(`<b style="color:var(--danger);">Error:</b> ${escapeHtml(run.error)}`);
  if (run.output !== undefined && run.output !== null && !run.error) {
    const out = typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2);
    parts.push(`<b>Output:</b> ${escapeHtml(out.slice(0, 500))}`);
  }
  if (run.events && run.events.length) {
    const tree = renderEventTree(run.events);
    parts.push(`<b>Events:</b>\n${tree}`);
  }
  if (run.logs && run.logs.length) {
    parts.push(`<b>Logs:</b>\n${run.logs.map((l: string) => escapeHtml(l)).join("\n")}`);
  }
  return parts.join("\n\n");
}

function renderEventTree(events: any[]): string {
  // Build parent->children
  const byParent = new Map<string | undefined, any[]>();
  for (const ev of events) {
    const key = ev.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(ev);
  }
  const lines: string[] = [];
  const roots = byParent.get(undefined) || [];
  const walk = (ev: any, depth: number) => {
    const indent = "  ".repeat(depth);
    const dur = ev.endedAt ? `${((ev.endedAt - ev.startedAt) / 1000).toFixed(2)}s` : "…";
    const icon = ev.status === "success" ? "✓" : ev.status === "error" ? "✗" : "⟳";
    lines.push(`<span class="skill-run-event status-${ev.status}">${indent}${icon} ${escapeHtml(ev.label)} — ${dur}</span>`);
    const children = byParent.get(ev.id) || [];
    for (const c of children) walk(c, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Live progress via onSkillProgress ──────────────────────

window.yo.onSkillProgress?.((data: { runId: string; event: any }) => {
  // During a live run, append events to the top of the run list so the user sees progress
  // We take a simple approach: refresh run history after each event
  if (editingSkillName) {
    loadSkillRunHistory(editingSkillName);
  }
});

window.yo.onSkillAskUser?.((data: { runId: string; qid: string; question: string }) => {
  const modal = document.getElementById("skill-ask-user-modal")!;
  const qEl = document.getElementById("skill-ask-user-question")!;
  const ansEl = document.getElementById("skill-ask-user-answer") as HTMLTextAreaElement;
  qEl.textContent = data.question;
  ansEl.value = "";
  modal.classList.remove("hidden");
  const submit = document.getElementById("skill-ask-user-submit")!;
  const cancel = document.getElementById("skill-ask-user-cancel")!;
  const onSubmit = () => {
    window.yo.skillsUserResponse(data.qid, ansEl.value);
    modal.classList.add("hidden");
    submit.removeEventListener("click", onSubmit);
    cancel.removeEventListener("click", onCancel);
  };
  const onCancel = () => {
    window.yo.skillsUserResponse(data.qid, "");
    modal.classList.add("hidden");
    submit.removeEventListener("click", onSubmit);
    cancel.removeEventListener("click", onCancel);
  };
  submit.addEventListener("click", onSubmit);
  cancel.addEventListener("click", onCancel);
});

// ── Drips ─────────────────────────────────────────────────

let dripsPage = 0;
let allDrips: Array<{ name: string; recipe: string }> = [];
let builtinEffects: string[] = [];
const dripsListEl = document.getElementById("drips-list")!;
const dripsToolbar = document.getElementById("drips-toolbar")!;
const dripEditor = document.getElementById("drip-editor")!;
const dripNameInput = document.getElementById("drip-name") as HTMLInputElement;
const dripDeleteBtn = document.getElementById("drip-delete-btn") as HTMLButtonElement;
const dripSearchInput = document.getElementById("drip-search") as HTMLInputElement;
const dripFormError = document.getElementById("drip-form-error")!;
const dripModeSelect = document.getElementById("drip-mode") as HTMLSelectElement;
const dripCountInput = document.getElementById("drip-count") as HTMLInputElement;
const dripEffectsList = document.getElementById("drip-effects-list")!;
const dripRecipePreview = document.getElementById("drip-recipe-preview")!;
let editingDripName: string | null = null;

function buildDripRecipe(): string {
  const mode = dripModeSelect.value;
  const parts: string[] = [];
  if (mode === "persistent") parts.push("-1");
  else if (mode === "counted") parts.push(dripCountInput.value || "3");
  const selects = dripEffectsList.querySelectorAll("select");
  selects.forEach((sel) => { if ((sel as HTMLSelectElement).value) parts.push((sel as HTMLSelectElement).value); });
  return parts.join(" ");
}

function updateDripRecipePreview() {
  const recipe = buildDripRecipe();
  dripRecipePreview.textContent = recipe || "—";
}

function addEffectRow(value?: string) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;align-items:center;";
  const sel = document.createElement("select");
  sel.className = "settings-input";
  sel.style.cssText = "flex:1;";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select effect...";
  sel.appendChild(placeholder);
  for (const eff of builtinEffects) {
    const opt = document.createElement("option");
    opt.value = eff;
    opt.textContent = eff;
    sel.appendChild(opt);
  }
  if (value) sel.value = value;
  sel.addEventListener("change", updateDripRecipePreview);
  row.appendChild(sel);

  const removeBtn = document.createElement("button");
  removeBtn.className = "action-btn danger";
  removeBtn.style.cssText = "padding:4px 8px;font-size:11px;flex-shrink:0;";
  removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  removeBtn.addEventListener("click", () => {
    row.remove();
    updateDripRecipePreview();
  });
  row.appendChild(removeBtn);

  dripEffectsList.appendChild(row);
  updateDripRecipePreview();
}

function parseRecipeIntoBuilder(recipe: string) {
  dripEffectsList.innerHTML = "";
  const tokens = recipe.trim().split(/\s+/);
  let mode = "oneshot";
  let idx = 0;

  if (tokens[0] === "-1") { mode = "persistent"; idx = 1; }
  else if (/^\d+$/.test(tokens[0]) && parseInt(tokens[0]) > 1) {
    mode = "counted";
    dripCountInput.value = tokens[0];
    idx = 1;
  }

  dripModeSelect.value = mode;
  dripCountInput.classList.toggle("hidden", mode !== "counted");

  for (; idx < tokens.length; idx++) {
    if (tokens[idx]) addEffectRow(tokens[idx]);
  }
  if (dripEffectsList.children.length === 0) addEffectRow();
  updateDripRecipePreview();
}

async function loadDrips() {
  dripEditor.classList.add("hidden");
  dripFormError.classList.add("hidden");

  const dripsGate = document.getElementById("drips-upgrade-gate")!;

  // Custom drips require Basic or Advanced
  try {
    const auth = await window.yo.getAuthStatus();
    if (auth.tier !== "basic" && auth.tier !== "advanced") {
      dripsGate.classList.remove("hidden");
      dripsToolbar.classList.add("hidden");
      dripsListEl.classList.add("hidden");
      document.getElementById("drips-upgrade-btn")!.onclick = () => {
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
      return;
    }
  } catch { /* fall through */ }

  dripsGate.classList.add("hidden");
  dripsToolbar.classList.remove("hidden");
  dripsListEl.classList.remove("hidden");

  if (builtinEffects.length === 0) {
    builtinEffects = await window.yo.dripsBuiltinEffects();
  }
  allDrips = await window.yo.dripsList();
  renderDripsList();
}

function renderDripsList() {
  const query = dripSearchInput.value.trim().toLowerCase();
  const filtered = query ? allDrips.filter((d) => d.name.toLowerCase().includes(query)) : allDrips;

  if (allDrips.length === 0) {
    dripsListEl.innerHTML = `<div class="crud-empty">No custom drips yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    dripsListEl.innerHTML = `<div class="crud-empty">No drips matching "${query}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, dripsPage);
  dripsPage = state.page;
  dripsListEl.innerHTML = "";

  for (const drip of items) {
    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${drip.name}</span>
        <span class="crud-card-meta">${drip.recipe}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-play-btn" title="Play">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-play-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      window.yo.dripsPreview(drip.recipe);
    });

    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      openDripEditor(drip.name, drip.recipe);
    });

    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete drip "${drip.name}"?`);
      if (!confirmed) return;
      await window.yo.dripsDelete(drip.name);
      loadDrips();
    });

    card.addEventListener("click", () => openDripEditor(drip.name, drip.recipe));

    dripsListEl.appendChild(card);
  }
  dripsListEl.appendChild(renderPaginationBar(state, (p) => { dripsPage = p; renderDripsList(); }));
}

function openDripEditor(name: string, recipe: string) {
  editingDripName = name || null;
  dripNameInput.value = name;
  dripDeleteBtn.style.display = name ? "" : "none";
  dripFormError.classList.add("hidden");

  if (recipe) {
    parseRecipeIntoBuilder(recipe);
  } else {
    dripModeSelect.value = "oneshot";
    dripCountInput.classList.add("hidden");
    dripEffectsList.innerHTML = "";
    addEffectRow();
  }

  dripsListEl.classList.add("hidden");
  dripsToolbar.classList.add("hidden");
  dripEditor.classList.remove("hidden");
  dripNameInput.focus();
}

function closeDripEditor() {
  dripEditor.classList.add("hidden");
  dripsListEl.classList.remove("hidden");
  dripsToolbar.classList.remove("hidden");
  editingDripName = null;
  loadDrips();
}

async function saveDrip() {
  let valid = true;
  const name = dripNameInput.value.trim().toLowerCase();
  const recipe = buildDripRecipe();

  if (!name) { dripNameInput.classList.add("invalid"); clearInvalid(dripNameInput); valid = false; }
  const hasEffects = Array.from(dripEffectsList.querySelectorAll("select")).some((s) => (s as HTMLSelectElement).value);
  if (!hasEffects) {
    dripFormError.textContent = "Select at least one effect.";
    dripFormError.classList.remove("hidden");
    valid = false;
  }
  if (!valid) {
    if (!dripFormError.textContent) {
      dripFormError.textContent = "Please fill in all required fields.";
      dripFormError.classList.remove("hidden");
    }
    return;
  }

  if (editingDripName && editingDripName !== name) {
    await window.yo.dripsDelete(editingDripName);
  }
  await window.yo.dripsSave(name, recipe);
  editingDripName = name;
  closeDripEditor();
}

async function deleteDrip() {
  if (!editingDripName) return;
  const confirmed = await confirmAction(`Delete drip "${editingDripName}"?`);
  if (!confirmed) return;
  await window.yo.dripsDelete(editingDripName);
  closeDripEditor();
}

// ── About ─────────────────────────────────────────────────

// ── Docs ──────────────────────────────────────────────────

function loadDocs() {
  // Docs sub-nav is handled above (docsSubNav click handlers)
  // Nothing dynamic to load — all content is static HTML
}

// ── Support ───────────────────────────────────────────────
const DISCORD_INVITE = "https://discord.gg/7wR9amSs";

let supportInitialized = false;

function loadSupport() {
  if (supportInitialized) return;
  supportInitialized = true;

  const discordLink = document.getElementById("support-discord-link")!;
  discordLink.addEventListener("click", () => {
    window.yo.openExternal(DISCORD_INVITE);
  });

  const form = document.getElementById("support-form") as HTMLFormElement;
  const subjectInput = document.getElementById("support-subject") as HTMLInputElement;
  const descInput = document.getElementById("support-description") as HTMLTextAreaElement;
  const submitBtn = document.getElementById("support-submit-btn") as HTMLButtonElement;
  const statusEl = document.getElementById("support-status")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const subject = subjectInput.value.trim();
    const description = descInput.value.trim();
    if (!subject || !description) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
    statusEl.textContent = "";
    statusEl.className = "support-status";

    const result = await window.yo.submitSupportTicket({ subject, description });

    if (result.ok) {
      statusEl.textContent = "Ticket submitted! We'll get back to you soon.";
      statusEl.className = "support-status success";
      subjectInput.value = "";
      descInput.value = "";
    } else {
      statusEl.textContent = result.error || "Failed to submit ticket. Try Discord instead.";
      statusEl.className = "support-status error";
    }

    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
  });
}

// ── About ─────────────────────────────────────────────────
async function loadAbout() {
  // Version from package.json via main process
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    const ver = await window.yo.getAppVersion();
    versionEl.textContent = `Version ${ver}`;
  }

  const updateBtn = document.getElementById("about-check-update") as HTMLButtonElement | null;
  if (updateBtn) {
    updateBtn.addEventListener("click", async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = "Checking...";
      const ver = await window.yo.checkForUpdates();
      if (ver) {
        updateBtn.textContent = `v${ver} available — downloading`;
      } else {
        updateBtn.textContent = "You're up to date";
        setTimeout(() => {
          updateBtn.textContent = "Check for Updates";
          updateBtn.disabled = false;
        }, 3000);
      }
    });
  }

  // Terms of Use
  const termsEl = document.querySelector("#policy-terms .policy-content");
  if (termsEl) termsEl.innerHTML = TERMS_OF_USE;

  // Privacy Policy
  const privacyEl = document.querySelector("#policy-privacy .policy-content");
  if (privacyEl) privacyEl.innerHTML = PRIVACY_POLICY;

  // Refund Policy
  const refundEl = document.querySelector("#policy-refund .policy-content");
  if (refundEl) refundEl.innerHTML = REFUND_POLICY;
}

const TERMS_OF_USE = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>These Terms of Use ("Terms") govern your access to and use of .Yo, a desktop application and related services ("Service") provided by Glyphh AI LLC ("Company", "we", "us"). By installing, accessing, or using the Service, you agree to be bound by these Terms.</p>

<p><strong>1. Eligibility</strong></p>
<p>You must be at least 13 years old to use the Service. If you are under 18, you represent that your parent or legal guardian has reviewed and agreed to these Terms on your behalf.</p>

<p><strong>2. Account and License</strong></p>
<p>Use of the Service requires a valid license key. You are responsible for keeping your license key confidential. Each license is personal and non-transferable. You may activate your license on up to two (2) machines simultaneously. Sharing, reselling, or distributing your license key is prohibited and may result in immediate revocation.</p>

<p><strong>3. Acceptable Use</strong></p>
<p>You agree not to:</p>
<ul>
  <li>Reverse engineer, decompile, or disassemble the Service</li>
  <li>Use the Service to violate any applicable law or regulation</li>
  <li>Attempt to gain unauthorized access to the Service or its related systems</li>
  <li>Use the Service to transmit malware, spam, or any harmful content</li>
  <li>Interfere with the operation of the Service or other users' use of the Service</li>
  <li>Resell, sublicense, or redistribute the Service without written permission</li>
</ul>

<p><strong>4. Intellectual Property</strong></p>
<p>The Service, including all software, designs, trademarks, and content, is the intellectual property of Glyphh AI LLC. Your license grants a limited, non-exclusive, non-transferable, revocable right to use the Service for personal or internal business purposes only.</p>

<p><strong>5. Third-Party Services</strong></p>
<p>.Yo integrates with third-party AI services (e.g., Anthropic, OpenAI, Google AI). Your use of those services is governed by their respective terms and privacy policies. You are responsible for providing your own API keys and complying with third-party terms. Glyphh AI LLC is not responsible for the availability, accuracy, or conduct of third-party services.</p>

<p><strong>6. User Content</strong></p>
<p>You retain ownership of all content you create, capture, or process using the Service. We do not claim any ownership over your data. You are solely responsible for the content you process through the Service and for ensuring that your use complies with applicable laws and third-party rights.</p>

<p><strong>7. Service Availability</strong></p>
<p>We strive to maintain continuous availability but do not guarantee uninterrupted access. The Service may be temporarily unavailable for maintenance, updates, or due to circumstances beyond our control. We reserve the right to modify, suspend, or discontinue any part of the Service at any time with reasonable notice.</p>

<p><strong>8. Limitation of Liability</strong></p>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, GLYPHH AI LLC SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, PROFITS, OR REVENUE, ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY SHALL NOT EXCEED THE AMOUNT YOU PAID US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.</p>

<p><strong>9. Disclaimer of Warranties</strong></p>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE DISCLAIM ALL WARRANTIES INCLUDING, BUT NOT LIMITED TO, IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>

<p><strong>10. Termination</strong></p>
<p>We may terminate or suspend your access to the Service at any time for violation of these Terms. Upon termination, your license is revoked and you must cease all use of the Service. Sections 4, 6, 8, 9, and 11 survive termination.</p>

<p><strong>11. Governing Law</strong></p>
<p>These Terms are governed by the laws of the State of Delaware, without regard to conflict of law principles. Any disputes shall be resolved in the state or federal courts located in Delaware.</p>

<p><strong>12. Changes to Terms</strong></p>
<p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the revised Terms. Material changes will be communicated through the application or via email.</p>

<p><strong>13. Contact</strong></p>
<p>For questions about these Terms, contact us at support@yosup.dev.</p>
`;

const PRIVACY_POLICY = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>This Privacy Policy describes how Glyphh AI LLC ("Company", "we", "us") collects, uses, and protects your information when you use .Yo ("Service").</p>

<p><strong>1. Information We Collect</strong></p>
<p><strong>Account Information:</strong> When you register or purchase a license, we collect your email address, license key, and payment information (processed by Stripe). We do not store your full payment card details.</p>
<p><strong>Usage Data:</strong> We may collect anonymized, aggregated data about how the Service is used (e.g., feature usage, error reports) to improve the product. This data cannot be used to identify you personally.</p>
<p><strong>Device Information:</strong> For license activation and validation, we generate a machine fingerprint (a one-way hash of hardware identifiers). This hash cannot be used to identify your specific hardware.</p>

<p><strong>2. Information We Do NOT Collect</strong></p>
<ul>
  <li>We do not collect, transmit, or store the content of your AI conversations</li>
  <li>We do not collect your API keys (these are stored locally on your machine)</li>
  <li>We do not collect your captured context, library items, or skills</li>
  <li>We do not track your browsing activity within the Service's embedded panels</li>
  <li>We do not sell or share your personal information with third parties for advertising</li>
</ul>

<p><strong>3. Local-First Architecture</strong></p>
<p>.Yo is designed with a local-first architecture. Your data — including captured context, skills, layouts, preferences, and API keys — is stored exclusively on your local machine in the <code>~/yo/</code> directory. If you enable Cloud Sync (Basic plan and above), your library data is encrypted and synced to our servers. You can disable Cloud Sync at any time, and request deletion of cloud-stored data.</p>

<p><strong>4. How We Use Information</strong></p>
<ul>
  <li>To provide, maintain, and improve the Service</li>
  <li>To process payments and manage your subscription</li>
  <li>To validate your license and prevent unauthorized use</li>
  <li>To communicate with you about the Service (updates, security alerts)</li>
  <li>To comply with legal obligations</li>
</ul>

<p><strong>5. Third-Party Services</strong></p>
<p>When you use .Yo with third-party AI providers (Anthropic, OpenAI, Google AI, etc.), your prompts and data are sent directly from your machine to those providers using your own API keys. We do not proxy, intercept, or store this data. Please review the privacy policies of those providers.</p>
<p>We use Stripe for payment processing. Stripe's handling of your payment information is governed by <a href="https://stripe.com/privacy" style="color:#25C75E">Stripe's Privacy Policy</a>.</p>

<p><strong>6. Data Security</strong></p>
<p>We implement industry-standard security measures to protect the information we collect, including encryption in transit (TLS) and at rest. However, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

<p><strong>7. Data Retention</strong></p>
<p>We retain account and license information for the duration of your subscription plus 90 days. Payment records are retained as required by law. You may request deletion of your account data at any time by contacting us.</p>

<p><strong>8. Your Rights</strong></p>
<p>Depending on your jurisdiction, you may have the right to:</p>
<ul>
  <li>Access the personal data we hold about you</li>
  <li>Request correction of inaccurate data</li>
  <li>Request deletion of your data</li>
  <li>Object to or restrict processing of your data</li>
  <li>Data portability</li>
</ul>
<p>To exercise these rights, contact us at support@yosup.dev.</p>

<p><strong>9. Children's Privacy</strong></p>
<p>The Service is not intended for children under 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected such information, we will take steps to delete it.</p>

<p><strong>10. International Transfers</strong></p>
<p>If you are accessing the Service from outside the United States, your information may be transferred to and processed in the United States. By using the Service, you consent to such transfer.</p>

<p><strong>11. Changes to This Policy</strong></p>
<p>We may update this Privacy Policy from time to time. We will notify you of material changes through the application or via email. Continued use of the Service after changes constitutes acceptance.</p>

<p><strong>12. Contact</strong></p>
<p>For privacy-related questions or requests, contact us at support@yosup.dev.</p>
`;

const REFUND_POLICY = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>This Refund Policy applies to paid subscriptions for .Yo offered by Glyphh AI LLC.</p>

<p><strong>1. Free Tier</strong></p>
<p>The free tier of .Yo is available at no cost and requires no payment. No refund applies.</p>

<p><strong>2. Paid Subscriptions (Basic, Advanced)</strong></p>
<p>Paid plans are billed on a monthly subscription basis. You may cancel your subscription at any time.</p>

<p><strong>3. Refund Eligibility</strong></p>
<p>We offer a full refund within 14 days of your first subscription payment ("Refund Window") if you are not satisfied with the Service. To request a refund during this window, contact us at support@yosup.dev with your license key and the email associated with your account.</p>

<p><strong>4. After the Refund Window</strong></p>
<p>After the 14-day Refund Window, subscription payments are non-refundable. When you cancel your subscription, you retain access to paid features through the end of your current billing period. No partial refunds are issued for unused time within a billing cycle.</p>

<p><strong>5. Plan Changes</strong></p>
<p>If you upgrade from Basic to Advanced, you will be charged the prorated difference for the remainder of your billing cycle. If you downgrade, the change takes effect at the start of your next billing cycle. No refunds are issued for downgrades.</p>

<p><strong>6. Service Disruption</strong></p>
<p>If the Service experiences a significant outage or disruption lasting more than 72 continuous hours, you may be eligible for a prorated credit at our discretion. Contact support@yosup.dev to report service disruptions.</p>

<p><strong>7. Revoked Licenses</strong></p>
<p>If your license is revoked due to a violation of our Terms of Use, no refund will be issued.</p>

<p><strong>8. How to Cancel</strong></p>
<p>You can cancel your subscription at any time through the Settings section of the .Yo application. Alternatively, contact support@yosup.dev. Cancellation takes effect at the end of your current billing period.</p>

<p><strong>9. Contact</strong></p>
<p>For billing or refund questions, contact us at support@yosup.dev.</p>
`;

// ── MCP Servers (standalone section removed — merged into Apps tabs) ──

// Export policy HTML for use in onboarding
export { TERMS_OF_USE, PRIVACY_POLICY, REFUND_POLICY };
