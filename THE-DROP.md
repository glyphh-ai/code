# The Drop — design + build plan

The Drop is yo-client's gamefied hub for cyphers and agents. Modeled after a
game-server browser (Twitch + Steam vibe): browse live cyphers, see top
agents, manage your roster, drop new cyphers.

It is now the only home for two things that used to live in the Help overlay:
**Agents** and **Cyphers**. Both nav items have been removed from the Help
overlay. The legacy modules (`src/renderer/help/agents.ts`,
`src/renderer/help/cyphers.ts`) are kept on disk as references for the
rebuild — they have no callers.

## Mental model

- **Cypher = hosted server.** Owns goal, kanban, bus, draft state. Lives on
  yo-server. Thin coordination, not a job queue.
- **Agents = players who join.** Run on the joiner's machine with the
  joiner's keys, model, sandbox. They bring their **loadout** — registry
  config, skills, apps, system prompt, avatar, reputation.
- **Compute split:** cypher = thin server-side state; agent = thick local
  LLM + tools. 1000 agents = 1000 joiners' machines; cypher stays light.
- **Fame > money for v1.** Reputation drives participation. Kitty (yos
  payouts) is hidden / deferred. Platform makes money on proxy yos
  consumption — more agents in cyphers = more yos = more revenue.

## Mental model — locked

**.yo = your stack.** Apps connected, skills built, hardware, model,
wallet, identity. What you bring to a cypher.

**Jammer = a named loadout in your .yo.** A bundle of (skills + model +
system prompt + apps + guardrails) curated for a specific kind of work.
Each has its own avatar, bio, joinable flag, and reputation track.
Different jammers perform differently — your UI jammer on Sonnet might
crush while your server jammer on GPT-5.5 gets dunked on; per-jammer
stats are how you tell. (In code we still call this `AgentConfig` /
`agents` table — the rename is UI-only for now.)

**Cypher = a match.** Hosted server you join. Cyphers draft roles
(leader/worker) onto jammers fielded by users. Match runs; jammers earn
reputation; the .yo is the player account that backs them.

**Memory.** Each jammer has its own data store under
`~/.yo/agents/<id>/memory/` that grows from work. Veteran jammers >
rookie jammers even with identical config. Reputation reflects real
capability, not just rank.

## Already shipped (foundation)

- **Identicon avatars + Profile tab** for agents (display_name, avatar_url,
  bio). Mirrored on yo-server (`published_agents` + `agent_profiles`).
- **Performance write-back schema** (migration 022) + service +
  `POST /api/agents/performance` + `GET /api/agents/leaderboard`.
- **The Drop app shell** registered as built-in `yo://drop`. drop.html,
  drop.ts, drop-preload.ts, build:drop esbuild step.
- **Four views** in The Drop:
  - **Browse** — hero (auto-features highest-jammer live cypher),
    live cyphers row, top agents row, your cyphers row, search.
  - **Your Agents** — avatar grid, identicon fallbacks, skill tags,
    joinable chip. Edit overlay (Profile + Behavior tabs).
  - **Lobby** — timer (urgent pulse last 10s), roster, draft section
    (with Re-draft host action), Start/Cancel/Leave actions.
  - **Workspace** — live match view (described below).
- **Help-overlay Cyphers + Agents tabs removed.** Modules left on disk
  as references (`help/cyphers.ts`, `help/agents.ts`) — no callers.
- **Registry-backed cypher participants** — `cw:get-agents` and
  `buildAgentConfig` now read from the SQLite agent registry instead of
  the legacy per-workspace `agents.json`.

## Build order

### 1. Agents in The Drop ✅ shipped (v1)

- **Phase 1 done** — slug + name + role + system prompt + avatar +
  bio + joinable + model selector. Full CRUD via overlay.
- **Phase 2 deferred** — Apps + Skills + Guardrails + Remote tabs.
  Add as additional tabs in the same overlay later. Not blocking
  cypher work.

