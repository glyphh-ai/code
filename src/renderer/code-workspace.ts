interface CodeWorkspaceAPI {
  onAgentMessage: (cb: (agent: string, msg: any) => void) => void;
  onAgentStatus: (cb: (agent: string, status: string) => void) => void;
  startAgent: (agent: string) => void;
  stopAgent: (agent: string) => void;
  sendMessage: (agent: string, message: string) => void;
  getAgents: () => Promise<Array<{ name: string; role: string; prompt?: string }>>;
  addAgent: (name: string, role: string, prompt?: string) => Promise<{ ok: boolean; error?: string }>;
  cypherStatus: () => Promise<
    | { associated: false; layout_name: string | null; error?: string }
    | { associated: true; layout_name: string; cypher_id: string; slug: string; title: string; status: string; type: string; kitty: number; jammers: number }
  >;
}

const api = (window as any).codeWorkspace as CodeWorkspaceAPI;

// ── State ─────────────────────────────────────────────────────

interface Participant {
  name: string;
  role: string;
  status: "idle" | "running" | "done" | "error";
  isRemote: boolean;
  el: HTMLDivElement;
  messages: HTMLDivElement;
  streamingEl: HTMLElement | null;
  activeTimeline: HTMLDivElement | null;
  activeTools: Map<string, HTMLDivElement>;
}

const participants = new Map<string, Participant>();
let focusedAgent: string | null = null;

// ── DOM refs ──────────────────────────────────────────────────

const stageContent = document.getElementById("stage-content")!;
const stageEmpty = document.getElementById("stage-empty")!;
const stageAgentDot = document.getElementById("stage-agent-dot")!;
const stageAgentName = document.getElementById("stage-agent-name")!;
const stageAgentRole = document.getElementById("stage-agent-role")!;
const stageSharingBadge = document.getElementById("stage-sharing-badge")!;
const stageInput = document.getElementById("stage-input") as HTMLTextAreaElement;
const stageSend = document.getElementById("stage-send")!;
const stageStop = document.getElementById("stage-stop")!;
const participantsList = document.getElementById("participants-list")!;
const participantsCount = document.getElementById("participants-count")!;
const addAgentBtn = document.getElementById("add-agent-btn")!;
const cypherBarDot = document.getElementById("cypher-bar-dot")!;
const cypherBarTitle = document.getElementById("cypher-bar-title")!;
const cypherBarKitty = document.getElementById("cypher-bar-kitty")!;
const cypherBarJammers = document.getElementById("cypher-bar-jammers")!;

// Modal
const addModal = document.getElementById("add-agent-modal")!;
const modalName = document.getElementById("modal-agent-name") as HTMLInputElement;
const modalRole = document.getElementById("modal-agent-role") as HTMLInputElement;
const modalPrompt = document.getElementById("modal-agent-prompt") as HTMLTextAreaElement;
const modalCancel = document.getElementById("modal-cancel")!;
const modalAdd = document.getElementById("modal-add")!;

// ── Markdown renderer ─────────────────────────────────────────

