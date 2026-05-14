/**
 * substrate-deps.ts — Panel / tab / cypher / project / council substrate deps.
 *
 * Extracted from main.ts.  Builds the second setSubstrateToolDeps() call that
 * wires runtime panel-interaction, tab management, cypher/project CRUD, and
 * council orchestration into the unified substrate tool registry.
 *
 * Usage (in main.ts):
 *   import { buildSubstrateDeps } from "./substrate-deps";
 *   setSubstrateToolDeps(buildSubstrateDeps({ ... }));
 */

import type { BrowserWindow } from "electron";
import type { PanelManager } from "./panel-manager";
import type { AppConnector } from "./app-connector";
import type { WorkspaceManager } from "./workspace-manager";
import type { CypherBus } from "./cypher-bus";
import type { YoAgent } from "./yo-agent";
import type { YoInterceptor } from "./yo-interceptor";
import type { SubstrateToolDeps } from "./substrate/tools";
import type { CouncilCreateConfig } from "./council-session";

// ── Deps interface ──────────────────────────────────────────────

export interface BuildSubstrateDepsArgs {
  /** Electron main BrowserWindow (may be null during startup). */
  mainWindow: BrowserWindow | null;
  panelManager: PanelManager;
  appConnector: AppConnector;
  workspaceManager: WorkspaceManager;
  cypherBus: CypherBus;
  yoAgent: YoAgent;
  yoInterceptor: YoInterceptor;

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
  councilHtml: string;
  councilPreload: string;
  execCommand: (cmd: string, sourcePanelId?: string) => Promise<string>;

  // Server helpers
  serverGetAuthed: <T>(url: string) => Promise<T>;
  serverPostAuthed: <T = unknown>(url: string, body: Record<string, unknown>) => Promise<T>;
  getDropAuthStatus: () => any;
  fetchServerModels: () => Promise<Array<{ provider: string; model: string; display_name?: string; max_context_tokens?: number }>>;

  // Preferences
  setPreference: (key: string, value: unknown) => void;
  yoPanelWidth: () => number;
}

// ── Builder ─────────────────────────────────────────────────────