### 2. Cyphers in The Drop (creation + lobby) — partially shipped

**Server-side state machine ✅**
- Migration `023_cypher_lobby.sql` — adds `lobby` to status check,
  `lobby_started_at` + `lobby_duration_seconds` columns.
- `CypherStatus` extended: `draft | lobby | live | wrapped | cancelled`.
- `publishCypher(...)` now flips draft → **lobby** (not live), accepts
  optional `lobbyDurationSeconds`. Default deposit 0 (kitty hidden).
- New `startCypher(ownerUserId, cypherId)` flips lobby → live.
- New route `POST /api/cyphers/:id/start`. Existing
  `POST /api/cyphers/:id/publish` accepts `lobby_duration_seconds`.

**Client wizard ✅** — "+ Drop a Cypher" opens a 3-step overlay:
- Step 1: title, goal, vibe (open/coop/bounty/sponsored chips),
  visibility (public/unlisted/invite chips), max jammers.
- Step 2: Seed Roster — multi-select your agents (live list, seed cards
  toggle on click).
- Step 3: Lobby duration (1m / 5m / 15m / 1h / Open until I start).
- "Drop it" → `cypherCreate` → `cypherJoin` per seeded agent →
  `cypherPublish` (lobby_duration_seconds wired through). On success
  drops the user straight into the Lobby view.

**Lobby view ✅** (third view in The Drop)
- Hero: title + goal + status pill + jammer count.
- Countdown timer panel — large mono clock, pulses urgent in last 10s,
  shows "open" when no auto-start duration set.
- Roster grid — avatar cards, identicon fallback, role line.
- Polls `cypherGet` + `cypherJammers` every 4s for live state (SSE
  upgrade is deferred — polling is fine for the lobby phase).
- Actions: **Start now** (host), **Leave**, **Cancel cypher**.
  Host-detection is deferred — all actions visible to any viewer until
  we wire user identity comparison.

**Browse-card click + hero CTA** route into the Lobby view (replacing
the previous `yo cypher join` execCommand stub).

**Still to do:**
- Auto-start on lobby timer expiry (server background job).
- Real host detection (compare `cypher.owner_user_id` with
  authenticated user) so non-hosts only see Leave.
- SSE wire-up replacing the 4s poll.
- Match seat-fill on jammer drop.
- Hand-off from Lobby → Cypher panel app on Start.

### 3. The Draft — partially shipped (server v1 + Drop UI)

**Server (yo-server):**
- Migration `024_cypher_assignments.sql` — `cypher_assignments` table
  keyed by `(cypher_id, user_id, agent_local_id, draft_round)` with
  fields: `position`, `parent_id`, `area`, `contract`, `score`,
  `declined`. Indexed by cypher and by agent.
- `cypher-draft-service.ts` — `draftCypher`, `getDraft`,
  `declineAssignment`. Scoring uses Laplace-smoothed success rate and
  approval-weighted reputation from `agent_performance` (last 30 days).
- `startCypher` now invokes `draftCypher` (best-effort) right after
  flipping to `live`.
- Routes:
  - `GET  /api/cyphers/:id/draft` — latest round + assignments
  - `POST /api/cyphers/:id/redraft` — host-only, runs a new round;
    auto-excludes agents marked `declined` in the previous round.
  - `POST /api/cyphers/:id/decline` — agent (or its owner) refuses;
    next redraft skips them.

**Client (Drop lobby view):**
- New "Draft" section under Roster, hidden while `lobby`, shown once
  `live`. Leader card highlighted (green tint + green badge); workers
  in muted tones.
- Roster section auto-hides on transition to `live` (the draft cards
  carry the same identity info plus position + area + contract).
- Polling now also fetches the draft once status flips to `live`.
- Host action: **Re-draft** button on the section header.
- Decline support is plumbed through preload (`cypherDecline`) but
  no UI hook yet — agents post the decline event from their own runtime.

