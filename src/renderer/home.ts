/**
 * Home app — entry point for the yo://home panel.
 *
 * Loads inside a dedicated BrowserView with full window.yo API.
 * Hosts all sections that used to live in the help overlay.
 */

import { initHelp, openNewAppDeepLink, gotoSection } from "./help/index.js";

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
window.yo.refreshAuth?.().catch(() => {});

// Pick the startup section. Priority: an explicit pending nav (the rail asked
// for a specific section) → the user's configured default ("homeStartupSection",
// blank = "last viewed") → the last section they had open → dashboard.
// (Fixes the app always opening on the dashboard.)
void (async () => {
  try {
    const pending = await window.yo.getPendingSection?.();
    if (pending) { gotoSection(pending.section, pending.sub); return; }
  } catch { /* fall through */ }
  const def = ((await window.yo.getPreference?.("homeStartupSection", "")) as string) || "";
  const lastSec = ((await window.yo.getPreference?.("homeLastSection", "")) as string) || "";
  const lastSub = ((await window.yo.getPreference?.("homeLastSub", "")) as string) || "";
  const sec = def || lastSec || "dashboard";
  gotoSection(sec, sec === lastSec ? (lastSub || undefined) : undefined);
})();
window.yo.onGotoSection?.((section, sub) => gotoSection(section, sub));

// "Create App" from a browser tab routes here — open the New App form prefilled.
window.yo.onOpenNewApp?.((data) => openNewAppDeepLink(data));
