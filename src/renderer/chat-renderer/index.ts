/**
 * Chat renderer — a VS Code-style chat message renderer for the yo panel.
 *
 * Design lifted from VS Code's chat renderer (docs/_reference/vscode-chat) and
 * re-implemented free of VS Code service deps: a content-part model, one
 * renderer per part kind, incremental markdown, and verbatim DOM/CSS structure.
 * See docs/CHAT-RENDERER-ADAPTATION.md.
 */

export { ChatRenderer } from "./turn-list.js";
export type {
  ContentPart,
  TextPart,
  ThinkingPart,
  ToolPart,
  ProgressPart,
  Turn,
} from "./types.js";