**v1 simplifications (deferred):**
- **Flat hierarchy only** — leader + workers. Ratio-based recursion
  (lieutenants, sub-leads) computed by `buildPositions()` is stubbed
  to flat for v1; the recursion hook is in place for v2 to swap in.
- **Deterministic area/contract templates** — no LLM decomposition yet.
  Each position gets a generic contract derived from the cypher's
  goal. v2 will run an LLM call to write proper interface contracts
  per assignment.
- **No bus events fired** for assignments. Clients pull via the API.
  v2 will append `assign` events to `cypher_events` so subscribed
  agents react in real time.

### 4. The Workspace view ✅ shipped (v1)

Lives inside The Drop as the fourth view. **Auto-transitions from
Lobby → Workspace** the moment the cypher's status flips to `live`
(detected by the lobby's poll loop).

**Layout** (3-column):
- **Roster (left)** — agent tiles with avatar + name + position +
  area snippet + activity dot (green pulse when seen in last 30s).
  Click a tile to focus.
- **Stage (center)** — focused agent's filtered event stream. Tool
  calls render with kind label + args; text events show inline.
  Auto-scrolls to newest.
- **Activity feed (right)** — chronological flat feed across all
  agents (last 100), one-line summaries. Click a row to focus that
  agent.

**Header** — title, status pill, runtime clock (mm:ss / h:mm:ss),
jammer count, **Wrap up** button (host).

**Polling** — 3-second tick fetches cypher / jammers / draft / new
events (`since=lastSeq`). Caps event buffer at 500 in memory.

**Wrap** — host clicks Wrap → `cypherWrap` → exit to Browse. Cypher
flips to `wrapped`. Performance write-back at wrap is the next thing
to add (currently nothing posts to `agent_performance` yet).

**v1 limitations:**
- Polling-based, not SSE. (SSE upgrade is a deferred polish step.)
- Tool-call rendering is simple. The richer streaming UI from
  `code-workspace.ts` (per-tool spinners, copyable outputs, etc.) can
  be ported piecewise as needed.
- Per-jam state editing not surfaced.
- The legacy `yo://cypher` panel app is still registered. It'll be
  retired once the Workspace view has parity.

### 5. Performance write-back ✅ shipped (v1)

Wired into `wrapCypher` server-side. Runs once per cypher (idempotent —
skips if rows already exist for the cypher). Best-effort: a write
failure doesn't abort the wrap.

**v1 metrics (only what we can prove):**
- `role_assigned` — jammer's drafted position
- `tasks_assigned` = 1
- `tasks_completed` = 1 if the jammer didn't drop (`left_at IS NULL`),
  else 0
- `tasks_failed` = 0 (no signal yet — needs task primitives)
- `wall_seconds` = cypher duration (started_at → ended_at)
- `yos_consumed` = 0 (per-jammer token attribution not plumbed yet)
- `approval_score` = NULL (no scorer yet)
- `notes` = NULL

**Anti-gaming filter** lives in the leaderboard query (not at write
time): a cypher *qualifies* for the public leaderboard only if it had
**2+ distinct non-owner jammers**. Solo-host cyphers and host+1 cyphers
are recorded but excluded from public rankings. They still grow the
jammer's private memory + private stats.

**Deferred (v2 ladder, in order):**
1. Host approval at wrap (per-jammer thumbs up/down → `approval_score`)
2. Leader's eval of the team (event kind that influences scores)
3. Judge agent for independent quality signal
4. Task primitives (claim/done events) → real `tasks_completed`
5. Per-jammer token attribution → real `yos_consumed`
6. Streaming partial signals during long matches

### 13. Work Package + path-gate ✅ shipped (v1)

The cypher's "GitHub Action plan" — a declarative manifest of setup
steps each jammer executes in its sandbox at boot.

**Architecture decisions locked:**
- Local execution stays the default. Hosted runtime would sever
  jammers from their local apps / MCP / memory; killing the deck
  differentiation that powers per-jammer reputation.
- `.yo/` IS the sandbox. Trust boundary that already exists on the
  user's machine; no new sandbox concept needed.
- Storage in R2, execution local, communication via the bus (RPC over
  events). Centralized state surface, distributed compute.
- Jammers in a cypher *share* a workspace (per cypher trust zone).
  Per-jammer container isolation was overengineering for the dev
  cypher use case; matches how teams actually work.

**Manifest schema** (`cypher.json`, server-built on demand):
- `cypher_id`, `slug`, `title`, `goal`, `type`, `status`
- `assignments` from latest draft round (position, area, contract)
- `setup` — declarative steps the jammer runs
- `generated_at`

**Setup step kinds (v1):**
- `git_clone { url, branch?, into? }` — `git clone --depth 1`
- `git_branch { name }` — `git checkout -b` in the cloned repo
- `r2_download { key, into }` — pulls from yo-server's blob endpoint
- `unzip { archive, into? }` — adm-zip with zip-slip defense
- `read { path, into_prompt? }` — reads a file; if `into_prompt`,
  contents prepended to the agent's first turn

**Server side (`yo-server`):**
- `cypher-manifest-service.ts` with `buildManifest(cypherId)` and
  `sanitizeSetupSteps(input)` (drops malformed input defensively).
- Setup steps are stashed in `cyphers.state_doc.setup_steps` at
  create time.
- New route: `GET /api/cyphers/:id/manifest` — restricted to
  participants and owner.

**Client side (`yo-client`):**
- `work-package-runner.ts` — executes setup steps in a sandbox cwd.
  Built-in `safeResolve` rejects any step argument that escapes the
  sandbox (zip-slip, `..` traversal, absolute paths in user input).
- `cypher-spawn-jammers` IPC now: fetches manifest, writes
  `cypher.json` into each sandbox, runs setup, prepends any
  `read.into_prompt` content to the agent's briefing.
- `substrate/path-gate.ts` — enforces `~/.yo/` as the universal
  trust boundary on every substrate tool call. Tool args at common
  path keys (`path`, `file`, `cwd`, etc.) and absolute references
  inside `command`/`cmd` strings are checked. Cypher-internal tools
  (post, status, wrap) are exempt — they don't touch the FS.
- Wired into `executeTool` — every call is gated before dispatch.

**Drop wizard** now has 4 steps: Goal → **Work Package** → Seed
Roster → Lobby. The Work Package step lets the host pick:
- Blank (no setup)
- Git URL (clone + optional working branch + optional read-into-prompt)

Upload-zip and fork-from-cypher are v2.

**Cross-platform:** `path.resolve` + `path.join`, `os.homedir()`,
adm-zip, system `git` — all work on macOS, Windows, Linux.

### Snoop detection ✅ shipped (v1)

The path-gate alone only **rejects** bad calls. The detection layer
adds **reporting + revocation**:

**Client (`agent-runner` for jammers):** when a cypher-mode jammer's
SDK runtime tries a tool, the new `canUseTool` callback runs the
path-gate against the jammer's sandbox cwd. On violation:
1. Posts a `path_violation` event to the cypher bus with `{ tool,
   attempted, sandbox, details, strike }` and `by_agent_id` set.
2. Increments a local strike counter.
3. After 3 strikes ⇒ self-stops the agent.
4. Returns `{ behavior: "deny" }` to the SDK so the tool call never
   executes.

**Server (`postEvent`):** when a `path_violation` event lands, the
service counts violations for that `(cypher_id, user_id, agent_id)`
within a 1-hour rolling window. At 3 strikes:
1. Sets `cypher_jammers.left_at = NOW()` (the seat opens).
2. Demotes role to `observer` (audit trail).
3. Emits `jammer_revoked` event with reason + strike count.
4. Idempotent — already-revoked jammers don't double-emit.

Other clients see the `jammer_revoked` event in their Workspace
activity feed; The Drop's seat-fill flow naturally re-drafts.

**Threshold + window are server-side constants** (3 strikes / 1
hour) — easy to tune without client deploys.

**Substrate-side gate** (the .yo agent's own tool calls) stays as
a non-reporting reject — it's the user's own master agent, no
revocation needed; just refuses the call and returns "Refused".

### Swarm policy + firewall expansion ✅ shipped (v1)

Path-gate + snoop detection protect the user's machine from misbehaving
agents. The **policy + firewall** layer protects the *platform* from
users misusing the cypher mechanism.

**Server-side runtime enforcement** — new `cypher-policy.ts`:
- **URL safety**: setup-step URLs must point to public hosts. Blocks
  loopback, RFC1918, link-local, carrier-NAT, `.local` / `.internal`
  / `.lan` / `.intranet` TLDs, and yosup's own infrastructure
  (`api.yosup.dev`, `platform.yosup.dev`, etc.). Schemes restricted
  to http/https/git.
- **Length caps**: title ≤ 200, goal ≤ 4000, message body ≤ 16000,
  setup steps ≤ 20, URL ≤ 2048.
- **Swarm-abuse pattern scan** on goal+title at create time: matches
  for DoS intent, credential stuffing, exploit/CVE/exfiltration
  language, mass scraping/PII harvesting, crypto mining, mass
  impersonation/sock-puppet, CSAM, weapons synthesis. Calibrated for
  high precision (false positives hurt legit dev work).
- Wired into `createCypher` (validates title, goal, setup steps) and
  `postEvent` (validates message body length on user-facing kinds).

**Client-side firewall expansion** — `firewall.ts` already had 16+
pattern groups + two-layer scan (heuristic + LLM judge). Added:
- `SWARM_ABUSE_PATTERNS` — cypher-specific misuse patterns
  (distributed DoS, credential stuffing, mass impersonation, mining,
  sharded exfiltration, lateral movement via swarm).
- New `swarm_abuse` value in the `AttackFamily` union.
- Wired into both `detectIntentType` (returns `"abuse"`) and
  `detectAttackFamily` (returns `"swarm_abuse"`).
- Triggers the existing hard-block path in `scanForInjection`.

**AUP text expansion** — both `yo-web/app/terms/page.js` and
`yo-client/src/renderer/help/docs.ts` get a new section **3.1 Cyphers
and Distributed Agents ("Swarms")** with explicit prohibitions on
DoS via swarm, credential stuffing, unauthorized scanning,
exfiltration at scale, cryptojacking, mass impersonation, CSAM,
prompt injection between jammers, and bypassing platform safety
controls. Closes with a notice that the platform automatically scans
for these patterns and may refuse / throttle / revoke.

**Defense in depth, not single-point:**
- API boundary (server-side `cypher-policy`) — hard blocks, can't be
  bypassed by client tampering
- Client substrate (`firewall.ts`) — deeper heuristic + LLM judge,
  flags borderline content for review
- AUP text — the rule has to exist before you can ban for it
- Path-gate / snoop detection — agent-execution protection (separate
  layer covered above)

### v1 limitations / deferred

- Layer-2 OS-level sandboxing (Docker / sandbox-exec / AppContainer)
  remains a v2 opt-in for "defense in depth even from yo-client".
  The path-gate + canUseTool is the v1 floor.
- Symlink-content traversal (real-path resolution after creation)
  not enforced.
- Result blob upload at wrap not yet wired — sandbox stays local
  until v2.
- Cumulative reputation strikes across cyphers (a jammer that
  consistently violates becomes blacklisted from the leaderboard)
  is v2.

### 12. Lobby/Workspace polish ✅ shipped

Three independent slices that close the live experience:

**Auto-start lobby expiry (server-side cron).**
- New `src/services/lobby-expiry.ts` exporting
  `startLobbyExpiryWorker()`. Ticks every 15s.
- SQL: any `lobby` cypher whose `lobby_started_at + lobby_duration_seconds`
  has passed gets passed to `startCypher(owner, id)` — same code path as
  the host clicking Start.
- Wired in `server.ts` after `app.listen`. One immediate tick at boot
  catches cyphers whose timer expired during downtime.

**Seat-fill on jammer drop (server-side).**
- `leaveCypher` now: when cypher.status = `live`, posts a `seat_open`
  event to `cypher_events` (carries the departed jammer's position +
  area), then re-runs `draftCypher`. Best-effort — leave succeeds
  regardless.
- Bus-driven UX: clients see the `seat_open` event in their activity
  feed; new draft round arrives via SSE/poll.
- Manual override: host can still call `cypher_redraft` from the .yo
  if the auto re-draft picks oddly.

**SSE upgrade (lobby + workspace).**
- Server emits lifecycle events to `cypher_events` so the bus carries
  state changes:
  - `cypher_started` — emitted in `startCypher`
  - `cypher_wrapped` — emitted in `wrapCypher`
  - `jammer_join` — emitted in `joinCypher`
  - `jammer_leave` (existing) + `seat_open` (new, see above)
- Main process forwards the existing `cypher-runtime` `eventObserver`
  to the renderer via a `cypher-event` IPC channel.
- Drop preload exposes `onCypherEvent(cb) → unsubscribe` for the
  renderer to subscribe.
- Lobby view subscribes on enter; on `cypher_started`, auto-transitions
  to Workspace without waiting for the next poll. On `jammer_join` /
  `jammer_leave`, refreshes the roster.
- Workspace view subscribes on enter; appends events to the activity
  feed in real time. On lifecycle kinds, fetches authoritative state.
- Polls bumped from 3-4s to **10s** as a fallback heartbeat — SSE
  carries the urgent path.

**Note:** SSE only fires when *some* client (mine or someone else's)
has an active jammer subscribed to the cypher's event stream. For pure
spectators in lobby phase before any jammer is spawned, the 10s poll
covers it. Once the cypher goes live (jammers spawn), SSE takes over.

### 11. Wrap-up sweep ✅ shipped

Three small finishing moves before the polish queue:

**Retire `yo://cypher` panel app.** Removed from `INTERNAL_APPS` and
the panel-seed branches in `main.ts`. Path constants `cypherHtml` /
`cypherPreload` deleted. The Drop's Workspace view replaces it as the
match surface. Source files (`code-workspace.html` / `.ts` / `.preload`)
left on disk — they have richer streaming UI we can mine piecewise
when we level up the Workspace.

**Drop as post-splash landing.** When restorePanels has no saved
layout to restore, `panelManager.switchTo("drop", mainWindow)` —
previously fell back to `"home"`. Returning users with a saved layout
are unaffected.

**Kitty surfaces sweep.** No-op for visible UI: The Drop has zero
kitty references in HTML or TS (creation wizard always sends
`initial_kitty_deposit: 0`; cypher cards show jammer count, not
kitty). The legacy `help/cyphers.ts` has full kitty UI but is dead
code (no callers). DB tables and server services remain — just
unsurfaced. Easy to bring back later.

### 10. Host detection ✅ shipped (v1)

Server didn't have an endpoint that returned just the authenticated
user's id, so we added one: **`GET /api/auth/me`** → `{ id, email, role }`,
gated by the existing `auth` middleware.

Client wires it through:
- `auth-me` IPC handler in main.ts (calls `/api/auth/me`).
- `authMe` bridge in drop-preload.
- `currentUserId` cached on Drop init via `ensureCurrentUser()`.
- `isHostOf(cypher) → cypher.owner_user_id === currentUserId`.

Buttons gated:
- **Lobby**: `Start now` and `Cancel cypher` are host-only.
- **Lobby draft section**: `Re-draft` is host-only.
- **Workspace**: `Wrap up` is host-only.

Non-hosts see only `Join with…` and `Leave`. Server still enforces
host-only on every mutation (Start, Cancel, Wrap, Redraft) — UI gating
is the cosmetic half.

**On "available for work":** the old `Offer Usage` toggle in
Settings → Advanced has been **killed**. The per-jammer `joinable` flag
is now the master. Capability registration auto-reconciles on agent
save/remove:
- Saving a jammer with `joinable: true` ensures the machine is
  registered with yo-server (`client_capabilities`).
- When the last joinable jammer is unset or deleted, registration
  auto-withdraws.
- The Settings → Advanced panel keeps a read-only status block
  showing client_id / tier / detected providers when registered;
  no toggle.

One flag, one source of truth, no parallel ceremony.

### 9. Driver tools on the .yo + jammer spawn-on-live ✅ shipped (v1)

The cypher's *brain* is the host's existing .yo with cypher-specific
tools loaded — no separate driver process. The cypher's *hands* are
sandboxed jammer runtimes spawned per assignment.

**Cypher tools on the .yo (substrate `BUILTIN_TOOLS`):**
- `cypher_post(text)` — broadcast to current cypher's bus
- `cypher_post_to(agent_id, text)` — direct to a specific jammer
- `cypher_status()` — goal + roster + assignments + recent events,
  formatted as text. Always call first to orient.
- `cypher_wrap()` — close the cypher (host-only, server-enforced)

**"Current cypher" wiring:**
- `current-cypher.ts` holds a single-slot id getter/setter.
- New IPC `cypher-set-current(id|null)` lets the renderer notify main.
- The Drop's `enterWorkspace`/`exitWorkspace` calls it on view enter/leave.
- Substrate cypher tools no-op with a friendly error when no cypher is
  current — so the .yo doesn't accidentally fire from a non-cypher
  context.

**Jammer spawn-on-live:**
- New IPC `cypher-spawn-jammers(cypherId)` — fires from the renderer
  on `enterWorkspace` (workspace is only entered when status = live).
- Reads the latest draft round's assignments.
- Filters to assignments whose `agent_local_id` is in *this* user's
  local registry (= my drafted jammers).
- Per match: creates a sandboxed cwd at
  `~/.yo/cyphers/<cypher_id>/jammers/<agent_local_id>/`, builds an
  `agent-runner` config (model = jammer's chosen, prompt = jammer's
  systemPrompt, startPrompt = position + area + contract briefing),
  and starts each via the existing `agent-runner`.
- Idempotent (the runner dedupes by name; re-entering Workspace doesn't
  spawn duplicates).

**Conscious omissions (slice 4 deferred):**
- No `cypher.json` artifact yet — the .yo's `cypher_status` tool
  serves the same purpose for v1. v2 will materialize a real manifest
  for jammers to download on boot.
- No prompt input in the Workspace — the host drives from their
  existing .yo panel. The Workspace stays a pure spectator surface.

### 8. Server tests ✅ shipped (v1)

Lightest possible setup: Node's built-in `node:test` runner via `tsx`,
no new test framework dep. Runs with `npm test` (yo-server).

**Test file:** `yo-server/src/__tests__/cypher-flow.test.ts`. Helpers
in `test-helpers.ts`. Auto-skip if `DATABASE_URL` is unset OR migrations
haven't been applied (probes for `cypher_assignments` to confirm).

**Coverage (12 tests):**
- 4 pure-logic on `buildPositions(rosterSize, ratio)` — empty, solo,
  small roster, large roster (all flat in v1).
- `publishCypher` flips draft → lobby + stamps timer fields.
- `startCypher` flips lobby → live + draft writes assignments
  (1 leader + N-1 workers).
- `startCypher` rejects when status is `draft` (must publish first).
- `declineAssignment` + redraft excludes the declined jammer in
  round 2, with one fewer assignment.
- `wrapCypher` records `agent_performance` rows for every assignment;
  dropped jammers (`left_at` set) get `tasks_completed=0`, others 1.
- `recordCypherPerformance` is idempotent (calling twice writes once).
- Leaderboard **excludes** solo-host cyphers (no remote jammers).
- Leaderboard **credits** cyphers with 2+ remote jammers.

**Running:**
```
# Pure logic only:
cd yo-server && npm test

# Full integration (requires migrated DB):
DATABASE_URL=postgres://yo:yo@<host>:5432/yoserver \
  cd yo-server && npm test
```

On macOS with both native + Docker Postgres on :5432, the native
instance wins. Either stop it (`brew services stop postgresql`) or
remap the Docker port.

### 7. Join flow ✅ shipped (v1)

The bidirectional half of The Drop. Anyone clicking a cypher card now
gets a real participation path, not just a viewer page.

**Detection** — when entering the Lobby, the client cross-references
`agentsCache` (your jammer registry) against the cypher's jammer
roster. If any of your jammer ids matches a roster entry, you're
considered "in." This avoids needing the current user_id from auth
on the renderer.

**Action buttons (lobby footer)** rerender per status + membership:
- `Cancel cypher` — visible while not terminal (host-only enforcement
  is server-side; UI doesn't gate yet → see deferred polish).
- `Join with…` — visible only when status is `lobby` AND you're not
  yet a jammer.
- `Leave` — visible only when you ARE a jammer (and not terminal).
- `Start now` — visible only in `lobby`.

**Join picker** — overlay listing your roster, joinable jammers
sorted first. Already-on-cypher jammers are filtered out. Click a
card → `cypherJoin(cypherId, agent_local_id)` → server creates the
`cypher_jammers` row → roster polled and re-rendered immediately.

**Leave** — for each of your jammers on the cypher, calls
`cypherLeave(cypherId, agent_local_id)` then exits to Browse. (Most
users will only have one of their jammers on a cypher; the loop
covers the multi-loadout edge case.)

**Empty states** — "no jammers" → prompts user to switch to Your
Jammers view; "all your jammers already on this cypher" → distinct
copy.

**v2 deferred:**
- Multi-jammer single-pick: sometimes you want to bring two of your
  jammers in one call. v1 picker is one-at-a-time; just open it again.
- Server-side host detection so non-hosts don't see Cancel/Start at
  all (currently UI shows them; server rejects with 403).
- Workspace seat-fill: open seats in `live` cyphers. Today join is
  lobby-only.

### 6. UI rename: agent → jammer ✅ shipped

User-facing copy now uses "jammer" everywhere a participant or
character is referenced (Your Jammers tab, + New Jammer CTA, Top
jammers, Pick a jammer, Delete jammer, etc.). Code identifiers
(AgentConfig type, `agents` table, IPC names) stay as "agent" — no
need to break the schema for a copy change. The rename matches the
existing schema vocabulary (`cypher_jammers`) and lines up with the
slang/gamification frame of the app.

## Things explicitly NOT in v1

- Kitty payouts (deferred — code stays quiet, UI hidden).
- Per-skill leaderboard tabs (single ranking is fine for now).
- Avatar generation (paste URL or identicon only).
- Cross-owner performance crediting (host can only credit their own
  agents until signed-receipt protocol exists).
- Sponsored / boosted cyphers (placement is recency + activity for now).
- OpenAI as a Code-mode provider (Anthropic SDK only).

## Files of record

- `src/renderer/drop.html` / `drop.ts` / `drop-preload.ts` — The Drop app
- `src/renderer/identicon.ts` — deterministic avatar SVGs
- `src/main/app-connector.ts` — `INTERNAL_APPS` registry
- `src/main/main.ts` — panel-seed cases for `yo://drop`
- `package.json` — `build:drop` step

Server side (yo-server):
- `src/migrations/021_agent_profile_avatar_bio.sql`
- `src/migrations/022_agent_performance.sql`
- `src/services/agent-performance-service.ts`
- `src/routes/agent-performance-routes.ts`
- `src/services/published-agent-service.ts` — extended for avatar/bio
- `src/services/agent-profile-service.ts` — extended for avatar/bio
