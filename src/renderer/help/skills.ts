/**
 * Skills section — editor, file tree, schedule builder, run history, export/import.
 */

import {
  paginate, renderPaginationBar, confirmAction, clearInvalid,
  escapeHtml, promptAction, closeHelp,
} from "./shared.js";

// ── Skills ────────────────────────────────────────────────
// Folder-based skills: SKILL.md (frontmatter + prompt) + SKILL.js (optional runner) + arbitrary files.

let skillsPage = 0;
let allSkillsDetailed: Array<{ name: string; description?: string; hasRunner: boolean; hasApp: boolean; scheduled: boolean; scheduleExpr?: string }> = [];
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
const skillTypeSelect = document.getElementById("skill-type") as HTMLSelectElement;
const skillRightTabs = document.getElementById("skill-right-tabs")!;
const skillTabCode = document.getElementById("skill-tab-code")!;
const skillTabPreview = document.getElementById("skill-tab-preview")!;
let skillPreviewWebview = document.getElementById("skill-preview-webview") as any;
let activeRightTab: "code" | "preview" = "code";
let _vibePreloadPath: string | null = null;

function switchSkillRightTab(tab: "code" | "preview") {
  activeRightTab = tab;
  skillTabCode.style.display = tab === "code" ? "" : "none";
  skillTabPreview.style.display = tab === "preview" ? "" : "none";
  Array.from(skillRightTabs.querySelectorAll(".skill-right-tab")).forEach(btn => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab);
  });
  if (tab === "preview") refreshVibePreview();
}

async function refreshVibePreview() {
  const html = editingFileContents.get("APP.html") || "";
  if (!html.trim()) {
    skillPreviewWebview.src = "data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="background:#0a0a0a;color:#999;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>No APP.html content</p></body>`
    );
    return;
  }
  try {
    const vibeName = editingSkillName || "preview";
    const result = await (window as any).yo.vibePreviewWrite(html, vibeName);
    // Setting preload via setAttribute on an attached <webview> is unreliable —
    // its webContents is created on DOM attach, before any later attribute change.
    // Replace the element with a fresh one that has preload set before insertion.
    if (!_vibePreloadPath) {
      _vibePreloadPath = result.preloadPath;
      const old = skillPreviewWebview;
      const fresh = document.createElement("webview") as any;
      fresh.id = old.id;
      fresh.className = old.className;
      const partition = old.getAttribute("partition");
      if (partition) fresh.setAttribute("partition", partition);
      fresh.setAttribute("preload", `file://${_vibePreloadPath}`);
      old.parentElement!.replaceChild(fresh, old);
      skillPreviewWebview = fresh;
    }
    skillPreviewWebview.src = result.fileUrl;
  } catch {
    skillPreviewWebview.src = "data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="background:#0a0a0a;color:#999;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Preview failed to load</p></body>`
    );
  }
}

function updatePreviewTabVisibility() {
  const isVibe = skillTypeSelect.value === "vibe" || editingSkillFiles.includes("APP.html");
  const previewBtn = skillRightTabs.querySelector('[data-tab="preview"]') as HTMLElement;
  if (previewBtn) previewBtn.style.display = isVibe ? "" : "none";
  if (!isVibe && activeRightTab === "preview") switchSkillRightTab("code");
}

skillRightTabs.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".skill-right-tab") as HTMLElement | null;
  if (!btn) return;
  switchSkillRightTab(btn.dataset.tab as "code" | "preview");
});

document.getElementById("skill-preview-refresh")?.addEventListener("click", () => {
  captureCurrentEditorContent();
  refreshVibePreview();
});

document.getElementById("skill-preview-open")?.addEventListener("click", async () => {
  if (!editingSkillName) return;
  await saveSkillInline();
  window.yo.execCommand(`.dip vibe-${editingSkillName}`);
});

