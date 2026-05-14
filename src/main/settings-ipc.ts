import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme } from "electron";
import type { LLMConfig } from "./llm-config";
import type { McpExpose } from "./mcp-expose";
import type { SessionCache } from "./session-cache";
import type { PanelManager } from "./panel-manager";
import type { CloudSync } from "./cloud-sync";
import type * as providerKeysModule from "./provider-keys";
import type { Transcriber } from "./transcriber";
import type { YoAgent } from "./yo-agent";

interface SettingsIpcDeps {
  getPreference: <T>(key: string, def?: T) => T;
  setPreference: (key: string, val: unknown) => void;
  getCurrentLimits: () => unknown;
  broadcastTheme: (resolved: string) => void;
  serverGetAuthed: <T = unknown>(path: string) => Promise<T>;
  startAuthFlow: (mode: "register" | "login") => Promise<unknown>;
  isAuthenticated: () => boolean;
  getAccountInfo: () => unknown;
  getAuthStatus: () => unknown;
  refreshHeartbeat: () => Promise<{ tier?: string; status?: string } | null>;
  logout: () => void;
  llmConfig: { provider: string; model: string };
  saveLLMConfig: (config: LLMConfig) => void;
  applyLLMConfig: (config: LLMConfig) => void;
  fetchServerModels: () => Promise<Array<{ provider: string; model: string }>>;
  mcpExpose: McpExpose;
  session: SessionCache;
  sendSessionState: () => void;
  providerKeys: typeof providerKeysModule;
  ccBootstrapStatus: () => unknown;
  spawnCcLogin: () => unknown;
  transcriber: Transcriber;
  cloudSyncInstance: CloudSync | null;
  execCommand: (cmd: string, sourcePanelId?: string) => Promise<string>;
  getMainWindow: () => BrowserWindow | null;
  panelManager: PanelManager;
  yoAgent: YoAgent;
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const {
    getPreference, setPreference, getCurrentLimits, broadcastTheme,
    serverGetAuthed, startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    llmConfig, saveLLMConfig, applyLLMConfig, fetchServerModels,
    mcpExpose, session, sendSessionState,
    providerKeys, ccBootstrapStatus, spawnCcLogin,
    transcriber, cloudSyncInstance,
    getMainWindow, panelManager,
  } = deps;

  ipcMain.handle("get-entitlements", () => getCurrentLimits());

  ipcMain.handle("get-theme", () => getPreference<string>("theme", "light"));
  ipcMain.handle("set-theme", (_e, theme: string) => {
    setPreference("theme", theme);
    nativeTheme.themeSource = theme === "system" ? "system" : theme as "light" | "dark";
    const resolved = theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
    broadcastTheme(resolved);
  });

  ipcMain.handle("exec-command", async (_e, cmd: string) => {
    return deps.execCommand(cmd, panelManager.activePanelId ?? undefined);
  });

  ipcMain.handle("session-info", () => session.getInfo());
  ipcMain.handle("session-clear", () => {
    session.clear();
    sendSessionState();
    return true;
  });

  ipcMain.handle("get-app-version", () => app.getVersion());

  ipcMain.handle("start-auth", async (_e, mode: "register" | "login") => startAuthFlow(mode));
  ipcMain.handle("is-authenticated", () => isAuthenticated());

  ipcMain.handle("dev-flags", () => ({
    cyphersEnabled: process.env.YO_CYPHERS_ENABLED === "1" || process.env.YO_CYPHERS_ENABLED === "true",
    enableGhAuth: process.env.YO_ENABLE_GH_AUTH === "1" || process.env.YO_ENABLE_GH_AUTH === "true",
  }));

  ipcMain.handle("gh-app-install", async () => {
    try {
      const r = await serverGetAuthed<{ slug: string; installUrl: string }>("/api/github/app-info");
      if (!r?.installUrl) return { ok: false, error: "GitHub App not configured" };

      const installed = await new Promise<boolean>((resolve) => {
        const win = new BrowserWindow({
          width: 1024,
          height: 720,
          title: "Install yo-cypher on GitHub",
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });

        let resolved = false;
        const finish = (val: boolean) => {
          if (resolved) return;
          resolved = true;
          resolve(val);
          try { if (!win.isDestroyed()) win.close(); } catch {}
        };

        const checkNav = (navUrl: string) => {
          try {
            const u = new URL(navUrl);
            if (
              u.searchParams.has("installation_id") ||
              /\/settings\/installations\/\d+/.test(u.pathname)
            ) {
              finish(true);
            }
          } catch {}
        };
        win.webContents.on("will-redirect", (_e, navUrl) => checkNav(navUrl));
        win.webContents.on("will-navigate", (_e, navUrl) => checkNav(navUrl));
        win.webContents.on("did-navigate", (_e, navUrl) => checkNav(navUrl));
        win.on("closed", () => finish(false));

        win.loadURL(r.installUrl);
      });

      return { ok: true, installed };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
    }
  });

