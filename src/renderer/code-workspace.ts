interface CodeWorkspaceAPI {
  onAgentMessage: (cb: (agent: string, msg: any) => void) => void;
  onAgentStatus: (cb: (agent: string, status: string) => void) => void;
  startAgent: (agent: string) => void;
  stopAgent: (agent: string) => void;
  sendMessage: (agent: string, message: string) => void;
  getAgents: () => Promise<Array<{ name: string; role: string; prompt?: string }>>;
  addAgent: (name: string, role: string, prompt?: string) => Promise<{ ok: boolean; error?: string }>;
  getVscodeUrl: () => Promise<string | null>;
  getLayout: () => Promise<{
    name: string;
    cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
    cols: number; rows: number; colWidths: number[]; rowHeights: number[];
    inputAgents: string[];
  } | null>;
  saveLayoutSizes: (colWidths: number[], rowHeights: number[]) => Promise<boolean>;
  addAgentToLayout: (name: string, role: string, prompt?: string) => Promise<boolean>;
  cypherStatus: () => Promise<
    | { associated: false; layout_name: string | null; error?: string }
    | { associated: true; layout_name: string; cypher_id: string; slug: string; title: string; status: string; type: string; kitty: number; jammers: number }
  >;
  cypherCreateAndPublish: (input: Record<string, unknown>) => Promise<
    { ok: boolean; cypher?: { id: string; slug: string }; kitty_balance?: number; error?: string }
  >;
  cypherDisassociate: () => Promise<{ ok: boolean }>;
}

const api = (window as any).codeWorkspace as CodeWorkspaceAPI;

// ── State ─────────────────────────────────────────────────────
interface AgentEntry {
  name: string;
  role: string;
  status: string;
  pane: HTMLDivElement;
  tab: HTMLButtonElement | null;
  dot: HTMLSpanElement;
  statusBar: HTMLDivElement | null;
  inputWrap: HTMLDivElement | null;
  streamingEl: HTMLElement | null;
  activeTimeline: HTMLDivElement | null;
  activeTools: Map<string, HTMLDivElement>;
}

const agents = new Map<string, AgentEntry>();
let activeAgent: string | null = null;

// Track which tabbed container each agent belongs to (null = standalone cell)
const tabbedContainers = new Map<string, { tabsBar: HTMLDivElement; messages: HTMLDivElement; addBtn: HTMLButtonElement }>();
let defaultTabbedKey: string | null = null;

// Input-enabled agents
const inputAgentSet = new Set<string>();

// Grid resize state
let gridCols = 0;
let gridRows = 0;
let gridColWidths: number[] = [];
let gridRowHeights: number[] = [];
let isDragging = false;
let dragType: "col" | "row" = "col";
let dragIndex = 0;
const cwHandles = document.getElementById("cw-handles")!;
const cwDragOverlay = document.getElementById("cw-drag-overlay")!;

// ── Markdown renderer ─────────────────────────────────────────
function formatText(text: string): string {
  if (!text) return "";

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, (_m: string, code: string) =>
        `<code class="yo-md-inline">${code}</code>`)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, t: string, url: string) => {
        const trimmed = url.trim().toLowerCase();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
          return `<a class="yo-md-link" href="${url}" title="${url}">${t}</a>`;
        return `<span class="yo-md-link">${t}</span>`;
      })
      .replace(/(^|[^"=])(https?:\/\/[^\s<>&]+)/g, (_m: string, pre: string, url: string) =>
        `${pre}<a class="yo-md-link" href="${url}" title="${url}">${url}</a>`);

  const lines = text.split("\n");
  const html: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let inList = false;

  for (const line of lines) {
    if (!inCode && line.startsWith("```")) {
      inCode = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      continue;
    }
    if (inCode) {
      if (line.startsWith("```")) {
        inCode = false;
        const id = `cb-${Math.random().toString(36).slice(2, 8)}`;
        html.push(`<div class="yo-md-codeblock" id="${id}"><div class="yo-md-codeblock-header"><span class="yo-md-codeblock-lang">${esc(codeLang)}</span><button class="yo-md-copy" data-target="${id}">Copy</button></div>${esc(codeLines.join("\n"))}</div>`);
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (line.startsWith("# ")) { html.push(`<div class="yo-md-h1">${inline(esc(line.slice(2)))}</div>`); continue; }
    if (line.startsWith("## ")) { html.push(`<div class="yo-md-h2">${inline(esc(line.slice(3)))}</div>`); continue; }
    if (line.startsWith("### ")) { html.push(`<div class="yo-md-h3">${inline(esc(line.slice(4)))}</div>`); continue; }
    if (line.startsWith("#### ")) { html.push(`<div class="yo-md-h4">${inline(esc(line.slice(5)))}</div>`); continue; }
    if (line.startsWith("> ")) { html.push(`<div class="yo-md-quote">${inline(esc(line.slice(2)))}</div>`); continue; }
    if (/^[-*]\s/.test(line)) {
      if (!inList) { html.push(`<ul class="yo-md-list">`); inList = true; }
      html.push(`<li class="yo-md-li">${inline(esc(line.replace(/^[-*]\s/, "")))}</li>`);
      continue;
    }
    if (inList) { html.push(`</ul>`); inList = false; }
    if (line.trim() === "") { html.push(`<div style="height:6px"></div>`); continue; }
    html.push(`<p class="yo-md-p">${inline(esc(line))}</p>`);
  }
  if (inList) html.push(`</ul>`);
  if (inCode) {
    const id = `cb-${Math.random().toString(36).slice(2, 8)}`;
    html.push(`<div class="yo-md-codeblock" id="${id}"><div class="yo-md-codeblock-header"><span class="yo-md-codeblock-lang">${esc(codeLang)}</span><button class="yo-md-copy" data-target="${id}">Copy</button></div>${esc(codeLines.join("\n"))}</div>`);
  }
  return html.join("");
}

function attachCopyHandlers(container: HTMLElement) {
  container.querySelectorAll<HTMLButtonElement>(".yo-md-copy").forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const block = document.getElementById(btn.dataset.target || "");
      if (!block) return;
      const header = block.querySelector(".yo-md-codeblock-header");
      const text = Array.from(block.childNodes)
        .filter(n => n !== header)
        .map(n => (n as HTMLElement).textContent || n.textContent || "")
        .join("");
      navigator.clipboard.writeText(text.trim());
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1200);
    });
  });
}

