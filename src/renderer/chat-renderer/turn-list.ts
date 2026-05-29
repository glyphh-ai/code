/**
 * Turn list — owns the message container, the per-turn DOM, the parts array,
 * and the render loop. This is the orchestration layer that the yo panel drives
 * via streaming events. Mirrors VS Code's chat list: a turn is an
 * `.interactive-item-container` whose `.value` holds a sequence of content
 * parts; the dispatcher picks a renderer per part kind.
 *
 * The whole subtree lives under a `.yo-chat` root so the lifted VS Code CSS is
 * namespaced and can't collide with existing yo styles.
 */

import type { ContentPart, LivePart, TextPart, ToolPart, Turn, TurnRole } from "./types.js";
import { rendererFor } from "./dispatch.js";
import { StatusSpinner } from "./status-spinner.js";

export class ChatRenderer {
  private turns: Turn[] = [];
  private current: Turn | null = null;
  private readonly spinner: StatusSpinner;

  constructor(private readonly container: HTMLElement) {
    this.container.classList.add("yo-chat");
    this.spinner = new StatusSpinner(container);
  }

  get isEmpty(): boolean {
    return this.container.children.length === 0;
  }

  reset(): void {
    this.spinner.hide();
    this.container.innerHTML = "";
    this.turns = [];
    this.current = null;
  }

  scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }

  // ── User + finalized turns (also used for history replay) ──────────────────

  addUserTurn(text: string): void {
    const turn = this.makeTurn("user");
    // User input is shown verbatim (no markdown), matching the prior bubble.
    turn.value.textContent = text;
    this.scrollToBottom();
  }

  /** A finalized assistant message (history replay). Rendered as markdown. */
  addAssistantTurn(text: string): void {
    const turn = this.makeTurn("assistant");
    if (text) this.pushPart(turn, { kind: "text", text });
    this.scrollToBottom();
  }

  // ── Streaming assistant turn ───────────────────────────────────────────────

  /** Start the active assistant turn (thinking indicator + working spinner).
   *  Idempotent — the send path can signal turn-start from more than one place;
   *  a second call only ensures the spinner is showing. */
  beginAssistantTurn(): void {
    if (this.current) {
      this.spinner.show();
      return;
    }
    this.current = this.makeTurn("assistant");
    // The pinned working spinner ("thinking…/cooking…") is the single
    // pre-output indicator. We deliberately do NOT push an inline "thinking"
    // placeholder part here: having both meant the inline row was removed when
    // the first token landed (jump up) and then text grew (jump down). One
    // bottom-pinned indicator that only grows downward = no vertical thrash.
    this.spinner.show();
    this.scrollToBottom();
  }

  appendText(delta: string): void {
    if (!delta) return;
    const turn = this.ensureCurrent();
    this.removeThinking(turn);
    let live = this.openTextPart(turn);
    if (!live) live = this.pushPart(turn, { kind: "text", text: "" });
    (live.part as TextPart).text += delta;
    rendererFor("text").update(live.part, live.node);
    this.scrollToBottom();
  }

  addTool(id: string, name: string, input: unknown): void {
    const turn = this.ensureCurrent();
    this.removeThinking(turn);
    this.pushPart(turn, { kind: "tool", id, name, input, status: "running" });
    this.scrollToBottom();
  }

  setToolResult(id: string, detail: string): void {
    const live = this.findTool(id);
    if (!live) return;
    const p = live.part as ToolPart;
    p.output = detail;
    if (p.status !== "error") p.status = "done";
    rendererFor("tool").update(p, live.node);
  }

  setToolProgress(id: string, status: string): void {
    const live = this.findTool(id);
    if (!live) return;
    const p = live.part as ToolPart;
    p.progress = status;
    rendererFor("tool").update(p, live.node);
  }

  addProgress(text: string): void {
    const turn = this.ensureCurrent();
    this.removeThinking(turn);
    this.pushPart(turn, { kind: "progress", text });
    this.scrollToBottom();
  }

  endAssistantTurn(): void {
    if (this.current) this.removeThinking(this.current);
    this.spinner.hide();
    this.current = null;
  }

  // ── Working spinner (also driven by the panel's send/stop paths) ───────────

  showWorking(): void {
    this.spinner.show();
  }

  hideWorking(): void {
    this.spinner.hide();
  }

  /** Append a caller-built row (approval card, stop quip, error, run marker)
   *  into the message flow. The pinned spinner floats back to the bottom. */
  appendRaw(el: HTMLElement): void {
    this.container.appendChild(el);
    this.scrollToBottom();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private makeTurn(role: TurnRole): Turn {
    const container = document.createElement("div");
    container.className =
      `interactive-item-container ${role === "user" ? "interactive-request" : "interactive-response"}`;
    const value = document.createElement("div");
    value.className = "value";
    container.appendChild(value);
    const turn: Turn = { role, container, value, parts: [] };
    this.container.appendChild(container);
    this.turns.push(turn);
    return turn;
  }

  private pushPart(turn: Turn, part: ContentPart): LivePart {
    const node = rendererFor(part.kind).hydrate(part);
    const live: LivePart = { part, node };
    turn.value.appendChild(node);
    turn.parts.push(live);
    return live;
  }

  private ensureCurrent(): Turn {
    if (!this.current) this.current = this.makeTurn("assistant");
    return this.current;
  }

  private removeThinking(turn: Turn): void {
    const idx = turn.parts.findIndex((p) => p.part.kind === "thinking");
    if (idx === -1) return;
    turn.parts[idx].node.remove();
    turn.parts.splice(idx, 1);
  }

  /** The text part *currently open for appending* — i.e. the trailing part of
   *  the turn, but only if it's text. Once a tool/progress/thinking part lands
   *  after it, that text part is closed: subsequent text starts a NEW part
   *  below the tool, so streaming text never grows a block that sits above an
   *  already-rendered tool row (which would reorder + jump the view). */
  private openTextPart(turn: Turn): LivePart | undefined {
    const last = turn.parts[turn.parts.length - 1];
    return last && last.part.kind === "text" ? last : undefined;
  }

  private findTool(id: string): LivePart | undefined {
    for (let t = this.turns.length - 1; t >= 0; t--) {
      const live = this.turns[t].parts.find(
        (p) => p.part.kind === "tool" && (p.part as ToolPart).id === id,
      );
      if (live) return live;
    }
    return undefined;
  }
}