  ipcMain.handle("get-account-info", () => getAccountInfo());
  ipcMain.handle("get-auth-status", () => getAuthStatus());
  ipcMain.handle("refresh-auth", async () => {
    const hb = await refreshHeartbeat();
    if (hb) cloudSyncInstance?.resetAuth();
    return { tier: hb?.tier || "free", status: hb?.status || "unknown" };
  });
  ipcMain.handle("copy-to-clipboard", (_e, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("logout", () => {
    const mainWindow = getMainWindow();
    logout();
    if (mainWindow) panelManager.hideActive(mainWindow);
    mainWindow?.webContents.send("show-onboarding");
  });
  ipcMain.handle("validate-api-key", async () => ({ valid: true }));
  ipcMain.handle("get-api-key", () => null);

  ipcMain.handle("get-llm-config", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
  }));
  ipcMain.handle("get-llm-presets", async () => {
    const models = await fetchServerModels();
    if (models.length === 0) {
      return { anthropic: { name: "Anthropic", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"], defaultModel: "claude-sonnet-4-6" } };
    }
    const grouped: Record<string, { name: string; models: string[]; defaultModel: string }> = {};
    for (const m of models) {
      if (!grouped[m.provider]) grouped[m.provider] = { name: m.provider.charAt(0).toUpperCase() + m.provider.slice(1), models: [], defaultModel: "" };
      grouped[m.provider].models.push(m.model);
    }
    if (grouped.anthropic) grouped.anthropic.defaultModel = "claude-sonnet-4-6";
    for (const key of Object.keys(grouped)) {
      if (!grouped[key].defaultModel) grouped[key].defaultModel = grouped[key].models[0];
    }
    return grouped;
  });
  ipcMain.handle("save-llm-config", async (_e, config: LLMConfig) => {
    saveLLMConfig(config);
    applyLLMConfig(config);
    return { ok: true };
  });

  ipcMain.handle("pick-directory", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose project directory",
      buttonLabel: "Select",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("mcp-expose-start", async () => {
    const result = await mcpExpose.start();
    if (result.ok) setPreference("mcpExposeRunning", true);
    return result;
  });
  ipcMain.handle("mcp-expose-stop", () => {
    mcpExpose.stop();
    setPreference("mcpExposeRunning", false);
  });
  ipcMain.handle("mcp-expose-status", () => ({
    running: mcpExpose.isRunning,
    port: mcpExpose.getPort(),
  }));

  ipcMain.handle("transcribe-audio", async (_e, audioBuffer: ArrayBuffer) => {
    try {
      const float32 = new Float32Array(audioBuffer);
      const text = await transcriber.transcribe(float32);
      return { ok: true, text };
    } catch (err: any) {
      console.error("[transcribe]", err);
      return { ok: false, error: err.message || "Transcription failed" };
    }
  });

  ipcMain.handle("provider-keys-list", () => providerKeys.listStatus());
  ipcMain.handle("provider-keys-set", (_e, provider: string, key: string) => {
    try {
      providerKeys.setKey(provider as providerKeysModule.ProviderId, key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });
  ipcMain.handle("provider-keys-remove", (_e, provider: string) => {
    providerKeys.removeKey(provider as providerKeysModule.ProviderId);
    return { ok: true };
  });
  ipcMain.handle("provider-keys-test", (_e, provider: string) =>
    providerKeys.testKey(provider as providerKeysModule.ProviderId));

  ipcMain.handle("cc-status", () => ccBootstrapStatus());
  ipcMain.handle("cc-login-open-terminal", () => spawnCcLogin());

  ipcMain.handle("yo-chats-list", () => deps.yoAgent.listChats());
  ipcMain.handle("yo-chats-load", (_e, id: string) => deps.yoAgent.loadChat(id));
  ipcMain.handle("yo-chats-delete", (_e, id: string) => deps.yoAgent.deleteChat(id));
  ipcMain.handle("yo-chats-search", () => []);
  ipcMain.handle("yo-chat-new", () => { deps.yoAgent.clear(); return true; });
}
