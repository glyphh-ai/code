/**
 * DomBridge — executes JavaScript in panel BrowserViews.
 *
 * The bridge between yosup and any web app's DOM.
 * Uses webContents.executeJavaScript() to extract content,
 * inject text, click elements, and read page structure.
 */

import { WebContents } from "electron";
import { CommandMapping } from "./app-connector";

// ── DOM Extraction (for connector agent) ────────────────

/**
 * Extract a structured, LLM-optimized representation of the page.
 *
 * Instead of a raw tree (which wastes tokens on non-interactive divs),
 * this returns organized sections:
 *   - INPUTS: all text inputs, textareas, contenteditable areas
 *   - BUTTONS: all clickable controls with context
 *   - FORMS: input→button clusters (e.g. search bar + search button)
 *   - CONTENT: main content regions with previews
 *   - NAV: sidebar/header navigation links
 *   - MODALS: any visible overlays/dialogs
 *   - TOOLBARS: action bar clusters
 *
 * Each element includes a CSS selector the agent can use directly.
 */
export async function extractDomStructure(webContents: WebContents): Promise<string> {
  const script = `(function() {
  var W = window.innerWidth, H = window.innerHeight;
  var result = {
    page: { url: location.href, title: document.title, viewport: W + 'x' + H },
    inputs: [],
    buttons: [],
    forms: [],
    content: [],
    nav: [],
    modals: [],
    toolbars: [],
    links: [],
    selects: [],
  };

  // ── Selector generator ──────────────────────────
  function uniq(el) {
    if (!el || el === document.body) return 'body';
    if (el.id && el.id.length > 3 && !/^\d|^[:.]/. test(el.id) && !/\d{4,}/.test(el.id) && !/^(ember|react|ng|mat-|cdk-|gb_)/.test(el.id) && !/^[a-z]{1,2}\d/.test(el.id)) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    var tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid=' + JSON.stringify(tid) + ']';
    var aria = el.getAttribute('aria-label');
    if (aria) return tag + '[aria-label=' + JSON.stringify(aria) + ']';
    var ph = el.getAttribute('placeholder');
    if (ph) return tag + '[placeholder=' + JSON.stringify(ph) + ']';
    var name = el.getAttribute('name');
    if (name) return tag + '[name=' + JSON.stringify(name) + ']';
    var role = el.getAttribute('role');
    if (role && el.parentElement) {
      var sameRole = el.parentElement.querySelectorAll(tag + '[role=' + JSON.stringify(role) + ']');
      if (sameRole.length === 1) return tag + '[role=' + JSON.stringify(role) + ']';
    }
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

  function vis(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function pos(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function zone(el) {
    var r = el.getBoundingClientRect();
    var cx = r.x + r.width/2, cy = r.y + r.height/2;
    var row = cy < H*0.12 ? 'top' : cy > H*0.88 ? 'bottom' : 'middle';
    var col = cx < W*0.22 ? 'left' : cx > W*0.78 ? 'right' : 'center';
    return row + '-' + col;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim();
  }

  function nearLabel(el) {
    if (el.id) {
      var lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
      if (lbl) return lbl.textContent.trim().slice(0, 50);
    }
    var aria = el.getAttribute('aria-label');
    if (aria) return aria.slice(0, 50);
    var ph = el.getAttribute('placeholder');
    if (ph) return ph.slice(0, 50);
    var prev = el.previousElementSibling;
    if (prev && prev.tagName !== 'SCRIPT') {
      var t = prev.textContent.trim();
      if (t.length > 0 && t.length < 50) return t;
    }
    return '';
  }

  // Track inputs by selector for form clustering
  var inputMap = {};

  // ── INPUTS ──────────────────────────────────────
  var inputEls = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), ' +
    'textarea, [contenteditable="true"]:not([aria-hidden="true"]), [role="textbox"]'
  );
  for (var i = 0; i < inputEls.length && result.inputs.length < 15; i++) {
    var el = inputEls[i];
    if (!vis(el)) continue;
    var tag = el.tagName.toLowerCase();
    var type = 'text';
    if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
      type = 'contenteditable';
      var r = el.getBoundingClientRect();
      if (r.top > H * 0.6) type = 'chat';
      if (r.height > 200) type = 'editor';
    } else if (tag === 'textarea') {
      type = 'textarea';
      if (el.getBoundingClientRect().height > 200) type = 'editor';
    } else {
      type = el.getAttribute('type') || 'text';
    }
    var ph = el.getAttribute('placeholder') || '';
    if (ph.toLowerCase().match(/search|find|filter/)) type = 'search';
    if (ph.toLowerCase().match(/message|reply|chat|ask|type here|send a message/)) type = 'chat';
    if (ph.toLowerCase().match(/subject/)) type = 'subject';
    if (ph.toLowerCase().match(/to:|recipients|email/i)) type = 'recipient';

    var sel = uniq(el);
    var entry = {
      selector: sel,
      type: type,
      placeholder: ph || undefined,
      label: nearLabel(el) || undefined,
      zone: zone(el),
      focused: document.activeElement === el,
      editable: el.getAttribute('contenteditable') === 'true' || undefined,
      multiline: (tag === 'textarea' || el.getAttribute('contenteditable') === 'true') || undefined,
      value: (el.value || el.textContent || '').trim().slice(0, 60) || undefined,
    };
    result.inputs.push(entry);
    inputMap[sel] = entry;
  }

  // ── BUTTONS ─────────────────────────────────────
  var btnEls = document.querySelectorAll(
    'button:not([aria-hidden="true"]):not([disabled]), ' +
    '[role="button"]:not([aria-hidden="true"]):not([disabled]), ' +
    'a[role="button"], input[type="submit"], input[type="button"]'
  );
  for (var i = 0; i < btnEls.length && result.buttons.length < 25; i++) {
    var el = btnEls[i];
    if (!vis(el)) continue;
    var text = directText(el) || (el.textContent || '').trim().slice(0, 50);
    var aria = el.getAttribute('aria-label') || '';
    var title = el.getAttribute('title') || '';
    var label = text || aria || title;
    if (!label) continue;

    // Detect icon-only buttons
    var isIcon = !text && (aria || title);

    // Find closest input
    var nearInput = '';
    var parentForm = el.closest('form');
    if (parentForm) {
      var fi = parentForm.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
      if (fi) nearInput = uniq(fi);
    }
    if (!nearInput && el.parentElement) {
      var sib = el.parentElement.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
      if (sib && sib !== el) nearInput = uniq(sib);
    }

    result.buttons.push({
      selector: uniq(el),
      label: label.slice(0, 50),
      ariaLabel: aria || undefined,
      title: title || undefined,
      iconOnly: isIcon || undefined,
      nearInput: nearInput || undefined,
      zone: zone(el),
      type: el.getAttribute('type') || undefined,
    });
  }

  // ── FORMS (input + button clusters) ─────────────
  var formEls = document.querySelectorAll('form');
  for (var i = 0; i < formEls.length && result.forms.length < 8; i++) {
    var form = formEls[i];
    if (!vis(form)) continue;
    var inputs = form.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable="true"]');
    var buttons = form.querySelectorAll('button, input[type="submit"], [role="button"]');
    if (inputs.length === 0 && buttons.length === 0) continue;
    var fields = [];
    for (var j = 0; j < inputs.length && fields.length < 8; j++) {
      if (!vis(inputs[j])) continue;
      fields.push({
        selector: uniq(inputs[j]),
        type: inputs[j].getAttribute('type') || inputs[j].tagName.toLowerCase(),
        label: nearLabel(inputs[j]) || undefined,
        placeholder: inputs[j].getAttribute('placeholder') || undefined,
      });
    }
    var actions = [];
    for (var j = 0; j < buttons.length && actions.length < 4; j++) {
      if (!vis(buttons[j])) continue;
      var t = (buttons[j].textContent || '').trim().slice(0, 30) || buttons[j].getAttribute('aria-label') || '';
      if (t) actions.push({ selector: uniq(buttons[j]), label: t });
    }
    if (fields.length > 0) {
      result.forms.push({
        selector: uniq(form),
        action: form.getAttribute('action') || undefined,
        zone: zone(form),
        fields: fields,
        buttons: actions
      });
    }
  }

  // ── CONTENT ─────────────────────────────────────
  var contentSels = [
    { q: '[role="main"]', role: 'main' },
    { q: 'main', role: 'main' },
    { q: '[data-testid*="conversation"], [data-testid*="chat"], [data-testid*="thread"], [data-testid*="message"]', role: 'conversation' },
    { q: '[role="feed"]', role: 'feed' },
    { q: '[role="list"]', role: 'list' },
    { q: 'article', role: 'article' },
    { q: '[class*="message-list"], [class*="chat-messages"], [class*="conversation"]', role: 'conversation' },
    { q: '[class*="editor"], [class*="document"], [class*="note-body"]', role: 'editor' },
  ];
  var seenContent = new Set();
  for (var c = 0; c < contentSels.length && result.content.length < 6; c++) {
    var els = document.querySelectorAll(contentSels[c].q);
    for (var j = 0; j < els.length && result.content.length < 6; j++) {
      var el = els[j];
      if (!vis(el)) continue;
      var s = uniq(el);
      if (seenContent.has(s)) continue;
      seenContent.add(s);
      var text = (el.innerText || '').trim();
      if (text.length < 20) continue;
      var p = pos(el);
      result.content.push({
        selector: s,
        role: contentSels[c].role,
        zone: zone(el),
        size: p.w + 'x' + p.h,
        preview: text.slice(0, 300),
        scrollable: (el.scrollHeight > el.clientHeight + 50) || undefined,
      });
    }
  }

  // ── NAV ─────────────────────────────────────────
  var navEls = document.querySelectorAll(
    'nav a, [role="tab"], [role="menuitem"], [role="treeitem"], ' +
    '[class*="sidebar"] a, [class*="nav"] a, [class*="menu"] a'
  );
  var seenNav = new Set();
  for (var i = 0; i < navEls.length && result.nav.length < 15; i++) {
    var el = navEls[i];
    if (!vis(el)) continue;
    var text = (el.textContent || '').trim().slice(0, 50);
    if (!text || seenNav.has(text)) continue;
    seenNav.add(text);
    var type = 'link';
    if (el.getAttribute('role') === 'tab') type = 'tab';
    else if (el.getAttribute('role') === 'menuitem') type = 'menu-item';
    else if (el.getAttribute('role') === 'treeitem') type = 'tree-item';
    var active = el.getAttribute('aria-selected') === 'true' ||
                 el.getAttribute('aria-current') === 'page' ||
                 el.classList.contains('active') || el.classList.contains('selected');
    result.nav.push({
      selector: uniq(el),
      text: text,
      type: type,
      zone: zone(el),
      active: active || undefined,
      href: el.getAttribute('href') || undefined,
    });
  }

  // ── MODALS / DIALOGS ────────────────────────────
  var modalEls = document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [class*="modal"]:not([aria-hidden="true"]), ' +
    '[class*="popup"]:not([aria-hidden="true"]), [class*="overlay"]:not([aria-hidden="true"])'
  );
  for (var i = 0; i < modalEls.length && result.modals.length < 3; i++) {
    var el = modalEls[i];
    if (!vis(el)) continue;
    var title = '';
    var heading = el.querySelector('h1, h2, h3, [class*="title"]');
    if (heading) title = heading.textContent.trim().slice(0, 60);
    var inputs = el.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]');
    var buttons = el.querySelectorAll('button, [role="button"]');
    var fields = [];
    for (var j = 0; j < inputs.length && fields.length < 5; j++) {
      if (vis(inputs[j])) fields.push({ selector: uniq(inputs[j]), label: nearLabel(inputs[j]) || undefined });
    }
    var acts = [];
    for (var j = 0; j < buttons.length && acts.length < 4; j++) {
      if (vis(buttons[j])) {
        var t = (buttons[j].textContent || '').trim().slice(0, 30) || buttons[j].getAttribute('aria-label') || '';
        if (t) acts.push({ selector: uniq(buttons[j]), label: t });
      }
    }
    result.modals.push({
      selector: uniq(el),
      title: title || undefined,
      fields: fields.length ? fields : undefined,
      buttons: acts.length ? acts : undefined,
    });
  }

  // ── TOOLBARS ────────────────────────────────────
  var toolbarEls = document.querySelectorAll('[role="toolbar"], [class*="toolbar"], [class*="action-bar"], [class*="actions"]');
  for (var i = 0; i < toolbarEls.length && result.toolbars.length < 4; i++) {
    var el = toolbarEls[i];
    if (!vis(el)) continue;
    var btns = el.querySelectorAll('button, [role="button"], a');
    var items = [];
    for (var j = 0; j < btns.length && items.length < 8; j++) {
      if (!vis(btns[j])) continue;
      var t = (btns[j].textContent || '').trim().slice(0, 30) || btns[j].getAttribute('aria-label') || btns[j].getAttribute('title') || '';
      if (t) items.push({ selector: uniq(btns[j]), label: t });
    }
    if (items.length > 0) {
      result.toolbars.push({ selector: uniq(el), zone: zone(el), items: items });
    }
  }

  // ── SELECT / DROPDOWN MENUS ─────────────────────
  var selectEls = document.querySelectorAll('select:not([hidden])');
  for (var i = 0; i < selectEls.length && result.selects.length < 6; i++) {
    var el = selectEls[i];
    if (!vis(el)) continue;
    var opts = [];
    for (var j = 0; j < el.options.length && opts.length < 10; j++) {
      opts.push({ value: el.options[j].value, text: el.options[j].text.trim().slice(0, 40), selected: el.options[j].selected || undefined });
    }
    result.selects.push({
      selector: uniq(el),
      label: nearLabel(el) || undefined,
      options: opts,
    });
  }

  // ── LINKS (important non-nav anchors) ───────────
  var linkEls = document.querySelectorAll('a[href]:not(nav a):not([class*="nav"] a)');
  var seenLinks = new Set();
  for (var i = 0; i < linkEls.length && result.links.length < 10; i++) {
    var el = linkEls[i];
    if (!vis(el)) continue;
    var text = (el.textContent || '').trim().slice(0, 50);
    var href = el.getAttribute('href') || '';
    if (!text || seenLinks.has(text) || href.startsWith('#') || href === '') continue;
    seenLinks.add(text);
    result.links.push({ selector: uniq(el), text: text, href: href.slice(0, 100) });
  }

  // Strip empty arrays for cleaner output
  for (var key in result) {
    if (Array.isArray(result[key]) && result[key].length === 0) delete result[key];
  }

  return JSON.stringify(result, null, 2);
})()`;
  return await webContents.executeJavaScript(script);
}

