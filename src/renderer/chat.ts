/**
 * Chat — yo's AI chat panel for cross-app automation.
 */

const chatPanel = document.getElementById("chat-panel")!;
const chatMessages = document.getElementById("chat-messages")!;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const chatSendBtn = document.getElementById("chat-send-btn")!;
const chatClearBtn = document.getElementById("chat-clear-btn")!;

let visible = false;
let currentMsg: HTMLElement | null = null;
let sending = false;

export function showChat() {
  chatPanel.classList.remove("hidden");
  visible = true;
  chatInput.focus();
}

export function hideChat() {
  chatPanel.classList.add("hidden");
  visible = false;
}

export function isChatVisible() {
  return visible;
}

export function initChat() {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  chatSendBtn.addEventListener("click", send);
  chatClearBtn.addEventListener("click", () => {
    chatMessages.innerHTML = "";
    window.yo.chatClear();
  });

  // Auto-resize textarea
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  // Streaming events
  window.yo.onChatDelta((delta: string) => {
    if (currentMsg) {
      currentMsg.textContent += delta;
      scroll();
    }
  });

  window.yo.onChatToolUse((data: { name: string; input: unknown }) => {
    const el = document.createElement("div");
    el.className = "chat-tool";
    const label = data.input && typeof data.input === "object" && "app" in (data.input as any)
      ? `${data.name} → ${(data.input as any).app}`
      : data.name;
    el.textContent = label;
    chatMessages.appendChild(el);
    scroll();
  });

  window.yo.onChatDone(() => {
    currentMsg = null;
    sending = false;
    chatInput.disabled = false;
    chatSendBtn.textContent = "Send";
    chatInput.focus();
  });

  window.yo.onShowChat(() => showChat());
}

function send() {
  if (sending) return;
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  sending = true;
  chatInput.disabled = true;
  chatSendBtn.textContent = "···";

  // User bubble
  const user = document.createElement("div");
  user.className = "chat-msg chat-user";
  user.textContent = text;
  chatMessages.appendChild(user);

  // Start assistant bubble
  currentMsg = document.createElement("div");
  currentMsg.className = "chat-msg chat-assistant";
  chatMessages.appendChild(currentMsg);
  scroll();

  window.yo.chatSend(text);
}

function scroll() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
