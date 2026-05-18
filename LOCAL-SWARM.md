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

### Phases C + E — the local swarm engine (one unit)

C and E are bound: a localized `spawnSwarm` needs a *local* manifest, and the
thing that produces it is the draft. Build them together.

**The local manifest** (replaces the server-fetched cypher manifest):

```ts
interface SwarmManifest {
  id: string;              // local swarm id (uuid)
  title: string;
  goal: string;
  workspace: string;       // .yo workspace slug — agents share this cwd
  agents: SwarmAssignment[];
}
interface SwarmAssignment {
  agentId: string;         // registry agent id
  position: string;        // "leader" | "worker"
  area?: string;
  contract?: string;
  parentAgentId?: string | null;
  reports?: string[];
}
```

**Phase C — `spawnSwarm`** (`cypher-session.ts` → `swarm-session.ts`):
`spawnSwarm(manifest: SwarmManifest, wc: WebContents)` —
- build hierarchy context from `manifest.agents` → set on `McpExpose` + the bus;
- per agent: `getAgent(agentId)` from the registry → build a `RunnerAgentConfig`
  (cwd in the shared working dir, systemPrompt from registry + hierarchy,
  model/provider/guardrails from registry, `mcpServers` → the local
  yo-workspace MCP) → start;
- leaders start immediately, workers deferred on `assign_task` (keep that logic);
- **no server** — drop the manifest fetch, draft POST, projects, gh-token,
  work-packages, repo-clone.

When the Codex/Gemini backends land, the Agents-tab model dropdown stops
using a hardcoded list and instead **queries each agent-loop CLI** for its
supported models — the CLIs are the source of truth, so the list never rots.

**Phase E — draft skill + `create_swarm` tool:**
- a bundled **draft skill**: input = goal + candidate agent roster; output = a
  `SwarmManifest` (assigns leader + workers, areas). The yo agent delegates to it.
- a **`create_swarm` tool**: `create_swarm(goal, agentIds[]|count)` → run the
  draft skill → `spawnSwarm(manifest)` → open the swarm-view panel.

### Phase D — localize the swarm view
The feed is already re-sourced (Phase B kept the `jammer-activity` IPC
contract). Remaining is the layout simplification:
- Drop the files view + the files section from the cypher panel — files
  already live in the app's left rail.
- Layout: agent cards on the left (with the activity popups); feed top-right;
  agent panel bottom-right.
- Drop per-agent messaging — keep only **Start all** / **Stop all**.

### Phase F — boot to the default app
App no longer opens into The Drop; loads the default app (already wired —
just remove the `cyphersOn → drop` branch in `restorePanels`).

### Phase G — Agents tab
Port the "My Jammers" page to an **Agents** tab in the left rail, registered
the same way Layouts is — a persistent side-menu entry, not a Drop sub-view.
Rename only: same agent registry (`agent-store-db`), same search / pagination /
table+card views. This is the library the swarm tool (Phase E) pulls from.
"Jammer" survives only as the word for an agent currently in a swarm.

### Phase H — cull the in-house editor
A home-grown editor is redundant with the VS Code integration and a
maintenance sink. Remove:
- **.Yo Editor** (`yo://files`) — `files.ts`, `files-preload.ts`, `files.html`,
  `build:files`, the app-connector entry, panel wiring.
- **The files left-rail** — the file tree + add-file / add-folder.

Keep **Monaco** (`yo://monaco`) and **VS Code** (`yo://vscode`).

Left-rail restructure: a **compact working-folder picker** stays pinned at the
top (shows + sets the folder — the swarm's `cwd`); the menu items move up
under it; platform + logout stay at the bottom.

---

## Open choices

- **Naming.** Rename `cypher*` → `swarm*` everywhere, or keep the internal
  names and only say "swarm" in the UI? Renaming is cleaner but churny;
  keeping internal names de-risks. (Leaning: keep internal names for now.)
- Composes with `JAMMER-BACKENDS.md` — each swarm agent runs on its own loop
  (Claude / Codex / Gemini).
