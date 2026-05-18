# Local Swarm — cyphers, localized

**Status:** planned · branch `local-agents`
**Goal:** keep the multi-agent machinery, drop the distributed/remote half.
A "cypher" becomes a **local swarm**: the yo agent spins up N agents from the
Agents tab, a "draft" skill sets up the hierarchy, and they work together over
an in-process bus — all on one machine, no server, no SSE, no Drop.

This supersedes the abandoned "delete all cypher" pass. The insight: the swarm,
the bus, the hierarchy, the draft, and the view are all worth keeping — only
the *remote* layer (server, SSE transport, The Drop, lobbies, matchmaking,
marketplace, remote jammers) is the weight a solo dev can't carry.

---

## Target experience

> "yo, create a 10-agent swarm to ship feature X"

The yo agent: pulls fitting agents from the **Agents tab** (the library) →
delegates the **draft skill** to compose a hierarchy (leader + workers) →
spawns them locally via `AgentRunner` (each on its chosen agent loop) → they
coordinate over the **local bus** → the **swarm view** panel shows the chatter.

Blocking ("wait for the swarm") and non-blocking ("kick it off") are both just
how the yo agent is prompted.

---

## Keep / localize / remove

**REMOVE — the remote layer:**
- yo-server `/api/cyphers/*` — done (`94a1c71`).
- `cypher-runtime.ts` — the SSE transport + remote prompt dispatch.
- The whole **Drop**: `drop.ts/.html`, `drop-preload`, `drop-pickers`,
  `drop-gh-landing`, `drop-auth`, `drop-api`, `drop-ipc`, `help/cyphers`.
- `cypher-crud-ipc.ts` — server-side cypher CRUD.
- The server-coupled parts of `cypher-session.ts` (manifest fetch, work
  packages, invites, repo clone, remote jammer spawn).

**KEEP & LOCALIZE:**
- `cypher-bus.ts` → in-process pub/sub. Strip the SSE bridge; keep
  `register` / `dispatchBroadcast` / `dispatchInbound`. `AgentRunner` already
  consumes it via `bus.register`.
- `cypher-session.ts` → a local `spawnSwarm`: build agent configs from the
  registry, start them via `AgentRunner`. No server round-trip.
- `cypher-thread-store.ts` — already local; keep.
- The cypher panel (`cypher.ts/.html`, `cypher-cards.ts`, `cypher-viz.ts`) →
  the **swarm view**, fed by the local bus instead of the SSE stream.
- Coordination + hierarchy tools in `mcp-expose` / `workspace-mcp`
  (`post`, `post_to`, `team_status`, `get_hierarchy`, `assign_task`, …) — the
  swarm talks over these, locally.

**KEEP AS-IS:** `agent-runner`, `jammer-backends/` (agent loops), the agent
registry, provider keys, the yo agent, council.

---

## Phases

### Phase A — remove the remote layer
Delete the Drop + `cypher-runtime` + `cypher-crud-ipc` + `drop-auth/api/ipc`.
Surgically cut their wiring from `main.ts`. Drop `build:drop` from package.json.

### Phase B — localize the bus
`cypher-bus.ts`: remove the SSE/server bridge; it becomes a pure in-process
event bus. No `postCypherEvent`, no subscriptions.

### Phase C — localize spawn
`cypher-session.ts` → `spawnSwarm(goal, agents[])`: build `AgentConfig`s from
the registry and start them on `AgentRunner`. Hierarchy comes from the draft
skill, not a server matchmaker.

### Phase D — localize the swarm view
Rewire the cypher panel from `onCypherEvent`/SSE to the local bus. Keep the
3-column layout (de-risk); it's the "see the bus chatter" surface.

### Phase E — yo-agent swarm tool + draft skill
A `create_swarm` tool the yo agent calls. A bundled **draft skill** that
composes the hierarchy from a goal + an agent roster.

### Phase F — boot to the default app
App no longer opens into The Drop; loads the default app (already wired —
just remove the `cyphersOn → drop` branch in `restorePanels`).

### Phase G — Agents tab
Port the "My Jammers" page to an **Agents** tab in the left rail, registered
the same way Layouts is — a persistent side-menu entry, not a Drop sub-view.
Rename only: same agent registry (`agent-store-db`), same search / pagination /
table+card views. This is the library the swarm tool (Phase E) pulls from.
"Jammer" survives only as the word for an agent currently in a swarm.

---

## Open choices

- **Naming.** Rename `cypher*` → `swarm*` everywhere, or keep the internal
  names and only say "swarm" in the UI? Renaming is cleaner but churny;
  keeping internal names de-risks. (Leaning: keep internal names for now.)
- Composes with `JAMMER-BACKENDS.md` — each swarm agent runs on its own loop
  (Claude / Codex / Gemini).