// ── Command Execution ───────────────────────────────────

/**
 * Resolve an element by CSS selector, with text-based fallback.
 * Injects a __yo_resolved marker attribute so subsequent calls can target it.
 */
async function resolveElement(wc: WebContents, selector: string, text?: string): Promise<string | null> {
  const escaped = escapeSelector(selector);
  const escapedText = text ? JSON.stringify(text.trim().slice(0, 80)) : "null";
  return await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      var textHint = ${escapedText};
      if (el && textHint) {
        var t = (el.textContent || '').trim();
        if (t !== textHint && t.indexOf(textHint) === -1) {
          var all = document.querySelectorAll('${escaped}');
          for (var i = 0; i < all.length; i++) {
            var ct = (all[i].textContent || '').trim();
            if (ct === textHint || ct.indexOf(textHint) !== -1) { el = all[i]; break; }
          }
        }
      }
      if (!el && textHint) {
        var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walk.nextNode()) {
          var n = walk.currentNode;
          var nt = (n.textContent || '').trim();
          if (nt === textHint && n.offsetWidth > 0 && n.offsetHeight > 0) { el = n; break; }
        }
      }
      if (!el) return null;
      el.setAttribute('__yo_resolved', '1');
      return '[__yo_resolved="1"]';
    })()
  `);
}

async function cleanupResolved(wc: WebContents): Promise<void> {
  await wc.executeJavaScript(`
    var r = document.querySelector('[__yo_resolved]');
    if (r) r.removeAttribute('__yo_resolved');
  `).catch(() => {});
}

/**
 * Execute a mapped command against a live DOM.
 */
export async function executeCommand(
  webContents: WebContents,
  mapping: CommandMapping,
  value?: string,
): Promise<string> {
  const resolved = await resolveElement(webContents, mapping.selector, mapping.text);
  const sel = resolved || mapping.selector;

  let result: string;
  switch (mapping.action) {
    case "extractText":
      result = await extractText(webContents, sel);
      break;
    case "extractHTML":
      result = await extractHTML(webContents, sel);
      break;
    case "setValue":
      result = await setValue(webContents, sel, value || "");
      break;
    case "click":
      result = await clickElement(webContents, sel);
      break;
    case "custom":
      if (mapping.script) {
        result = await runCustomScript(webContents, mapping.script, value);
      } else {
        result = "No script defined for custom action";
      }
      break;
    default:
      result = `Unknown action: ${mapping.action}`;
  }

  await cleanupResolved(webContents);
  return result;
}

/**
 * Validate that a CSS selector matches an element in the live DOM.
 */
/** Escape a CSS selector for safe interpolation into a JS string literal. */
function escapeSelector(selector: string): string {
  return selector
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "");
}

export async function validateSelector(webContents: WebContents, selector: string): Promise<boolean> {
  const escaped = escapeSelector(selector);
  return await webContents.executeJavaScript(
    `!!document.querySelector('${escaped}')`,
  );
}

// ── Primitives ──────────────────────────────────────────

async function extractText(wc: WebContents, selector: string): Promise<string> {
  const escaped = escapeSelector(selector);
  return await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      if (!el) return '[Element not found: ${escaped}]';
      return el.innerText || el.textContent || '';
    })()
  `);
}

