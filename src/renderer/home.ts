/**
 * Home app — entry point for the yo://home panel.
 *
 * Loads inside a dedicated BrowserView with full window.yo API.
 * Hosts all sections that used to live in the help overlay.
 */

import { initHelp, loadActiveSection } from "./help.js";

// Wire up all the section handlers. Skip openHelp() because it calls
// panelsHide() which would hide the home panel itself.
initHelp();
// Load the initial section's data (Dashboard charts, etc).
loadActiveSection();
// Refresh auth so tier gates reflect current plan.
window.yo.refreshAuth().catch(() => {});
