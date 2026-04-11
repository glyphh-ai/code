/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu } from "electron";
import path from "path";
import { PanelManager } from "./panel-manager";
import { CommandParser } from "./command-parser";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { MCPServer } from "./mcp-server";
import { CloudSync } from "./cloud-sync";
import { checkLicense, activateLicense, loadApiKey, saveApiKey, validateApiKey } from "./license";
import { LayoutManager } from "./layout-manager";
import { getPreference, setPreference } from "./preferences";

let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let library: Library;
let skillEngine: SkillEngine;
let mcpServer: MCPServer;
let cloudSync: CloudSync;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    transparent: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(
    path.join(__dirname, "..", "renderer", "index.html")
  );

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  // Core services
  library = new Library();
  skillEngine = new SkillEngine(library);
  panelManager = new PanelManager();
  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, library, skillEngine, layoutManager);
  commandParser.setWelcomeHandler(() => {
    mainWindow?.webContents.send("show-welcome");
  });

  // Local MCP server
  mcpServer = new MCPServer(library);
  await mcpServer.start();

  // Cloud sync (pulls from yo.yo.dev → ~/yo/library/)
  cloudSync = new CloudSync(library);
  cloudSync.start();

  // Create window
  await createWindow();

  // Helper: push grid state to renderer (for drag handles + panel chips)
  function sendSplitState() {
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
  }

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Restore last view (default to claude)
  const lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][] }>("lastView", null!);
  if (lastView && mainWindow) {
    if (lastView.type === "grid" && lastView.rows) {
      layoutManager.splitGrid(lastView.rows, mainWindow);
    } else if (lastView.type === "split" && lastView.panels) {
      if (lastView.panels.length === 2) {
        layoutManager.splitTwo(lastView.panels[0], lastView.panels[1], mainWindow);
      } else {
        layoutManager.splitN(lastView.panels, mainWindow);
      }
    } else if (lastView.type === "layout" && lastView.name) {
      layoutManager.apply(lastView.name, mainWindow);
    } else if (lastView.type === "panel" && lastView.id) {
      panelManager.switchTo(lastView.id, mainWindow);
    }
  } else if (mainWindow) {
    panelManager.switchTo("claude", mainWindow);
  }

  // Global hotkey: Cmd+Y / Ctrl+Y
  registerHotkey(mainWindow!);

  // App menu (Cmd+Q, Cmd+W, etc.)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" },
        ],
      },
    ])
  );

  // IPC: renderer sends commands
  ipcMain.on("command", async (_event, input: string) => {
    const result = await commandParser.execute(input);
    mainWindow?.webContents.send("command-result", result);
    sendSplitState();
  });

  // IPC: window controls
  ipcMain.on("window-close", () => mainWindow?.close());
  ipcMain.on("window-minimize", () => mainWindow?.minimize());
  ipcMain.on("window-maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  // IPC: refresh panels
  ipcMain.on("panels-refresh", (_e, id?: string) => {
    panelManager.refresh(id);
  });

  // IPC: zoom
  ipcMain.on("panels-zoom", (_e, factor: number) => {
    panelManager.setZoom(factor);
    setPreference("zoom", factor);
  });
  ipcMain.handle("panels-get-zoom", () => panelManager.getZoom());

  // IPC: panel visibility (for help overlay)
  ipcMain.on("panels-hide", () => {
    if (mainWindow) panelManager.hideActive(mainWindow);
  });
  ipcMain.on("panels-show", () => {
    if (!mainWindow) return;
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.showActive(mainWindow);
    }
    sendSplitState();
  });

  // IPC: library CRUD
  ipcMain.handle("library-list", () => library.list());
  ipcMain.handle("library-read", (_e, name: string) => library.read(name));
  ipcMain.handle("library-write", (_e, name: string, content: string) => {
    library.write(name, content);
    return true;
  });
  ipcMain.handle("library-remove", (_e, name: string) => library.remove(name));

  // IPC: skills CRUD
  ipcMain.handle("skills-list", () => skillEngine.listSkills());
  ipcMain.handle("skills-read", (_e, name: string) => skillEngine.readSkill(name));
  ipcMain.handle("skills-write", (_e, name: string, prompt: string) => {
    if (skillEngine.readSkill(name) !== null) {
      return skillEngine.updateSkill(name, prompt);
    }
    skillEngine.createSkill(name, prompt);
    return true;
  });
  ipcMain.handle("skills-remove", (_e, name: string) => skillEngine.deleteSkill(name));

  // IPC: layout config
  ipcMain.handle("panels-list", () => panelManager.listPanels());
  ipcMain.handle("panels-add", (_e, id: string, url: string) => {
    panelManager.addPanel(id, url);
    return true;
  });

  // IPC: layouts CRUD
  ipcMain.handle("layouts-list", () =>
    layoutManager.listLayouts().map((l) => ({
      name: l.name,
      splits: l.cells.map((c) => ({ panelId: c.panelId })),
    }))
  );
  ipcMain.handle("layouts-save", (_e, name: string, panelIds: string[]) => {
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
    layoutManager.saveLayout({
      ...grid,
      version: 2,
    });
    return true;
  });
  ipcMain.handle("layouts-delete", (_e, name: string) => layoutManager.deleteLayout(name));

  // IPC: autocomplete data
  ipcMain.handle("get-completions", () => ({
    panels: panelManager.listPanels().map((p) => p.id),
    library: library.list(),
    skills: skillEngine.listSkills(),
    layouts: layoutManager.listLayouts().map((l) => l.name),
  }));

  // IPC: grid resize (drag dividers)
  ipcMain.on("split-drag-start", () => {
    if (mainWindow) panelManager.hideActive(mainWindow);
  });
  ipcMain.on("split-drag-move", (_e, ratio: number) => {
    mainWindow?.webContents.send("split-drag-preview", ratio);
  });
  ipcMain.on("split-drag-end", (_e, ratio: number) => {
    if (!mainWindow) return;
    layoutManager.updateSplitRatio(ratio, mainWindow);
    sendSplitState();
  });
  ipcMain.on("grid-drag-end", (_e, type: "col" | "row", index: number, fraction: number) => {
    if (!mainWindow) return;
    if (type === "col") {
      layoutManager.updateColWidth(index, fraction, mainWindow);
    } else {
      layoutManager.updateRowHeight(index, fraction, mainWindow);
    }
    sendSplitState();
  });

  // IPC: swap one side of a split
  ipcMain.on("split-swap", (_e, index: number, newPanelId: string) => {
    if (!mainWindow) return;
    layoutManager.swapPanel(index, newPanelId, mainWindow);
    sendSplitState();
    // Persist updated split
    const info = layoutManager.getSplitInfo();
    if (info) {
      setPreference("lastView", { type: "split", panels: info.panelIds });
    }
  });

  // IPC: license + API key
  ipcMain.handle("check-license", () => checkLicense());
  ipcMain.handle("activate-license", (_e, key: string) => activateLicense(key));
  ipcMain.handle("validate-api-key", async (_e, key: string) => {
    const result = await validateApiKey(key);
    if (result.valid) {
      saveApiKey(key);
      // Update skill engine with the new key
      process.env.ANTHROPIC_API_KEY = key;
    }
    return result;
  });
  ipcMain.handle("get-api-key", () => loadApiKey());

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
  });

  // Tell renderer to check license gate
  mainWindow?.webContents.on("did-finish-load", () => {
    const license = checkLicense();
    const apiKey = loadApiKey();
    const needsOnboarding = license.status === "expired" || !apiKey;
    const hideWelcome = getPreference<boolean>("hideWelcome", false);
    mainWindow?.webContents.send("boot", {
      license,
      apiKey: apiKey ? true : false,
      needsOnboarding,
      hideWelcome,
    });
    sendSplitState();
  });
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  mcpServer?.stop();
  cloudSync?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
