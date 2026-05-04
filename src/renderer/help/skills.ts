/**
 * Skills section — editor, file tree, schedule builder, run history, export/import.
 */

import {
  paginate, renderPaginationBar, confirmAction, closeHelp,
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

  document.getElementById("skills-limit-msg")!.classList.add("hidden");

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
    if (skill.hasRunner) {
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

  const newSkill = !name;

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
  const schedule = getScheduleCron();

  const manifest: any = { name, description };
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


// Save without closing the editor
async function saveSkillInline() {
  captureCurrentEditorContent();
  const name = skillNameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!name) return;
  const description = skillDescInput.value.trim();
  const schedule = getScheduleCron();
  const manifest: any = { name, description };
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





export { loadSkills };

export function initSkillsEvents() {
  document.getElementById("skill-new-btn")!.addEventListener("click", () => openSkillEditor(null));
  document.getElementById("skill-save")!.addEventListener("click", saveSkill);
  document.getElementById("skill-cancel")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-back-link")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-delete")!.addEventListener("click", deleteSkill);
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
