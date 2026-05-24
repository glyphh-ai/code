// prompt-renderer.ts — the mini agent chat that lives in the caret-anchored prompt
// window. Plain DOM, dependency-free. On load it renders the user's dot-command
// query, auto-sends it, streams the reply into an assistant bubble, enables Insert
// on done, supports follow-ups (Enter), and resizes the window to fit.
interface YoPrompt {
  send(text: string): void;
  insert(text: string): void;
  dismiss(): void;
  resize(h: number): void;
  onInit(cb: (init: { trigger: string; query: string; app: string }) => void): void;
  onToken(cb: (delta: string) => void): void;
  onTool(cb: (info: { name: string }) => void): void;
  onDone(cb: (full: string) => void): void;
  onError(cb: (err: string) => void): void;
}
declare global {
  interface Window { yoprompt: YoPrompt }
}

const yoprompt = window.yoprompt;

const transcript = document.getElementById("transcript") as HTMLDivElement;
const input = document.getElementById("input") as HTMLInputElement;
const insertBtn = document.getElementById("insert") as HTMLButtonElement;
const triggerEl = document.getElementById("trigger") as HTMLSpanElement;

let currentAssistant: HTMLDivElement | null = null;
let lastAssistantText = "";
let streaming = false;

function fit(): void {
  // Let the window grow to fit content (capped at 600 in the main process).
  yoprompt.resize(document.body.scrollHeight);
}

function addBubble(cls: "user" | "assistant" | "tool", text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `bubble ${cls}`;
  el.textContent = text;
  transcript.appendChild(el);
  transcript.scrollTop = transcript.scrollHeight;
  fit();
  return el;
}

function startAssistant(): void {
  currentAssistant = addBubble("assistant", "");
  lastAssistantText = "";
  streaming = true;
  insertBtn.disabled = true;
}

function submit(text: string): void {
  const t = text.trim();
  if (!t || streaming) return;
  addBubble("user", t);
  startAssistant();
  yoprompt.send(t);
  input.value = "";
}

// Streaming callbacks.
yoprompt.onToken((delta) => {
  if (!currentAssistant) startAssistant();
  lastAssistantText += delta;
  currentAssistant!.textContent = lastAssistantText;
  transcript.scrollTop = transcript.scrollHeight;
  fit();
});

yoprompt.onTool((info) => {
  addBubble("tool", `· ${info.name}`);
});

yoprompt.onDone((full) => {
  streaming = false;
  if (full && currentAssistant) {
    lastAssistantText = full;
    currentAssistant.textContent = full;
  }
  currentAssistant = null;
  insertBtn.disabled = lastAssistantText.trim().length === 0;
  fit();
  input.focus();
});

yoprompt.onError((err) => {
  streaming = false;
  addBubble("tool", `error: ${err}`);
  currentAssistant = null;
  insertBtn.disabled = lastAssistantText.trim().length === 0;
  fit();
});

// Init: render the query and auto-send it.
yoprompt.onInit((init) => {
  triggerEl.textContent = init.trigger || ".yo";
  const q = (init.query || "").trim();
  if (q) {
    addBubble("user", q);
    startAssistant();
    yoprompt.send(q);
  } else {
    // No query yet — just wait for the user to type.
    input.focus();
  }
  fit();
});

// Follow-ups via Enter.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit(input.value);
  }
});

// Insert pastes the latest assistant text back into the origin field.
insertBtn.addEventListener("click", () => {
  if (lastAssistantText.trim()) yoprompt.insert(lastAssistantText);
});

// Esc closes; blur of the whole window closes too.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    yoprompt.dismiss();
  }
});
window.addEventListener("blur", () => {
  // Window lost focus (user clicked elsewhere) — dismiss.
  yoprompt.dismiss();
});

input.focus();
fit();
