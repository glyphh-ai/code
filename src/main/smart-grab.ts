/**
 * SmartGrab — intelligent content extraction from webview panels.
 *
 * Extracts page title + URL, then tries to find the main content area
 * (role="main", <main>, chat/conversation containers). For chat apps,
 * extracts the last N messages individually. For other pages, strips
 * nav/header/footer/sidebar noise and grabs clean body text.
 *
 * No LLM involved — pure DOM heuristics. Designed for action-driven
 * capture where quality matters more than raw completeness.
 */

import { WebContents } from "electron";

const GRAB_SCRIPT = `(function() {
  var lines = [];
  lines.push("PAGE: " + document.title);
  lines.push("URL: " + location.href);
  lines.push("");

  // Find main content area
  var mainEl = document.querySelector('[role="main"]')
    || document.querySelector('main')
    || document.querySelector('[data-testid*="conversation"]')
    || document.querySelector('[data-testid*="chat"]')
    || document.querySelector('[data-testid*="thread"]');

  if (mainEl) {
    // For chat apps: extract individual messages
    var messages = mainEl.querySelectorAll(
      '[data-message-id], [data-testid*="message"], [class*="message-"], ' +
      '[class*="Message"], [role="article"], [data-role], ' +
      '[class*="turn-"], [class*="chat-message"], [class*="ConversationItem"], ' +
      '[class*="font-claude-message"], [data-testid*="response"], ' +
      '[data-message-id], [class*="email-"], [role="listitem"]'
    );

    if (messages.length > 0) {
      // Chat/message app — extract last N messages
      var recent = Array.from(messages).slice(-15);
      for (var i = 0; i < recent.length; i++) {
        var msg = recent[i];
        var role = msg.getAttribute('data-role')
          || msg.getAttribute('data-testid')
          || '';
        var text = msg.innerText.trim();
        if (text.length < 5) continue;
        if (text.length > 1200) text = text.slice(0, 1200) + '...';
        if (role) lines.push("[" + role + "]");
        lines.push(text);
        lines.push("");
      }
    } else {
      // Non-chat: grab main content text
      var text = mainEl.innerText.trim();
      if (text.length > 8000) text = text.slice(0, 8000) + '...';
      lines.push(text);
    }
  } else {
    // No main element found — strip noise manually
    var clone = document.body.cloneNode(true);
    var noise = clone.querySelectorAll(
      'nav, header, footer, aside, [role="banner"], [role="navigation"], ' +
      '[role="complementary"], [class*="sidebar"], [class*="Sidebar"], ' +
      '[class*="nav-"], [class*="Nav-"], [class*="footer"], [class*="Footer"], ' +
      '[class*="header"], [class*="Header"], [class*="cookie"], [class*="Cookie"], ' +
      '[class*="banner"], [class*="Banner"], [class*="toolbar"], [class*="Toolbar"], ' +
      '[class*="menu"], [class*="Menu"], ' +
      'script, style, noscript, [aria-hidden="true"]'
    );
    for (var i = 0; i < noise.length; i++) {
      try { noise[i].remove(); } catch(e) {}
    }
    var text = clone.innerText.trim();
    if (text.length > 8000) text = text.slice(0, 8000) + '...';
    lines.push(text);
  }

  return lines.join("\\n").trim();
})()`;

/** Hash script — returns a quick content fingerprint for delta detection. */
const HASH_SCRIPT = `(function() {
  var text = (document.title || "") + "\\n" + (document.body ? document.body.innerText.slice(0, 5000) : "");
  // Simple FNV-1a 32-bit hash
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
})()`;

export async function smartGrab(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  try {
    const result = await wc.executeJavaScript(GRAB_SCRIPT);
    return result || null;
  } catch {
    return null;
  }
}

/** Fast content hash for detecting changes without full extraction. */
export async function contentHash(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  try {
    return await wc.executeJavaScript(HASH_SCRIPT);
  } catch {
    return null;
  }
}
