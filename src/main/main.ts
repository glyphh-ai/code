/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "path";
import { PanelManager } from "./panel-manager";
import { CommandParser } from "./command-parser";
import { ProxyCapture } from "./proxy-capture";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { MCPServer } from "./mcp-server";

let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let commandParser: CommandParser;
let proxyCapture: ProxyCapture;
let library: Library;
let skillEngine: SkillEngine;
let mcpServer: MCPServer;

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
  proxyCapture = new ProxyCapture();
  panelManager = new PanelManager();
  commandParser = new CommandParser(panelManager, library, skillEngine);

  // Local MCP server
  mcpServer = new MCPServer(library);
  await mcpServer.start();

  // Create window
  await createWindow();

  // Global hotkey: Cmd+Y / Ctrl+Y
  registerHotkey(mainWindow!);

  // IPC: renderer sends commands
  ipcMain.on("command", (_event, input: string) => {
    commandParser.execute(input, proxyCapture.currentBuffer());
  });
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  mcpServer?.stop();
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
