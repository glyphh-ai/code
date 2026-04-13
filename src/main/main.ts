/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, webContents } from "electron";
import path from "path";
import { PanelManager } from "./panel-manager";
import { TerminalManager } from "./terminal";
import { CommandParser } from "./command-parser";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { MCPServer } from "./mcp-server";
import { CloudSync } from "./cloud-sync";
import { checkLicense, activateLicense, loadApiKey, saveApiKey, validateApiKey, getCheckoutUrl } from "./license";
import { LayoutManager } from "./layout-manager";
import { AppConnector, CommandMapping } from "./app-connector";
import { ConnectorAgent } from "./connector-agent";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./preferences";
import { YoInterceptor } from "./yo-interceptor";
import { YoChat } from "./yo-chat";
import { SessionCache } from "./session-cache";
import { ToolManager } from "./tool-manager";

let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let library: Library;
let skillEngine: SkillEngine;
let mcpServer: MCPServer;
let cloudSync: CloudSync;
let appConnector: AppConnector;
let connectorAgent: ConnectorAgent;
let terminalManager: TerminalManager;

async function createWindow() {
  const saved = getPreference<{ x?: number; y?: number; width: number; height: number; maximized?: boolean }>("windowBounds", { width: 1200, height: 800 });

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
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

  if (saved.maximized) mainWindow.maximize();

  mainWindow.loadFile(
    path.join(__dirname, "..", "renderer", "index.html")
  );

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Persist window position and size
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const maximized = mainWindow.isMaximized();
      const bounds = maximized ? (getPreference<any>("windowBounds", null) || mainWindow.getBounds()) : mainWindow.getBounds();
      setPreference("windowBounds", { ...bounds, maximized });
    }, 500);
  };
  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  // Load saved API key into process.env BEFORE constructing services
  // (they read process.env.ANTHROPIC_API_KEY in their constructors)
  const savedApiKey = loadApiKey();
  if (savedApiKey) {
    process.env.ANTHROPIC_API_KEY = savedApiKey;
  }

  // Core services
  library = new Library();
  skillEngine = new SkillEngine(library);
  appConnector = new AppConnector();
  connectorAgent = new ConnectorAgent();

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();

  // Tool manager — AI automation recipes
  const toolManager = new ToolManager();

  // yo/sup/dip/wassup interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, library, skillEngine, session, toolManager);

  panelManager = new PanelManager((id, wc) => {
    if (id === "term") {
      // Spawn pty when terminal page loads
      wc.on("did-finish-load", () => terminalManager.spawn(wc));
    } else {
      // Activate interceptor so yo/dip/sup work on app panels
      yoInterceptor.activate(wc, id);
    }
  });

  // Persist zoom when changed via keyboard shortcut in panels
  panelManager.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Seed PanelManager configs from apps (apps are the source of truth)
  const terminalHtml = `file://${path.join(__dirname, "..", "renderer", "terminal.html")}`;
  const terminalPreload = path.join(__dirname, "terminal-preload.js");
  const monacoHtml = `file://${path.join(__dirname, "..", "renderer", "monaco.html")}`;
  for (const app of appConnector.list()) {
    if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://monaco") {
      panelManager.addPanel(app.id, monacoHtml);
    } else {
      panelManager.addPanel(app.id, app.url);
    }
  }

  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, library, skillEngine, layoutManager, appConnector);
  commandParser.setWelcomeHandler(() => {
    mainWindow?.webContents.send("show-welcome");
  });

  // LLM engine for inline yo/sup/wassup execution
  const yoChat = new YoChat(panelManager, library);
  yoChat.setSkillEngine(skillEngine);
  yoChat.setAppConnector(appConnector);
  yoInterceptor.setYoChat(yoChat);

  // Give interceptor access to visible panel IDs (for multi-panel grab)
  yoInterceptor.setVisiblePanelsGetter(() => {
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) return gridInfo.panelIds;
    return panelManager.activePanelId ? [panelManager.activePanelId] : [];
  });

  // Wire command callbacks for interceptor + chat (both need dip routing)
  const execCommand = async (cmd: string) => {
    const result = await commandParser.execute(cmd);
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
    return result;
  };
  yoInterceptor.setCommandHandler(execCommand);
  yoChat.setCommandCallback(execCommand);

  // Terminal yo/sup/dip — route through command parser, show result in terminal
  terminalManager.setCommandHandler(async (cmd, wc) => {
    const result = await execCommand(cmd);
    if (result && !wc.isDestroyed()) {
      // Write result to terminal in grey, then newline for fresh prompt
      const lines = result.replace(/\r/g, "").split("\n").join("\r\n");
      wc.send("terminal:data", `\x1b[90m${lines}\x1b[0m\r\n`);
    }
  });

  // Local MCP server
  mcpServer = new MCPServer(library);
  await mcpServer.start();

  // Cloud sync (pulls from yo.yo.dev → ~/yo/library/)
  cloudSync = new CloudSync(library);
  cloudSync.start();

  // Create window
  await createWindow();
  if (mainWindow) commandParser.setMainWindow(mainWindow);

  // Restore panels from last view (or default to claude)
  function restorePanels() {
    const lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][]; grid?: import("./layout-manager").GridLayout }>("lastView", null!);
    if (lastView && mainWindow) {
      if (lastView.type === "grid-full" && lastView.grid) {
        layoutManager.applyGridLayout(lastView.grid, mainWindow);
      } else if (lastView.type === "grid" && lastView.rows) {
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
  }

  // Helper: push grid state to renderer (for drag handles + panel chips)
  function sendSplitState() {
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
  }

  // Check if onboarding is needed BEFORE restoring panels
  // (BrowserViews render above HTML, so they'd cover the onboarding overlay)
  const bootLicense = checkLicense();
  const needsOnboarding = bootLicense.status === "expired" || !savedApiKey;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Only restore panels if not gated by onboarding
  if (!needsOnboarding) {
    restorePanels();
    panelsReady = true;
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
        label: "View",
        submenu: [
          {
            label: "Toggle Panel DevTools",
            accelerator: "CmdOrCtrl+Alt+I",
            click: () => panelManager.toggleDevTools(),
          },
          {
            label: "Toggle App DevTools",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => {
              if (mainWindow) {
                if (mainWindow.webContents.isDevToolsOpened()) {
                  mainWindow.webContents.closeDevTools();
                } else {
                  mainWindow.webContents.openDevTools({ mode: "detach" });
                }
              }
            },
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
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

  // IPC: capture panel screenshots (freeze-frame before hiding)
  ipcMain.handle("capture-panels", async () => {
    if (!mainWindow) return [];
    return panelManager.captureScreenshots(mainWindow);
  });

  // IPC: panel visibility (for help overlay)
  ipcMain.on("panels-hide", () => {
    if (mainWindow) panelManager.hideActive(mainWindow);
  });
  ipcMain.on("panels-show", () => {
    if (!mainWindow || !panelsReady) return;
    panelManager.hidden = false;
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

  // IPC: grid resize (drag dividers)
  ipcMain.on("grid-drag-end", (_e, type: "col" | "row", index: number, fraction: number) => {
    if (!mainWindow) return;
    if (type === "col") {
      layoutManager.updateColWidth(index, fraction, mainWindow);
    } else {
      layoutManager.updateRowHeight(index, fraction, mainWindow);
    }
    sendSplitState();
    // Persist updated proportions so they survive restart
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) {
      setPreference("lastView", {
        type: "grid-full",
        grid: {
          name: "",
          version: 2,
          cols: gridInfo.cols,
          rows: gridInfo.rows,
          colWidths: gridInfo.colWidths,
          rowHeights: gridInfo.rowHeights,
          cells: gridInfo.cells,
        },
      });
    }
  });

  // IPC: apps CRUD + connect + pick
  ipcMain.handle("apps-list", () => appConnector.list());
  ipcMain.handle("apps-add", (_e, id: string, name: string, url: string) => {
    const app = appConnector.add(id, name, url);
    panelManager.addPanel(id, url);
    return app;
  });
  ipcMain.handle("apps-remove", (_e, id: string) => appConnector.remove(id));
  ipcMain.handle("apps-update-name", (_e, id: string, name: string) => appConnector.updateName(id, name));
  ipcMain.handle("apps-update-id", (_e, oldId: string, newId: string) => {
    const ok = appConnector.updateId(oldId, newId);
    if (ok) {
      // Re-register panel with new ID
      const app = appConnector.get(newId);
      if (app) panelManager.addPanel(newId, app.url);
    }
    return ok;
  });
  ipcMain.handle("apps-connect", async (_e, id: string, webContentsId?: number) => {
    const appConfig = appConnector.get(id);
    if (!appConfig) return { ok: false, error: "App not found" };

    // Use embedded webview's webContents if provided, else fall back to panel
    let wc = webContentsId ? webContents.fromId(webContentsId) : null;
    if (!wc) {
      if (!mainWindow) return { ok: false, error: "No window" };
      if (!panelManager.hasPanel(id)) panelManager.addPanel(id, appConfig.url);
      const view = panelManager.getOrCreateView(id, mainWindow);
      if (!view) return { ok: false, error: "Could not create panel" };
      wc = view.webContents;
    }

    if (wc.isLoading()) {
      await new Promise<void>((resolve) => wc!.once("did-finish-load", () => resolve()));
    }

    try {
      const result = await connectorAgent.analyze(wc, appConfig.name, appConfig.url);
      appConnector.updateCommands(id, result.commands, result.meta);

      // Activate yo/sup interception on the panel's BrowserView
      const panelWc = panelManager.getWebContents(id);
      if (panelWc) yoInterceptor.activate(panelWc, id);

      return { ok: true, commandCount: Object.keys(result.commands).length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });
  ipcMain.handle("apps-set-command", (_e, id: string, commandKey: string, mapping: CommandMapping) => {
    return appConnector.setCommand(id, commandKey, mapping);
  });
  ipcMain.handle("apps-remove-command", (_e, id: string, commandKey: string) => {
    return appConnector.removeCommand(id, commandKey);
  });
  ipcMain.handle("apps-test-command", async (_e, id: string, commandKey: string, webContentsId?: number) => {
    const appConfig = appConnector.get(id);
    if (!appConfig) return "App not found";
    const mapping = appConfig.commands[commandKey];
    if (!mapping) return "Command not mapped";

    // Use embedded webview if provided, else panel
    let wc = webContentsId ? webContents.fromId(webContentsId) : panelManager.getWebContents(id);
    if (!wc) return "App not loaded.";

    try {
      // For setValue/push, send a test string so the user can see it working
      const testValue = mapping.action === "setValue" ? "Hello from yo!" : undefined;
      return await executeCommand(wc, mapping, testValue);
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  // IPC: DOM picker — inject picker script into a webContents, receive result via console-message
  // (executeJavaScript doesn't properly await Promises in Electron 35, so we use a message channel)
  ipcMain.on("start-picker", (_e, webContentsId: number) => {
    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      mainWindow?.webContents.send("picker-result", null);
      return;
    }

    // Listen for the picker result via console.log message
    const handler = (_event: Electron.Event, _level: number, message: string) => {
      if (!message.startsWith("__YO_PICK__:")) return;
      wc.removeListener("console-message", handler);
      try {
        const json = message.slice("__YO_PICK__:".length);
        const result = JSON.parse(json);
        mainWindow?.webContents.send("picker-result", result);
      } catch {
        mainWindow?.webContents.send("picker-result", null);
      }
    };
    wc.on("console-message", handler);

    // Timeout: cancel after 30s if no pick
    setTimeout(() => {
      wc.removeListener("console-message", handler);
    }, 30000);

    // Inject the picker script (fire-and-forget, no return value needed)
    const pickerScript = `
      (function() {
        var overlay = document.createElement('div');
        overlay.id = '__yo_picker_overlay__';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;cursor:crosshair;';

        var highlight = document.createElement('div');
        highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;' +
          'border:2px solid #25C75E;background:rgba(37,199,94,0.08);border-radius:3px;' +
          'transition:all 0.05s ease;box-shadow:0 0 12px rgba(37,199,94,0.3);display:none;';
        document.body.appendChild(highlight);

        var label = document.createElement('div');
        label.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;' +
          'background:#1a1a1a;color:#e0e0e0;font:12px monospace;' +
          'padding:4px 8px;border-radius:4px;border:1px solid #25C75E;' +
          'box-shadow:0 4px 12px rgba(0,0,0,0.5);max-width:400px;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;display:none;';
        document.body.appendChild(label);

        var lastTarget = null;

        function getEl(e) {
          overlay.style.pointerEvents = 'none';
          var el = document.elementFromPoint(e.clientX, e.clientY);
          overlay.style.pointerEvents = 'auto';
          return el;
        }

        // Filter out dynamic/framework-generated class names
        var DYNAMIC_CLASS_RE = /^(ng-tns-|ng-star-|ng-trigger-|ng-animating|ng-untouched|ng-touched|ng-pristine|ng-dirty|ng-valid|ng-invalid|cdk-|mat-|css-|sc-|_|jsx-|svelte-|\\d)/;
        var STATE_CLASS_RE = /^(is-|has-|with-|no-|not-|height-|width-|show-|hide-|visible-|hidden-|active$|focused$|disabled$|selected$|expanded$|collapsed$|open$|closed$)/;
        function isStableClass(c) {
          if (c.length <= 1 || c.length >= 50) return false;
          if (DYNAMIC_CLASS_RE.test(c)) return false;
          if (STATE_CLASS_RE.test(c)) return false;
          // Skip classes that look like generated hashes (contain long digit sequences)
          if (/\d{4,}/.test(c)) return false;
          return true;
        }

        function buildSelector(el) {
          if (!el || !el.tagName) return 'body';
          if (el === document.body || el === document.documentElement) return 'body';
          if (el.id) return '#' + CSS.escape(el.id);

          // Prefer stable attributes over classes
          try {
            var tid = el.getAttribute('data-testid');
            if (tid) return '[data-testid="' + tid + '"]';
          } catch(e) {}
          try {
            var role = el.getAttribute('role');
            if (role) {
              var rs = el.tagName.toLowerCase() + '[role="' + role + '"]';
              try { if (document.querySelectorAll(rs).length === 1) return rs; } catch(e) {}
            }
          } catch(e) {}
          try {
            var aria = el.getAttribute('aria-label');
            if (aria) {
              var s = el.tagName.toLowerCase() + '[aria-label="' + aria.replace(/"/g, '\\\\\\"') + '"]';
              try { if (document.querySelectorAll(s).length === 1) return s; } catch(e) {}
            }
          } catch(e) {}
          try {
            if (el.getAttribute('contenteditable') === 'true') {
              var ce = el.tagName.toLowerCase() + '[contenteditable="true"]';
              try { if (document.querySelectorAll(ce).length === 1) return ce; } catch(e) {}
            }
          } catch(e) {}
          try {
            var ph = el.getAttribute('placeholder');
            if (ph) {
              var ps = el.tagName.toLowerCase() + '[placeholder="' + ph.replace(/"/g, '\\\\\\"') + '"]';
              try { if (document.querySelectorAll(ps).length === 1) return ps; } catch(e) {}
            }
          } catch(e) {}

          var parts = [];
          var cur = el;
          while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 5) {
            var tag = cur.tagName ? cur.tagName.toLowerCase() : '?';
            if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
            var cls = '';
            try {
              var stable = Array.from(cur.classList || []).filter(isStableClass).slice(0, 3);
              cls = stable.map(function(c) { return '.' + CSS.escape(c); }).join('');
            } catch(e) {}
            // Also try role/contenteditable at this level for path segments
            var attrSel = '';
            try {
              var r2 = cur.getAttribute('role');
              if (r2) attrSel = '[role="' + r2 + '"]';
              else if (cur.getAttribute('contenteditable') === 'true') attrSel = '[contenteditable="true"]';
            } catch(e) {}
            var seg = tag + cls + attrSel;
            if (cur.parentElement) {
              try {
                var sibs = Array.from(cur.parentElement.children).filter(function(s) { return s.tagName === cur.tagName; });
                if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
              } catch(e) {}
            }
            parts.unshift(seg);
            cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
          }
          return parts.join(' > ') || el.tagName.toLowerCase();
        }

        overlay.addEventListener('mousemove', function(e) {
          var el = getEl(e);
          if (el === lastTarget) return;
          lastTarget = el;
          if (!el || el === overlay) { highlight.style.display = 'none'; label.style.display = 'none'; return; }
          try {
            var r = el.getBoundingClientRect();
            highlight.style.display = 'block';
            highlight.style.left = r.left + 'px'; highlight.style.top = r.top + 'px';
            highlight.style.width = r.width + 'px'; highlight.style.height = r.height + 'px';
            var info = (el.tagName || '?').toLowerCase();
            if (el.id) info += '#' + el.id;
            else if (el.className && typeof el.className === 'string') info += '.' + el.className.split(' ')[0];
            try { var role = el.getAttribute('role'); if (role) info += ' [' + role + ']'; } catch(x) {}
            label.textContent = info;
            label.style.display = 'block';
            label.style.left = r.left + 'px';
            label.style.top = Math.max(0, r.top - 28) + 'px';
          } catch(x) { highlight.style.display = 'none'; label.style.display = 'none'; }
        });

        overlay.addEventListener('click', function(e) {
          e.preventDefault(); e.stopPropagation();
          var el = getEl(e);
          cleanup();
          if (!el) { console.log('__YO_PICK__:null'); return; }
          var tag = (el.tagName || 'unknown').toLowerCase();
          var ce = false; try { ce = el.getAttribute('contenteditable') === 'true'; } catch(x) {}
          var role = ''; try { role = el.getAttribute('role') || ''; } catch(x) {}
          console.log('__YO_PICK__:' + JSON.stringify({
            selector: buildSelector(el), tag: tag,
            text: (el.innerText || el.textContent || '').trim().slice(0, 100),
            isEditable: ce || tag === 'input' || tag === 'textarea',
            isClickable: tag === 'button' || tag === 'a' || role === 'button',
          }));
        });

        function onKey(e) {
          if (e.key === 'Escape') { cleanup(); console.log('__YO_PICK__:null'); }
        }
        document.addEventListener('keydown', onKey);

        function cleanup() { overlay.remove(); highlight.remove(); label.remove(); document.removeEventListener('keydown', onKey); }
        document.body.appendChild(overlay);
      })();
    `;
    wc.executeJavaScript(pickerScript).catch(() => {});
  });

  // IPC: command execution (used by interceptor routing, no UI)
  ipcMain.handle("exec-command", async (_e, cmd: string) => {
    return execCommand(cmd);
  });

  // IPC: tools CRUD
  ipcMain.handle("tools-list", () => toolManager.list());
  ipcMain.handle("tools-read", (_e, id: string) => toolManager.get(id) || null);
  ipcMain.handle("tools-write", (_e, id: string, name: string, description: string, prompt: string) => {
    const existing = toolManager.get(id);
    if (existing) {
      return toolManager.update(id, { name, description, prompt });
    }
    toolManager.add(id, name, description, prompt);
    return true;
  });
  ipcMain.handle("tools-remove", (_e, id: string) => toolManager.remove(id));

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
  ipcMain.handle("get-checkout-url", async () => {
    const url = await getCheckoutUrl();
    if (url) {
      const { shell } = await import("electron");
      shell.openExternal(url);
    }
    return url;
  });

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
  });

  // IPC: onboarding complete — restore panels after activation
  ipcMain.handle("onboarding-complete", () => {
    restorePanels();
    panelsReady = true;
    sendSplitState();
  });

  // Tell renderer to check license gate
  mainWindow?.webContents.on("did-finish-load", () => {
    const hideWelcome = getPreference<boolean>("hideWelcome", false);
    mainWindow?.webContents.send("boot", {
      license: bootLicense,
      apiKey: savedApiKey ? true : false,
      needsOnboarding,
      hideWelcome,
    });
    if (!needsOnboarding) sendSplitState();
  });
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  mcpServer?.stop();
  cloudSync?.stop();
  terminalManager?.killAll();
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
