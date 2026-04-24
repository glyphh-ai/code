/**
 * Home app — entry point for the yo://home panel.
 *
 * Loads inside a dedicated BrowserView with full window.yo API.
 * Hosts all sections that used to live in the help overlay:
 * Guide, Skills, Layouts, Drips, Apps, Tools, Settings, Support, About.
 */

import { initHelp, openHelp } from "./help.js";

// The home page IS the help content (no overlay wrapper).
// Remove the "hidden" class that help.ts expects on the overlay,
// then run initHelp which wires up event listeners.
document.addEventListener("DOMContentLoaded", () => {
  // help.ts toggles #help-overlay visibility via .hidden class.
  // Since we're rendering it as the full page, make it always visible
  // and add a shim element that help.ts can find.
  const layout = document.getElementById("help-layout");
  if (!layout) return;

  // Some code paths call openHelp() which expects an overlay to toggle.
  // Make #help-overlay a reference to the root so toggles are harmless.
  if (!document.getElementById("help-overlay")) {
    const proxy = document.createElement("div");
    proxy.id = "help-overlay";
    proxy.style.display = "contents";
    layout.parentElement?.insertBefore(proxy, layout);
    proxy.appendChild(layout);
  }

  initHelp();
  openHelp();
});
