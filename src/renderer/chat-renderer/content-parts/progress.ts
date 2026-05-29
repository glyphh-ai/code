/**
 * Progress content part — a short one-line step description from the agent
 * (one row per step). Modeled on VS Code's progress content part.
 */

import type { PartRenderer, ProgressPart } from "../types.js";

export const progressRenderer: PartRenderer<ProgressPart> = {
  kind: "progress",

  hydrate(part: ProgressPart): HTMLElement {
    const row = document.createElement("div");
    row.className = "progress-step";
    const dot = document.createElement("span");
    dot.className = "progress-step-icon";
    const label = document.createElement("span");
    label.className = "progress-step-label";
    label.textContent = part.text;
    row.appendChild(dot);
    row.appendChild(label);
    return row;
  },

  update(part: ProgressPart, node: HTMLElement): void {
    const label = node.querySelector(".progress-step-label") as HTMLElement | null;
    if (label) label.textContent = part.text;
  },
};
