/**
 * Session preload: overrides window.alert / confirm / prompt in the page's
 * main world so they return immediately instead of blocking.
 *
 * Registered via session.registerPreloadScript on the "persist:yo" partition.
 * Runs before any per-webContents preload and before page scripts.
 */

import { webFrame } from "electron";

webFrame.executeJavaScript(`
  (function() {
    if (window.__yoDialogFixed) return;
    window.__yoDialogFixed = true;
    window.alert = function(msg) { console.log('[yo-alert]', msg); };
    window.confirm = function(msg) { console.log('[yo-confirm]', msg); return true; };
    window.prompt = function(msg, def) { console.log('[yo-prompt]', msg); return def || ''; };
  })();
`);