skillTypeSelect.addEventListener("change", () => {
  if (skillTypeSelect.value === "vibe" && !editingSkillFiles.includes("APP.html")) {
    const starter = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { padding: 24px; }
  h1 { margin-bottom: 16px; }
</style>
</head>
<body>
  <h1>My Vibe</h1>
  <p class="text-muted">Edit this file to build your app. Base theme CSS is auto-injected.</p>
  <script>
    // window.vibe.runSkill(name, input) — call a skill
    // window.vibe.ask(prompt) — one-shot LLM call
    // window.vibe.store.get/set/list/query — data store
    // window.vibe.copyToClipboard(text)
  </script>
</body>
</html>`;
    editingSkillFiles.push("APP.html");
    editingFileContents.set("APP.html", starter);
    renderSkillFileTree();
  }
  updatePreviewTabVisibility();
});

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

  // Resolve namespace: exact match first, then case-insensitive suffix match
  let resolvedNs = ns;
  if (ns && !cachedToolGroups.find(g => g.namespace === ns)) {
    const lower = ns.toLowerCase();
    const fuzzy = cachedToolGroups.find(g =>
      g.namespace.toLowerCase().endsWith(lower) ||
      g.namespace.toLowerCase().includes(lower)
    );
    if (fuzzy) resolvedNs = fuzzy.namespace;
  }

  const appSel = document.createElement("select");
  let appOptions = cachedToolGroups.map(g =>
    `<option value="${g.namespace}"${g.namespace === resolvedNs ? " selected" : ""}>${g.label}</option>`
  ).join("");
  if (resolvedNs && !cachedToolGroups.find(g => g.namespace === resolvedNs)) {
    appOptions += `<option value="${resolvedNs}" selected>${resolvedNs} (unresolved)</option>`;
  }
  appSel.innerHTML = `<option value="">App...</option>` + appOptions;

  const toolSel = document.createElement("select");
  const populateTools = (selectedNs: string, preselect?: string) => {
    const group = cachedToolGroups.find(g => g.namespace === selectedNs);
    const toolOptions = group ? group.tools.map(t =>
      `<option value="${t.name}"${t.name === preselect ? " selected" : ""}>${t.name}</option>`
    ).join("") : "";
    const hasMatch = group?.tools.some(t => t.name === preselect);
    const unresolvedOpt = preselect && !hasMatch
      ? `<option value="${preselect}" selected>${preselect} (unresolved)</option>`
      : "";
    toolSel.innerHTML = `<option value="">Tool...</option>` + toolOptions + unresolvedOpt;
  };
  if (resolvedNs) populateTools(resolvedNs, tool);
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

// Slot row functions live in layouts.ts (they reference layoutSlotsList)

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
    const pills: string[] = [];
    if (skill.hasApp) {
      pills.push('<span class="skill-pill skill-pill-vibe">Vibe</span>');
    } else if (skill.hasRunner) {
      pills.push('<span class="skill-pill skill-pill-js">JS</span>');
    } else {
      pills.push('<span class="skill-pill skill-pill-prompt">Prompt</span>');
    }
    if (skill.scheduled) pills.push(`<span class="skill-pill skill-pill-scheduled" title="${skill.scheduleExpr || ''}">Scheduled</span>`);
    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${skill.name} ${pills.join(" ")}</span>
        ${skill.description ? `<span class="crud-card-meta">${skill.description}</span>` : ""}
      </div>
      <div class="crud-card-actions">
        ${skill.hasApp ? `<button class="crud-card-btn crud-open-btn" title="Open vibe">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>` : ""}
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    const openBtn = card.querySelector(".crud-open-btn");
    if (openBtn) {
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.yo.execCommand(`.dip vibe-${skill.name}`);
      });
    }
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
    skillTypeSelect.value = "skill";
    setScheduleFromCron("");
    skillDeleteBtn.style.display = "none";
  } else {
    skillNameInput.value = name!;
    const full = await window.yo.skillsGet(name!);
    if (full) {
      skillDescInput.value = full.manifest?.description || "";
      skillTypeSelect.value = full.manifest?.type === "vibe" || full.hasApp ? "vibe" : "skill";
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
  switchSkillRightTab("code");
  updatePreviewTabVisibility();

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
  if (skillTypeSelect.value === "vibe") manifest.type = "vibe";
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
  if (skillTypeSelect.value === "vibe") manifest.type = "vibe";
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
  if (run.input) {
    const inputStr = typeof run.input === "string" ? run.input : JSON.stringify(run.input, null, 2);
    parts.push(renderRunSection("Input", escapeHtml(inputStr), inputStr.length > 200));
  }
  if (run.error) {
    parts.push(renderRunSection("Error", `<span style="color:var(--danger);">${escapeHtml(run.error)}</span>`, false));
  }
  if (run.output !== undefined && run.output !== null) {
    const out = typeof run.output === "string" ? run.output : JSON.stringify(run.output, null, 2);
    parts.push(renderRunSection("Output", escapeHtml(out), out.length > 200));
  }
  if (run.events && run.events.length) {
    const tree = renderEventTree(run.events);
    parts.push(renderRunSection("Events", tree, run.events.length > 5));
  }
  if (run.logs && run.logs.length) {
    parts.push(renderRunSection("Logs", run.logs.map((l: string) => escapeHtml(l)).join("\n"), run.logs.length > 5));
  }
  if (parts.length === 0) {
    parts.push(`<div style="color:var(--text-2);font-size:11px;">No output recorded for this run.</div>`);
  }
  return parts.join("");
}

function renderRunSection(label: string, content: string, collapsed: boolean): string {
  const bodyStyle = collapsed ? ' style="max-height:120px;overflow:hidden;position:relative;"' : '';
  const toggle = collapsed
    ? `<span style="cursor:pointer;color:var(--accent);font-size:10px;margin-left:6px;" onclick="const b=this.parentElement.nextElementSibling;if(b.style.maxHeight){b.style.maxHeight='';b.style.overflow='';this.textContent='▾ collapse'}else{b.style.maxHeight='120px';b.style.overflow='hidden';this.textContent='▸ expand'}">▸ expand</span>`
    : '';
  return `<div class="skill-run-section">
    <div class="skill-run-section-header"><b>${label}</b>${toggle}</div>
    <div class="skill-run-section-body"${bodyStyle}>${content}</div>
  </div>`;
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

// escapeHtml imported from shared

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


export { loadSkills };

export function initSkillsEvents() {
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
}
