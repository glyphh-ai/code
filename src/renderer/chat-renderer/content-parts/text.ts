/**
 * Text content part — assistant prose. Streaming tokens accumulate into
 * `part.text` and re-render incrementally into a `.rendered-markdown` node,
 * mirroring VS Code's markdown content part.
 */

import type { PartRenderer, TextPart } from "../types.js";
import { renderMarkdown } from "../markdown.js";

export const textRenderer: PartRenderer<TextPart> = {
  kind: "text",

  hydrate(part: TextPart): HTMLElement {
    return renderMarkdown(part.text);
  },

  update(part: TextPart, node: HTMLElement): void {
    renderMarkdown(part.text, node);
  },
};
