/**
 * Grab comparison test — paste this into a panel's devtools console
 * (or run via executeJavaScript) to compare raw vs smart extraction.
 *
 * Reports: character count, estimated tokens, and the actual content for both.
 */
(function() {
  // Rough token estimate: ~4 chars per token for English text
  function estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  // ── Method 1: Current raw grab (document.body.innerText) ──
  var rawGrab = document.body.innerText.slice(0, 10000);

  // ── Method 2: Smart content-targeted grab ──
  function smartGrab() {
    var lines = [];

    // Title context
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
        // Claude-specific
        '[class*="font-claude-message"], [data-testid*="response"], ' +
        // Gmail-specific
        '[data-message-id], [class*="email-"], [role="listitem"]'
      );

      if (messages.length > 0) {
        // Chat/message app — extract last N messages
        var recent = Array.from(messages).slice(-10);
        for (var i = 0; i < recent.length; i++) {
          var msg = recent[i];
          var role = msg.getAttribute('data-role')
            || msg.getAttribute('data-testid')
            || '';
          var text = msg.innerText.trim();
          if (text.length < 5) continue;
          // Cap individual messages
          if (text.length > 800) text = text.slice(0, 800) + '...';
          if (role) lines.push("[" + role + "]");
          lines.push(text);
          lines.push("");
        }
      } else {
        // Non-chat: grab main content text, skip navs
        var text = mainEl.innerText.trim();
        if (text.length > 4000) text = text.slice(0, 4000) + '...';
        lines.push(text);
      }
    } else {
      // No main element found — try to strip noise manually
      // Clone body, remove known noise elements
      var clone = document.body.cloneNode(true);
      var noise = clone.querySelectorAll(
        'nav, header, footer, aside, [role="banner"], [role="navigation"], ' +
        '[role="complementary"], [class*="sidebar"], [class*="Sidebar"], ' +
        '[class*="nav-"], [class*="Nav-"], [class*="footer"], [class*="Footer"], ' +
        '[class*="header"], [class*="Header"], [class*="cookie"], [class*="Cookie"], ' +
        '[class*="banner"], [class*="Banner"], [class*="toolbar"], [class*="Toolbar"], ' +
        '[class*="menu"], [class*="Menu"]:not([role="main"]), ' +
        'script, style, noscript, [aria-hidden="true"]'
      );
      for (var i = 0; i < noise.length; i++) {
        try { noise[i].remove(); } catch(e) {}
      }
      var text = clone.innerText.trim();
      if (text.length > 4000) text = text.slice(0, 4000) + '...';
      lines.push(text);
    }

    return lines.join("\n").trim();
  }

  var smart = smartGrab();

  // ── Report ──
  var sep = "═".repeat(60);
  console.log("\n" + sep);
  console.log("GRAB COMPARISON TEST");
  console.log(sep);
  console.log("");
  console.log("RAW GRAB (document.body.innerText):");
  console.log("  Characters: " + rawGrab.length);
  console.log("  Est. tokens: ~" + estimateTokens(rawGrab));
  console.log("");
  console.log("SMART GRAB (content-targeted):");
  console.log("  Characters: " + smart.length);
  console.log("  Est. tokens: ~" + estimateTokens(smart));
  console.log("");
  console.log("SAVINGS: " + Math.round((1 - smart.length / rawGrab.length) * 100) + "% fewer characters");
  console.log("");
  console.log(sep);
  console.log("RAW CONTENT (first 2000 chars):");
  console.log(sep);
  console.log(rawGrab.slice(0, 2000));
  console.log("");
  console.log(sep);
  console.log("SMART CONTENT:");
  console.log(sep);
  console.log(smart);
  console.log("");

  // Also return as object for programmatic use
  return {
    raw: { chars: rawGrab.length, tokens: estimateTokens(rawGrab), content: rawGrab },
    smart: { chars: smart.length, tokens: estimateTokens(smart), content: smart },
    savingsPercent: Math.round((1 - smart.length / rawGrab.length) * 100)
  };
})();
