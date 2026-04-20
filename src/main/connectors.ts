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

import { BrowserWindow } from "electron";
import { EventEmitter } from "events";
import { serverPostAuthed, serverGetAuthed, getAccountInfo } from "./auth";
import type { McpManager } from "./mcp-manager";

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

// The Pipedream MCP server ID — one per user, managed internally
const PIPEDREAM_SERVER_ID = "pipedream-connect";
const PIPEDREAM_SERVER_NAME = "Pipedream Connect";

// ── ConnectorManager ──────────────────────────────────────

export class ConnectorManager extends EventEmitter {
  private mcpManager: McpManager | null = null;
  private cachedAccounts: ConnectedAccount[] = [];
  private cachedApps: ConnectorApp[] = [];
  private oauthWindow: BrowserWindow | null = null;

  setMcpManager(mgr: McpManager): void {
    this.mcpManager = mgr;
  }

  // ── Tier gate ─────────────────────────────────────────

  isPro(): boolean {
    const account = getAccountInfo();
    return account?.tier === "advanced";
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
        return res.accounts;
      }
      return this.cachedAccounts;
    } catch {
      return this.cachedAccounts;
    }
  }

  getCachedAccounts(): ConnectedAccount[] {
    return this.cachedAccounts;
  }

  async disconnectAccount(accountId: string): Promise<boolean> {
    try {
      const res = await serverPostAuthed<DisconnectResponse>("/api/connectors/disconnect", { accountId });
      if (res.ok) {
        this.cachedAccounts = this.cachedAccounts.filter((a) => a.id !== accountId);
        // Refresh MCP to drop tools from disconnected account
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

  /**
   * Start the OAuth flow for a Pipedream app.
   * 1. Request a connect token from yo-server
   * 2. Open OAuth URL in a BrowserWindow
   * 3. Wait for callback / window close
   * 4. Refresh accounts + MCP
   */
  async connectApp(appSlug: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isPro()) {
      return { ok: false, error: "Advanced subscription required for Connectors" };
    }

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

    // Open OAuth window
    return new Promise((resolve) => {
      if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
        this.oauthWindow.close();
      }

      this.oauthWindow = new BrowserWindow({
        width: 600,
        height: 700,
        title: `Connect ${appSlug}`,
        resizable: true,
        minimizable: false,
        maximizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: "persist:pipedream",
        },
      });

      this.oauthWindow.setMenuBarVisibility(false);

      let resolved = false;
      const finish = async (success: boolean, error?: string) => {
        if (resolved) return;
        resolved = true;

        if (success) {
          // Refresh accounts and MCP connection
          await this.getAccounts();
          await this.refreshMcp();
          this.emit("changed");
        }

        if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
          this.oauthWindow.close();
        }
        resolve({ ok: success, error });
      };

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
          // Check if the account was actually added (they may have completed OAuth)
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
   * Ensure the Pipedream MCP server is configured and connected.
   * Pipedream exposes tools via a single SSE MCP endpoint per user.
   * The yo-server returns the MCP endpoint URL for the authenticated user.
   */
  async refreshMcp(): Promise<void> {
    if (!this.mcpManager) return;

    // Get MCP endpoint from yo-server
    try {
      const res = await serverGetAuthed<{
        ok: boolean;
        mcpUrl?: string;
        hasAccounts?: boolean;
        error?: string;
      }>("/api/connectors/mcp-endpoint");

      if (!res.ok || !res.mcpUrl) {
        // No MCP endpoint — maybe no accounts. Remove server if it exists.
        const existing = this.mcpManager.getConfigs().find((c) => c.id === PIPEDREAM_SERVER_ID);
        if (existing) {
          this.mcpManager.removeServer(PIPEDREAM_SERVER_ID);
        }
        return;
      }

      if (!res.hasAccounts) {
        // No connected accounts — remove server if present
        const existing = this.mcpManager.getConfigs().find((c) => c.id === PIPEDREAM_SERVER_ID);
        if (existing) {
          this.mcpManager.removeServer(PIPEDREAM_SERVER_ID);
        }
        return;
      }

      // Add or update the Pipedream MCP server
      const config = {
        id: PIPEDREAM_SERVER_ID,
        name: PIPEDREAM_SERVER_NAME,
        transport: "sse" as const,
        url: res.mcpUrl,
        enabled: true,
      };

      this.mcpManager.addServer(config);

      // Reconnect to pick up new/removed tools
      try {
        await this.mcpManager.connectServer(config);
      } catch (err) {
        console.error("Pipedream MCP connect error:", err);
      }
    } catch (err) {
      console.error("Connectors MCP refresh error:", err);
    }
  }

  /** Initialize — load accounts and set up MCP if any exist. */
  async init(): Promise<void> {
    if (!this.isPro()) return;

    try {
      await this.getAccounts();
      if (this.cachedAccounts.length > 0) {
        await this.refreshMcp();
      }
    } catch {
      // Silent — connectors are non-critical
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
