# GH-Pivot session notes — 2026-05-08

Branch: `gh-pivot` on both yo-client and yo-server.
Goal: scaffold THE-PIVOT-GITHUB end-to-end skeletons in one night so that
the live cut-over is mostly server-side flips later.

This doc is the morning-regroup brief. Read it before opening the diffs.

---

## What landed

### yo-server `gh-pivot` branch

- **Migration `035_users_github_identity.sql`**
  - `users.gh_user_id BIGINT` (unique partial index)
  - `users.gh_login TEXT` (lowered index for joins)
  - `users.gh_avatar TEXT`
  - `github_oauth_states` table (state → flow / return_to / bind_user_id /
    expires_at / consumed_at)

- **`src/services/gh-app-service.ts`**
  - Single source of truth for GH App config (App ID, PEM, webhook secret,
    OAuth client_id/secret/callback). Loaded from env, Heroku-safe `\n`
    handling on the PEM.
  - `getGhAppConfig() / isConfigured() / buildAuthorizeUrl(state, scopes)`

- **`src/routes/github-auth-routes.ts`**
  - `GET  /api/auth/github/start`     — **live** (mints state, returns URL)
  - `GET  /api/auth/github/callback`  — **live** (placeholder + postMessage
                                        for web flow; Electron intercepts)
  - `POST /api/auth/github/exchange`  — **501** + `EXCHANGE_RESPONSE_CONTRACT`

- **`src/routes/project-routes.ts`** (all 501 with response contracts)
  - `POST /api/projects`
  - `GET  /api/projects/mine`
  - `GET  /api/projects/discover`
  - `GET  /api/projects/:ref`
  - `GET  /api/projects/:ref/board`
  - `GET  /api/projects/:ref/events/stream`  (SSE — connects + emits `not-implemented` event)
  - `POST /api/projects/:ref/start`
  - `POST /api/projects/:ref/wrap`

- **`src/routes/installation-routes.ts`** (all 501)
  - `GET  /api/me/installations`
  - `GET  /api/me/installations/:owner/repos`
  - `POST /api/me/heartbeat`
  - `GET  /api/me/assignments/stream`  (SSE)

All registered in `server.ts`. TypeScript clean.

### yo-client `gh-pivot` branch

- **`src/main/drop-auth.ts`** (new)
  - `~/yo/.session.drop` storage (encrypted via `safeStorage`)
  - `signInWithGitHub()` — hits `/api/auth/github/start`, opens child
    `BrowserWindow` on the partition `persist:drop-session`, intercepts the
    callback redirect (will-redirect/did-navigate), POSTs `{code,state}` to
    `/api/auth/github/exchange`, persists session, schedules refresh.
  - `getDropAuthStatus() / getDropAccessToken() / signOutDrop() / initDropAuth()`
  - Refresh stub points at `/api/auth/refresh` (existing yo path); will need
    a parallel GH-bound endpoint if we don't reuse.

- **`src/main/drop-api.ts`** (new)
  - `dropFetch<T>` wrapper that pulls Bearer from the Drop session.
  - Exports `dropApi` with: `projectsMine`, `projectDiscover`, `projectGet`,
    `projectBoard`, `projectCreate`, `projectStart`, `projectWrap`,
    `installationsList`, `reposForInstallation`, `heartbeat`.

- **`src/main/main.ts`**
  - Imports `initDropAuth`, `signInWithGitHub`, `signOutDrop`, `getDropAuthStatus`, `dropApi`.
  - Calls `initDropAuth()` next to `initAuth()` at boot.
  - New IPC handlers (block before `mcp-expose-get-tokens`):
    `drop-gh-status`, `drop-gh-sign-in`, `drop-gh-sign-out`, `projects-mine`,
    `projects-discover`, `project-get`, `project-board`, `project-create`,
    `project-start`, `project-wrap`, `installations-list`, `repos-for-installation`.
  - `dev-flags` IPC also returns `enableGhAuth: process.env.YO_ENABLE_GH_AUTH === "1"`.

- **`src/renderer/drop-preload.ts`**
  - Extended `DropAPI` with `ghStatus`, `signInWithGitHub`, `signOutGitHub`,
    `projectsMine`, `projectDiscover`, `projectGet`, `projectBoard`,
    `projectCreate`, `projectStart`, `projectWrap`, `installationsList`,
    `reposForInstallation`. All routed through `ipcRenderer.invoke`.

- **`src/renderer/drop-gh-landing.ts`** (new)
  - `maybeRenderGhLanding(host)` — if `enableGhAuth && !signedIn`, takes
    over the panel with a "Continue with GitHub" card. On success fires
    `drop-gh-signed-in` `CustomEvent`.
  - Surfaces 501-stub errors clearly in the UI.

- **`src/renderer/drop-pickers.ts`** (new)
  - `OwnerOption` / `RepoOption` types.
  - `loadOwners() / loadRepos(ownerLogin)` — try IPC first, fall back to
    fixtures (`FIXTURE_OWNERS`, `FIXTURE_REPOS`) if 501/error.
  - `renderOwnerPicker(host, opts)` and `renderRepoPicker(host, opts)`.

- **`src/renderer/drop.ts`**
  - Inlined boot hook in `init()` that dynamically imports
    `./drop-gh-landing.js`, calls `maybeRenderGhLanding`, hides the rest of
    the Drop UI behind it when shown.

- **`src/renderer/drop.html`**
  - New CSS block at end of `<style>` for `.yo-gh-landing`,
    `.yo-gh-landing-card`, `.yo-gh-landing-btn`, `.yo-owner-picker`,
    `.yo-repo-picker`, etc.

