/**
 * Renderer dispatch — `kind -> PartRenderer` lookup. Mirrors VS Code's
 * content-part renderer registry: the turn-list walks a turn's parts and asks
 * the dispatcher for the renderer that owns each kind.
 */

import type { ContentPart, PartKind, PartRenderer } from "./types.js";
import { textRenderer } from "./content-parts/text.js";
import { thinkingRenderer } from "./content-parts/thinking.js";
import { toolRenderer } from "./content-parts/tool-invocation.js";
import { progressRenderer } from "./content-parts/progress.js";

const REGISTRY: Record<PartKind, PartRenderer<ContentPart>> = {
  thinking: thinkingRenderer as PartRenderer<ContentPart>,
  text: textRenderer as PartRenderer<ContentPart>,
  tool: toolRenderer as PartRenderer<ContentPart>,
  progress: progressRenderer as PartRenderer<ContentPart>,
};

export function rendererFor(kind: PartKind): PartRenderer<ContentPart> {
  return REGISTRY[kind];
}
