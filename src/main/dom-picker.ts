/**
 * DomPicker — visual element picker for manual command mapping.
 *
 * Injects a highlight overlay into a BrowserView. User hovers to
 * preview, clicks to select. Returns a CSS selector for the picked element.
 *
 * This is the fallback when the connector agent can't auto-map a command.
 */

import { WebContents } from "electron";

export interface PickResult {
  selector: string;
  tag: string;
  text: string;
  id?: string;
  classes?: string;
  role?: string;
  ariaLabel?: string;
  isEditable: boolean;
  isClickable: boolean;
}

/**
 * Activate the DOM picker in a BrowserView.
 * Returns a promise that resolves when the user clicks an element,
 * or rejects if they press Escape to cancel.
 */
export function activatePicker(webContents: WebContents): Promise<PickResult> {
  const script = `
    new Promise(function(resolve, reject) {
      // Overlay container
      var overlay = document.createElement('div');
      overlay.id = '__yo_picker_overlay__';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;cursor:crosshair;';

      // Highlight box
      var highlight = document.createElement('div');
      highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;' +
        'border:2px solid #a855f7;background:rgba(168,85,247,0.08);border-radius:3px;' +
        'transition:all 0.05s ease;box-shadow:0 0 12px rgba(168,85,247,0.3);';
      document.body.appendChild(highlight);

      // Label showing element info
      var label = document.createElement('div');
      label.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;' +
        'background:#1a1a1a;color:#e0e0e0;font:12px "SF Mono",monospace;' +
        'padding:4px 8px;border-radius:4px;border:1px solid #a855f7;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.5);max-width:400px;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;';
      document.body.appendChild(label);

      var lastTarget = null;

      function getElementUnder(e) {
        overlay.style.pointerEvents = 'none';
        var el = document.elementFromPoint(e.clientX, e.clientY);
        overlay.style.pointerEvents = 'auto';
        return el;
      }

      function buildSelector(el) {
        if (!el || el === document.body || el === document.documentElement) return 'body';

        // Prefer unique identifiers
        if (el.id) return '#' + CSS.escape(el.id);

        var testid = el.getAttribute('data-testid');
        if (testid) return '[data-testid="' + testid + '"]';

        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          var sel = el.tagName.toLowerCase() + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        // Build path
        var parts = [];
        var cur = el;
        while (cur && cur !== document.body && parts.length < 5) {
          var tag = cur.tagName.toLowerCase();
          if (cur.id) {
            parts.unshift('#' + CSS.escape(cur.id));
            break;
          }
          var cls = Array.from(cur.classList).slice(0, 3).map(function(c) { return '.' + CSS.escape(c); }).join('');
          var seg = tag + cls;
          // Add nth-child if needed for uniqueness
          if (cur.parentElement) {
            var siblings = Array.from(cur.parentElement.children).filter(function(s) {
              return s.tagName === cur.tagName;
            });
            if (siblings.length > 1) {
              var idx = siblings.indexOf(cur) + 1;
              seg += ':nth-of-type(' + idx + ')';
            }
          }
          parts.unshift(seg);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }

      function updateHighlight(el) {
        if (!el || el === overlay) {
          highlight.style.display = 'none';
          label.style.display = 'none';
          return;
        }
        var rect = el.getBoundingClientRect();
        highlight.style.display = 'block';
        highlight.style.left = rect.left + 'px';
        highlight.style.top = rect.top + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';

        var tag = el.tagName.toLowerCase();
        var info = tag;
        if (el.id) info += '#' + el.id;
        else if (el.className && typeof el.className === 'string') info += '.' + el.className.split(' ')[0];
        if (el.getAttribute('role')) info += ' [' + el.getAttribute('role') + ']';
        label.textContent = info;
        label.style.display = 'block';
        label.style.left = rect.left + 'px';
        label.style.top = Math.max(0, rect.top - 28) + 'px';
      }

      overlay.addEventListener('mousemove', function(e) {
        var el = getElementUnder(e);
        if (el !== lastTarget) {
          lastTarget = el;
          updateHighlight(el);
        }
      });

      overlay.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var el = getElementUnder(e);
        cleanup();
        if (!el) { resolve(null); return; }

        var tag = el.tagName.toLowerCase();
        var isEditable = el.getAttribute('contenteditable') === 'true' ||
          tag === 'input' || tag === 'textarea';
        var role = el.getAttribute('role');
        var isClickable = tag === 'button' || tag === 'a' ||
          role === 'button' || role === 'link' || !!el.onclick;

        resolve({
          selector: buildSelector(el),
          tag: tag,
          text: (el.innerText || el.textContent || '').trim().slice(0, 100),
          id: el.id || undefined,
          classes: (typeof el.className === 'string' ? el.className : '') || undefined,
          role: role || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          isEditable: isEditable,
          isClickable: isClickable,
        });
      });

      function onKey(e) {
        if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      }
      document.addEventListener('keydown', onKey);

      function cleanup() {
        overlay.remove();
        highlight.remove();
        label.remove();
        document.removeEventListener('keydown', onKey);
      }

      document.body.appendChild(overlay);
    })
  `;

  return webContents.executeJavaScript(script);
}
