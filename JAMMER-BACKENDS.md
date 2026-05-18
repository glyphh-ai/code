# Jammer Backends — running jammers on agent loops other than Claude

**Status:** in progress · branch `jammer-backends`
**Goal:** let a jammer run on an agent loop other than Claude Code — per-jammer,
so one cypher can mix a Claude jammer, a Codex jammer, and a Gemini jammer.

---

## The decision: external agentic CLIs

A jammer is not a raw API call — it's an *agent loop* (tool-calling, multi-turn,
MCP). Claude jammers run on the Claude Agent SDK, which spawns the `claude`
binary. The chosen approach extends that exact pattern:

- **OpenAI → Codex CLI**, **Google → Gemini CLI** — spawn the vendor's agentic
  CLI, same as Claude Code is spawned today.
- Rejected: a hand-built native tool-loop on the BYOK adapters. It would mean
  reimplementing three vendors' agent runtimes (tool loop, streaming, context
  management, sandboxing, retries, session resume) for a strictly worse,
  self-owned result.

Why this works cleanly here:

- The `yo-workspace` MCP server (`mcp-expose.ts`) is plain HTTP — every
  MCP-capable CLI connects to it with zero new code.
- Codex and Gemini CLIs ship built-in file/shell tools — no tool sandbox to
  rebuild.
- BYOK keys for openai/google are already stored (`provider-keys.ts`); we feed
  them as `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars to the spawned CLI, so
  there is **no separate OAuth login**.
- The CLIs are bundled as npm deps (like `@anthropic-ai/claude-agent-sdk`) —
  zero install friction for the user.

The one gap — xAI/Perplexity have no good agentic CLI — is deferred; nobody
needs jammers on those yet.

---

## Architecture: the `JammerBackend` seam

`AgentRunner` owns everything provider-agnostic. A `JammerBackend` owns exactly
one provider's agent loop and normalizes its output into `JammerEvent`s.

```
AgentRunner  ──selectBackend(config)──▶  JammerBackend
  lifecycle, queueing, guardrails,         init() · preflight()
  idle timers, bus posting, persistence    runTurn() ──▶ AsyncGenerator<JammerEvent>
  ◀── JammerEvent stream ──────────────    abort()
```

- `src/main/jammer-backends/types.ts` — `JammerBackend` interface, the
  `JammerEvent` union (the *only* shape `AgentRunner` consumes), `AgentConfig`.
- `src/main/jammer-backends/claude-backend.ts` — `ClaudeBackend`.
- `src/main/jammer-backends/codex-backend.ts` — `CodexBackend` *(Phase 2)*.
- `src/main/jammer-backends/gemini-backend.ts` — `GeminiBackend` *(Phase 3)*.
- `src/main/jammer-backends/index.ts` — `selectBackend(config)`.

`JammerEvent` kinds: `init` · `assistant` (ordered text/tool_use blocks) ·
`partial_text` · `tool_start` · `tool_progress` · `result` · `status` · `state`.

Per-jammer provider is already modeled: every agent record carries
`model_provider` + `model_name` (`agent-store-db.ts`).

---

## Phases

### Phase 0 — backend abstraction ✅ done (`9783fb5`)
Pure refactor, zero behavior change. Extracted `JammerBackend` + `JammerEvent`;
the original Claude loop became `ClaudeBackend`; `AgentRunner` rewritten to be
provider-agnostic and drive turns through `backend.runTurn()`.

### Phase 1 — per-jammer provider routing ⏳ in progress
- `buildJammerConfig` (cypher-session) and `buildAgentConfig` (main) pass the
  registry's `model_provider` through as `AgentConfig.modelProvider`.
- `selectBackend` branches on `modelProvider`; unknown/unbuilt providers fall
  back to Claude with a warning until their backend lands.

### Phase 2 — CodexBackend
Spawn `codex exec --json` in the cypher sandbox cwd, auto-approve, MCP config →
`yo-workspace`, `OPENAI_API_KEY` from BYOK. Parse Codex's JSON event stream →
`JammerEvent`s. Session resume.

### Phase 3 — GeminiBackend
Same for `gemini --yolo --output-format json`, MCP via `.gemini/settings.json`,
`GEMINI_API_KEY` from BYOK.

### Phase 4 — bundle + preflight
Add `@openai/codex` + `@google/gemini-cli` as deps; resolve binaries
ASAR-safely. Each backend's `preflight()` checks its BYOK key; a missing key
surfaces a clear feed message instead of a crash.

### Phase 5 — UI
Provider + model picker per jammer in jammer creation / My Jammers (fields
already persist). Feed/cards show which loop each jammer runs on.

---

## Risks / open items

- **CLI flag drift** across Codex/Gemini versions — pin versions, detect.
- **MCP config injection** per jammer — temp config file vs CLI flags.
- **Usage mapping** — each CLI reports tokens differently; map into the existing
  `input_tokens`/`output_tokens` schema.
- **Session resume** — Codex/Gemini resume semantics differ from Claude's
  `resume: sessionId`; each backend owns its own resume handling.
- xAI/Perplexity jammers — deferred (no good agentic CLI).
