# Vibe — spec

> A vibe-coding workspace (Cursor-ish) that runs Claude Code against a consistent,
> editable plan and shows agent · plan · live preview in one layout. **Vibe is a yo
> app that produces yo apps.**

## Core concept: everything is a yo app
- `council`, `vibe`, `home`, `browser` … are all **yo apps** (`INTERNAL_APPS` in `app-connector.ts`, `yo://<id>`).
- **The output of a vibe is itself a yo app** — when a vibe finishes building something, the result is registered as a yo app the user can add to their apps list.
- yo apps are a **standard, portable unit**: importable / exportable as a `.yoapp` bundle (manifest + assets/code). Marketplace later; for now local import/export + "add to my apps."

## The workspace (one layout, 3 regions)
A single panel `vibe.html` (one WebContents) with a 3-region grid (mirrors the `code-workspace.html` multi-region pattern — simplest IPC):
1. **Agent** — a Claude Code agent in a PTY. Spawn via `terminalManager.spawnAgent(wc, { name, role, cwd, command:"claude", args, workspace })`; PTY I/O over `terminal:data`/`terminal:write`/`terminal:resize`; xterm in-region (reuse `terminal-renderer.ts` bindings). Gate on `ensureCcAuth()` first. `cwd = vibeCodeDir(id)`.
2. **Plan** — renders/edits `plan.md` (the living task list). The agent reads + checks it off; the user can edit. Simple editor + file sync to `~/yo/vibes/<id>/plan.md`.
3. **Preview** — a `<webview>` (panel `webviewTag:true`) pointed at the vibe's dev server (`meta.dev_server_url`, e.g. `http://localhost:5173`), auto-reload.

## Vibe registry (persistence) — `src/main/vibe-store.ts`
Mirror `agent-store`/`council-store` per-item-on-disk pattern under `~/yo/vibes/<id>/`:
```
~/yo/vibes/<id>/
  meta.json        # VibeMeta (below)
  plan.md          # living task list
  CLAUDE.md        # the methodology fed to the coding agent (editable per project)
  code/            # the project being built (agent cwd)
  .runs/<runId>.json
```
`VibeMeta = { id, name, description?, status, createdAt, updatedAt, council_id?, dev_server_port?, dev_server_url?, outputAppId? }`.
API: `listVibes()`, `getVibe(id)`, `saveVibe(meta)`, `deleteVibe(id)`, `vibeCodeDir(id)`, `vibePlanPath(id)`, `vibeClaudePath(id)`, run records.

## Vibes in the left rail
Persisted Vibes list in the rail (on `main` the rail is light — add a Vibes list/toggle, or fold into the nicer rail when ported). Each Vibe row → opens the `vibe` panel bound to that `id` (restores agent cwd + plan + preview). `+ New Vibe` → create flow.

## vibe-planner skill — `~/.claude/skills/vibe-planner/`
A real yo skill (the reusable methodology). `SKILL.md` (Read/Write tools) takes `{ prompt, cwd, councilSynthesis? }` and writes `plan.md` + `CLAUDE.md` into the vibe dir. Invoked from main via `skillEngine.runSkill("vibe-planner", { prompt, cwd })` at vibe creation. Output is **per-project editable** (skill seeds; user edits).

## Council → vibe feed
On "plan with a council": `createCouncil(...)` → run → `summarizeCouncil(id)` → `{ text }` synthesis → pass as `councilSynthesis` into `vibe-planner` → `plan.md`. Multi-LLM decides *what/how*; Claude Code *builds it*. (Council events can also stream into the vibe via `setCouncilForwardWc`.)

## yo app package (import / export) — later phase
- **Manifest** (extend the app-connector app shape): `{ id, name, url | entry(html), commands?, mcp?, capturePolicy, version, kind:"web"|"bundled" }`.
- **Export**: zip the app's manifest + (for bundled) its `code/` build → `<name>.yoapp`.
- **Import**: unzip → register via `app-connector.add(...)` → appears in the user's apps.
- **Vibe output → app**: on "ship", register the built project as a yo app (web: url to its server; bundled: its built assets), set `meta.outputAppId`. The user adds it to their apps list.

## Build order (phased, each committed green)
1. **Workspace shell** — `vibe.html`/`vibe.ts` real 3-region layout; Claude Code PTY agent in region 1 (cwd = a scratch dir for now); plan pane (region 2) editing a plan.md; `<webview>` preview (region 3). Single agent.
2. **Vibe registry + rail** — `vibe-store.ts`, `vibe-ipc.ts` (list/get/create/delete + open), rail Vibes list, open-by-id binds the workspace to `~/yo/vibes/<id>/`.
3. **vibe-planner skill** — generate `plan.md` + `CLAUDE.md` from a goal on create.
4. **Council → vibe feed** — synthesis seeds the plan.
5. **yo app import/export** — `.yoapp` bundle; vibe "ship" registers the output as an app.

## Gotchas (from recon)
- PTY: first `resize` must come from the renderer (xterm reports cols/rows) or the `claude` TUI wraps wrong; `env.PATH` via `getShellPath()` so `claude` resolves; auto-respawn on exit, permanent kill on wc destroy.
- Webview: `webviewTag:true`, contextIsolation → preload for IPC; local dev server may want its own session.
- CC auth: `ensureCcAuth()` is non-blocking (shows a modal); `spawnCcLogin()` for first login.
- Council sessions are in-memory — `summarizeCouncil()` persists; capture synthesis before `endCouncil()`.
- Skill `Write plan.md` lands relative to the agent cwd → pass the vibe dir.
