/**
 * SmartGrab — content-targeted DOM extraction.
 *
 * Replaces raw document.body.innerText with targeted extraction that
 * strips nav/sidebar/footer noise and focuses on main content.
 * For chat apps, extracts individual messages. Zero LLM cost.
 */

import { WebContents } from "electron";

const SMART_GRAB_SCRIPT = `(function() {
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
    // For chat/message apps: extract individual messages
    var messages = mainEl.querySelectorAll(
      '[data-message-id], [data-testid*="message"], [class*="message-"], ' +
      '[class*="Message"], [role="article"], [data-role], ' +
      '[class*="turn-"], [class*="chat-message"], [class*="ConversationItem"], ' +
      '[class*="font-claude-message"], [data-testid*="response"], ' +
      '[role="listitem"][class*="email"], [role="row"]'
    );

    if (messages.length > 0) {
      var recent = Array.from(messages).slice(-15);
      for (var i = 0; i < recent.length; i++) {
        var msg = recent[i];
        var role = msg.getAttribute('data-role')
          || msg.getAttribute('data-testid')
          || '';
        var text = msg.innerText.trim();
        if (text.length < 5) continue;
        if (text.length > 1000) text = text.slice(0, 1000) + '...';
        if (role) lines.push("[" + role + "]");
        lines.push(text);
        lines.push("");
      }
    } else {
      // Non-chat: grab main content, skip nested navs
      var clone = mainEl.cloneNode(true);
      var nested = clone.querySelectorAll('nav, [role="navigation"], [role="banner"], footer');
      for (var i = 0; i < nested.length; i++) { try { nested[i].remove(); } catch(e) {} }
      var text = clone.innerText.trim();
      if (text.length > 6000) text = text.slice(0, 6000) + '...';
      lines.push(text);
    }
  } else {
    // No main element — strip noise manually
    var clone = document.body.cloneNode(true);
    var noise = clone.querySelectorAll(
      'nav, header, footer, aside, [role="banner"], [role="navigation"], ' +
      '[role="complementary"], [class*="sidebar"], [class*="Sidebar"], ' +
      '[class*="nav-"], [class*="Nav-"], [class*="footer"], [class*="Footer"], ' +
      '[class*="header"], [class*="Header"], [class*="cookie"], [class*="Cookie"], ' +
      '[class*="banner"], [class*="Banner"], [class*="toolbar"], [class*="Toolbar"], ' +
      'script, style, noscript, [aria-hidden="true"]'
    );
    for (var i = 0; i < noise.length; i++) { try { noise[i].remove(); } catch(e) {} }
    var text = clone.innerText.trim();
    if (text.length > 6000) text = text.slice(0, 6000) + '...';
    lines.push(text);
  }

  return lines.join("\\n").trim();
})()`;

export async function smartGrab(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  try {
    const result = await wc.executeJavaScript(SMART_GRAB_SCRIPT);
    return result || null;
  } catch {
    return null;
  }
}
