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

## Status (as of v4.2.0 tag)
Phases 1–5 built + the Vibes left-rail item. **Compile-verified only — not yet run.** First smoke test: `npm run dev` → open a Vibe → confirm the Claude Code agent boots, "Generate plan" writes a plan.md, the preview loads.

## Next iteration — make the plan dynamic + agent-driven (not yet built)
First-pass notes from dogfooding; the static planner (Phase 3) is the seed, this makes it live:
- **Agent owns the plan.** The vibe's `CLAUDE.md` IS the coding agent's system prompt (Claude Code reads it in the project dir). Put the rails there: on load, **ask the user what they want to build**; create/maintain `plan.md`; progress task-by-task and check items off as it goes.
- **Feed the URL to the agent.** Pass the vibe's preview/publish URL into the agent (env var + written into `CLAUDE.md`) so it knows where to serve and "publish to"; the preview pane points at the same URL.
- **Live plan pane.** Watch `plan.md` for the agent's edits → re-render the pane; user edits write back. Bidirectional, not a one-shot read.
- **Controls on the building page.** A control strip in the vibe panel: start/stop the agent, run the dev server, ship, advance-to-next-task. Shape it as it firms up.
- **Re-seed note:** `seedBuiltinSkills()` skips an existing on-disk `vibe-planner/SKILL.md`, so prompt changes (e.g. the council-synthesis instruction) won't reach already-seeded users until re-seeded (version the skill or re-write on bump).

## Known tech debt — the hidden nav
`home.html` has a hidden `#help-nav` (`display:none`) whose `.help-nav-item[data-section]` buttons are **load-bearing state** for the section switcher (`activeSection()`/`switchToSection()`/`loadActiveSection()` in `navigation.ts`). The visible nav is the app's left rail (`#files-rail-nav` in `index.html`), which drives sections via `openHomeSection → gotoSection` (flipping the hidden nav's active classes). Leftover from migrating nav to the rail without rewriting the switcher. Footgun: every section must be wired in **two** places (hidden nav for state + visible rail for display) — caused "Vibes missing from rail" and "always loads dashboard". Cleanup (a refactor): drive section state from the rail/a state var and delete `#help-nav` + the `.help-nav-item` coupling so there's one nav.
