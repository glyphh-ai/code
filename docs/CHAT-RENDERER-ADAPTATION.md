# Chat Renderer Adaptation — From VS Code to .Yo

## Goal

Replace the yo panel's ad-hoc rendering with an architecture modeled after VS
Code's chat renderer. Match the look-and-feel that Claude Code has when running
inside VS Code, without paying the cost of VS Code's framework dependencies.

## Why "design lift" and not "verbatim port"

VS Code's chat renderer is well-architected, but it's deeply tied to VS Code's
contribution system. A few honest data points:

- `chatListRenderer.ts` alone is ~160KB / 4000 lines.
- The rendering pipeline imports 30+ VS Code services (instantiation,
  configuration, theming, telemetry, layout, accessibility, instantiation,
  list virtualization, monaco-editor, markdown-renderer, theming, etc).
- The list widget (`chatListWidget.ts`) is responsible for scroll performance
  on long conversations via list virtualization — there is no good "stub" for
  this.
- There are 50+ content-part files under
  `widget/chatContentParts/` and `widget/chatContentParts/toolInvocationParts/`.

Lifting that surface verbatim means weeks of stubbing services that will then
drift away from upstream every time Microsoft updates the renderer. Stubs
accumulate bugs faster than we port new features. The renderer never actually
ships.

**The pragmatic path is to lift the design, not the framework.** Same
architecture, same content-part model, same incremental markdown rendering,
identical CSS — but re-implemented in our codebase, free of VS Code service
deps. About 1/10th the code, ships incrementally, and the visual + behavioral
match remains tight because the bits that the user actually sees (CSS, DOM
structure, render lifecycle) are copied 1:1 where they have no dependencies.

## Architecture

Three layers, mirroring VS Code's structure:

1. **Model** — a turn is a sequence of *content parts*. Each part has a
   discriminated `kind` (`text`, `thinking`, `tool-invocation`, `progress`,
   `markdown`, …) plus part-specific data. Parts can mutate as the stream
   advances (token deltas appended to text, tool result attached to a running
   tool invocation, etc).
2. **Renderer dispatch** — one renderer per part kind. The dispatcher gets a
   part, returns/updates a DOM node, owns the lifecycle (`hydrate`, `update`,
   `dispose`).
3. **Incremental markdown** — re-render-on-token machinery for streaming text.
   Mirrors VS Code's `chatContentMarkdownRenderer.ts` approach: parse the
   in-progress markdown, diff against last-rendered, swap only what changed.

CSS + DOM structure copied verbatim from VS Code where they have no
dependencies. TypeScript re-implemented for our codebase.

## VS Code reference files

Copies of the relevant VS Code chat-renderer files live under
`docs/_reference/vscode-chat/` for ongoing reference during the port. They are
**not** built — the path is excluded from the renderer tsconfig. Each file
retains its original Microsoft copyright header.

Inventory (fetched 2026-05-29 from `microsoft/vscode` main):

| File | Size | Purpose |
| ---- | ---- | ------- |
| `chatListRenderer.ts` | 161 KB | Turn-level orchestration. The dispatcher that walks a turn's parts and picks renderers. |
| `chatContentMarkdownRenderer.ts` | 6 KB | Incremental markdown renderer used by text-bearing parts. |
| `chatContentParts/chatContentParts.ts` | 4 KB | Base `IChatContentPart` interface. |
| `chatContentParts/chatMarkdownContentPart.ts` | 40 KB | Markdown content part — assistant text bubbles, code blocks. |
| `chatContentParts/chatThinkingContentPart.ts` | 88 KB | "Thinking…" indicator + extended-thinking blocks (the most feature-rich; useful for the look). |
| `chatContentParts/chatProgressContentPart.ts` | 14 KB | Progress lines (one-shot step descriptions). |
| `chatContentParts/chatTaskContentPart.ts` | 3 KB | Task progress shell. |
| `chatContentParts/chatToolInputOutputContentPart.ts` | 10 KB | Tool input/output collapsible block. |
| `chatContentParts/toolInvocationParts/chatToolInvocationPart.ts` | 15 KB | Tool invocation top-level part. |
| `chatContentParts/toolInvocationParts/chatToolInvocationSubPart.ts` | 2 KB | Sub-part base for tool invocation children. |
| `chatContentParts/toolInvocationParts/chatToolProgressPart.ts` | 7 KB | Tool-running progress part. |
| `chatContentParts/toolInvocationParts/chatToolOutputPart.ts` | 7 KB | Tool output rendering. |
| `chatContentParts/toolInvocationParts/chatSimpleToolProgressPart.ts` | 5 KB | Single-line tool progress (simple cases). |
| `media/chat.css` | 114 KB | All chat CSS. Will be lifted in phase 5, namespaced under `.yo-chat`. |

