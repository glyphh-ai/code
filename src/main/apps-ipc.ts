import { ipcMain } from "electron";
import type { AppConnector } from "./app-connector";
import type { LayoutManager } from "./layout-manager";
import type { DripManager } from "./drip-manager";
import type { PanelManager } from "./panel-manager";

interface AppsIpcDeps {
  appConnector: AppConnector;
  layoutManager: LayoutManager;
  dripManager: DripManager | null;
  panelManager: PanelManager;
  canAddApp: (count: number) => { allowed: boolean; reason?: string };
  canSaveLayout: (count: number) => { allowed: boolean; reason?: string };
  getMainWindow: () => import("electron").BrowserWindow | null;
  PICKER_SCRIPT: string;
}

// `vscode` is intentionally NOT here: it's a real, user-addable panel app
// (it has a yo:// URL and dedicated launch handling) and must appear in the
// "+" new-tab menu, the Layouts page, and the Apps page.
const INTERNAL_APP_IDS = new Set(["home", "monaco", "browser", "context"]);

export function registerAppsIpc(deps: AppsIpcDeps): void {
  const {
    appConnector,
    layoutManager,
    dripManager,
    panelManager,
    canAddApp,
    canSaveLayout,
    getMainWindow,
    PICKER_SCRIPT,
  } = deps;

  // IPC: layouts CRUD
  ipcMain.handle("layouts-list", () =>
    layoutManager.listLayouts().map((l) => ({
      name: l.name,
      cols: l.cols,
      rows: l.rows,
      colWidths: l.colWidths,
      rowHeights: l.rowHeights,
      splits: l.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan })),
    }))
  );
  ipcMain.handle("layouts-save", (_e, name: string, panelIds: string[]) => {
    const existing = layoutManager.listLayouts().find(l => l.name === name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    const count = panelIds.length;
    layoutManager.saveLayout({
      name,
      version: 2,
      cols: count,
      rows: 1,
      colWidths: Array(count).fill(1 / count),
      rowHeights: [1],
      cells: panelIds.map((id, i) => ({
        panelId: id,
        col: i,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      })),
    });
    return true;
  });
  ipcMain.handle("layouts-save-grid", (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => {
    const existing = layoutManager.listLayouts().find(l => l.name === grid.name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    layoutManager.saveLayout({ ...grid, version: 2 });
    return true;
  });
  ipcMain.handle("layouts-delete", (_e, name: string) => layoutManager.deleteLayout(name));

  // IPC: Drips CRUD
  ipcMain.handle("drips-list", () => dripManager?.listCustoms() ?? []);
  ipcMain.handle("drips-save", (_e, name: string, recipe: string) => dripManager?.saveCustom(name, recipe) ?? "");
  ipcMain.handle("drips-delete", (_e, name: string) => dripManager?.deleteCustom(name) ?? "");
  ipcMain.handle("drips-builtin-effects", () => {
    const { BUILTIN_EFFECTS } = require("./drip-manager");
    return BUILTIN_EFFECTS as string[];
  });
  ipcMain.handle("drips-preview", async (_e, recipe: string) => {
    if (!dripManager) return "drip manager not ready";
    return dripManager.execute(recipe.split(/\s+/));
  });

  // IPC: apps CRUD (panel apps)
  ipcMain.handle("apps-list", () =>
    appConnector.list().filter(a => !INTERNAL_APP_IDS.has(a.id))
  );
  ipcMain.handle("apps-add", (_e, id: string, name: string, url?: string) => {
    const userApps = appConnector.list().filter(a => a.url && !a.url.startsWith("yo://")).length;
    const gate = canAddApp(userApps);
    if (!gate.allowed) return { error: gate.reason };
    const app = appConnector.add(id, name, url);
    if (url) panelManager.addPanel(id, url);
    return app;
  });
  ipcMain.handle("apps-remove", (_e, id: string) => appConnector.remove(id));
  ipcMain.handle("apps-set-connection", (_e, id: string, pipedreamSlug: string) => appConnector.setConnection(id, { pipedreamSlug }));
  ipcMain.handle("apps-remove-connection", (_e, id: string) => appConnector.removeConnection(id));
  ipcMain.handle("apps-set-mcp", (_e, id: string, mcp: any) => appConnector.setMcp(id, mcp));
  ipcMain.handle("apps-remove-mcp", (_e, id: string) => appConnector.removeMcp(id));
  ipcMain.handle("apps-update-id", (_e, oldId: string, newId: string) => {
    const ok = appConnector.updateId(oldId, newId);
    if (ok) layoutManager.renamePanelId(oldId, newId);
    return ok;
  });
  ipcMain.handle("apps-update-name", (_e, id: string, name: string) => appConnector.updateName(id, name));
  ipcMain.handle("apps-update-url", (_e, id: string, url: string) => appConnector.updateUrl(id, url));
  ipcMain.handle("apps-update-force-web", (_e, id: string, forceWeb: boolean) => appConnector.updateForceWeb(id, forceWeb));
  ipcMain.handle("apps-update-do-not-record", (_e, id: string, doNotRecord: boolean) => appConnector.updateDoNotRecord(id, doNotRecord));
  ipcMain.handle("apps-update-capture-policy", (_e, id: string, policy: { type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }) =>
    appConnector.updateCapturePolicy(id, policy as any));
  ipcMain.handle("apps-get-capture-policy", (_e, id: string) => appConnector.getCapturePolicy(id));
  ipcMain.handle("apps-set-connected-slug", () => false);

  // IPC: app command mapping (DOM picker)
  ipcMain.handle("apps-set-command", (_e, id: string, key: string, mapping: { selector: string; action: string; description: string }) => {
    return appConnector.setCommand(id, key, mapping as any);
  });
  ipcMain.handle("apps-remove-command", (_e, id: string, key: string) => {
    return appConnector.removeCommand(id, key);
  });
  ipcMain.handle("apps-test-command", async (_e, id: string, key: string, wcId?: number) => {
    const app = appConnector.get(id);
    if (!app) return "App not found";
    const mapping = app.commands[key];
    if (!mapping) return "Command not found";
    let wc: import("electron").WebContents | null = null;
    if (wcId) {
      const { webContents } = require("electron") as typeof import("electron");
      wc = webContents.fromId(wcId) ?? null;
    }
    if (!wc) wc = panelManager.getGuestOrWebContents(id);
    if (!wc || wc.isDestroyed()) return "Panel not open";
    const { executeCommand: execCmd } = await import("./dom-bridge");
    return execCmd(wc, mapping);
  });

  ipcMain.on("start-picker", (_e, wcId: number) => {
    const { webContents } = require("electron") as typeof import("electron");
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(PICKER_SCRIPT).catch(() => {});
    const mainWindow = getMainWindow();
    const onConsole = (_ev: Electron.Event, _level: number, message: string) => {
      if (!message.startsWith("__YO_PICK__:")) return;
      try {
        const result = JSON.parse(message.slice("__YO_PICK__:".length));
        mainWindow?.webContents.send("picker-result", result);
      } catch {}
      wc.off("console-message", onConsole);
    };
    wc.on("console-message", onConsole);
  });
}
