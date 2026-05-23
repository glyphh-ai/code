/**
 * substrate-deps.ts — Panel / tab / swarm substrate deps.
 *
 * Extracted from main.ts.  Builds the second setSubstrateToolDeps() call that
 * wires runtime panel-interaction, tab management, and local swarm spawning
 * into the unified substrate tool registry.
 *
 * Usage (in main.ts):
 *   import { buildSubstrateDeps } from "./substrate-deps";
 *   setSubstrateToolDeps(buildSubstrateDeps({ ... }));
 */

import type { BrowserWindow } from "electron";
import type { PanelManager } from "./panel-manager";
import type { AppConnector } from "./app-connector";
import type { SubstrateToolDeps } from "./substrate/tools";

// ── Deps interface ──────────────────────────────────────────────

export interface BuildSubstrateDepsArgs {
  /** Electron main BrowserWindow (may be null during startup). */
  mainWindow: BrowserWindow | null;
  panelManager: PanelManager;
  appConnector: AppConnector;

  // Mutable tab state owned by main.ts
  openTabs: string[];
  getTabBrowserCounter: () => number;
  setTabBrowserCounter: (n: number) => void;
  ensureTab: (id: string) => void;

  // Functions / helpers injected from main.ts scope
  scanPanel: (wc: Electron.WebContents) => Promise<any>;
  formatScan: (scan: any) => string;
  smartGrab: (wc: Electron.WebContents) => Promise<string | null>;
  executeCommand: (wc: Electron.WebContents, mapping: any, value?: string) => Promise<string>;
  browserHtmlUrl: (initialUrl?: string) => string;
  execCommand: (cmd: string, sourcePanelId?: string) => Promise<string>;

  // User-created agent registry (drives list_agents / call_agent tools).
  agentRegistry?: {
    list: () => Array<{ id: string; name: string; role?: string; mode?: string }>;
    get: (id: string) => { id: string; name: string; role?: string } | null;
  };

  // Local swarm — draft + spawn (returns a text status for the yo agent).
  swarmCreate: (goal: string, agentIds?: string[], size?: number) => Promise<string>;

  // Local council — convene a multi-LLM debate + open the Council app.
  councilCreate: (config: {
    council_prompt: string;
    name?: string;
    style?: string;
    round_cap?: number;
    members?: Array<{ provider: string; model: string; startup_prompt?: string }>;
  }) => Promise<string>;
}

// ── Builder ─────────────────────────────────────────────────────

