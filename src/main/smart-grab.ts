/**
 * SmartGrab — intelligent content extraction from webview panels.
 *
 * Extracts page title + URL, then tries to find the main content area.
 * For chat apps, extracts messages with role tagging. For other pages,
 * strips nav/header/footer/sidebar noise and grabs clean body text.
 *
 * Grabs aggressively — the capture store chunker handles splitting.
 * No LLM involved — pure DOM heuristics.
 */

import { WebContents } from "electron";

const GRAB_SCRIPT = `(function() {
  var lines = [];
  lines.push("PAGE: " + document.title);
  lines.push("URL: " + location.href);
  lines.push("");

  // ── Chat message extraction ──────────────────────────────
  // Try ALL selectors, keep the set with the most results.
  // Site-specific selectors may go stale — casting a wide net
  // and picking the best catch is more robust than breaking
  // on the first hit.

  var selectorGroups = [
    // Claude
    '[data-testid*="message"]',
    '[class*="font-claude-response"]',
    '[class*="font-user-message"]',
    '[data-testid="chat-message-content"]',
    // ChatGPT
    '[data-message-author-role]',
    '[data-message-id]',
    // Gemini
    'message-content',
    '[class*="response-container"]',
    'model-response',
    // Grok
    '[data-testid*="response"]',
    // Generic patterns
    '[data-role]',
    '[role="article"]',
    '[class*="message-"]',
    '[class*="Message"]',
    '[class*="turn-"]',
    '[class*="chat-message"]',
    '[class*="ConversationItem"]',
    '[class*="prose"]',
  ];

  // Merge all selector results — different selectors may match user vs
  // assistant messages separately. Deduplicate and skip nested elements
  // (a child already covered by a parent match).
  var seen = new Set();
  var merged = [];
  for (var s = 0; s < selectorGroups.length; s++) {
    try {
      var found = document.querySelectorAll(selectorGroups[s]);
      for (var f = 0; f < found.length; f++) {
        var el = found[f];
        if (seen.has(el)) continue;
        // Skip if this element is inside an already-matched element
        var dominated = false;
        for (var m = 0; m < merged.length; m++) {
          if (merged[m].contains(el)) { dominated = true; break; }
        }
        if (dominated) { seen.add(el); continue; }
        // If a previously matched element is inside this one, replace it
        var kept = [];
        for (var m = 0; m < merged.length; m++) {
          if (el.contains(merged[m])) seen.delete(merged[m]);
          else kept.push(merged[m]);
        }
        merged = kept;
        merged.push(el);
        seen.add(el);
      }
    } catch(e) {}
  }
  // Sort by document order
  merged.sort(function(a, b) {
    var pos = a.compareDocumentPosition(b);
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });
  // Guard: if fewer than 2 elements have meaningful text, this probably
  // isn't a chat page — fall through to main content extraction.
  var meaningful = 0;
  for (var c = 0; c < merged.length && meaningful < 2; c++) {
    if (merged[c].innerText && merged[c].innerText.trim().length >= 20) meaningful++;
  }
  var bestMessages = meaningful >= 2 ? merged : [];

  // Build structured output from messages
  var structured = "";
  if (bestMessages.length > 0) {
    var parts = [];
    // Grab up to 100 messages — let the chunker handle size
    var recent = bestMessages.slice(-100);
    for (var i = 0; i < recent.length; i++) {
      var msg = recent[i];

      // Role detection — try multiple attributes
      var role = msg.getAttribute('data-role')
        || msg.getAttribute('data-message-author-role')
        || '';

      // Fallback: infer role from data-testid or class names
      if (!role) {
        var testId = msg.getAttribute('data-testid') || '';
        var cls = msg.className || '';
        if (/user/i.test(testId) || /user/i.test(cls)) role = 'user';
        else if (/assistant|bot|claude|model|ai/i.test(testId) || /assistant|bot|claude|model|ai/i.test(cls)) role = 'assistant';
        else if (/human/i.test(testId) || /human/i.test(cls)) role = 'human';
        else if (testId) role = testId;
      }

      var text = msg.innerText.trim();
      if (text.length < 5) continue;

      // Per-message cap at 64K — individual messages can be very long
      // (code blocks, long responses). Let the chunker split downstream.
      if (text.length > 64000) text = text.slice(0, 64000) + '\\n[truncated]';

      if (role) parts.push("[" + role + "]");
      parts.push(text);
      parts.push("");
    }
    structured = parts.join("\\n");
  }

  // Always grab main content area as fallback
  var mainText = "";
  var mainEl = document.querySelector('[role="main"]')
    || document.querySelector('main')
    || document.querySelector('[data-testid*="conversation"]')
    || document.querySelector('[data-testid*="chat"]')
    || document.querySelector('[data-testid*="thread"]')
    || document.querySelector('article');
  if (mainEl) {
    mainText = mainEl.innerText.trim();
  }
  if (!mainText) {
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
    mainText = clone.innerText.trim();
  }

  // Use whichever captured more content — selectors can go stale
  var content = (structured.length >= mainText.length) ? structured : mainText;

  // Cap at 200K chars — generous, let the chunker split downstream.
  // Take the LAST 200K so recent content (newest messages) is preserved.
  if (content.length > 200000) content = content.slice(-200000);
  lines.push(content);

  return lines.join("\\n").trim();
})()`;

/** Hash script — returns a quick content fingerprint for delta detection.
 *  Hashes title + head/tail sample so both navigation changes (top)
 *  and new chat messages (bottom) are detected. */
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
  var selectorGroups = [
    '[data-testid*="message"]',
    '[class*="font-claude-response"]',
    '[class*="font-user-message"]',
    '[data-testid="chat-message-content"]',
    'message-content',
    '[class*="response-container"]',
    'model-response',
    '[data-testid*="response"]',
    '[data-message-author-role="assistant"]',
    '[data-message-id]',
    '[data-role]',
    '[role="article"]',
    '[class*="message-"]',
    '[class*="Message"]',
    '[class*="turn-"]',
    '[class*="chat-message"]',
    '[class*="ConversationItem"]',
  ];

  var seen = new Set();
  var merged = [];
  for (var s = 0; s < selectorGroups.length; s++) {
    try {
      var found = document.querySelectorAll(selectorGroups[s]);
      for (var f = 0; f < found.length; f++) {
        var el = found[f];
        if (seen.has(el)) continue;
        var dominated = false;
        for (var m = 0; m < merged.length; m++) {
          if (merged[m].contains(el)) { dominated = true; break; }
        }
        if (dominated) { seen.add(el); continue; }
        var kept = [];
        for (var m = 0; m < merged.length; m++) {
          if (el.contains(merged[m])) seen.delete(merged[m]);
          else kept.push(merged[m]);
        }
        merged = kept;
        merged.push(el);
        seen.add(el);
      }
    } catch(e) {}
  }
  merged.sort(function(a, b) {
    var pos = a.compareDocumentPosition(b);
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });
  var bestMessages = merged;

  if (bestMessages.length === 0) {
    var mainEl = document.querySelector('[role="main"]')
      || document.querySelector('main')
      || document.querySelector('[data-testid*="conversation"]')
      || document.querySelector('[data-testid*="chat"]');
    if (mainEl) {
      var text = mainEl.innerText.trim();
      return text.length > 16000 ? text.slice(-16000) : text;
    }
    return null;
  }

  // Get the last message (most likely the AI response)
  var last = bestMessages[bestMessages.length - 1];
  var text = last.innerText.trim();
  if (text.length > 32000) text = text.slice(0, 32000) + '\\n[truncated]';
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
