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

  // AI chat message selectors — try site-specific first, then generic
  var msgSelectors = [
    // Claude
    '[data-testid="chat-message-content"]',
    '[class*="font-claude-message"]',
    // Gemini
    'message-content',
    '[class*="response-container"]',
    'model-response',
    // Grok
    '[data-testid*="response"]',
    // ChatGPT
    '[data-message-author-role]',
    // Generic
    '[data-message-id]',
    '[data-testid*="message"]',
    '[data-role]',
    '[role="article"]',
    '[class*="message-"]',
    '[class*="Message"]',
    '[class*="turn-"]',
    '[class*="chat-message"]',
    '[class*="ConversationItem"]',
  ];

  var messages = [];
  for (var s = 0; s < msgSelectors.length; s++) {
    try {
      var found = document.querySelectorAll(msgSelectors[s]);
      if (found.length > 0) { messages = Array.from(found); break; }
    } catch(e) {}
  }

  if (messages.length === 0) {
    // Fallback: find main content area
    var mainEl = document.querySelector('[role="main"]')
      || document.querySelector('main')
      || document.querySelector('[data-testid*="conversation"]')
      || document.querySelector('[data-testid*="chat"]')
      || document.querySelector('[data-testid*="thread"]');
    if (mainEl) {
      var text = mainEl.innerText.trim();
      if (text.length > 8000) text = text.slice(0, 8000) + '...';
      lines.push(text);
    } else {
      // Last resort: strip noise
      var clone = document.body.cloneNode(true);
      var noise = clone.querySelectorAll(
        'nav, header, footer, aside, [role="banner"], [role="navigation"], ' +
        '[role="complementary"], [class*="sidebar"], [class*="Sidebar"], ' +
        '[class*="nav-"], [class*="Nav-"], [class*="footer"], [class*="Footer"], ' +
        '[class*="header"], [class*="Header"], [class*="toolbar"], [class*="Toolbar"], ' +
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
  } else {
    // Chat app — extract last N messages
    var recent = messages.slice(-15);
    for (var i = 0; i < recent.length; i++) {
      var msg = recent[i];
      var role = msg.getAttribute('data-role')
        || msg.getAttribute('data-message-author-role')
        || msg.getAttribute('data-testid')
        || '';
      var text = msg.innerText.trim();
      if (text.length < 5) continue;
      if (text.length > 2000) text = text.slice(0, 2000) + '...';
      if (role) lines.push("[" + role + "]");
      lines.push(text);
      lines.push("");
    }
  }

  return lines.join("\\n").trim();
})()`;

/** Hash script — returns a quick content fingerprint for delta detection.
 *  Hashes title + first 2500 chars + last 2500 chars so both navigation
 *  changes (top) and new chat messages (bottom) are detected. */
const HASH_SCRIPT = `(function() {
  var raw = document.body ? document.body.innerText : "";
  var text = (document.title || "") + "\\n";
  if (raw.length <= 8000) {
    text += raw;
  } else {
    text += raw.slice(0, 3000) + raw.slice(-5000);
  }
  // Simple FNV-1a 32-bit hash
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
})()`;

/** Grab only the last AI response — used by council for clean cross-pollination. */
const GRAB_LAST_RESPONSE_SCRIPT = `(function() {
  var msgSelectors = [
    '[data-testid="chat-message-content"]',
    '[class*="font-claude-message"]',
    'message-content',
    '[class*="response-container"]',
    'model-response',
    '[data-testid*="response"]',
    '[data-message-author-role="assistant"]',
    '[data-message-id]',
    '[data-testid*="message"]',
    '[data-role]',
    '[role="article"]',
    '[class*="message-"]',
    '[class*="Message"]',
    '[class*="turn-"]',
    '[class*="chat-message"]',
    '[class*="ConversationItem"]',
  ];

  var messages = [];
  for (var s = 0; s < msgSelectors.length; s++) {
    try {
      var found = document.querySelectorAll(msgSelectors[s]);
      if (found.length > 0) { messages = Array.from(found); break; }
    } catch(e) {}
  }

  if (messages.length === 0) {
    var mainEl = document.querySelector('[role="main"]')
      || document.querySelector('main')
      || document.querySelector('[data-testid*="conversation"]')
      || document.querySelector('[data-testid*="chat"]');
    if (mainEl) {
      var text = mainEl.innerText.trim();
      return text.length > 4000 ? text.slice(-4000) : text;
    }
    return null;
  }

  // Get the last message (most likely the AI response)
  var last = messages[messages.length - 1];
  var text = last.innerText.trim();
  if (text.length > 4000) text = text.slice(0, 4000) + '...';
  return text || null;
})()`;

export async function grabLastResponse(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  try {
    const result = await wc.executeJavaScript(GRAB_LAST_RESPONSE_SCRIPT);
    return result || null;
  } catch {
    return null;
  }
}

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
