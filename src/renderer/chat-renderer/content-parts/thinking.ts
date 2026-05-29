/**
 * Thinking indicator — the "Thinking…" shimmer shown at the start of an
 * assistant turn, before the first text token or tool call. Modeled on VS
 * Code's animated-ellipsis / thinking-shimmer treatment.
 *
 * The turn-list removes this part as soon as real content arrives.
 */

import type { PartRenderer, ThinkingPart } from "../types.js";

export const thinkingRenderer: PartRenderer<ThinkingPart> = {
  kind: "thinking",

  hydrate(_part: ThinkingPart): HTMLElement {
    const row = document.createElement("div");
    row.className = "chat-thinking show-detail-progress";
    const label = document.createElement("span");
    label.className = "chat-thinking-label";
    label.textContent = "Thinking";
    const ellipsis = document.createElement("span");
    ellipsis.className = "chat-animated-ellipsis";
    row.appendChild(label);
    row.appendChild(ellipsis);
    return row;
  },

  update(_part: ThinkingPart, _node: HTMLElement): void {
    // static
  },
};