async function extractHTML(wc: WebContents, selector: string): Promise<string> {
  const escaped = escapeSelector(selector);
  return await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      if (!el) return '';
      return el.innerHTML;
    })()
  `);
}

async function setValue(wc: WebContents, selector: string, value: string): Promise<string> {
  const escaped = escapeSelector(selector);

  // Step 1: Focus the target element (with fallbacks if selector is stale)
  const focused = await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');

      // If selector didn't match, try common input fallbacks
      if (!el) {
        var fallbacks = [
          '[role="textbox"]',
          '[contenteditable="true"]:not([aria-hidden="true"])',
          'textarea:not([hidden]):not([aria-hidden="true"])',
          'input[type="text"]:not([hidden])',
          'input:not([type]):not([hidden])',
        ];
        for (var i = 0; i < fallbacks.length; i++) {
          var candidates = document.querySelectorAll(fallbacks[i]);
          for (var j = 0; j < candidates.length; j++) {
            var c = candidates[j];
            var r = c.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { el = c; break; }
          }
          if (el) break;
        }
      }

      if (!el) return 'not-found';

      // Walk up to find editable target if needed
      var target = el;
      if (el.getAttribute('contenteditable') !== 'true' &&
          el.getAttribute('role') !== 'textbox' &&
          el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var cur = el;
        while (cur && cur !== document.body) {
          if (cur.getAttribute('contenteditable') === 'true' ||
              cur.getAttribute('role') === 'textbox') {
            target = cur;
            break;
          }
          cur = cur.parentElement;
        }
      }

      // Focus and clear
      target.focus();
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        var proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(target, '');
        else target.value = '';
      } else {
        // Select all content so insertText replaces it
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      return 'ok';
    })()
  `);

  if (focused === "not-found") return `Element not found: ${escaped}`;

  // Step 2: Use webContents.insertText for real keyboard-level input.
  // This works with every framework (Angular, React, ProseMirror, etc.)
  // because it's indistinguishable from the user typing.
  await wc.insertText(value);

  return "ok";
}

