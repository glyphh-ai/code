/**
 * DomScanner — fast zero-LLM panel scan.
 *
 * Injects a lightweight JS function into a panel's webContents that
 * returns a structured map of actionable elements: inputs, buttons,
 * content areas, and navigation items. The navigator agent uses this
 * map to make surgical tool calls instead of guessing selectors.
 *
 * Execution: ~5ms, no LLM cost, runs via executeJavaScript.
 */

import { WebContents } from "electron";

export interface PanelScan {
  url: string;
  title: string;
  inputs: Array<{
    selector: string;
    type: string;           // "chat", "search", "text", "email", "password", "contenteditable"
    placeholder?: string;
    label?: string;
    focused: boolean;
  }>;
  buttons: Array<{
    selector: string;
    text: string;
    ariaLabel?: string;
    near?: string;          // nearby input or context hint
  }>;
  content: Array<{
    selector: string;
    role: string;           // "main", "conversation", "list", "article"
    preview: string;        // first ~200 chars
  }>;
  nav: Array<{
    selector: string;
    text: string;
    type: string;           // "link", "tab", "menu-item"
  }>;
}

const SCAN_SCRIPT = `(function() {
  var result = {
    url: location.href,
    title: document.title,
    inputs: [],
    buttons: [],
    content: [],
    nav: []
  };

  // ── Unique selector generator ──────────────────────
  function uniq(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    // Try aria-label
    var aria = el.getAttribute('aria-label');
    if (aria) return tag + '[aria-label=' + JSON.stringify(aria) + ']';
    // Try data-testid
    var tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid=' + JSON.stringify(tid) + ']';
    // Try placeholder
    var ph = el.getAttribute('placeholder');
    if (ph) return tag + '[placeholder=' + JSON.stringify(ph) + ']';
    // Try role
    var role = el.getAttribute('role');
    if (role) {
      var text = directText(el).slice(0, 30);
      if (text) return tag + '[role=' + JSON.stringify(role) + ']';
    }
    // Try name
    var name = el.getAttribute('name');
    if (name) return tag + '[name=' + JSON.stringify(name) + ']';
    // Fallback: nth-of-type
    var parent = el.parentElement;
    if (parent) {
      var siblings = parent.querySelectorAll(':scope > ' + tag);
      if (siblings.length === 1) return uniq(parent) + ' > ' + tag;
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === el) return uniq(parent) + ' > ' + tag + ':nth-of-type(' + (i+1) + ')';
      }
    }
    return tag;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim();
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function nearbyLabel(el) {
    // Check for associated label
    if (el.id) {
      var lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
      if (lbl) return lbl.textContent.trim().slice(0, 40);
    }
    // Check aria-label
    var aria = el.getAttribute('aria-label');
    if (aria) return aria.slice(0, 40);
    // Check placeholder
    var ph = el.getAttribute('placeholder');
    if (ph) return ph.slice(0, 40);
    // Check preceding sibling or parent text
    var prev = el.previousElementSibling;
    if (prev) {
      var t = prev.textContent.trim();
      if (t.length < 40 && t.length > 0) return t;
    }
    return '';
  }

  // ── Scan inputs ────────────────────────────────────
  var inputEls = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), ' +
    'textarea, ' +
    '[contenteditable="true"]:not([aria-hidden="true"]), ' +
    '[role="textbox"]'
  );
  for (var i = 0; i < inputEls.length && result.inputs.length < 10; i++) {
    var el = inputEls[i];
    if (!visible(el)) continue;
    var tag = el.tagName.toLowerCase();
    var type = 'text';
    if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
      type = 'contenteditable';
      // Heuristic: if near bottom of page or has chat-like context, it's a chat input
      var r = el.getBoundingClientRect();
      if (r.top > window.innerHeight * 0.6) type = 'chat';
    } else if (tag === 'textarea') {
      type = 'textarea';
    } else {
      type = el.getAttribute('type') || 'text';
    }
    var ph = el.getAttribute('placeholder') || '';
    if (ph.toLowerCase().match(/search|find|filter/)) type = 'search';
    if (ph.toLowerCase().match(/message|reply|chat|ask|type here/)) type = 'chat';

    result.inputs.push({
      selector: uniq(el),
      type: type,
      placeholder: ph || undefined,
      label: nearbyLabel(el) || undefined,
      focused: document.activeElement === el
    });
  }

  // ── Scan buttons ───────────────────────────────────
  var btnEls = document.querySelectorAll(
    'button:not([aria-hidden="true"]):not([disabled]), ' +
    '[role="button"]:not([aria-hidden="true"]):not([disabled])'
  );
  for (var i = 0; i < btnEls.length && result.buttons.length < 15; i++) {
    var el = btnEls[i];
    if (!visible(el)) continue;
    var text = (el.textContent || '').trim().slice(0, 40);
    var aria = el.getAttribute('aria-label') || '';
    // Skip empty/icon-only buttons with no aria-label
    if (!text && !aria) continue;
    // Figure out what input this button is near
    var near = '';
    var prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'INPUT' || prev.tagName === 'TEXTAREA' ||
        prev.getAttribute('contenteditable') === 'true')) {
      near = nearbyLabel(prev) || prev.getAttribute('placeholder') || 'input';
    }
    // Also check parent for nearby input
    if (!near && el.parentElement) {
      var sibInput = el.parentElement.querySelector('input, textarea, [contenteditable="true"]');
      if (sibInput && sibInput !== el) {
        near = nearbyLabel(sibInput) || sibInput.getAttribute('placeholder') || 'input';
      }
    }
    result.buttons.push({
      selector: uniq(el),
      text: text || aria,
      ariaLabel: aria || undefined,
      near: near || undefined
    });
  }

  // ── Scan content areas ─────────────────────────────
  var contentSels = [
    { sel: '[role="main"]', role: 'main' },
    { sel: 'main', role: 'main' },
    { sel: '[data-testid*="conversation"], [data-testid*="chat"], [data-testid*="thread"]', role: 'conversation' },
    { sel: '[role="feed"], [role="list"]', role: 'list' },
    { sel: 'article', role: 'article' },
  ];
  for (var c = 0; c < contentSels.length && result.content.length < 5; c++) {
    var els = document.querySelectorAll(contentSels[c].sel);
    for (var j = 0; j < els.length && result.content.length < 5; j++) {
      var el = els[j];
      if (!visible(el)) continue;
      var text = (el.innerText || '').trim();
      if (text.length < 20) continue;
      result.content.push({
        selector: uniq(el),
        role: contentSels[c].role,
        preview: text.slice(0, 200)
      });
    }
  }

  // ── Scan navigation ────────────────────────────────
  var navEls = document.querySelectorAll(
    'nav a, [role="tab"], [role="menuitem"], .sidebar a, [class*="sidebar"] a, [class*="nav"] a'
  );
  for (var i = 0; i < navEls.length && result.nav.length < 10; i++) {
    var el = navEls[i];
    if (!visible(el)) continue;
    var text = (el.textContent || '').trim().slice(0, 40);
    if (!text) continue;
    var type = 'link';
    if (el.getAttribute('role') === 'tab') type = 'tab';
    else if (el.getAttribute('role') === 'menuitem') type = 'menu-item';
    result.nav.push({ selector: uniq(el), text: text, type: type });
  }

  return JSON.stringify(result);
})()`;

