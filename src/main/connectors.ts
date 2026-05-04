/**
 * Connectors — Pipedream Connect integration for managed OAuth connections.
 *
 * Pro-tier feature. Flow:
 *   1. Client calls yo-server to create/get Pipedream external user
 *   2. Client requests a connect token for a specific app
 *   3. Opens OAuth window using the connect token URL
 *   4. After OAuth, refreshes MCP connection to discover new tools
 *   5. Connected accounts stored in Pipedream, queried via yo-server
 *
 * All Pipedream API calls go through yo-server (api.yosup.dev) to keep
 * project keys server-side. The client only sees connect tokens and account lists.
 */

import { BrowserWindow, shell } from "electron";
import { EventEmitter } from "events";
import { serverPostAuthed, serverGetAuthed, getAccountInfo, getHeartbeatInfo } from "./auth";
import type { McpManager } from "./mcp-manager";
import type { AppConnector } from "./app-connector";

// ── Types ──────────────────────────────────────────────────

export interface ConnectorApp {
  id: string;
  name: string;
  description: string;
  icon?: string;
  categories?: string[];
}

export interface ConnectedAccount {
  id: string;
  appSlug: string;
  appName: string;
  createdAt: string;
  healthy: boolean;
}

interface ConnectTokenResponse {
  ok: boolean;
  token?: string;
  connectUrl?: string;
  error?: string;
}

interface AccountsResponse {
  ok: boolean;
  accounts?: ConnectedAccount[];
  error?: string;
}

interface AppsResponse {
  ok: boolean;
  apps?: ConnectorApp[];
  hasMore?: boolean;
  error?: string;
}

interface DisconnectResponse {
  ok: boolean;
  error?: string;
}

// Legacy Pipedream server ID prefix — cleaned up on init
const LEGACY_PIPEDREAM_PREFIX = "pipedream-connect";

// ── ConnectorManager ──────────────────────────────────────

export class ConnectorManager extends EventEmitter {
  private mcpManager: McpManager | null = null;
  private appConnector: AppConnector | null = null;
  private cachedAccounts: ConnectedAccount[] = [];
  private cachedApps: ConnectorApp[] = [];

  setMcpManager(mgr: McpManager): void {
    this.mcpManager = mgr;
  }

  setAppConnector(ac: AppConnector): void {
    this.appConnector = ac;
  }

  // ── Available apps (browse catalog) ───────────────────