function toolDisplayName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.length >= 3 ? `${parts[1]}:${parts.slice(2).join("__")}` : name;
  }
  const map: Record<string, string> = {
    Read: "Reading file", Edit: "Editing file", Write: "Writing file",
    Bash: "Running command", Grep: "Searching", Glob: "Finding files",
    WebFetch: "Fetching URL", WebSearch: "Searching web",
    Agent: "Spawning agent", TodoWrite: "Updating tasks",
  };
  return map[name] || name;
}

// ── Grid rendering ───────────────────────────────────────────
const workspace = document.getElementById("workspace")!;

function buildVscodeCell(): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "cw-cell cw-cell-vscode";
  cell.innerHTML = `<div class="cw-vscode-placeholder">VS Code — loading...</div>`;
  api.getVscodeUrl().then(url => {
    if (url) {
      cell.innerHTML = "";
      const wv = document.createElement("webview");
      wv.setAttribute("src", url);
      wv.setAttribute("style", "width:100%;height:100%;border:none;");
      wv.setAttribute("allowpopups", "");
      cell.appendChild(wv);
    } else {
      cell.innerHTML = `<div class="cw-vscode-placeholder">VS Code not available — enable in Home → Apps</div>`;
    }
  });
  return cell;
}

function buildTabbedCell(key: string): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "cw-cell";

  const tabsBar = document.createElement("div");
  tabsBar.className = "cw-tabs-bar";
  const addBtn = document.createElement("button");
  addBtn.className = "cw-add-btn";
  addBtn.textContent = "+";
  addBtn.title = "Add agent";
  addBtn.addEventListener("click", showAddModal);
  tabsBar.appendChild(addBtn);

  const messages = document.createElement("div");
  messages.className = "cw-messages";

  const statusBar = buildStatusBar();

  cell.appendChild(tabsBar);
  cell.appendChild(messages);
  cell.appendChild(statusBar);

  tabbedContainers.set(key, { tabsBar, messages, addBtn });
  return cell;
}

function buildSingleAgentCell(agentName: string): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "cw-cell";

  const header = document.createElement("div");
  header.className = "cw-cell-header";
  const dot = document.createElement("span");
  dot.className = "agent-tab-dot idle";
  dot.id = `solo-dot-${agentName}`;
  const title = document.createElement("span");
  title.className = "cw-cell-title";
  title.textContent = agentName;
  header.appendChild(dot);
  header.appendChild(title);

  const pane = document.createElement("div");
  pane.className = "cw-single-pane";

  const statusBar = buildStatusBar();
  statusBar.id = `solo-status-${agentName}`;

  cell.appendChild(header);
  cell.appendChild(pane);
  cell.appendChild(statusBar);

  cell.dataset.agentName = agentName;
  return cell;
}

function buildStatusBar(): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "cw-status-bar";
  bar.innerHTML = `
    <div class="cw-status-dot"></div>
    <div class="cw-status-text">idle</div>
    <button class="cw-stop-btn">Stop</button>
  `;
  const stopBtn = bar.querySelector(".cw-stop-btn") as HTMLButtonElement;
  stopBtn.addEventListener("click", () => {
    if (activeAgent) api.stopAgent(activeAgent);
  });
  return bar;
}

