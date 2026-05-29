/**
 * Tool invocation content part — a collapsible block with a header (status
 * icon, tool name + arg summary, chevron) and a lazily-rendered body (Input /
 * Output code blocks). DOM + collapse behavior modeled on VS Code's
 * `ChatCollapsibleInputOutputContentPart`
 * (docs/_reference/vscode-chat/chatToolInputOutputContentPart.ts).
 */

import type { PartRenderer, ToolPart } from "../types.js";

const ICON_CHECK = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 4 6.5 12 3 8.5"/></svg>`;
const ICON_ERROR = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="9"/><line x1="8" y1="11.5" x2="8" y2="11.5"/></svg>`;
const ICON_SPIN = `<svg class="chat-tool-spin" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2.5 a5.5 5.5 0 1 1 -5.5 5.5" opacity="0.9"/></svg>`;
const CHEVRON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 4 10 8 6 12"/></svg>`;

/** One-line argument summary for the header (path, command, url, …). */
function summarize(input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = o.file_path ?? o.path ?? o.command ?? o.url ?? o.pattern ?? o.query ?? o.prompt;
  if (typeof pick === "string") return pick.length > 80 ? pick.slice(0, 80) + "…" : pick;
  return "";
}

function codeBlock(text: string): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);
  return pre;
}

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function applyStatus(node: HTMLElement, part: ToolPart): void {
  const widget = node.querySelector(".chat-confirmation-widget") as HTMLElement;
  const icon = node.querySelector(".chat-tool-status-icon") as HTMLElement;
  widget.classList.toggle("tool-error", part.status === "error");
  widget.classList.toggle("tool-running", part.status === "running");
  widget.classList.toggle("tool-done", part.status === "done");
  if (part.status === "error") icon.innerHTML = ICON_ERROR;
  else if (part.status === "done") icon.innerHTML = ICON_CHECK;
  else icon.innerHTML = ICON_SPIN;

  const sub = node.querySelector(".chat-tool-subtitle") as HTMLElement | null;
  if (sub) sub.textContent = part.progress || summarize(part.input);
}

/** Build (once) the lazily-rendered Input/Output body. */
function ensureBody(node: HTMLElement, part: ToolPart): void {
  const widget = node.querySelector(".chat-confirmation-widget") as HTMLElement;
  if (widget.querySelector(".chat-confirmation-widget-message")) {
    // refresh output if it arrived after first expand
    const outWrap = widget.querySelector(".chat-tool-output") as HTMLElement | null;
    if (outWrap && part.output != null && !outWrap.dataset.filled) {
      outWrap.dataset.filled = "1";
      outWrap.style.display = "";
      outWrap.querySelector("pre")?.remove();
      outWrap.appendChild(codeBlock(part.output));
    }
    return;
  }
  const message = document.createElement("div");
  message.className = "chat-confirmation-widget-message";

  const inTitle = document.createElement("h3");
  inTitle.textContent = "Input";
  message.appendChild(inTitle);
  message.appendChild(codeBlock(inputText(part.input)));

  const outWrap = document.createElement("div");
  outWrap.className = "chat-tool-output";
  const outTitle = document.createElement("h3");
  outTitle.textContent = "Output";
  outWrap.appendChild(outTitle);
  if (part.output != null) {
    outWrap.dataset.filled = "1";
    outWrap.appendChild(codeBlock(part.output));
  } else {
    outWrap.style.display = "none";
  }
  message.appendChild(outWrap);

  widget.appendChild(message);
}

export const toolRenderer: PartRenderer<ToolPart> = {
  kind: "tool",

  hydrate(part: ToolPart): HTMLElement {
    const container = document.createElement("div");
    container.className = "chat-confirmation-widget-container chat-tool-invocation";
    container.dataset.toolId = part.id;

    const widget = document.createElement("div");
    widget.className = "chat-confirmation-widget collapsed";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-confirmation-widget-title monaco-text-button";

    const icon = document.createElement("span");
    icon.className = "chat-tool-status-icon";

    const inner = document.createElement("span");
    inner.className = "chat-confirmation-widget-title-inner";
    const name = document.createElement("span");
    name.className = "chat-tool-name";
    name.textContent = part.name;
    const subtitle = document.createElement("span");
    subtitle.className = "chat-tool-subtitle";
    subtitle.textContent = summarize(part.input);
    inner.appendChild(name);
    inner.appendChild(subtitle);

    const chevron = document.createElement("span");
    chevron.className = "chat-collapsible-hover-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = CHEVRON;

    btn.appendChild(icon);
    btn.appendChild(inner);
    btn.appendChild(chevron);
    widget.appendChild(btn);
    container.appendChild(widget);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const collapsed = widget.classList.toggle("collapsed");
      if (!collapsed) ensureBody(container, part);
    });

    applyStatus(container, part);
    return container;
  },

  update(part: ToolPart, node: HTMLElement): void {
    applyStatus(node, part);
    const widget = node.querySelector(".chat-confirmation-widget") as HTMLElement;
    if (!widget.classList.contains("collapsed")) ensureBody(node, part);
  },
};
