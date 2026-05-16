/**
 * Home app — entry point for the yo://home panel.
 *
 * Loads inside a dedicated BrowserView with full window.yo API.
 * Hosts all sections that used to live in the help overlay.
 */

import { initHelp, loadActiveSection, openNewAppDeepLink, gotoSection } from "./help/index.js";

// Theme: the inline script in home.html applied localStorage theme synchronously.
// Here we re-fetch the authoritative value from main and keep localStorage in sync.
function applyTheme(theme: string) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  try { localStorage.setItem("yoTheme", theme); } catch {}
}

window.yo.getTheme?.().then(applyTheme).catch(() => {});
window.yo.onThemeChanged?.(applyTheme);

// React to system dark/light changes when theme = "system"
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", async () => {
  try {
    const theme = await window.yo.getTheme();
    if (theme === "system") applyTheme(theme);
  } catch {}
});

initHelp();
loadActiveSection();
window.yo.refreshAuth?.().catch(() => {});

// Section switching is driven by the app's left-rail nav (the in-page sidebar
// is hidden). Honor a pending request made before this page finished loading,
// then listen for live ones.
window.yo.getPendingSection?.()
  .then((p) => { if (p) gotoSection(p.section, p.sub); })
  .catch(() => {});
window.yo.onGotoSection?.((section, sub) => gotoSection(section, sub));

// "Create App" from a browser tab routes here — open the New App form prefilled.
window.yo.onOpenNewApp?.((data) => openNewAppDeepLink(data));