function buildInputWrap(agentName: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "cw-input-wrap";

  const textarea = document.createElement("textarea");
  textarea.className = "cw-agent-input";
  textarea.rows = 1;
  textarea.placeholder = `Message ${agentName}...`;

  const sendBtn = document.createElement("button");
  sendBtn.className = "cw-send-btn";
  sendBtn.innerHTML = "&uarr;";

  const doSend = () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    textarea.style.height = "36px";
    api.sendMessage(agentName, text);

    const entry = agents.get(agentName);
    if (entry) {
      const el = document.createElement("div");
      el.className = "cw-user-msg";
      el.textContent = text;
      entry.pane.appendChild(el);
      scrollToBottom(agentName);
    }
  };

  sendBtn.addEventListener("click", doSend);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  textarea.addEventListener("input", () => {
    textarea.style.height = "36px";
    textarea.style.height = Math.min(120, textarea.scrollHeight) + "px";
  });

  wrap.appendChild(textarea);
  wrap.appendChild(sendBtn);
  return wrap;
}

function ensureSpinnerAtBottom(entry: AgentEntry) {
  const spinner = entry.pane.querySelector(".cw-spinner");
  if (spinner) entry.pane.appendChild(spinner);
}

// ── Resize handles ───────────────────────────────────────────
function renderResizeHandles() {
  cwHandles.innerHTML = "";
  if (gridCols < 2 && gridRows < 2) return;

  const ww = window.innerWidth;
  const wh = window.innerHeight;

  let cumCol = 0;
  for (let i = 0; i < gridCols - 1; i++) {
    cumCol += gridColWidths[i];
    const handle = document.createElement("div");
    handle.className = "cw-col-handle";
    handle.style.left = `${Math.round(cumCol * ww)}px`;
    handle.dataset.index = String(i);
    cwHandles.appendChild(handle);
    handle.addEventListener("mousedown", (e) => startResize(e, "col", i));
  }

  let cumRow = 0;
  for (let i = 0; i < gridRows - 1; i++) {
    cumRow += gridRowHeights[i];
    const handle = document.createElement("div");
    handle.className = "cw-row-handle";
    handle.style.top = `${Math.round(cumRow * wh)}px`;
    handle.dataset.index = String(i);
    cwHandles.appendChild(handle);
    handle.addEventListener("mousedown", (e) => startResize(e, "row", i));
  }
}

function startResize(e: MouseEvent, type: "col" | "row", index: number) {
  e.preventDefault();
  isDragging = true;
  dragType = type;
  dragIndex = index;
  (e.currentTarget as HTMLElement).classList.add("dragging");
  cwDragOverlay.className = type === "col" ? "drag-col" : "drag-row";
}

function applyGridTemplate() {
  workspace.style.gridTemplateColumns = gridColWidths.map(w => `${w}fr`).join(" ");
  workspace.style.gridTemplateRows = gridRowHeights.map(h => `${h}fr`).join(" ");
}

function computeFractions(fraction: number, type: "col" | "row"): { a: number; b: number } | null {
  const widths = type === "col" ? gridColWidths : gridRowHeights;
  let before = 0;
  for (let i = 0; i < dragIndex; i++) before += widths[i];
  const after = 1 - before;
  const aFrac = fraction - before;
  const bFrac = after - aFrac;
  if (aFrac < 0.02 || bFrac < 0.02) return null;
  return { a: aFrac, b: bFrac };
}

function cumulativePos(widths: number[], index: number, total: number): number {
  let cum = 0;
  for (let i = 0; i <= index; i++) cum += widths[i];
  return Math.round(cum * total);
}

document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  if (dragType === "col") {
    const fraction = Math.max(0.05, Math.min(0.95, e.clientX / window.innerWidth));
    const fracs = computeFractions(fraction, "col");
    if (fracs) {
      gridColWidths[dragIndex] = fracs.a;
      gridColWidths[dragIndex + 1] = fracs.b;
      applyGridTemplate();
      const handle = cwHandles.querySelector<HTMLElement>(`.cw-col-handle[data-index="${dragIndex}"]`);
      if (handle) handle.style.left = `${cumulativePos(gridColWidths, dragIndex, window.innerWidth)}px`;
    }
  } else {
    const fraction = Math.max(0.05, Math.min(0.95, e.clientY / window.innerHeight));
    const fracs = computeFractions(fraction, "row");
    if (fracs) {
      gridRowHeights[dragIndex] = fracs.a;
      gridRowHeights[dragIndex + 1] = fracs.b;
      applyGridTemplate();
      const handle = cwHandles.querySelector<HTMLElement>(`.cw-row-handle[data-index="${dragIndex}"]`);
      if (handle) handle.style.top = `${cumulativePos(gridRowHeights, dragIndex, window.innerHeight)}px`;
    }
  }
});

