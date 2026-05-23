/**
 * relay-handlers — panel management + RPA primitives exposed through the relay.
 *
 * Each handler returns plain JSON-serializable data; the relay-client wraps
 * thrown errors into `{ok:false,error}` frames automatically. Handlers that
 * target a panel always validate the panel exists and its webContents is
 * alive before doing work.
 */

import type { BrowserWindow, WebContents } from "electron";
import type { PanelManager } from "./panel-manager.js";
import type { McpManager } from "./mcp-manager.js";
import { registerRelayHandler } from "./relay-client.js";

interface Deps {
  panelManager: PanelManager;
  getMainWindow: () => BrowserWindow | null;
  getMcpManager: () => McpManager | null;
}

/** Pull a live webContents for a panel id, or throw a structured error. */
function getLiveWc(pm: PanelManager, panelId: string): WebContents {
  const wc = pm.getGuestOrWebContents(panelId);
  if (!wc || wc.isDestroyed()) {
    throw new Error(`panel not found or not loaded: ${panelId}`);
  }
  return wc;
}

/** Stringify a value for executeJavaScript injection without breaking quotes. */
function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

export function installRelayHandlers(deps: Deps): void {
  const { panelManager, getMainWindow, getMcpManager } = deps;

  // ── panels ──────────────────────────────────────────────

  registerRelayHandler("panels.list", () => {
    const ids = panelManager.getLoadedPanelIds();
    const active = panelManager.activePanelId;
    return ids.map((id) => {
      const wc = panelManager.getWebContents(id);
      const dead = !wc || wc.isDestroyed();
      return {
        id,
        url: dead ? null : wc!.getURL(),
        title: dead ? null : wc!.getTitle(),
        active: id === active,
      };
    });
  });

  registerRelayHandler("panels.switch", (params) => {
    const id = String((params as { id?: string } | null | undefined)?.id || "");
    if (!id) throw new Error("panels.switch requires { id }");
    const win = getMainWindow();
    if (!win) throw new Error("main window not ready");
    const ok = panelManager.switchTo(id, win);
    if (!ok) throw new Error(`could not switch to panel: ${id}`);
    return { id, switched: true };
  });

  registerRelayHandler("panels.close", (params) => {
    const id = String((params as { id?: string } | null | undefined)?.id || "");
    if (!id) throw new Error("panels.close requires { id }");
    const win = getMainWindow();
    if (!win) throw new Error("main window not ready");
    panelManager.closePanel(id, win);
    return { id, closed: true };
  });

  registerRelayHandler("panels.open", (params) => {
    const p = params as { id?: string; url?: string; webviewTag?: boolean } | null;
    const id = String(p?.id || "");
    const url = String(p?.url || "");
    if (!id || !url) throw new Error("panels.open requires { id, url }");
    panelManager.addPanel(id, url, undefined, false, p?.webviewTag ?? false);
    const win = getMainWindow();
    if (win) panelManager.switchTo(id, win);
    return { id, url, opened: true };
  });

  // ── rpa ─────────────────────────────────────────────────

  // Click an element matched by a CSS selector. Throws if the element doesn't
  // exist or isn't visible (offsetParent === null catches `display:none`).
  registerRelayHandler("rpa.click", async (params) => {
    const p = params as { panelId?: string; selector?: string } | null;
    const panelId = String(p?.panelId || "");
    const selector = String(p?.selector || "");
    if (!panelId || !selector) throw new Error("rpa.click requires { panelId, selector }");
    const wc = getLiveWc(panelManager, panelId);
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { ok: false, error: "no match for selector" };
        if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") {
          return { ok: false, error: "element not visible" };
        }
        el.click();
        return { ok: true };
      })()
    `, true);
    if (!result || !result.ok) throw new Error(result?.error || "click failed");
    return { clicked: true };
  });

  // Set the value of an input/textarea and dispatch input/change so frameworks
  // pick up the new value. Falls back to focus + execCommand for editable divs.
  registerRelayHandler("rpa.type", async (params) => {
    const p = params as { panelId?: string; selector?: string; text?: string } | null;
    const panelId = String(p?.panelId || "");
    const selector = String(p?.selector || "");
    const text = String(p?.text ?? "");
    if (!panelId || !selector) throw new Error("rpa.type requires { panelId, selector, text }");
    const wc = getLiveWc(panelManager, panelId);
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { ok: false, error: "no match for selector" };
        var t = ${jsLiteral(text)};
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          var setter = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set;
          if (setter) setter.call(el, t); else el.value = t;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
        if (el.isContentEditable) {
          el.focus();
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, t);
          return { ok: true };
        }
        return { ok: false, error: "element is not an input or contenteditable" };
      })()
    `, true);
    if (!result || !result.ok) throw new Error(result?.error || "type failed");
    return { typed: true };
  });

  // Read visible text or a specific attribute from a matched element.
  registerRelayHandler("rpa.read", async (params) => {
    const p = params as { panelId?: string; selector?: string; attr?: string } | null;
    const panelId = String(p?.panelId || "");
    const selector = String(p?.selector || "");
    const attr = p?.attr ? String(p.attr) : "";
    if (!panelId || !selector) throw new Error("rpa.read requires { panelId, selector }");
    const wc = getLiveWc(panelManager, panelId);
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { ok: false, error: "no match for selector" };
        var attrName = ${jsLiteral(attr)};
        if (attrName) return { ok: true, value: el.getAttribute(attrName) };
        if ("value" in el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          return { ok: true, value: (el).value };
        }
        return { ok: true, value: (el.innerText || el.textContent || "").trim() };
      })()
    `, true);
    if (!result || !result.ok) throw new Error(result?.error || "read failed");
    return { value: result.value };
  });

  // Capture a screenshot of the panel's webContents as a base64 PNG.
  // Note: Phase 2 returns base64; Phase 3 will switch to binary frames once
  // the relay's wire format supports it (saves ~33% on transfer).
  registerRelayHandler("rpa.screenshot", async (params) => {
    const panelId = String((params as { panelId?: string } | null | undefined)?.panelId || "");
    if (!panelId) throw new Error("rpa.screenshot requires { panelId }");
    const wc = getLiveWc(panelManager, panelId);
    const image = await wc.capturePage();
    if (image.isEmpty()) throw new Error("capturePage returned empty image");
    return { dataUrl: image.toDataURL() };
  });

  // ── MCP passthrough — re-expose the user's connected-app tools ─

  // List every tool from the user's connected MCP servers, flattened. The
  // external caller can discover what's available before invoking. Schemas
  // come through so the caller can shape arguments correctly.
  registerRelayHandler("mcp.list_tools", () => {
    const mm = getMcpManager();
    if (!mm) return [];
    return mm.getAllTools().map((t) => ({
      serverId: t.serverId,
      serverName: t.serverName,
      name: t.name,
      qualifiedName: t.qualifiedName,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  });

  // Invoke a specific tool by (serverId, name). Returns the coerced text
  // result McpManager.callToolDirect produces — image content becomes
  // `[image: mime]`, errors are caught and returned as a string.
  registerRelayHandler("mcp.call_tool", async (params) => {
    const p = params as { serverId?: string; name?: string; args?: Record<string, unknown> } | null;
    const serverId = String(p?.serverId || "");
    const name = String(p?.name || "");
    if (!serverId || !name) throw new Error("mcp.call_tool requires { serverId, name }");
    const mm = getMcpManager();
    if (!mm) throw new Error("MCP manager not initialized");
    const result = await mm.callToolDirect(serverId, name, p?.args || {});
    return { result };
  });
}