- **`src/main/cypher-bus.ts`**
  - Header docblock now lists explicit Phase 5+6 migration mappings
    (postCypherEvent → `/api/projects/:ref/events/stream`,
    subscribeCypherAgent → `/api/me/assignments/stream`,
    `getCypherForWorkspace` → drop session's bound `project_id`,
    `dispatchInbound` → daemon in `agent-runner.ts` consuming the new SSE).

- **`tsconfig.json` + `src/renderer/tsconfig.json`**
  - New renderer files (`drop-gh-landing.ts`, `drop-pickers.ts`) added to
    renderer include and main exclude.

- **`docs/THE-PIVOT-GITHUB.md`**
  - Status table: Phases 1, 2, 3, 5, 6 flipped to 🟡 scaffold/IPC wired/
    pickers scaffolded/migration TODOs annotated.

Both branches: TypeScript clean. `npm run build` clean. Ready to push.

---

## What is still 501 / TODO before live

These need real credentials + work I can't do tonight:

1. **Register the yo-cypher GitHub App.** Apple-style App registration on
   github.com. Needs an account + manual UI clicks. After registration:
   - Set env on the server: `GH_APP_ID`, `GH_APP_PRIVATE_KEY` (PEM),
     `GH_APP_WEBHOOK_SECRET`, `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`,
     `GH_OAUTH_CALLBACK_URL` (must point to a public yo-server URL).

2. **Implement `POST /api/auth/github/exchange` body** (Phase 10):
   - Look up the state row by `state`, verify not consumed, not expired
   - POST to `https://github.com/login/oauth/access_token` with `code` +
     `client_id` + `client_secret` to swap for user-OAuth token
   - GET `https://api.github.com/user` with `Authorization: token <ghtok>`
   - UPSERT yo user by `gh_user_id` (preserves email-match join when
     binding while logged in via `bind_user_id`)
   - Mark state row consumed, mint yo session JWT enriched with
     `gh_user_id` / `gh_login` / `gh_avatar`
   - Return `EXCHANGE_RESPONSE_CONTRACT`

3. **Webhook ingest endpoint** (separate file, Phase 11+12+14):
   `POST /api/github/webhook` with HMAC verification using
   `GH_APP_WEBHOOK_SECRET`. Routes events into pg `LISTEN/NOTIFY` channel
   that `/api/projects/:ref/events/stream` consumes.

4. **Project-creation matchmaker** (Phase 11):
   - Schema: `projects` table, `project_items` table, `project_assignees`
   - Server creates the actual GitHub Project v2 via GraphQL using an
     installation token (App-as-bot)
   - Custom fields: `Status`, `Mode`, `Capability`, `Slots`, `Winners`,
     `ReviewMode` (matches the wizard inputs)

5. **`installationsList` + `reposForInstallation`** (Phase 11):
   Proxy `/user/installations` and `/installation/repositories` from the
   user's stored OAuth token.

6. **Jammer daemon hook in `agent-runner.ts`** (Phase 6):
   Subscribe to `/api/me/assignments/stream` whenever `.session.drop` exists
   AND at least one local agent loadout has `joinable: true`. The IPC and
   `dropApi.heartbeat()` exist; the daemon code does not.

7. **Drop-a-Cypher wizard rewrite** (Phase 3):
   The pickers live in `drop-pickers.ts` but the existing wizard in
   `drop.ts` (3000+ LOC) still uses the old steps. Rewrite once Phase 1
   sign-in is real.

---

## How to test what's already on `gh-pivot`

### Server

```sh
cd yo-server
git checkout gh-pivot
npm run build
PORT=3001 npm start
# In another shell:
curl http://localhost:3001/api/auth/github/start
# Returns 501 with detail "GitHub App not configured" (expected — no env).
# Set GH_APP_* vars and re-run; /start should mint a state and return URL.
curl -X POST -H "Authorization: Bearer <yo session JWT>" http://localhost:3001/api/projects
# Returns 501 with response contract.
```

### Client

```sh
cd yo-client
git checkout gh-pivot
YO_ENABLE_GH_AUTH=1 npm run dev
# Open The Drop panel: landing card should appear.
# Click "Continue with GitHub" → opens child window → server returns 501
# until env vars are set; UI surfaces the 501 message in the error slot.
```

To test pickers in isolation:

```js
// In Drop's DevTools console:
const { loadOwners, loadRepos } = await import("./drop-pickers.js");
console.log(await loadOwners());                // FIXTURE_OWNERS
console.log(await loadRepos("acme"));           // FIXTURE_REPOS["acme"]
```

To test cypher-bus migration audit: `grep "PIVOT-GITHUB MIGRATION" src/main/cypher-bus.ts` — the header docblock now spells out the deletion plan.

---

## What I'd do next session

1. **Server first**: register the GH App (manual), set env, implement
   `/exchange` body. ~half day to get end-to-end sign-in green.
2. **Client**: rewire The Drop's Browse / Your Cyphers data sources to
   `dropApi.projectDiscover()` / `projectsMine()`. The IPC + bridges are
   already in place.
3. **Schema for projects table** + matchmaker stub that writes a row +
   creates a Project v2 via GraphQL.
4. **Webhook ingress + pg LISTEN/NOTIFY** for the SSE streams.
5. **Drop-a-Cypher wizard rewrite** in drop.ts using the pickers.
6. **Daemon in agent-runner.ts** subscribing to assignments stream.