document.addEventListener("mouseup", () => {
  if (!isDragging) return;
  isDragging = false;
  cwHandles.querySelectorAll(".dragging").forEach(el => el.classList.remove("dragging"));
  cwDragOverlay.className = "";
  api.saveLayoutSizes(gridColWidths, gridRowHeights);
  renderResizeHandles();
});

window.addEventListener("resize", () => {
  if (gridCols > 1 || gridRows > 1) renderResizeHandles();
});

// ── Agent management ──────────────────────────────────────────
function createAgentInTabbed(name: string, role: string, containerKey: string): AgentEntry {
  if (agents.has(name)) return agents.get(name)!;

  const container = tabbedContainers.get(containerKey);
  if (!container) throw new Error(`No tabbed container: ${containerKey}`);

  const pane = document.createElement("div");
  pane.className = "agent-pane";
  container.messages.appendChild(pane);

  const tab = document.createElement("button");
  tab.className = "agent-tab";
  const dot = document.createElement("span");
  dot.className = "agent-tab-dot idle";
  tab.appendChild(dot);
  tab.appendChild(document.createTextNode(name));
  tab.title = role;
  tab.addEventListener("click", () => switchAgent(name));
  container.tabsBar.insertBefore(tab, container.addBtn);

  const statusBar = container.tabsBar.closest(".cw-cell")?.querySelector(".cw-status-bar") as HTMLDivElement;

  let inputWrap: HTMLDivElement | null = null;
  if (inputAgentSet.has(name)) {
    inputWrap = buildInputWrap(name);
    const cwCell = container.tabsBar.closest(".cw-cell")!;
    cwCell.insertBefore(inputWrap, statusBar);
  }

  const entry: AgentEntry = {
    name, role, status: "idle",
    pane, tab, dot, statusBar, inputWrap,
    streamingEl: null, activeTimeline: null, activeTools: new Map(),
  };
  agents.set(name, entry);
  return entry;
}

function createAgentInCell(name: string, role: string, cell: HTMLDivElement): AgentEntry {
  if (agents.has(name)) return agents.get(name)!;

  const pane = cell.querySelector(".cw-single-pane") as HTMLDivElement;
  const dot = cell.querySelector(`#solo-dot-${name}`) as HTMLSpanElement;
  const statusBar = cell.querySelector(".cw-status-bar") as HTMLDivElement;

  const stopBtn = statusBar.querySelector(".cw-stop-btn") as HTMLButtonElement;
  stopBtn.addEventListener("click", () => api.stopAgent(name));

  let inputWrap: HTMLDivElement | null = null;
  if (inputAgentSet.has(name)) {
    inputWrap = buildInputWrap(name);
    cell.insertBefore(inputWrap, statusBar);
  }

  const entry: AgentEntry = {
    name, role, status: "idle",
    pane, tab: null, dot, statusBar, inputWrap,
    streamingEl: null, activeTimeline: null, activeTools: new Map(),
  };
  agents.set(name, entry);
  return entry;
}

function switchAgent(name: string) {
  if (!agents.has(name)) return;
  activeAgent = name;
  agents.forEach((a, key) => {
    if (a.pane.classList.contains("agent-pane")) {
      a.pane.classList.toggle("active", key === name);
    }
    a.tab?.classList.toggle("active", key === name);
  });
  updateStatusBar(name);
  scrollToBottom(name);
}

function scrollToBottom(name: string) {
  const entry = agents.get(name);
  if (entry) {
    const scrollTarget = entry.pane;
    requestAnimationFrame(() => {
      scrollTarget.scrollTop = scrollTarget.scrollHeight;
    });
  }
}

function updateStatusBar(name: string) {
  const entry = agents.get(name);
  if (!entry || !entry.statusBar) return;
  const st = entry.status;
  const dot = entry.statusBar.querySelector(".cw-status-dot") as HTMLElement;
  const text = entry.statusBar.querySelector(".cw-status-text") as HTMLElement;
  const stop = entry.statusBar.querySelector(".cw-stop-btn") as HTMLElement;
  if (dot) dot.className = `cw-status-dot ${st === "running" || st === "starting" ? "running" : st === "waiting" ? "waiting" : ""}`;
  if (text) text.textContent = st === "waiting" ? "ready" : st;
  if (stop) stop.classList.toggle("visible", st === "running" || st === "starting");
}

