/**
 * home-ipc — IPC for the Settings / home panel: the usage dashboard, the
 * MCP server manager, app connectors, exposed-MCP tokens, and the prompt log.
 *
 * (Formerly bundled into drop-ipc; the Drop is gone, these handlers are not.)
 */

import { ipcMain } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import type { McpExpose } from "./mcp-expose";
import type { McpManager } from "./mcp-manager";
import type { ConnectorManager } from "./connectors";
import type { PanelManager } from "./panel-manager";
import { reconnectRelay, getRelayStatus } from "./relay-client";
import { serverGetAuthed, serverPostAuthed, serverDeleteAuthed } from "./auth";
import { listVibes, getVibe, createVibe, deleteVibe, type VibeMeta } from "./vibe-store";

interface HomeIpcDeps {
  mcpExpose: McpExpose;
  mcpManager: McpManager | null;
  connectorManager: ConnectorManager | null;
  canUseMcp: () => { allowed: boolean; reason?: string };
  usageTracker: { getToday: () => unknown; getHistory: (days: number) => unknown; getAllTime: () => unknown };
  promptLog: { list: (offset: number, limit: number) => unknown; search: (query: string, limit: number) => unknown; get: (id: string) => unknown; count: number };
  llmConfig: { provider: string; model: string };
  panelManager: PanelManager;
  getMainWindow: () => import("electron").BrowserWindow | null;
  activeReminders: Map<string, { message: string; fireAt: number; timer: ReturnType<typeof setTimeout> }>;
  /** Open a vibe by id: set it active + show/reload the vibe panel. Returns the vibe. */
  openVibe: (id: string) => VibeMeta | null;
}

