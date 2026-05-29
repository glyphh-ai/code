/**
 * Chat-renderer content-part model.
 *
 * A turn is a sequence of content parts. Each part has a discriminated `kind`
 * plus part-specific data, and may mutate as the stream advances (token deltas
 * appended to text, output attached to a running tool, …). One renderer per
 * kind owns the DOM lifecycle for that part.
 *
 * Modeled on VS Code's chat renderer (docs/_reference/vscode-chat). Same
 * architecture and content-part model, re-implemented free of VS Code's
 * service dependencies.
 */

export type PartKind = "thinking" | "text" | "tool" | "progress";

export interface ThinkingPart {
  kind: "thinking";
}

export interface TextPart {
  kind: "text";
  /** Raw markdown accumulated so far. Re-rendered incrementally as it grows. */
  text: string;
}

export type ToolStatus = "running" | "done" | "error";

export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  /** Result detail text, attached when the tool finishes. */
  output?: string;
  status: ToolStatus;
  /** Transient progress label while running (e.g. a step description). */
  progress?: string;
}

export interface ProgressPart {
  kind: "progress";
  text: string;
}

export type ContentPart = ThinkingPart | TextPart | ToolPart | ProgressPart;

/** A live part: its data plus the DOM node the renderer produced for it. */
export interface LivePart<T extends ContentPart = ContentPart> {
  part: T;
  node: HTMLElement;
}

/**
 * One renderer per part kind. `hydrate` builds the DOM node; `update`
 * re-renders it in place when the part data mutates; `dispose` releases any
 * resources (timers, listeners) the node holds.
 */
export interface PartRenderer<T extends ContentPart> {
  readonly kind: T["kind"];
  hydrate(part: T): HTMLElement;
  update(part: T, node: HTMLElement): void;
  dispose?(node: HTMLElement): void;
}

export type TurnRole = "user" | "assistant";

export interface Turn {
  role: TurnRole;
  /** `.interactive-item-container` */
  container: HTMLElement;
  /** `.value` — holds the rendered content parts. */
  value: HTMLElement;
  parts: LivePart[];
}