// ── Message handling ──────────────────────────────────────────
api.onAgentMessage((agent, msg) => {
  const entry = agents.get(agent);
  if (!entry) return;

  switch (msg.type) {
    case "init": renderInit(entry, msg); break;
    case "assistant": renderAssistant(entry, msg); break;
    case "partial_text": renderPartialText(entry, msg); break;
    case "tool_start": renderToolStart(entry, msg); break;
    case "tool_progress": renderToolProgress(entry, msg); break;
    case "result": renderResult(entry, msg); break;
    case "status": renderStatus(entry, msg); break;
    case "error": renderError(entry, msg); break;
    case "stopped": renderStopped(entry, msg); break;
  }
});

api.onAgentStatus((agent, status) => {
  const entry = agents.get(agent);
  if (!entry) return;
  entry.status = status;
  entry.dot.className = `agent-tab-dot ${status === "running" || status === "starting" ? "running" : status === "waiting" ? "waiting" : status === "error" ? "error" : "idle"}`;
  if (activeAgent === agent) updateStatusBar(agent);

  if (status === "starting") {
    entry.pane.innerHTML = "";
    clearStreaming(entry);
  }
});

function clearStreaming(entry: AgentEntry) {
  entry.streamingEl = null;
  entry.activeTimeline = null;
  entry.activeTools.clear();
}

// ── Render helpers ────────────────────────────────────────────
function renderInit(entry: AgentEntry, msg: any) {
  const el = document.createElement("div");
  el.className = "cw-init-info";
  el.textContent = `model: ${msg.model || "—"}`;
  if (msg.mcpServers && Object.keys(msg.mcpServers).length > 0) {
    el.textContent += ` · mcp: ${Object.keys(msg.mcpServers).join(", ")}`;
  }
  entry.pane.appendChild(el);
  scrollToBottom(entry.name);
}

function ensureTimeline(entry: AgentEntry): HTMLDivElement {
  if (!entry.activeTimeline) {
    entry.activeTimeline = document.createElement("div");
    entry.activeTimeline.className = "cw-timeline";
    entry.pane.appendChild(entry.activeTimeline);
  }
  return entry.activeTimeline;
}

function finalizeStreaming(entry: AgentEntry) {
  if (entry.streamingEl) {
    const raw = entry.streamingEl.getAttribute("data-raw") || "";
    entry.streamingEl.innerHTML = formatText(raw);
    attachCopyHandlers(entry.streamingEl);
    entry.streamingEl = null;
  }
}

function renderAssistant(entry: AgentEntry, msg: any) {
  const hadStreaming = !!entry.streamingEl;
  if (entry.streamingEl) {
    entry.streamingEl.remove();
    entry.streamingEl = null;
  }
  entry.activeTimeline = null;
  entry.activeTools.clear();

  if (msg.text) {
    const el = document.createElement("div");
    el.className = "cw-msg-text";
    el.innerHTML = formatText(msg.text);
    attachCopyHandlers(el);
    entry.pane.appendChild(el);
  }

  if (msg.toolUses?.length > 0) {
    const timeline = ensureTimeline(entry);
    for (const tool of msg.toolUses) {
      const block = createToolBlock(tool.id, tool.name, tool.input);
      timeline.appendChild(block);
    }
  }
  ensureSpinnerAtBottom(entry);
  scrollToBottom(entry.name);
}

function renderPartialText(entry: AgentEntry, msg: any) {
  if (!entry.streamingEl) {
    finalizeStreaming(entry);
    entry.activeTimeline = null;
    entry.activeTools.clear();
    entry.streamingEl = document.createElement("div");
    entry.streamingEl.className = "cw-msg-text";
    entry.streamingEl.setAttribute("data-raw", "");
    entry.pane.appendChild(entry.streamingEl);
  }
  const raw = (entry.streamingEl.getAttribute("data-raw") || "") + msg.text;
  entry.streamingEl.setAttribute("data-raw", raw);
  entry.streamingEl.innerHTML = formatText(raw) + `<span class="cw-streaming-cursor"></span>`;
  ensureSpinnerAtBottom(entry);
  scrollToBottom(entry.name);
}

function renderToolStart(entry: AgentEntry, msg: any) {
  finalizeStreaming(entry);
  const timeline = ensureTimeline(entry);
  const block = createToolBlock(msg.id, msg.name, "");
  block.classList.add("active");
  timeline.appendChild(block);
  entry.activeTools.set(msg.id, block);
  ensureSpinnerAtBottom(entry);
  scrollToBottom(entry.name);
}

function renderToolProgress(entry: AgentEntry, msg: any) {
  const block = entry.activeTools.get(msg.toolUseId);
  if (block) {
    const elapsed = block.querySelector(".cw-tool-elapsed");
    if (elapsed && msg.elapsed) {
      elapsed.textContent = `${Math.round(msg.elapsed)}s`;
    }
  }
}

