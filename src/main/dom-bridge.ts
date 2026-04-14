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
 * Extract a simplified DOM tree from a page.
 * Returns a compact representation the LLM can reason about:
 * tag names, IDs, classes, roles, aria-labels, visible text, interactivity.
 */
export async function extractDomStructure(webContents: WebContents): Promise<string> {
  const script = `
    (function() {
      const MAX_TEXT = 60;
      const MAX_DEPTH = 10;
      const MAX_CHILDREN = 30;
      const SKIP = new Set(['script','style','noscript','svg','link','meta','br','hr']);

      function sel(el, depth) {
        if (depth > MAX_DEPTH || !el || el.nodeType !== 1) return null;
        var tag = el.tagName.toLowerCase();
        if (SKIP.has(tag)) return null;

        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && tag !== 'input' && tag !== 'textarea') return null;

        var n = { tag: tag };
        if (el.id) n.id = el.id;
        if (el.className && typeof el.className === 'string') {
          var cls = el.className.trim().split(/\\s+/).slice(0, 5).join(' ');
          if (cls) n.cls = cls;
        }
        var role = el.getAttribute('role');
        if (role) n.role = role;
        var aria = el.getAttribute('aria-label');
        if (aria) n.aria = aria.slice(0, 80);
        var ph = el.getAttribute('placeholder');
        if (ph) n.placeholder = ph.slice(0, 80);
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          n.type = el.getAttribute('type') || tag;
        }
        if (el.getAttribute('contenteditable') === 'true') n.editable = true;
        var tid = el.getAttribute('data-testid');
        if (tid) n.testid = tid;

        // Direct text only
        var txt = '';
        for (var i = 0; i < el.childNodes.length; i++) {
          if (el.childNodes[i].nodeType === 3) txt += el.childNodes[i].textContent;
        }
        txt = txt.trim().slice(0, MAX_TEXT);
        if (txt) n.text = txt;

        // Interactive flag
        if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
            tag === 'select' || role === 'button' || role === 'textbox' || role === 'link' ||
            el.getAttribute('contenteditable') === 'true' || el.onclick) {
          n.interactive = true;
        }

        var kids = [];
        var ch = el.children;
        for (var j = 0; j < Math.min(ch.length, MAX_CHILDREN); j++) {
          var k = sel(ch[j], depth + 1);
          if (k) kids.push(k);
        }
        if (kids.length > 0) n.children = kids;
        return n;
      }

      return JSON.stringify(sel(document.body, 0));
    })()
  `;
  return await webContents.executeJavaScript(script);
}

// ── Command Execution ───────────────────────────────────

/**
 * Execute a mapped command against a live DOM.
 */
export async function executeCommand(
  webContents: WebContents,
  mapping: CommandMapping,
  value?: string,
): Promise<string> {
  switch (mapping.action) {
    case "extractText":
      return extractText(webContents, mapping.selector);
    case "extractHTML":
      return extractHTML(webContents, mapping.selector);
    case "setValue":
      return setValue(webContents, mapping.selector, value || "");
    case "click":
      return clickElement(webContents, mapping.selector);
    case "custom":
      if (mapping.script) {
        return runCustomScript(webContents, mapping.script, value);
      }
      return "No script defined for custom action";
    default:
      return `Unknown action: ${mapping.action}`;
  }
}

/**
 * Validate that a CSS selector matches an element in the live DOM.
 */
export async function validateSelector(webContents: WebContents, selector: string): Promise<boolean> {
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return await webContents.executeJavaScript(
    `!!document.querySelector('${escaped}')`,
  );
}

// ── Primitives ──────────────────────────────────────────

async function extractText(wc: WebContents, selector: string): Promise<string> {
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      if (!el) return '[Element not found: ${escaped}]';
      return el.innerText || el.textContent || '';
    })()
  `);
}

async function extractHTML(wc: WebContents, selector: string): Promise<string> {
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      if (!el) return '';
      return el.innerHTML;
    })()
  `);
}

async function setValue(wc: WebContents, selector: string, value: string): Promise<string> {
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

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
  const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return await wc.executeJavaScript(`
    (function() {
      var el = document.querySelector('${escaped}');
      if (!el) return 'Element not found: ${escaped}';
      el.click();
      return 'ok';
    })()
  `);
}

async function runCustomScript(wc: WebContents, script: string, value?: string): Promise<string> {
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
