# Workspace renderer — architecture & conventions

The workspace shell (`workspace.html` + `workspace-shell.js`) is the new app
UI. We're rebuilding screens into it incrementally. **Leave existing modules
in place; build new screens in the structure below and pull from the old code
as needed.**

## Directory layout

```
src/renderer/
  workspace.html            # thin skeleton: chrome + mount slots. NOT a markup dump.
  workspace.ts              # Electron-only bundle: boot gate + agent panel + drip + workdir
  workspace/
    shell.ts                # orchestrator: builds ctx, registers core + screens
    lib/
      bridge.ts             # typed window.yo accessor + hasBridge()
      ctx.ts                # WorkspaceCtx type + Screen contract
      dom.ts                # el()/mount()/$/$$ — no framework
    styles/
      tokens.css            # design tokens (single source of truth) — linked first
      base.css              # shared primitives (.ws-screen, headings…)
      <name>.css            # per-screen styles, linked from workspace.html
    components/             # reusable UI bits (Button, List, Modal, Field…)
    screens/
      _template/            # copy this to start a screen (delete once real screens exist)
      <name>/<name>.ts      # one screen = one folder; owns its markup
    *.ts                    # LEGACY core modules (slides, rails, recents, launcher…) — keep until touched
```

## Rules

1. **No massive files.** ~250-line soft cap. Past it, split by responsibility
   into sibling files in the screen's folder.
2. **Screens own their markup.** Render DOM in the screen module (template
   string or `el()`), mounted into a host. Don't grow `workspace.html`.
3. **CSS is linked, not bundled.** A screen's TS lives in `screens/<name>/`;
   its stylesheet lives in `styles/screens/<name>.css` and is linked in
   `workspace.html <head>` as `styles/screens/<name>.css` (build copies
   `workspace/styles/*` recursively → `dist/renderer/styles/`). Always consume
   `tokens.css` vars — never hard-code colors/spacing, so light/dark theming
   works. Scope every rule under a screen-root class (e.g. `.skills`) to avoid
   leakage. See `screens/skills/` + `styles/screens/skills.css` as the reference.
4. **Real TypeScript for new code.** Use `lib/bridge.ts` (not `(window as
   any).yo`) and `lib/ctx.ts` types. No `@ts-nocheck` in new files. Legacy
   modules keep theirs until rewritten.
5. **Guard the bridge.** `hasBridge()` before any `yo.*` call so browser-
   preview degrades gracefully.

## Build

`npm run build:workspace` bundles `workspace.ts` and `workspace/shell.ts` with
esbuild (it resolves `./x.js` imports to `.ts`), copies `workspace.html`, and
copies `workspace/styles/*` → `dist/renderer/styles/`. CSS is plain linked
files — no CSS bundling step.

## Migration posture

`workspace.html` still holds a large legacy inline `<style>` and markup. As each
screen is rebuilt, its CSS moves to a `styles/<name>.css` file and its markup
moves into the screen module — shrinking the inline block over time. We don't
do a big-bang refactor.