function renderResult(entry: AgentEntry, msg: any) {
  finalizeStreaming(entry);
  entry.activeTools.forEach(block => block.classList.remove("active"));
  entry.activeTools.clear();
  entry.activeTimeline = null;

  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  const spinner = entry.pane.querySelector(".cw-spinner");
  if (spinner) spinner.remove();

  const el = document.createElement("div");
  el.className = "cw-result-block";
  const parts = [`${msg.numTurns || 0} turns`];
  if (msg.durationMs) parts.push(`${(msg.durationMs / 1000).toFixed(1)}s`);
  if (msg.costUsd) parts.push(`$${msg.costUsd.toFixed(4)}`);
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;">
      <span style="color:${msg.isError ? 'var(--danger)' : 'var(--accent)'}">${msg.isError ? '✗' : '✓'}</span>
      <span>${parts.join(" · ")}</span>
    </div>
  `;

  entry.pane.appendChild(el);
  scrollToBottom(entry.name);
}

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧"];
const SPINNER_PHRASES = ["thinking","cooking","vibing","brewing","conjuring","channeling"];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;

function renderStatus(entry: AgentEntry, msg: any) {
  if (msg.status === "requesting") {
    let spinner = entry.pane.querySelector(".cw-spinner") as HTMLElement;
    if (!spinner) {
      const phrase = SPINNER_PHRASES[Math.floor(Math.random() * SPINNER_PHRASES.length)];
      spinner = document.createElement("div");
      spinner.className = "cw-spinner";
      spinner.innerHTML = `<span class="cw-spinner-char">${SPINNER_FRAMES[0]}</span><span class="cw-spinner-phrase">${phrase}...</span>`;

      let frame = 0;
      if (spinnerInterval) clearInterval(spinnerInterval);
      const charEl = spinner.querySelector(".cw-spinner-char")!;
      spinnerInterval = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        charEl.textContent = SPINNER_FRAMES[frame];
      }, 80);
    }
    entry.pane.appendChild(spinner);
    scrollToBottom(entry.name);
  } else {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    const spinner = entry.pane.querySelector(".cw-spinner");
    if (spinner) spinner.remove();
  }
}

function renderError(entry: AgentEntry, msg: any) {
  finalizeStreaming(entry);
  const el = document.createElement("div");
  el.className = "cw-msg-error";
  el.textContent = msg.text || "Unknown error";
  entry.pane.appendChild(el);
  scrollToBottom(entry.name);
}

function renderStopped(entry: AgentEntry, msg: any) {
  finalizeStreaming(entry);
  const el = document.createElement("div");
  el.className = "cw-msg-stopped";
  el.textContent = msg.text || "Agent stopped.";
  entry.pane.appendChild(el);
  scrollToBottom(entry.name);
}

function createToolBlock(id: string, name: string, subtitle: string): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "cw-tool-block";
  block.id = `tool-${id}`;
  block.innerHTML = `
    <div class="cw-tool-header">
      <span class="cw-tool-dot"></span>
      <div class="cw-tool-headings">
        <span class="cw-tool-name">${toolDisplayName(name)}</span>
        ${subtitle ? `<span class="cw-tool-subtitle">${escapeHtml(subtitle)}</span>` : ""}
      </div>
      <span class="cw-tool-elapsed"></span>
    </div>
  `;
  return block;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Add agent modal ───────────────────────────────────────────
const modal = document.getElementById("add-agent-modal")!;
const modalName = document.getElementById("modal-agent-name") as HTMLInputElement;
const modalRole = document.getElementById("modal-agent-role") as HTMLInputElement;
const modalPrompt = document.getElementById("modal-agent-prompt") as HTMLTextAreaElement;
const modalCancel = document.getElementById("modal-cancel")!;
const modalAdd = document.getElementById("modal-add")!;

function showAddModal() {
  modalName.value = "";
  modalRole.value = "";
  modalPrompt.value = "";
  modal.classList.add("visible");
  modalName.focus();
}

modalCancel.addEventListener("click", () => modal.classList.remove("visible"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.remove("visible");
});

modalAdd.addEventListener("click", async () => {
  const name = modalName.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const role = modalRole.value.trim() || name;
  const prompt = modalPrompt.value.trim() || undefined;
  if (!name) { modalName.focus(); return; }

  const result = await api.addAgent(name, role, prompt);
  if (!result.ok) {
    alert(result.error || "Failed to add agent");
    return;
  }
  modal.classList.remove("visible");

  if (defaultTabbedKey) {
    createAgentInTabbed(name, role, defaultTabbedKey);
    switchAgent(name);
  }
  api.addAgentToLayout(name, role, prompt);
  api.startAgent(name);
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [agentList, layout] = await Promise.all([
    api.getAgents(),
    api.getLayout(),
  ]);

  const agentsByName = new Map(agentList.map(a => [a.name, a]));

  if (layout?.inputAgents) {
    layout.inputAgents.forEach(n => inputAgentSet.add(n));
  }

  // Build grid
  if (layout && layout.cells.length > 0) {
    gridCols = layout.cols;
    gridRows = layout.rows;
    gridColWidths = [...layout.colWidths];
    gridRowHeights = [...layout.rowHeights];

    const colTemplate = layout.colWidths.map(w => `${w}fr`).join(" ");
    const rowTemplate = layout.rowHeights.map(h => `${h}fr`).join(" ");
    workspace.style.gridTemplateColumns = colTemplate;
    workspace.style.gridTemplateRows = rowTemplate;

    const standaloneAgents = new Set<string>();
    let hasTabbedCell = false;

    for (const cell of layout.cells) {
      if (!cell.panelId) continue;
      let cellEl: HTMLDivElement;

      if (cell.panelId === "vscode") {
        cellEl = buildVscodeCell();
      } else if (cell.panelId === "agents-tabbed") {
        hasTabbedCell = true;
        const key = `tabbed-${cell.col}-${cell.row}`;
        cellEl = buildTabbedCell(key);
        if (!defaultTabbedKey) defaultTabbedKey = key;
      } else if (cell.panelId.startsWith("agent:")) {
        const agentName = cell.panelId.slice(6);
        cellEl = buildSingleAgentCell(agentName);
        standaloneAgents.add(agentName);
      } else {
        cellEl = document.createElement("div");
        cellEl.className = "cw-cell";
      }

      cellEl.style.gridColumn = `${cell.col + 1} / span ${cell.colSpan}`;
      cellEl.style.gridRow = `${cell.row + 1} / span ${cell.rowSpan}`;
      workspace.appendChild(cellEl);
    }

    // Create agent entries
    for (const a of agentList) {
      if (standaloneAgents.has(a.name)) {
        const cell = workspace.querySelector(`[data-agent-name="${a.name}"]`) as HTMLDivElement;
        if (cell) createAgentInCell(a.name, a.role, cell);
      } else if (defaultTabbedKey) {
        createAgentInTabbed(a.name, a.role, defaultTabbedKey);
      }
    }

    renderResizeHandles();
  } else {
    // Default layout: vscode left, agents-tabbed right
    gridCols = 2;
    gridRows = 1;
    gridColWidths = [0.7, 0.3];
    gridRowHeights = [1];
    workspace.style.gridTemplateColumns = "0.7fr 0.3fr";
    workspace.style.gridTemplateRows = "1fr";

    const vscodeCell = buildVscodeCell();
    workspace.appendChild(vscodeCell);

    const key = "tabbed-default";
    const tabbedCell = buildTabbedCell(key);
    defaultTabbedKey = key;
    workspace.appendChild(tabbedCell);

    for (const a of agentList) {
      createAgentInTabbed(a.name, a.role, key);
    }

    renderResizeHandles();
  }

  // Activate first agent
  if (agentList.length > 0) {
    switchAgent(agentList[0].name);
  }

  // Start all agents
  for (const a of agentList) {
    api.startAgent(a.name);
  }

  // Cypher widget — show status, allow publish-this-workspace
  initCypherWidget();
}

// ── Cypher widget ────────────────────────────────────────────
const cyWidget = document.getElementById("cw-cypher-widget") as HTMLDivElement;
const cyStatusText = document.getElementById("cw-cy-status-text")!;
const cyStats = document.getElementById("cw-cy-stats") as HTMLSpanElement;
const cyKittyEl = document.getElementById("cw-cy-kitty")!;
const cyJammersEl = document.getElementById("cw-cy-jammers")!;
const cyAction = document.getElementById("cw-cy-action") as HTMLButtonElement;
const cyModal = document.getElementById("cw-cy-publish-modal") as HTMLDivElement;
const cyTitle = document.getElementById("cw-cy-title") as HTMLInputElement;
const cyGoal = document.getElementById("cw-cy-goal") as HTMLInputElement;
const cyDesc = document.getElementById("cw-cy-description") as HTMLTextAreaElement;
const cyType = document.getElementById("cw-cy-type") as HTMLSelectElement;
const cyVis = document.getElementById("cw-cy-visibility") as HTMLSelectElement;
const cyReqSkills = document.getElementById("cw-cy-req-skills") as HTMLInputElement;
const cyReqApps = document.getElementById("cw-cy-req-apps") as HTMLInputElement;
const cyReqTier = document.getElementById("cw-cy-req-tier") as HTMLSelectElement;
const cyMaxJammers = document.getElementById("cw-cy-max-jammers") as HTMLInputElement;
const cyKittyAmount = document.getElementById("cw-cy-kitty-amount") as HTMLInputElement;
const cyKittyHint = document.getElementById("cw-cy-kitty-hint")!;
const cyErr = document.getElementById("cw-cy-publish-err")!;
const cyCancel = document.getElementById("cw-cy-cancel")!;
const cyPublishGo = document.getElementById("cw-cy-publish-go")!;

let cypherWidgetTimer: ReturnType<typeof setInterval> | null = null;
let cypherCurrentId: string | null = null;

function fmtYos(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return String(n);
}

function csvList(s: string): string[] | undefined {
  const arr = s.split(",").map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

function updateCyKittyHint() {
  const t = cyType.value;
  if (t === "bounty") cyKittyHint.textContent = "Bounty cyphers must pre-fund > 0.";
  else if (t === "coop") cyKittyHint.textContent = "Co-op: each joiner contributes equally; this is your share.";
  else if (t === "sponsored") cyKittyHint.textContent = "You're the sponsor — fund what jammers will draw.";
  else cyKittyHint.textContent = "Anyone can add to the kitty after publish.";
}
cyType.addEventListener("change", updateCyKittyHint);

async function refreshCypherWidget(): Promise<void> {
  if (!api.cypherStatus) return;          // older preload — no-op
  let s: Awaited<ReturnType<typeof api.cypherStatus>>;
  try { s = await api.cypherStatus(); } catch { cyWidget.style.display = "none"; return; }
  cyWidget.style.display = "flex";

  if (s.associated === true) {
    cyWidget.classList.add("live");
    cyStatusText.textContent = `${s.title} · ${s.status}`;
    cyStats.style.display = "inline-flex";
    cyKittyEl.textContent = fmtYos(s.kitty) + " yos";
    cyJammersEl.textContent = String(s.jammers);
    cyAction.textContent = "Manage";
    cypherCurrentId = s.cypher_id;
  } else {
    cyWidget.classList.remove("live");
    cyStatusText.textContent = "Local cypher";
    cyStats.style.display = "none";
    cyAction.textContent = "Publish";
    cypherCurrentId = null;
  }
}

function openPublishModal() {
  cyTitle.value = "";
  cyGoal.value = "";
  cyDesc.value = "";
  cyType.value = "open";
  cyVis.value = "public";
  cyReqSkills.value = "";
  cyReqApps.value = "";
  cyReqTier.value = "";
  cyMaxJammers.value = "";
  cyKittyAmount.value = "1000";
  cyErr.classList.remove("visible");
  updateCyKittyHint();
  cyModal.classList.add("visible");
  cyTitle.focus();
}

function closePublishModal() {
  cyModal.classList.remove("visible");
}

cyCancel.addEventListener("click", closePublishModal);
cyModal.addEventListener("click", (e) => {
  if (e.target === cyModal) closePublishModal();
});

cyAction.addEventListener("click", () => {
  if (cypherCurrentId) {
    // Already published — leave the workspace, the user can manage in Home → Cyphers
    // For v1 just open the publish-cypher detail in Home would require an IPC roundtrip;
    // here we just nudge the user via alert so they know where to go.
    alert(`Open Home (cmd+H) → Cyphers → "${cyStatusText.textContent}" to manage.`);
  } else {
    openPublishModal();
  }
});

cyPublishGo.addEventListener("click", async () => {
  cyErr.classList.remove("visible");
  const title = cyTitle.value.trim();
  if (!title) { cyErr.textContent = "Title required"; cyErr.classList.add("visible"); return; }
  const requirements: Record<string, unknown> = {};
  const skills = csvList(cyReqSkills.value); if (skills) requirements.skills = skills;
  const apps = csvList(cyReqApps.value); if (apps) requirements.apps = apps;
  if (cyReqTier.value) requirements.min_tier = cyReqTier.value;
  const maxJ = Number(cyMaxJammers.value);
  const r = await api.cypherCreateAndPublish({
    title,
    goal: cyGoal.value.trim() || undefined,
    description: cyDesc.value.trim() || undefined,
    type: cyType.value,
    visibility: cyVis.value,
    sensitivity: "internal",
    max_jammers: Number.isFinite(maxJ) && maxJ > 0 ? maxJ : undefined,
    requirements,
    work_package: { kind: "blank" },
    initial_kitty_deposit: Math.max(0, Number(cyKittyAmount.value) || 0),
  });
  if (!r.ok) {
    cyErr.textContent = r.error || "Publish failed";
    cyErr.classList.add("visible");
    return;
  }
  closePublishModal();
  await refreshCypherWidget();
});

function initCypherWidget(): void {
  if (cypherWidgetTimer) return;
  void refreshCypherWidget();
  cypherWidgetTimer = setInterval(() => { void refreshCypherWidget(); }, 10000);
}

init();