/**
 * Scan a panel's DOM and return a structured map of actionable elements.
 * Fast (~5ms), no LLM cost.
 */
export async function scanPanel(wc: WebContents): Promise<PanelScan | null> {
  if (wc.isDestroyed()) return null;
  try {
    const raw = await wc.executeJavaScript(SCAN_SCRIPT);
    return JSON.parse(raw) as PanelScan;
  } catch {
    return null;
  }
}

/**
 * Format a PanelScan into a compact text block for the navigator's context.
 * Keeps it under ~1000 chars so it doesn't flood the prompt.
 */
export function formatScan(scan: PanelScan): string {
  const lines: string[] = [`[${scan.title}] ${scan.url}`];

  if (scan.inputs.length > 0) {
    lines.push("INPUTS:");
    for (const inp of scan.inputs) {
      const parts = [`  ${inp.type}: ${inp.selector}`];
      if (inp.placeholder) parts.push(`"${inp.placeholder}"`);
      if (inp.label) parts.push(`label="${inp.label}"`);
      if (inp.focused) parts.push("(focused)");
      lines.push(parts.join(" "));
    }
  }

  if (scan.buttons.length > 0) {
    lines.push("BUTTONS:");
    for (const btn of scan.buttons) {
      const parts = [`  "${btn.text}": ${btn.selector}`];
      if (btn.near) parts.push(`near="${btn.near}"`);
      lines.push(parts.join(" "));
    }
  }

  if (scan.content.length > 0) {
    lines.push("CONTENT:");
    for (const c of scan.content) {
      lines.push(`  [${c.role}] ${c.selector}: ${c.preview.slice(0, 80)}...`);
    }
  }

  if (scan.nav.length > 0) {
    lines.push("NAV:");
    for (const n of scan.nav.slice(0, 5)) {
      lines.push(`  ${n.type}: "${n.text}" ${n.selector}`);
    }
  }

  return lines.join("\n");
}
