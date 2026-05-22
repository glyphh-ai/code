/**
 * template.ts — reference for a rebuilt workspace screen. Copy this folder to
 * `screens/<name>/`, rename, and wire it from shell.ts. Delete the `_template`
 * folder once a couple of real screens exist.
 *
 * Rules of the road:
 *  - One screen = one folder: `<name>.ts` (+ helpers if it grows past ~250
 *    lines, split into sibling files) and `<name>.css` (co-located styles).
 *  - The screen OWNS its markup — render it here, don't park it in
 *    workspace.html. workspace.html stays a thin skeleton (chrome + slots).
 *  - Link the screen's css from workspace.html <head> as `styles/<name>.css`
 *    (build:workspace copies workspace/styles/* → dist/renderer/styles/), or
 *    keep screen css under styles/screens/ and link accordingly.
 *  - Consume design tokens (var(--ws-*) / var(--text) …) — never hard-code.
 *  - Real TypeScript: typed bridge + ctx, no @ts-nocheck in new files.
 */

import { el, mount } from "../../lib/dom.js";
import { hasBridge } from "../../lib/bridge.js";
import type { Screen, WorkspaceCtx } from "../../lib/ctx.js";

export const templateScreen: Screen = {
  id: "_template",
  label: "Template",

  mount(host: HTMLElement, _ctx: WorkspaceCtx) {
    const root = el("div", { class: "ws-screen tpl" }, [
      el("div", { class: "ws-screen__body" }, [
        el("h2", { class: "ws-screen__title", text: "Template screen" }),
        el("p", { class: "ws-screen__desc", text: "Copy screens/_template to start a new screen." }),
        el("div", { class: "tpl__hint", text: hasBridge() ? "Bridge ready." : "Browser preview (no bridge)." }),
      ]),
    ]);
    mount(host, root);
  },
};