  async getApps(search?: string, offset?: number): Promise<{ apps: ConnectorApp[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (offset) params.set("offset", String(offset));
    const qs = params.toString() ? `?${params.toString()}` : "";
    try {
      const res = await serverGetAuthed<AppsResponse>(`/api/connectors/apps${qs}`);
      if (res.ok && res.apps) {
        this.cachedApps = res.apps;
        return { apps: res.apps, hasMore: !!res.hasMore };
      }
      return { apps: this.cachedApps, hasMore: false };
    } catch {
      return { apps: this.cachedApps, hasMore: false };
    }
  }

  getCachedApps(): ConnectorApp[] {
    return this.cachedApps;
  }

  // ── Connected accounts ────────────────────────────────

  async getAccounts(): Promise<ConnectedAccount[]> {
    try {
      const res = await serverGetAuthed<AccountsResponse>("/api/connectors/accounts");
      if (res.ok && res.accounts) {
        this.cachedAccounts = res.accounts;
        this.syncAccountsToApps(res.accounts);
        return res.accounts;
      }
      return this.cachedAccounts;
    } catch {
      return this.cachedAccounts;
    }
  }

  private syncAccountsToApps(accounts: ConnectedAccount[]): void {
    if (!this.appConnector) return;
    for (const account of accounts) {
      const app = this.appConnector.findByPipedreamSlug(account.appSlug);
      if (app) {
        this.appConnector.setConnection(app.id, {
          pipedreamSlug: account.appSlug,
          accountId: account.id,
          healthy: account.healthy,
        });
      }
    }
  }

  getCachedAccounts(): ConnectedAccount[] {
    return this.cachedAccounts;
  }

  async disconnectAccount(accountId: string): Promise<boolean> {
    try {
      const removed = this.cachedAccounts.find((a) => a.id === accountId);
      const res = await serverPostAuthed<DisconnectResponse>("/api/connectors/disconnect", { accountId });
      if (res.ok) {
        this.cachedAccounts = this.cachedAccounts.filter((a) => a.id !== accountId);
        if (removed && this.appConnector) {
          const app = this.appConnector.findByPipedreamSlug(removed.appSlug);
          if (app?.connection?.accountId === accountId) {
            this.appConnector.setConnection(app.id, { pipedreamSlug: removed.appSlug });
          }
        }
        await this.refreshMcp();
        this.emit("changed");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── OAuth connect flow ────────────────────────────────

  private oauthWindow: BrowserWindow | null = null;

  /**
   * Start the OAuth flow for a Pipedream app.
   * 1. Request a connect token from yo-server
   * 2. Open OAuth URL in Electron BrowserWindow (shared session for existing cookies)
   * 3. Wait for callback / window close
   * 4. Refresh accounts + MCP
   */
  async connectApp(appSlug: string): Promise<{ ok: boolean; error?: string }> {
    // Get connect token from yo-server
    let connectUrl: string;
    try {
      const res = await serverPostAuthed<ConnectTokenResponse>("/api/connectors/connect", { appSlug });
      if (!res.ok || !res.connectUrl) {
        return { ok: false, error: res.error || "Failed to get connect token" };
      }
      connectUrl = res.connectUrl;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Server error" };
    }

    // Open OAuth in Electron window (no partition — shares default session so
    // existing Google/provider logins are available, avoiding "suspicious" flags)
    return new Promise((resolve) => {
      if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
        this.oauthWindow.close();
      }

      this.oauthWindow = new BrowserWindow({
        width: 500,
        height: 700,
        title: `Connect ${appSlug}`,
        resizable: true,
        minimizable: false,
        maximizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: "persist:yo",
        },
      });

      this.oauthWindow.setMenuBarVisibility(false);
      // Spoof Chrome UA so Google's fraud detection doesn't flag Electron
      this.oauthWindow.webContents.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      );

      let resolved = false;
      const finish = async (success: boolean, error?: string) => {
        if (resolved) return;
        resolved = true;

        if (success) {
          const accounts = await this.getAccounts();
          console.log(`[connectors] After OAuth, accounts:`, accounts.map(a => `${a.appSlug} (${a.id})`));
          const mcpResult = await this.refreshMcp();
          console.log(`[connectors] After OAuth, refreshMcp:`, mcpResult);
          this.emit("changed");
        }

        if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
          this.oauthWindow.close();
        }
        resolve({ ok: success, error });
      };

      // Open external links (Google Cloud Console, etc.) in system browser
      this.oauthWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.includes("pipedream")) {
          shell.openExternal(url);
          return { action: "deny" };
        }
        return { action: "allow" };
      });

      // Watch for success callback URL from Pipedream
      this.oauthWindow.webContents.on("will-navigate", (_event, url) => {
        if (url.includes("/connect/callback") || url.includes("success=true")) {
          finish(true);
        }
      });

      this.oauthWindow.webContents.on("will-redirect", (_event, url) => {
        if (url.includes("/connect/callback") || url.includes("success=true")) {
          finish(true);
        }
      });

      // If user closes the window, check if they completed OAuth
      this.oauthWindow.on("closed", () => {
        this.oauthWindow = null;
        if (!resolved) {
          this.getAccounts().then((accounts) => {
            const wasAdded = accounts.some((a) => a.appSlug === appSlug);
            if (wasAdded) {
              this.refreshMcp().then(() => {
                this.emit("changed");
                resolve({ ok: true });
              });
            } else {
              resolve({ ok: false, error: "Connection cancelled" });
            }
          }).catch(() => {
            resolve({ ok: false, error: "Connection cancelled" });
          });
        }
      });