export function buildSubstrateDeps(deps: BuildSubstrateDepsArgs): SubstrateToolDeps {
  const {
    mainWindow,
    panelManager,
    appConnector,
    openTabs,
    getTabBrowserCounter,
    setTabBrowserCounter,
    ensureTab,
    scanPanel,
    formatScan,
    smartGrab,
    executeCommand,
    browserHtmlUrl,
    execCommand,
    swarmCreate,
    councilCreate,
    agentRegistry,
  } = deps;

  return {
    panels: {
      list: () => {
        const ids = panelManager.getLoadedPanelIds();
        if (ids.length === 0) return "No panels open.";
        return ids.map((id: string) => {
          const app = appConnector.get(id);
          const url = app?.url || "";
          const active = id === panelManager.activePanelId ? " [active]" : "";
          return `${id}${active} — ${app?.name || id} (${url})`;
        }).join("\n");
      },
      scan: async (panelId) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc) return null;
        const scan = await scanPanel(wc);
        if (!scan) return null;
        let result = formatScan(scan);
        const app = appConnector.get(panelId);
        if (app && Object.keys(app.commands).length > 0) {
          const lines: string[] = ["MAPPED COMMANDS:"];
          for (const [name, cmd] of Object.entries(app.commands)) {
            const parts = [`  ${name}: ${cmd.action} "${cmd.selector}"`];
            if (cmd.description) parts.push(`— ${cmd.description}`);
            lines.push(parts.join(" "));
          }
          result += "\n" + lines.join("\n");
        }
        return result;
      },
      grab: async (panelId) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc) return null;
        const app = appConnector.get(panelId);
        let content = "";
        if (app?.commands.grab) {
          try { content = await executeCommand(wc, app.commands.grab); } catch {}
        }
        if (!content || content.startsWith("[Element not found")) {
          try { content = await smartGrab(wc) || ""; } catch {}
        }
        return content || null;
      },
      click: async (panelId, text, selector) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        try {
          const result = await wc.executeJavaScript(`(function(){
            function realClick(el) {
              var rect = el.getBoundingClientRect();
              var x = rect.left + rect.width / 2;
              var y = rect.top + rect.height / 2;
              var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
              el.dispatchEvent(new PointerEvent('pointerdown', opts));
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new PointerEvent('pointerup', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
            }
            function findClickable(el) {
              var cur = el;
              while (cur && cur !== document.body) {
                var tag = cur.tagName.toLowerCase();
                if (tag === 'button' || tag === 'a' || cur.getAttribute('role') === 'button' ||
                    cur.getAttribute('role') === 'tab' || cur.getAttribute('role') === 'menuitem' ||
                    cur.onclick || cur.getAttribute('tabindex') !== null) return cur;
                cur = cur.parentElement;
              }
              return el;
            }
            ${selector && !text ? `
            var el = document.querySelector(${JSON.stringify(selector)});
            if (el) { realClick(findClickable(el)); return 'Clicked successfully.'; }
            return 'Element not found: ' + ${JSON.stringify(selector)};
            ` : ''}
            ${text ? `
            var target = ${JSON.stringify(text)};
            var targetLower = target.toLowerCase();
            var candidates = [];
            var all = document.querySelectorAll('[aria-label],[title],[data-tooltip],[placeholder],[data-testid]');
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              var attrs = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.getAttribute('placeholder'), el.getAttribute('data-testid')];
              for (var j = 0; j < attrs.length; j++) {
                if (!attrs[j]) continue;
                var val = attrs[j].toLowerCase();
                if (val === targetLower) { candidates.push({ el: el, score: 0 }); break; }
                if (val.includes(targetLower)) { candidates.push({ el: el, score: val.length }); break; }
              }
            }
            if (candidates.length === 0) {
              var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              while (walker.nextNode()) {
                var el = walker.currentNode;
                var rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                var t = (el.innerText || el.textContent || '').trim();
                if (!t || t.length > 500) continue;
                var tLower = t.toLowerCase();
                if (tLower === targetLower) { candidates.push({ el: el, score: 0 }); break; }
                if (tLower.includes(targetLower) && t.length < 200) { candidates.push({ el: el, score: t.length }); }
              }
            }
            candidates.sort(function(a, b) { return a.score - b.score; });
            if (candidates.length > 0) { realClick(findClickable(candidates[0].el)); return 'Clicked successfully.'; }
            return 'Element not found: ' + target;
            ` : ''}
          })()`);
          await new Promise((r) => setTimeout(r, 500));
          return result;
        } catch (err) {
          return `Click failed: ${err instanceof Error ? err.message : err}`;
        }
      },
      navigate: async (panelId, url) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        try { wc.loadURL(url); return `Navigating to ${url}`; }
        catch (err) { return `Navigation failed: ${err instanceof Error ? err.message : err}`; }
      },
      type: async (panelId, text, opts) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        const shouldClear = opts.clear !== false;
        try {
          const focused = await wc.executeJavaScript(`(function(){
            var el = null;
            ${opts.selector ? `el = document.querySelector(${JSON.stringify(opts.selector)});` : ''}
            ${opts.label && !opts.selector ? `
            if (!el) { var labels = document.querySelectorAll('label, [aria-label]'); for (var i = 0; i < labels.length; i++) { var lbl = labels[i]; var lt = (lbl.getAttribute('aria-label') || lbl.textContent || '').trim().toLowerCase(); if (lt.includes(${JSON.stringify(opts.label.toLowerCase())})) { var forId = lbl.getAttribute('for'); if (forId) { el = document.getElementById(forId); break; } el = lbl.querySelector('input,textarea,[contenteditable]'); if (el) break; el = lbl.nextElementSibling; if (el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable)) break; el = null; } } }` : ''}
            ${opts.placeholder && !opts.selector ? `if (!el) { var inputs = document.querySelectorAll('input[placeholder],textarea[placeholder]'); for (var i = 0; i < inputs.length; i++) { if (inputs[i].placeholder.toLowerCase().includes(${JSON.stringify(opts.placeholder.toLowerCase())})) { el = inputs[i]; break; } } }` : ''}
            if (!el) { if (document.activeElement && (document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA'||document.activeElement.isContentEditable)) { el = document.activeElement; } }
            if (!el) return 'not_found';
            el.focus();
            if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') { el.select(); }
            else if (el.isContentEditable) { var range = document.createRange(); range.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
            return 'focused';
          })()`);
          if (focused === 'not_found') return 'Input field not found.';
          if (shouldClear) {
            await wc.executeJavaScript(`(function(){ var el = document.activeElement; if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } else if (el.isContentEditable) { el.textContent=''; } })()`);
          }
          wc.insertText(text);
          await new Promise((r) => setTimeout(r, 200));
          if (opts.submit) {
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
            await new Promise((r) => setTimeout(r, 50));
            wc.sendInputEvent({ type: 'char', keyCode: 'Return' });
            await new Promise((r) => setTimeout(r, 50));
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
            await new Promise((r) => setTimeout(r, 300));
            const clicked = await wc.executeJavaScript(`(function(){ var selectors = ['button[aria-label*="Send" i]','button[aria-label*="Submit" i]','button[data-testid*="send"]','button[data-testid*="submit"]','button[class*="send" i]','form button[type="submit"]']; for (var i = 0; i < selectors.length; i++) { var btn = document.querySelector(selectors[i]); if (btn && !btn.disabled) { btn.click(); return 'clicked'; } } return 'no-btn'; })()`);
            if (clicked === 'clicked') await new Promise((r) => setTimeout(r, 200));
            return 'Typed and submitted.';
          }
          return 'Typed successfully.';
        } catch (err) { return `Type failed: ${err instanceof Error ? err.message : err}`; }
      },
      open: async (urlOrName, panelId) => {
        if (!mainWindow || mainWindow.isDestroyed()) return "Main window not available.";
        let url = urlOrName; let id = panelId; let isUrl = false;
        try { new URL(urlOrName); isUrl = true; } catch {}
        if (!isUrl) {
          const appName = urlOrName.toLowerCase().replace(/\s+/g, "");
          const app = appConnector.get(appName);
          if (app?.url) { url = app.url; id = id || app.id; }
          else if (panelManager.hasPanel(appName)) {
            const ok = panelManager.switchTo(appName, mainWindow);
            return ok ? `Switched to panel "${appName}".` : `Failed to switch to "${appName}".`;
          } else { return `Unknown app "${urlOrName}". Provide a full URL starting with https://.`; }
        }
        id = id || new URL(url).hostname.replace(/^www\./, "").split(".")[0];
        if (!panelManager.hasPanel(id)) panelManager.addPanel(id, url);
        const ok = panelManager.switchTo(id, mainWindow);
        if (!ok) return `Failed to open panel "${id}".`;
        await new Promise((r) => setTimeout(r, 2000));
        return `Opened panel "${id}" at ${url}.`;
      },
      openBackground: async (urlOrName, panelId) => {
        if (!mainWindow || mainWindow.isDestroyed()) return "Main window not available.";
        let url = urlOrName; let id = panelId; let isUrl = false;
        try { new URL(urlOrName); isUrl = true; } catch {}
        if (!isUrl) {
          const appName = urlOrName.toLowerCase().replace(/\s+/g, "");
          const app = appConnector.get(appName);
          if (app?.url) { url = app.url; id = id || "bg-" + app.id; }
          else return `Unknown app "${urlOrName}". Provide a full URL starting with https://.`;
        }
        id = id || "bg-" + new URL(url).hostname.replace(/^www\./, "").split(".")[0];
        if (!panelManager.hasPanel(id)) panelManager.addPanel(id, url);
        const view = panelManager.getOrCreateView(id, mainWindow);
        if (!view) return `Failed to create background panel "${id}".`;
        await new Promise((r) => setTimeout(r, 2000));
        return `Background panel "${id}" loaded at ${url}.`;
      },
      runCommand: async (panelId, command, value) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        const app = appConnector.get(panelId);
        if (!app) return `No app config for panel "${panelId}".`;
        const mapping = app.commands[command];
        if (!mapping) return `No command "${command}" mapped for ${app.name}. Available: ${Object.keys(app.commands).join(", ") || "none"}`;
        try { return await executeCommand(wc, mapping, value); }
        catch { return `Command "${command}" failed.`; }
      },
      screenshot: async (panelId) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return null;
        try { const image = await wc.capturePage(); return image.toDataURL(); }
        catch { return null; }
      },
      refresh: async (panelId) => {
        panelManager.refresh(panelId);
        return panelId ? `Refreshed panel: ${panelId}` : "Refreshed active panel.";
      },
    },
    tabs: {
      list: () => openTabs.map((id) => ({
        id,
        title: appConnector.get(id)?.name || id,
        url: appConnector.get(id)?.url,
      })),
      switch: (id) => { if (mainWindow) panelManager.switchTo(id, mainWindow); },
      close: (id) => {
        if (!mainWindow) return;
        const idx = openTabs.indexOf(id);
        if (idx >= 0) openTabs.splice(idx, 1);
        const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
        panelManager.closePanel(id, mainWindow, nextId);
      },
      create: () => {
        const counter = getTabBrowserCounter() + 1;
        setTabBrowserCounter(counter);
        const id = `browse-${counter}`;
        panelManager.addPanel(id, browserHtmlUrl(""), undefined, undefined, true);
        if (mainWindow) panelManager.switchTo(id, mainWindow);
        ensureTab(id);
        return id;
      },
    },
    execCommand: async (cmd: string) => {
      const clean = cmd.replace(/^\.(dip|drip)\b/i, "$1");
      const result = await execCommand(clean);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
      return result;
    },
    apps: {
      list: () => appConnector.list().map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url,
        description: (a as { description?: string }).description,
      })),
      open: async (id: string) => {
        const result = await execCommand(`dip ${id}`);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
        return result;
      },
    },
    swarm: {
      create: (goal: string, agentIds?: string[], size?: number) => swarmCreate(goal, agentIds, size),
    },
    council: {
      create: (config) => councilCreate(config),
    },
    agentRegistry,
  };
}