export function registerHomeIpc(deps: HomeIpcDeps): void {
  const {
    mcpExpose, mcpManager, connectorManager, canUseMcp,
    usageTracker, promptLog, llmConfig,
    panelManager, getMainWindow, activeReminders,
    openVibe,
  } = deps;

  // ── Vibes registry CRUD + open ────────────────────────────
  ipcMain.handle("vibes-list", () => listVibes());
  ipcMain.handle("vibes-get", (_e, id: string) => getVibe(id));
  ipcMain.handle("vibes-create", (_e, name: string, description?: string) => createVibe(name, description));
  ipcMain.handle("vibes-delete", (_e, id: string) => deleteVibe(id));
  // Open: set the vibe active and switch + reload the vibe panel (so the agent
  // re-spawns in the new vibe's code dir). Returns the opened vibe.
  ipcMain.handle("vibes-open", (_e, id: string) => openVibe(id));

  ipcMain.handle("mcp-expose-get-tokens", () => mcpExpose.getTokens());
  ipcMain.handle("mcp-expose-gen-token", (_e, label: string, ttlDays?: number) => mcpExpose.generateToken(label, ttlDays));
  ipcMain.handle("mcp-expose-revoke-token", (_e, token: string) => { mcpExpose.revokeToken(token); });

  // Relay: bouncing the WS after the user flips the toggle, and proxying
  // token CRUD to yo-server (the JWT authenticates these calls — same one
  // the WS uses, so signed-in org admins can manage their own server tokens
  // without ever opening the platform).
  ipcMain.handle("relay-reconnect", () => { reconnectRelay(); });
  ipcMain.handle("relay-status", () => getRelayStatus());
  ipcMain.handle("relay-tokens-list", async () => {
    try { return await serverGetAuthed<unknown[]>("/api/mcp/tokens?type=EXTERNAL"); }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("relay-tokens-create", async (_e, label: string) => {
    try {
      return await serverPostAuthed<{ ok: boolean; id: string; token: string; expiresAt: string }>(
        "/api/mcp/tokens",
        { label: label || "default", type: "EXTERNAL" },
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("relay-tokens-revoke", async (_e, id: string) => {
    try { return await serverDeleteAuthed<{ ok: boolean }>(`/api/mcp/tokens/${encodeURIComponent(id)}`); }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  });

  // Install the relay into the user's ~/.claude.json so Claude code picks it
  // up without hand-editing. Idempotent: only touches the "yo-relay" entry
  // under mcpServers; everything else (other servers, projects, settings)
  // round-trips untouched. Returns the resolved path on success.
  ipcMain.handle("relay-install-claude", async (_e, token: string) => {
    if (!token || typeof token !== "string") return { error: "token is required" };
    const cfgPath = path.join(os.homedir(), ".claude.json");
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, "utf8");
        if (raw.trim()) existing = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch (err) {
      return { error: `Could not read ${cfgPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const mcpServers = (existing.mcpServers && typeof existing.mcpServers === "object")
      ? existing.mcpServers as Record<string, unknown>
      : {};
    mcpServers["yo-relay"] = {
      type: "http",
      url: "https://api.yosup.dev/mcp",
      headers: { Authorization: `Bearer ${token}` },
    };
    existing.mcpServers = mcpServers;
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
      return { ok: true, path: cfgPath };
    } catch (err) {
      return { error: `Could not write ${cfgPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  ipcMain.handle("mcp-get-servers", () => {
    if (!mcpManager) return [];
    return mcpManager.getServerStates().map((s) => ({
      config: s.config,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
    }));
  });
  ipcMain.handle("mcp-add-server", (_e, config: Record<string, unknown>) => {
    const gate = canUseMcp();
    if (!gate.allowed) throw new Error((gate as any).reason);
    mcpManager!.addServer(config as any);
  });
  ipcMain.handle("mcp-update-server", (_e, id: string, updates: Record<string, unknown>) => {
    mcpManager!.updateServer(id, updates as any);
  });
  ipcMain.handle("mcp-remove-server", (_e, id: string) => {
    mcpManager!.removeServer(id);
  });
  ipcMain.handle("mcp-connect-server", async (_e, id: string) => {
    const gate = canUseMcp();
    if (!gate.allowed) return { ok: false, error: (gate as any).reason };
    const state = mcpManager!.getServerState(id);
    if (!state) return { ok: false, error: "Server not found" };
    try {
      await mcpManager!.connectServer(state.config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("mcp-disconnect-server", async (_e, id: string) => {
    await mcpManager!.disconnectServer(id);
  });
  ipcMain.handle("mcp-get-tool-override", (_e, serverId: string, toolName: string) => {
    return mcpManager!.getToolOverride(serverId, toolName);
  });
  ipcMain.on("mcp-set-tool-override", (_e, serverId: string, toolName: string, override: string) => {
    mcpManager!.setToolOverride(serverId, toolName, override as any);
  });
  ipcMain.on("mcp-set-server-override", (_e, serverId: string, override: string) => {
    mcpManager!.setServerOverride(serverId, override as any);
  });

  ipcMain.handle("connectors-get-apps", async (_e, search?: string, offset?: number) => {
    if (!connectorManager) return { apps: [], hasMore: false };
    return connectorManager.getApps(search, offset);
  });
  ipcMain.handle("connectors-get-accounts", async () => {
    if (!connectorManager) return [];
    return connectorManager.getAccounts();
  });
  ipcMain.handle("connectors-connect", async (_e, appSlug: string) => {
    if (!connectorManager) return { ok: false, error: "Not initialized" };
    return connectorManager.connectApp(appSlug);
  });
  ipcMain.handle("connectors-disconnect", async (_e, accountId: string) => {
    if (!connectorManager) return false;
    return connectorManager.disconnectAccount(accountId);
  });
  ipcMain.handle("connectors-refresh-mcp", async () => {
    if (!connectorManager) return { ok: false, error: "Not initialized", toolCount: 0 };
    return connectorManager.refreshMcp();
  });
  ipcMain.handle("connectors-list-tools", async () => {
    if (!connectorManager) return [];
    return connectorManager.listTools();
  });

  ipcMain.handle("dashboard:today", () => usageTracker.getToday());
  ipcMain.handle("dashboard:history", (_e, days?: number) => usageTracker.getHistory(days || 30));
  ipcMain.handle("dashboard:all-time", () => usageTracker.getAllTime());

  ipcMain.handle("dashboard:apps", () => {
    const appsDir = path.join(os.homedir(), "yo", "apps");
    try {
      if (!fs.existsSync(appsDir)) return [];
      const entries = fs.readdirSync(appsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const indexPath = path.join(appsDir, e.name, "index.html");
          let modified = "";
          try {
            const stat = fs.statSync(indexPath);
            modified = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          } catch {}
          return { name: e.name, path: path.join(appsDir, e.name), modified };
        })
        .filter((a) => a.modified);
    } catch { return []; }
  });

  ipcMain.on("dashboard:open-app", (_e, name: string) => {
    const filePath = path.join(os.homedir(), "yo", "apps", name, "index.html");
    const mainWindow = getMainWindow();
    if (fs.existsSync(filePath) && mainWindow) {
      const fileUrl = `file://${filePath}`;
      panelManager.addPanel(`app-${name}`, fileUrl);
      panelManager.switchTo(`app-${name}`, mainWindow);
    }
  });

  ipcMain.handle("dashboard:delete-app", (_e, name: string) => {
    const appDir = path.join(os.homedir(), "yo", "apps", name);
    try {
      fs.rmSync(appDir, { recursive: true, force: true });
      return true;
    } catch { return false; }
  });

  ipcMain.handle("dashboard:reminders", () => {
    const result: Array<{ id: string; message: string; fireAt: number }> = [];
    for (const [id, r] of activeReminders) {
      result.push({ id, message: r.message, fireAt: r.fireAt });
    }
    return result;
  });

  ipcMain.handle("dashboard:cancel-reminder", (_e, id: string) => {
    const r = activeReminders.get(id);
    if (!r) return false;
    clearTimeout(r.timer);
    activeReminders.delete(id);
    return true;
  });

  ipcMain.handle("dashboard:llm-info", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
  }));

  ipcMain.handle("prompts-list", (_e, offset?: number, limit?: number) => promptLog.list(offset || 0, limit || 50));
  ipcMain.handle("prompts-search", (_e, query: string, limit?: number) => promptLog.search(query, limit || 50));
  ipcMain.handle("prompts-get", (_e, id: string) => promptLog.get(id));
  ipcMain.handle("prompts-count", () => promptLog.count);
}