      this.oauthWindow.loadURL(connectUrl);
    });
  }

  // ── MCP bridge ────────────────────────────────────────

  /**
   * Ensure Pipedream MCP servers are connected using real app IDs.
   * Each connected Pipedream account maps to the existing app in AppConnector.
   * Servers are ephemeral (in-memory only) since tokens are short-lived.
   */
  async refreshMcp(): Promise<{ ok: boolean; error?: string; toolCount: number }> {
    if (!this.mcpManager) return { ok: false, error: "MCP manager not available", toolCount: 0 };

    try {
      const res = await serverGetAuthed<{
        ok: boolean;
        mcpUrl?: string;
        mcpToken?: string;
        mcpHeaders?: Record<string, string>;
        hasAccounts?: boolean;
        apps?: Array<{ slug: string; mcpUrl: string }>;
        error?: string;
      }>("/api/connectors/mcp-endpoint");

      console.log(`[connectors] mcp-endpoint response:`, JSON.stringify({ ok: res.ok, hasAccounts: res.hasAccounts, appsCount: res.apps?.length, error: res.error }));

      if (!res.ok) {
        this.removePipedreamServers();
        return { ok: false, error: `Server returned: ${res.error || "no MCP URL"}`, toolCount: 0 };
      }

      if (!res.hasAccounts || !res.apps?.length) {
        this.removePipedreamServers();
        return { ok: false, error: "No connected accounts on server", toolCount: 0 };
      }

      const headers: Record<string, string> = {
        ...(res.mcpHeaders || {}),
      };
      if (res.mcpToken) {
        headers["Authorization"] = `Bearer ${res.mcpToken}`;
      }

      // Resolve Pipedream slugs to real app IDs
      const activeAppIds = new Set<string>();
      const appEntries: Array<{ appId: string; slug: string; mcpUrl: string }> = [];
      for (const pdApp of res.apps) {
        const realApp = this.appConnector?.findByPipedreamSlug(pdApp.slug);
        const appId = realApp?.id || pdApp.slug;
        activeAppIds.add(appId);
        appEntries.push({ appId, slug: pdApp.slug, mcpUrl: pdApp.mcpUrl });
      }

      // Remove stale ephemeral servers no longer in the active set
      for (const id of this.pipedreamServerIds) {
        if (!activeAppIds.has(id)) {
          this.mcpManager.removeEphemeralServer(id);
        }
      }
      this.pipedreamServerIds = activeAppIds;

      let totalTools = 0;
      let lastError: string | undefined;
      let anyOk = false;

      for (const entry of appEntries) {
        const config = {
          id: entry.appId,
          name: this.appConnector?.get(entry.appId)?.name || entry.slug,
          transport: "streamable-http" as const,
          url: entry.mcpUrl,
          headers,
          enabled: true,
        };

        this.mcpManager.addEphemeralServer(config);

        try {
          await this.mcpManager.connectServer(config);
          const state = this.mcpManager.getServerState(entry.appId);
          const tools = state?.tools.length || 0;
          totalTools += tools;
          if (state?.status === "connected") anyOk = true;
          console.log(`[connectors] MCP ${entry.appId} (${entry.slug}): status=${state?.status}, tools=${tools}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          console.error(`[connectors] MCP ${entry.appId} (${entry.slug}) failed: ${msg}`);
        }
      }

      return { ok: anyOk, error: lastError, toolCount: totalTools };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Connectors MCP refresh error:", msg);
      return { ok: false, error: msg, toolCount: 0 };
    }
  }

  private pipedreamServerIds = new Set<string>();

  private removePipedreamServers(): void {
    if (!this.mcpManager) return;
    for (const id of this.pipedreamServerIds) {
      this.mcpManager.removeEphemeralServer(id);
    }
    this.pipedreamServerIds.clear();
  }

  /** Initialize — load accounts and set up MCP if any exist. */
  async init(): Promise<void> {
    this.cleanupLegacyServers();
    try {
      const accounts = await this.getAccounts();
      console.log(`[connectors] init: ${accounts.length} accounts found`);
      if (accounts.length > 0) {
        const result = await this.refreshMcp();
        console.log(`[connectors] init: ${result.toolCount} MCP tools loaded`);
      }
    } catch (err) {
      console.warn("[connectors] init failed:", err);
    }
  }

  private cleanupLegacyServers(): void {
    if (!this.mcpManager) return;
    for (const state of this.mcpManager.getServerStates()) {
      if (state.config.id === LEGACY_PIPEDREAM_PREFIX || state.config.id.startsWith(`${LEGACY_PIPEDREAM_PREFIX}-`)) {
        this.mcpManager.removeServer(state.config.id);
        console.log(`[connectors] removed legacy server: ${state.config.id}`);
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────

  cleanup(): void {
    if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
      this.oauthWindow.close();
      this.oauthWindow = null;
    }
  }
}