export function buildSubstrateDeps(deps: BuildSubstrateDepsArgs): SubstrateToolDeps {
  const {
    mainWindow,
    panelManager,
    appConnector,
    workspaceManager,
    cypherBus,
    yoAgent,
    yoInterceptor,
    openTabs,
    getTabBrowserCounter,
    setTabBrowserCounter,
    ensureTab,
    scanPanel,
    formatScan,
    smartGrab,
    executeCommand,
    browserHtmlUrl,
    councilHtml,
    councilPreload,
    execCommand,
    serverGetAuthed,
    serverPostAuthed,
    getDropAuthStatus,
    fetchServerModels,
    setPreference,
    yoPanelWidth,
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
    cypher: {
      getCurrent: () => {
        // Lazy import to avoid loading order issues
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getCurrentCypher } = require("./current-cypher");
        return getCurrentCypher();
      },
      post: async (cypherId: string, text: string) => {
        try {
          // Broadcast locally to all running agents
          const wsSlug = workspaceManager.getActive()?.slug || "";
          cypherBus.dispatchBroadcast(wsSlug, {
            from: "orchestrator",
            body: text,
            kind: "post",
          });
          // Persist to server
          await serverPostAuthed(`/api/cyphers/${encodeURIComponent(cypherId)}/events`, {
            kind: "post", payload: { text },
          });
          return `Posted to cypher.`;
        } catch (err) {
          return `Post failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      postTo: async (cypherId: string, agentLocalId: string, text: string) => {
        try {
          // Deliver locally to the running agent via the bus
          const wsSlug = workspaceManager.getActive()?.slug || "";
          cypherBus.dispatchInbound(agentLocalId, wsSlug, {
            from: "orchestrator",
            to: agentLocalId,
            body: text,
            kind: "post_to",
          });
          // Also persist to server for observers/recovery
          await serverPostAuthed(`/api/cyphers/${encodeURIComponent(cypherId)}/events`, {
            kind: "post_to", payload: { to: agentLocalId, text },
          });
          return `Routed to ${agentLocalId}.`;
        } catch (err) {
          return `Post failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      status: async (cypherId: string) => {
        try {
          const [c, jR, dR, eR] = await Promise.all([
            serverGetAuthed<{ cypher?: { title?: string; goal?: string; status?: string; type?: string } }>(`/api/cyphers/${encodeURIComponent(cypherId)}`),
            serverGetAuthed<{ jammers?: Array<{ agent_local_id: string; user_id: string; role?: string; left_at?: string | null }> }>(`/api/cyphers/${encodeURIComponent(cypherId)}/jammers`),
            serverGetAuthed<{ assignments?: Array<{ agent_local_id: string; position: string; area?: string | null }> }>(`/api/cyphers/${encodeURIComponent(cypherId)}/draft`),
            serverGetAuthed<{ events?: Array<{ kind: string; by_agent_id?: string | null; payload?: Record<string, unknown>; created_at: string }> }>(`/api/cyphers/${encodeURIComponent(cypherId)}/events?limit=10`),
          ]);
          const lines: string[] = [];
          const cy = c?.cypher;
          if (cy) {
            lines.push(`Cypher: ${cy.title ?? "(untitled)"} [${cy.status}]`);
            if (cy.goal) lines.push(`Goal: ${cy.goal}`);
          }
          const jammers = jR?.jammers ?? [];
          const active = jammers.filter((j) => !j.left_at);
          lines.push(`Jammers (${active.length} active):`);
          for (const j of active) lines.push(`  - ${j.agent_local_id}${j.role ? ` (${j.role})` : ""}`);
          const ass = dR?.assignments ?? [];
          if (ass.length > 0) {
            lines.push(`Draft:`);
            for (const a of ass) lines.push(`  - ${a.agent_local_id} → ${a.position}${a.area ? `: ${a.area}` : ""}`);
          }
          const events = eR?.events ?? [];
          if (events.length > 0) {
            lines.push(`Recent activity:`);
            for (const e of events.slice(-10)) {
              const who = e.by_agent_id ?? "system";
              const body = (e.payload as { text?: string; body?: string } | undefined)?.text
                ?? (e.payload as { text?: string; body?: string } | undefined)?.body
                ?? JSON.stringify(e.payload).slice(0, 80);
              lines.push(`  [${e.kind}] ${who}: ${body}`);
            }
          }
          return lines.join("\n");
        } catch (err) {
          return `Status fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      wrap: async (cypherId: string) => {
        try {
          await serverPostAuthed(`/api/cyphers/${encodeURIComponent(cypherId)}/wrap`, {});
          return `Cypher wrapped.`;
        } catch (err) {
          return `Wrap failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    project: {
      getForCypher: async (cypherId: string) => {
        try {
          const r = await serverGetAuthed<{ project?: { slug: string } }>(`/api/projects/by-cypher/${encodeURIComponent(cypherId)}`);
          return r?.project?.slug || null;
        } catch { return null; }
      },
      create: async (cypherId: string, goal: string, linkedRepos: string[]) => {
        try {
          // Get GitHub owner info from drop auth
          const ghStatus = await getDropAuthStatus();
          const ownerLogin = ghStatus?.github?.gh_login || "local";
          const r = await serverPostAuthed(`/api/projects`, {
            goal,
            cypher_id: cypherId,
            owner_login: ownerLogin,
            owner_kind: "user",
            linked_repos: linkedRepos.map((repo) => ({ full_name: repo })),
          }) as any;
          return r?.project?.slug ? `Project created: ${r.project.slug}` : `Project created.`;
        } catch (err) {
          return `Create failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      board: async (projectRef: string) => {
        try {
          const r = await serverGetAuthed<{ items?: Array<{ id: string; title: string; status: string; assignee_user_id?: string; pr_url?: string; pr_state?: string }> }>(`/api/projects/${encodeURIComponent(projectRef)}/board`);
          const items = r?.items || [];
          if (items.length === 0) return "Board is empty. Add items with project_add_item.";
          const lines = items.map((i) => {
            const assign = i.assignee_user_id ? ` → ${i.assignee_user_id}` : "";
            const pr = i.pr_url ? ` [PR: ${i.pr_state || "open"}]` : "";
            return `[${i.status}] ${i.title}${assign}${pr} (id: ${i.id})`;
          });
          return lines.join("\n");
        } catch (err) {
          return `Board fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      createItem: async (projectRef: string, title: string, body?: string, assignee?: string) => {
        try {
          const r = await serverPostAuthed(`/api/projects/${encodeURIComponent(projectRef)}/items`, {
            title, body, assignee_agent_id: assignee,
          }) as any;
          const item = r?.item;
          if (item?.id) {
            const cypherWc = panelManager.getView("cypher")?.webContents;
            if (cypherWc && !cypherWc.isDestroyed()) {
              cypherWc.send("cypher-project-item-update", { id: item.id, title, status: item.status || "Backlog", assignee });
            }
            return `Item created: "${title}" (id: ${item.id})`;
          }
          return `Item created.`;
        } catch (err) {
          return `Item create failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      updateItemStatus: async (projectRef: string, itemId: string, status: string) => {
        try {
          await serverPostAuthed(`/api/projects/${encodeURIComponent(projectRef)}/items/${encodeURIComponent(itemId)}/status`, { status });
          const cypherWc = panelManager.getView("cypher")?.webContents;
          if (cypherWc && !cypherWc.isDestroyed()) {
            cypherWc.send("cypher-project-item-update", { id: itemId, status });
          }
          return `Item moved to ${status}.`;
        } catch (err) {
          return `Status update failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      assignItem: async (projectRef: string, itemId: string, assigneeAgentId: string) => {
        try {
          await serverPostAuthed(`/api/projects/${encodeURIComponent(projectRef)}/items/${encodeURIComponent(itemId)}/assign`, { agent_id: assigneeAgentId });
          const cypherWc = panelManager.getView("cypher")?.webContents;
          if (cypherWc && !cypherWc.isDestroyed()) {
            cypherWc.send("cypher-project-item-update", { id: itemId, assignee: assigneeAgentId });
          }
          return `Item assigned to ${assigneeAgentId}.`;
        } catch (err) {
          return `Assign failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      commentOnItem: async (projectRef: string, itemId: string, body: string) => {
        try {
          const r = await serverPostAuthed(`/api/projects/${encodeURIComponent(projectRef)}/items/${encodeURIComponent(itemId)}/comment`, { body }) as any;
          return r?.url ? `Comment posted: ${r.url}` : "Comment posted.";
        } catch (err) {
          return `Comment failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    council: {
      getCurrent: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getCurrentCouncil } = require("./current-council");
        return getCurrentCouncil();
      },
      setCurrent: (id: string | null) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { setCurrentCouncil } = require("./current-council");
        setCurrentCouncil(id);
      },
      create: async (config) => {
        const { createCouncil } = await import("./council-session");
        const models = await fetchServerModels();
        const enriched = { ...config } as CouncilCreateConfig;
        if (enriched.members) {
          enriched.members = enriched.members.map((m) => {
            const sm = models.find((s) => s.provider === m.provider && s.model === m.model);
            return { ...m, max_context_tokens: sm?.max_context_tokens ?? undefined };
          });
        }
        const r = createCouncil(enriched, null);
        return r.ok ? { ok: true, council_id: r.council_id } : { ok: false, error: r.error };
      },
      runRound: async (councilId: string) => {
        const { runCouncilRound } = await import("./council-session");
        return runCouncilRound(councilId);
      },
      interject: (councilId: string, text: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { interjectCouncil } = require("./council-session");
        return interjectCouncil(councilId, text);
      },
      askMember: async (councilId: string, memberId: string, question: string) => {
        const { askCouncilMember } = await import("./council-session");
        return askCouncilMember(councilId, memberId, question);
      },
      stop: (councilId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { stopCouncil } = require("./council-session");
        return stopCouncil(councilId);
      },
      summarize: async (councilId: string) => {
        const { summarizeCouncil } = await import("./council-session");
        return summarizeCouncil(councilId);
      },
      status: (councilId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { renderCouncilStatus } = require("./council-session");
        return renderCouncilStatus(councilId);
      },
      listProviderModels: async () => {
        try {
          const r = await serverGetAuthed<{ models: Array<{ provider: string; model: string; display_name: string }> }>("/api/models");
          return r?.models ?? [];
        } catch { return []; }
      },
      openPanel: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const app = appConnector.get("council");
        const needsLoad = !panelManager.hasPanel("council");
        if (app && needsLoad) {
          panelManager.addPanel("council", councilHtml, councilPreload);
        }
        panelManager.switchTo("council", mainWindow!);
        panelManager.setRightInset(yoPanelWidth());
        mainWindow.webContents.send("yo-panel-open", "");
        const wc = panelManager.getWebContents("council");
        if (wc && needsLoad) {
          await new Promise<void>((resolve) => {
            const onLoad = () => { wc.removeListener("did-finish-load", onLoad); resolve(); };
            wc.on("did-finish-load", onLoad);
            setTimeout(resolve, 3000);
          });
        }
        if (wc) {
          const { getCurrentCouncil } = require("./current-council");
          const cid = getCurrentCouncil();
          if (cid) {
            const { setCouncilForwardWc } = require("./council-session");
            setCouncilForwardWc(cid, wc);
          }
        }
      },
      setMode: (mode: string) => {
        if (mode === "council") {
          yoAgent.setCouncilMode(true);
          setPreference("agentMode", "council");
          mainWindow?.webContents.send("agent-mode-changed", "council");
          yoInterceptor.setAgentMode("council");
        }
      },
      notifyReady: (info: { name: string; council_prompt: string; members: Array<{ provider: string; model: string }>; style: string; round_cap: number }) => {
        mainWindow?.webContents.send("yo-panel-council-ready", info);
        const wc = panelManager.getWebContents("council");
        if (wc) {
          const { getCurrentCouncil } = require("./current-council");
          const cid = getCurrentCouncil();
          wc.send("council-convened", { council_id: cid, ...info });
        }
      },
    },
  };
}