async function clickElement(wc: WebContents, selector: string): Promise<string> {
  const escaped = escapeSelector(selector);
  const coords = await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus && el.focus();
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()
  `);
  if (!coords) return `Element not found: ${escaped}`;
  await wc.sendInputEvent({ type: "mouseMove", x: coords.x, y: coords.y });
  await new Promise(r => setTimeout(r, 80));
  await wc.sendInputEvent({ type: "mouseDown", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await wc.sendInputEvent({ type: "mouseUp", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  return "ok";
}

/** Dangerous patterns that should never appear in custom scripts */
const BLOCKED_SCRIPT_PATTERNS = [
  /(?<![.\w])require\s*\(/i, // Node.js require (not window.require or .require)
  /process\s*\./i,          // Node.js process access
  /child_process/i,         // Shell execution
  /eval\s*\(/i,             // Dynamic code evaluation
  /(?:new\s+|[^a-z])Function\s*\(/,  // Dynamic function creation (not plain `function()`)
  /fetch\s*\(\s*['"`](?!https?:\/\/)/i, // Non-HTTP fetch (data:, file:, etc.)
  /XMLHttpRequest/i,        // Raw XHR (prefer fetch with URL check)
  /window\.open\s*\(/i,     // Opening new windows
  /location\s*[.=]/i,       // Navigation/redirect
  /document\.cookie/i,      // Cookie access
  /localStorage|sessionStorage/i, // Storage exfiltration
  /indexedDB/i,
  /navigator\.sendBeacon/i, // Silent data exfiltration
  /WebSocket/i,             // Opening websocket connections
];

async function runCustomScript(wc: WebContents, script: string, value?: string): Promise<string> {
  // Security: block scripts containing dangerous patterns
  for (const pattern of BLOCKED_SCRIPT_PATTERNS) {
    if (pattern.test(script)) {
      return `[blocked — custom script contains restricted pattern: ${pattern.source}]`;
    }
  }

  // The script can reference __value__ as the input
  const wrapped = `
    (async function() {
      var __value__ = ${JSON.stringify(value || "")};
      ${script}
    })()
  `;
  const result = await wc.executeJavaScript(wrapped);
  return String(result ?? "ok");
}
