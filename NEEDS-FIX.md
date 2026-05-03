# Needs-Fix Backlog

Known follow-ups that aren't blocking ship. Trim as items land.

## Remote control mode (yo agent panel)

The mode dropdown next to the perm dropdown is currently single-entry
("standard") because `.council` and `.code` were removed. Keep it — the
second slot is reserved for **remote** mode:

- `standard` — local input. User types in the side panel, yoAgent runs.
- `remote` — platform-driven input. The user starts a self-jammer cypher;
  the platform (yosup.dev) posts events to it via voice transcript or web
  UI; the local cypher-runtime picks them up and dispatches to yoAgent;
  responses stream back to the platform via the same event channel.

What needs to land before this can ship:
- Replace cypher-runtime's 3-second poll loop with SSE/WebSocket — voice
  control with up to 3s of dead air per command is unusable.
- Permission UX in remote mode is more sensitive than local. The
  SDK-aligned `canUseTool` callback (see below) needs to either auto-deny
  destructive ops in remote mode, or surface approval prompts through the
  platform UI rather than the local desktop client.
- Platform side: voice-input UI + transport for posting events to the
  user's self-jammer cypher.
- Auth: the platform must only be able to post to the user's own remote
  session, not arbitrary cyphers. Re-use existing yo-server bearer auth.

## Cypher event stream — replace polling with SSE/WebSocket

`cypher-runtime.ts` polls `/api/cyphers/{id}/events` every 3s. Acceptable
for async multi-party coordination, painful for any real-time use case
(remote control above, in-flight tool confirmations, live agent traces).
Server side already has the schema for it — just needs the transport.

## Cypher-workspace rename pass

The local multi-agent execution layer is currently called "code-workspace"
in the codebase (panel id, baseAppId branch, `type: "code"` on layouts,
preference keys like `codeWorkspaceLayout` / `codeWorkspaceCypher`). That
naming is from the `.code` command era. Rename to `cypher-workspace`
across the surface, with a one-time read-time migration shim for existing
persisted state:
- `~/yo/workspaces/<slug>/layouts.json` entries with `type: "code"` →
  `type: "cypher"`
- preferences `codeWorkspaceLayout` → `cypherWorkspaceLayout`,
  `codeWorkspaceCypher` → `cypherWorkspaceCypher`
- panel id `"code-workspace"` → `"cypher-workspace"` (renderer asset
  paths follow)
- HTML files, build script entries in `package.json`

## SDK permissionMode wiring (in this PR's scope)

Tracked here for context: `yo-agent.ts` previously hardcoded
`permissionMode: "bypassPermissions"` and ran the SDK wide open while our
`action-gate.ts` did parallel UI gating. This PR aligns the perm enum to
SDK terms and pipes `this._mode` through to the SDK. Once the renderer
approval flow is fully wired into `canUseTool`, the parallel
`action-gate` + `approvalCallback` path can be retired.
