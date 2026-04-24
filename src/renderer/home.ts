/**
 * Home app — entry point for the yo://home panel.
 *
 * Loads inside a dedicated BrowserView with full window.yo API.
 * Hosts all sections that used to live in the help overlay.
 */

import { initHelp, openHelp } from "./help.js";

// help.ts runs its top-level DOM queries when imported, so by the time
// we get here all its const refs (including #help-overlay) are bound.
// We just need to initialize event listeners and show the content.
initHelp();
openHelp();