function formatText(text: string): string {
  if (!text) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    s.replace(/`([^`]+)`/g, (_m: string, code: string) => `<code class="yo-md-inline">${code}</code>`)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, t: string, url: string) => {
        const trimmed = url.trim().toLowerCase();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
          return `<a class="yo-md-link" href="${url}">${t}</a>`;
        return `<span class="yo-md-link">${t}</span>`;
      });

  const lines = text.split("\n");
  const html: string[] = [];
  let inCode = false, codeLang = "", codeLines: string[] = [], inList = false;

  for (const line of lines) {
    if (!inCode && line.startsWith("```")) { inCode = true; codeLang = line.slice(3).trim(); codeLines = []; continue; }
    if (inCode) {
      if (line.startsWith("```")) {
        inCode = false;
        const id = `cb-${Math.random().toString(36).slice(2, 8)}`;
        html.push(`<div class="yo-md-codeblock" id="${id}"><div class="yo-md-codeblock-header"><span class="yo-md-codeblock-lang">${esc(codeLang)}</span><button class="yo-md-copy" data-target="${id}">Copy</button></div>${esc(codeLines.join("\n"))}</div>`);
      } else { codeLines.push(line); }
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
      const text = Array.from(block.childNodes).filter(n => n !== header).map(n => (n as HTMLElement).textContent || "").join("");
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

// ── Participant management ────────────────────────────────────

function createParticipant(name: string, role: string, isRemote = false): Participant {
  const el = document.createElement("div");
  el.className = "participant";
  el.innerHTML = `
    <span class="p-dot idle"></span>
    <div class="p-info">
      <div class="p-name">${name}</div>
      <div class="p-role">${role}</div>
    </div>
    <span class="p-badge ${isRemote ? "remote" : "local"}">${isRemote ? "remote" : "local"}</span>
  `;
  el.addEventListener("click", () => focusAgent(name));

  const messages = document.createElement("div");
  messages.style.display = "none";

  const p: Participant = {
    name, role, status: "idle", isRemote, el, messages,
    streamingEl: null, activeTimeline: null, activeTools: new Map(),
  };
  participants.set(name, p);
  participantsList.appendChild(el);
  updateCount();
  return p;
}

function updateCount() {
  participantsCount.textContent = String(participants.size);
}

function updateParticipantStatus(name: string, status: "idle" | "running" | "done" | "error") {
  const p = participants.get(name);
  if (!p) return;
  p.status = status;
  const dot = p.el.querySelector(".p-dot")!;
  dot.className = `p-dot ${status}`;

  if (name === focusedAgent) {
    stageAgentDot.className = status === "running" ? "running" : "";
    stageStop.classList.toggle("visible", status === "running");
    if (status === "running") {
      stageSharingBadge.style.display = "inline";
    } else {
      stageSharingBadge.style.display = "none";
    }
  }
}

// ── Focus / stage ─────────────────────────────────────────────

function focusAgent(name: string) {
  const p = participants.get(name);
  if (!p) return;

  // Deactivate previous
  if (focusedAgent) {
    const prev = participants.get(focusedAgent);
    if (prev) prev.el.classList.remove("active");
  }

  focusedAgent = name;
  p.el.classList.add("active");

  // Update stage header
  stageAgentName.textContent = name;
  stageAgentRole.textContent = p.role;
  stageAgentDot.className = p.status === "running" ? "running" : "";
  stageStop.classList.toggle("visible", p.status === "running");
  stageSharingBadge.style.display = p.status === "running" ? "inline" : "none";
  stageInput.placeholder = `Message ${name}...`;

  // Show their messages in stage
  stageContent.innerHTML = "";
  stageEmpty.style.display = "none";
  stageContent.appendChild(p.messages);
  p.messages.style.display = "block";
  stageContent.scrollTop = stageContent.scrollHeight;
}

// Auto-focus: when an agent starts running, focus them (like active speaker)
function autoFocus(name: string) {
  if (!focusedAgent || participants.get(focusedAgent)?.status !== "running") {
    focusAgent(name);
  }
}

// ── Message handling ──────────────────────────────────────────

function appendToAgent(name: string, html: string) {
  const p = participants.get(name);
  if (!p) return;
  const div = document.createElement("div");
  div.innerHTML = html;
  p.messages.appendChild(div);
  attachCopyHandlers(div);
  if (name === focusedAgent) {
    stageContent.scrollTop = stageContent.scrollHeight;
  }
}

function handleAgentMessage(agent: string, msg: any) {
  let p = participants.get(agent);
  if (!p) {
    p = createParticipant(agent, "agent", false);
    api.startAgent(agent);
  }

  switch (msg.type) {
    case "text": {
      if (p.streamingEl) {
        const cursor = p.streamingEl.querySelector(".streaming-cursor");
        if (cursor) cursor.remove();
        p.streamingEl.innerHTML = formatText(msg.fullText || msg.text);
        attachCopyHandlers(p.streamingEl);
      } else {
        const el = document.createElement("div");
        el.className = "msg-text";
        el.innerHTML = formatText(msg.text) + `<span class="streaming-cursor"></span>`;
        p.messages.appendChild(el);
        p.streamingEl = el;
      }
      if (agent === focusedAgent) stageContent.scrollTop = stageContent.scrollHeight;
      break;
    }

    case "text_done": {
      if (p.streamingEl) {
        const cursor = p.streamingEl.querySelector(".streaming-cursor");
        if (cursor) cursor.remove();
        p.streamingEl = null;
      }
      break;
    }

    case "tool_use": {
      if (!p.activeTimeline) {
        const tl = document.createElement("div");
        tl.className = "tool-timeline";
        p.messages.appendChild(tl);
        p.activeTimeline = tl;
      }
      const block = document.createElement("div");
      block.className = "tool-block active";
      const subtitle = msg.input?.command || msg.input?.file_path || msg.input?.query || "";
      block.innerHTML = `
        <div class="tool-header">
          <span class="tool-dot"></span>
          <span class="tool-name">${toolDisplayName(msg.name)}</span>
          <span class="tool-subtitle">${subtitle.toString().slice(0, 60)}</span>
        </div>
      `;
      p.activeTimeline.appendChild(block);
      p.activeTools.set(msg.id, block);
      if (agent === focusedAgent) stageContent.scrollTop = stageContent.scrollHeight;
      break;
    }

    case "tool_result": {
      const block = p.activeTools.get(msg.id);
      if (block) {
        block.classList.remove("active");
        p.activeTools.delete(msg.id);
      }
      if (p.activeTools.size === 0) p.activeTimeline = null;
      break;
    }

    case "error": {
      const el = document.createElement("div");
      el.className = "msg-error";
      el.textContent = msg.message || msg.text || "Error";
      p.messages.appendChild(el);
      if (agent === focusedAgent) stageContent.scrollTop = stageContent.scrollHeight;
      break;
    }

    case "done": {
      if (p.streamingEl) {
        const cursor = p.streamingEl.querySelector(".streaming-cursor");
        if (cursor) cursor.remove();
        p.streamingEl = null;
      }
      p.activeTimeline = null;
      p.activeTools.clear();
      break;
    }

    case "user_message": {
      const el = document.createElement("div");
      el.className = "msg-user";
      el.textContent = msg.text;
      p.messages.appendChild(el);
      if (agent === focusedAgent) stageContent.scrollTop = stageContent.scrollHeight;
      break;
    }
  }
}

// ── Input handling ────────────────────────────────────────────

function sendMessage() {
  const text = stageInput.value.trim();
  if (!text || !focusedAgent) return;
  stageInput.value = "";
  stageInput.style.height = "36px";
  api.sendMessage(focusedAgent, text);

  const p = participants.get(focusedAgent);
  if (p) {
    const el = document.createElement("div");
    el.className = "msg-user";
    el.textContent = text;
    p.messages.appendChild(el);
    stageContent.scrollTop = stageContent.scrollHeight;
  }
}

stageSend.addEventListener("click", sendMessage);
stageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
stageInput.addEventListener("input", () => {
  stageInput.style.height = "36px";
  stageInput.style.height = Math.min(stageInput.scrollHeight, 120) + "px";
});
stageStop.addEventListener("click", () => {
  if (focusedAgent) api.stopAgent(focusedAgent);
});

// ── Add agent modal ───────────────────────────────────────────

addAgentBtn.addEventListener("click", () => {
  modalName.value = "";
  modalRole.value = "";
  modalPrompt.value = "";
  addModal.classList.add("visible");
  modalName.focus();
});
modalCancel.addEventListener("click", () => addModal.classList.remove("visible"));
addModal.addEventListener("click", (e) => { if (e.target === addModal) addModal.classList.remove("visible"); });
modalAdd.addEventListener("click", async () => {
  const name = modalName.value.trim();
  const role = modalRole.value.trim();
  if (!name) return;
  const result = await api.addAgent(name, role, modalPrompt.value.trim() || undefined);
  if (result.ok) {
    addModal.classList.remove("visible");
    createParticipant(name, role || "agent");
    api.startAgent(name);
    focusAgent(name);
  }
});

// ── IPC listeners ─────────────────────────────────────────────

api.onAgentMessage((agent, msg) => handleAgentMessage(agent, msg));

api.onAgentStatus((agent, status) => {
  const s = status as "idle" | "running" | "done" | "error";
  updateParticipantStatus(agent, s);
  if (s === "running") autoFocus(agent);
});

// ── Cypher bar ────────────────────────────────────────────────

function fmtYos(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return String(n);
}

async function refreshCypherBar() {
  if (!api.cypherStatus) return;
  try {
    const s = await api.cypherStatus();
    if (s.associated === true) {
      cypherBarDot.classList.add("live");
      cypherBarTitle.textContent = s.title;
      cypherBarKitty.textContent = `${fmtYos(s.kitty)} yos`;
      cypherBarJammers.textContent = `${s.jammers} jammers`;
    } else {
      cypherBarDot.classList.remove("live");
      cypherBarTitle.textContent = "Local workspace";
      cypherBarKitty.textContent = "";
      cypherBarJammers.textContent = "";
    }
  } catch { /* ignore */ }
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
  const agents = await api.getAgents();
  for (const a of agents) {
    createParticipant(a.name, a.role || "agent");
  }
  if (agents.length > 0) {
    focusAgent(agents[0].name);
  }
  void refreshCypherBar();
  setInterval(() => void refreshCypherBar(), 10000);
}

init();
