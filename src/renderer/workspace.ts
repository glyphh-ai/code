/**
 * workspace.ts — renderer entry for the new workspace shell.
 *
 * Slim bootstrap: runs the auth/boot gate + agent panel + drip against
 * the workspace.html DOM. The old browser-shell wiring (tabs, grid,
 * url-bar, files-rail, panel screenshots, downloads) is intentionally
 * NOT included — the workspace shell replaces it. The shell's own UI
 * (slides, apps, agents, layouts, customize, modes, ghost chat) lives
 * in the inline <script> in workspace.html.
 */

import { showOnboarding } from "./onboarding.js";
import { initBootGate } from "./boot-gate-ui.js";
import { initDrip } from "./drip-ui.js";
import { initYoPanel } from "./yo-panel-ui.js";
import { initWorkdir } from "./workspace/workdir.js";

// window.yo is provided by preload.js; type it loosely here since this
// bundle is built with esbuild (no shared global declaration).
const yo = (window as unknown as { yo: any }).yo;

// ── Window controls ───────────────────────────────────────────
document.getElementById("btn-close")?.addEventListener("click", () => yo.windowClose());
document.getElementById("btn-minimize")?.addEventListener("click", () => yo.windowMinimize());
document.getElementById("btn-maximize")?.addEventListener("click", () => yo.windowMaximize());
document.getElementById("splash-close")?.addEventListener("click", () => yo.windowClose());

// ── Agent panel (chat) ────────────────────────────────────────
// The workspace has no BrowserView grid, so renderGridHandles is a
// no-op. yo-panel-ui wires #yo-panel-* (input, send, messages, mode +
// perm dropdowns, streaming) which the workspace markup preserves.
const yoPanelApi = initYoPanel({ renderGridHandles: () => {} });

// Expose the panel API to the workspace shell's inline script so the
// Recents rail (and + New Session) can drive chat history.
(window as unknown as { __yoPanel: typeof yoPanelApi }).__yoPanel = yoPanelApi;
// Tell the shell the bridge is ready so it can do its first render.
window.dispatchEvent(new Event("yo-panel-ready"));

// ── Drip picker ───────────────────────────────────────────────
initDrip();

// ── Working-directory bar ─────────────────────────────────────
// New chats default to the user's home folder (no first-run prompt);
// the user changes it from the workdir bar picker when they want to.
initWorkdir();

// ── First-run preference parity ───────────────────────────────
// The agent is the center of the workspace, so there's no panel to
// auto-open — but keep the preference write so behavior matches the
// old shell and a future hook can react to it.
function maybeAutoOpenYoPanel(): void {
  yo.getPreference("hasAutoOpenedYoPanel", false).then((opened: boolean) => {
    if (opened) return;
    yo.setPreference("hasAutoOpenedYoPanel", true);
  });
}

window.addEventListener("yo-onboarding-done", () => {
  setTimeout(maybeAutoOpenYoPanel, 800);
});

// ── Boot gate ─────────────────────────────────────────────────
// Owns splash, auth, lockout, tutorial, cc-bootstrap, theme. Panels
// show/hide are no-ops — the workspace shell is always visible (no
// floating BrowserViews to reveal/conceal).
initBootGate({
  onBootReady: (data: { needsOnboarding?: boolean }) => {
    if (!data.needsOnboarding) maybeAutoOpenYoPanel();
  },
  showPanels: () => {},
  hidePanels: () => {},
  applyTheme: (theme: string) => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("yoTheme", theme); } catch { /* ignore */ }
  },
  showOnboarding: (requiresAuth?: boolean) => showOnboarding(requiresAuth),
});