Total snapshot size: ~470 KB across 14 files.

## Implementation phases

### Phase 1 — Skeleton

Goal: token streaming + Thinking… indicator running through the new renderer.

Files under `src/renderer/chat-renderer/`:

- `types.ts` — `ContentPart` discriminated union, base `PartRenderer<T>`
  interface, `Turn` type.
- `turn-list.ts` — owns the per-turn DOM container, the parts array, and the
  render loop.
- `dispatch.ts` — `kind → renderer` lookup.
- `content-parts/text.ts` — text-only part (no markdown yet). Streams tokens
  into a single div via `textContent +=`.
- `content-parts/thinking.ts` — "Thinking…" indicator. Auto-disappears on
  first text token or tool call.

Wire into yo panel: `onYoPanelKickoff` → push `thinking` part. `onYoPanelToken`
→ append to `text` part (creating one if needed). `onYoPanelDone` → finalize
turn.

### Phase 2 — Tool invocations

Goal: tool calls render as collapsible blocks matching VS Code.

Files:

- `content-parts/tool-invocation.ts` — collapsible block with header (tool
  name, summary args, status icon) and body (input/output). Mirrors
  `chatToolInputOutputContentPart.ts`.
- Per-tool icons + status pill (running / done / error).

Wire: `tool_use` block → push `tool-invocation` part with status `running`.
`tool_result` → update same part with output + status `done`.

### Phase 3 — Markdown rendering

Goal: code blocks, lists, headings, anchors render correctly.

Files:

- `markdown-renderer.ts` — replaces the current `formatMarkdown` helper for
  text parts. Mirrors `chatContentMarkdownRenderer.ts`: incremental parse,
  diff against last render, swap nodes.
- Upgrade `content-parts/text.ts` to use the renderer.

### Phase 4 — Progress + status

Goal: persistent "still working" indicator pinned at the bottom; per-step
progress lines from the agent.

Files:

- `content-parts/progress.ts` — short progress lines (one per step).
- `status-spinner.ts` — pinned bottom spinner (already partly in
  yo-panel-ui).

### Phase 5 — CSS verbatim

Copy the relevant rules from VS Code's chat media files. Namespace under
`.yo-chat` to avoid collision with existing yo styles. Match colors via the
theme tokens already in our styles.css.

## Cut-over

After phase 4 is green, swap out yo-panel-ui's rendering subscriptions
(`onYoPanelToken`, `onYoPanelToolUse`, `onYoPanelToolResult`, etc) to push
parts into the new renderer instead of doing inline DOM work. Keep input
handling, perm/model dropdowns, welcome screen, etc in yo-panel-ui — only the
message-rendering layer is replaced.

## License

VS Code is MIT-licensed. All copied/adapted files retain the original
Microsoft copyright header. Files we write from scratch carry no copyright
notice (matching the rest of the yo-client repo).

## Out of scope (for now)

- List virtualization (`chatListWidget.ts`). Long conversations can lag; we
  re-evaluate when it actually hurts.
- Linked resources from thinking blocks
  (`chatThinkingExternalResourcesWidget.ts`).
- Multi-diff / workspace edit content parts — not relevant until we model
  agent-driven file edits.
