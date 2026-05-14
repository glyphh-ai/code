import { ipcMain } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import type { McpExpose } from "./mcp-expose";
import type { McpManager } from "./mcp-manager";
import type { ConnectorManager } from "./connectors";
import type { PanelManager } from "./panel-manager";

interface DropIpcDeps {
  signInWithGitHub: () => Promise<{ ok: boolean; error?: string }>;
  signOutDrop: () => void;
  getDropAuthStatus: () => unknown;
  dropApi: {
    projectsMine: () => Promise<unknown>;
    projectDiscover: (opts?: Record<string, unknown>) => Promise<unknown>;
    projectGet: (ref: string, withParts?: string[]) => Promise<unknown>;
    projectBoard: (ref: string) => Promise<unknown>;
    projectCreate: (input: Record<string, unknown>) => Promise<unknown>;
    projectStart: (ref: string) => Promise<unknown>;
    projectWrap: (ref: string) => Promise<unknown>;
    installationsList: () => Promise<{ ok: boolean; data?: unknown }>;
    reposForInstallation: (owner: string) => Promise<{ ok: boolean; data?: unknown }>;
  };
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
}

export function registerDropIpc(deps: DropIpcDeps): void {
  const {
    signInWithGitHub, signOutDrop, getDropAuthStatus, dropApi,
    mcpExpose, mcpManager, connectorManager, canUseMcp,
    usageTracker, promptLog, llmConfig,
    panelManager, getMainWindow, activeReminders,
  } = deps;

  ipcMain.handle("drop-gh-status", () => getDropAuthStatus());
  ipcMain.handle("drop-gh-sign-in", async () => {
    try { return await signInWithGitHub(); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "sign-in failed" }; }
  });
  ipcMain.handle("drop-gh-sign-out", () => { signOutDrop(); return { ok: true }; });

  ipcMain.handle("projects-mine", () => dropApi.projectsMine());
  ipcMain.handle("projects-discover", (_e, opts?: { q?: string; mode?: string; capability?: string; limit?: number }) =>
    dropApi.projectDiscover(opts));
  ipcMain.handle("project-get", (_e, ref: string, withParts?: string[]) => dropApi.projectGet(ref, withParts));
  ipcMain.handle("project-board", (_e, ref: string) => dropApi.projectBoard(ref));
  ipcMain.handle("project-create", (_e, input: Record<string, unknown>) => dropApi.projectCreate(input));
  ipcMain.handle("project-start", (_e, ref: string) => dropApi.projectStart(ref));
  ipcMain.handle("project-wrap", (_e, ref: string) => dropApi.projectWrap(ref));

  ipcMain.handle("installations-list", async () => {
    const result = await dropApi.installationsList();
    if (!result.ok) return [];
    const raw = (result.data as any)?.installations ?? [];
    return raw.map((inst: any) => ({
      id: inst.installation_id,
      account: {
        login: inst.account_login ?? "",
        type: inst.account_kind ?? "user",
      },
    }));
  });
  ipcMain.handle("repos-for-installation", async (_e, owner: string) => {
    const result = await dropApi.reposForInstallation(owner);
    if (!result.ok) return [];
    return (result.data as any)?.repos ?? (result.data as any)?.repositories ?? [];
  });

  ipcMain.handle("mcp-expose-get-tokens", () => mcpExpose.getTokens());
  ipcMain.handle("mcp-expose-gen-token", (_e, label: string, ttlDays?: number) => mcpExpose.generateToken(label, ttlDays));
  ipcMain.handle("mcp-expose-revoke-token", (_e, token: string) => { mcpExpose.revokeToken(token); });

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
