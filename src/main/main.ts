/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import "dotenv/config";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeTheme, shell, systemPreferences } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { PanelManager } from "./panel-manager";
import { TerminalManager } from "./terminal";
import { CommandParser } from "./command-parser";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, serverPostAuthed } from "./auth";
import { CloudSync } from "./cloud-sync";
import { loadLLMConfig, saveLLMConfig, validateLLMConfig, PROVIDER_PRESETS, LLMConfig } from "./llm-config";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { canAddApp, canCreateSkill, canSaveLayout, canUseMcp, canUseSync, canUseVoice, getCurrentLimits } from "./entitlements";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./preferences";
import { YoInterceptor } from "./yo-interceptor";
import { YoChat } from "./yo-chat";
import { SessionCache } from "./session-cache";
import { NoteStore } from "./note-store";
import { MemoryStore } from "./memory-store";
import { Transcriber } from "./transcriber";
import { VoiceRelay } from "./voice-relay";
import { smartGrab } from "./smart-grab";
import { scanPanel, formatScan } from "./dom-scanner";
import { VSCodeServer } from "./vscode-server";
import { autoUpdater } from "electron-updater";
import { ConfigSync } from "./config-sync";
import { reloadRemotePatterns } from "./firewall";
import { usageTracker } from "./usage-tracker";
import { promptLog } from "./prompt-log";
import { Embedder } from "./embedder";
import { CaptureStore } from "./capture-store";
import { YoAgent } from "./yo-agent";
import { ActionGrabber } from "./action-grabber";
import { Council } from "./council";
import { McpExpose } from "./mcp-expose";
import { McpManager } from "./mcp-manager";
import { DripManager } from "./drip-manager";
import { ConnectorManager } from "./connectors";


let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let skillEngine: SkillEngine;
let appConnector: AppConnector;

let terminalManager: TerminalManager;
let vscodeServer: VSCodeServer;
let noteStore: NoteStore;
let voiceRelay: VoiceRelay | null = null;
let cloudSyncInstance: CloudSync | null = null;
let configSync: ConfigSync | null = null;
let embedder: Embedder | null = null;
let mcpExpose: McpExpose | null = null;
let mcpManager: McpManager | null = null;
let dripManager: DripManager | null = null;
let actionGrabber: ActionGrabber | null = null;
let connectorManager: ConnectorManager | null = null;

// ── DOM Picker script (injected into panel webContents) ─────
const PICKER_SCRIPT = `(function(){
  if(document.getElementById('__yo_picker__')) return;
  const overlay=document.createElement('div');
  overlay.id='__yo_picker__';
  overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
  const highlight=document.createElement('div');
  highlight.style.cssText='position:fixed;pointer-events:none;border:2px solid #a855f7;background:rgba(168,85,247,0.08);z-index:2147483646;transition:all 0.05s;display:none;';
  const label=document.createElement('div');
  label.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#a855f7;color:#fff;font:11px/1.3 monospace;padding:2px 6px;border-radius:3px;display:none;max-width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
  document.body.appendChild(highlight);
  document.body.appendChild(label);
  document.body.appendChild(overlay);
  let current=null;
  function buildSelector(el){
    if(el.dataset && el.dataset.testid) return '[data-testid="'+el.dataset.testid+'"]';
    if(el.getAttribute('role')&&el.getAttribute('aria-label')) return '[role="'+el.getAttribute('role')+'"][aria-label="'+el.getAttribute('aria-label')+'"]';
    if(el.id&&!/\\d{4,}/.test(el.id)&&!/^[:.]/.test(el.id)&&el.id.length>3&&!/^(ember|react|ng|mat-|cdk-|gb_)/.test(el.id)&&!/^[a-z]{1,2}\\d/.test(el.id)) return '#'+CSS.escape(el.id);
    if(el.getAttribute('placeholder')) return el.tagName.toLowerCase()+'[placeholder="'+el.getAttribute('placeholder')+'"]';
    if(el.getAttribute('aria-label')) return '[aria-label="'+el.getAttribute('aria-label')+'"]';
    if(el.getAttribute('role')) return el.tagName.toLowerCase()+'[role="'+el.getAttribute('role')+'"]';
    if(el.getAttribute('name')&&!el.getAttribute('name').match(/\\d{4,}/)) return el.tagName.toLowerCase()+'[name="'+el.getAttribute('name')+'"]';
    const parts=[];
    let node=el;
    while(node&&node!==document.body){
      let tag=node.tagName.toLowerCase();
      const parent=node.parentElement;
      if(parent){
        const siblings=Array.from(parent.children).filter(c=>c.tagName===node.tagName);
        if(siblings.length>1) tag+=':nth-of-type('+(siblings.indexOf(node)+1)+')';
      }
      parts.unshift(tag);
      node=parent;
      if(parts.length>=4) break;
    }
    return parts.join(' > ');
  }
  overlay.addEventListener('mousemove',function(e){
    overlay.style.pointerEvents='none';
    const target=document.elementFromPoint(e.clientX,e.clientY);
    overlay.style.pointerEvents='auto';
    if(!target||target===overlay||target===highlight||target===label){highlight.style.display='none';label.style.display='none';current=null;return;}
    current=target;
    const r=target.getBoundingClientRect();
    highlight.style.display='block';
    highlight.style.left=r.left+'px';highlight.style.top=r.top+'px';highlight.style.width=r.width+'px';highlight.style.height=r.height+'px';
    const sel=buildSelector(target);
    const txt=(target.textContent||'').trim().slice(0,40);
    label.textContent=target.tagName.toLowerCase()+(txt?' — '+txt:'');
    label.style.display='block';
    label.style.left=Math.min(r.left,window.innerWidth-310)+'px';
    label.style.top=Math.max(0,r.top-22)+'px';
  });
  overlay.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    if(!current) return;
    const sel=buildSelector(current);
    const tag=current.tagName.toLowerCase();
    const txt=(current.textContent||'').trim().slice(0,80);
    const isEditable=tag==='input'||tag==='textarea'||current.isContentEditable||current.getAttribute('role')==='textbox';
    const isClickable=tag==='button'||tag==='a'||current.getAttribute('role')==='button'||current.onclick!=null||window.getComputedStyle(current).cursor==='pointer';
    console.log('__YO_PICK__:'+JSON.stringify({selector:sel,tag:tag,text:txt,isEditable:isEditable,isClickable:isClickable}));
    overlay.remove();highlight.remove();label.remove();
  });
  overlay.addEventListener('contextmenu',function(e){e.preventDefault();overlay.remove();highlight.remove();label.remove();});
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){overlay.remove();highlight.remove();label.remove();document.removeEventListener('keydown',esc);}});
})()`;

// Drip effects — extracted to drip-manager.ts

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

  // Request macOS mic entitlement (triggers OS permission dialog on first use)
  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("microphone").catch(() => {});
  }

  // Allow microphone access in the main window renderer (for voice input)
  const mainSes = mainWindow.webContents.session;
  mainSes.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  mainSes.setPermissionCheckHandler((_wc, permission) => permission === "media");

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

  // Refresh auth/tier when window regains focus (e.g. returning from billing portal)
  mainWindow.on("focus", () => {
    refreshHeartbeat().catch(() => {});
  });
}

async function boot() {
  app.setName("Yo");

  // Clear stale IndexedDB locks from previous crashes
  try {
    const idbDir = path.join(app.getPath("userData"), "Partitions", "yo", "IndexedDB");
    const fs = require("fs");
    if (fs.existsSync(idbDir)) {
      for (const entry of fs.readdirSync(idbDir)) {
        const lockPath = path.join(idbDir, entry, "LOCK");
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
    }
  } catch { /* non-critical */ }

  // Load LLM config (auto-migrates from legacy .apikey if needed)
  let llmConfig = loadLLMConfig();
  if (llmConfig.provider === "anthropic" && llmConfig.apiKey) {
    process.env.ANTHROPIC_API_KEY = llmConfig.apiKey;
  }

  function applyLLMConfig(config: LLMConfig) {
    llmConfig = config;
    if (config.provider === "anthropic" && config.apiKey) {
      process.env.ANTHROPIC_API_KEY = config.apiKey;
    }
    yoChat?.setLLMConfig(config);
    skillEngine?.setLLMConfig(config);
    yoAgent?.setLLMConfig(config);
    yoInterceptor?.setCurrentModel(config.model);
    yoInterceptor?.setAvailableModels(PROVIDER_PRESETS[config.provider]?.models || []);
  }

  // Core services
  skillEngine = new SkillEngine();
  appConnector = new AppConnector();

  // Embedder + capture store
  embedder = new Embedder();
  embedder.init().catch((err) => console.error("[embedder]", err));

  const captureStore = new CaptureStore();
  captureStore.setEmbedder(embedder);
  captureStore.setPolicyResolver((source) => appConnector.getCapturePolicy(source));

  // Action-driven capture — grabs content on blur/navigate + polls chat panels
  actionGrabber = new ActionGrabber();
  actionGrabber.setCaptureStore(captureStore);
  actionGrabber.setAppConnector(appConnector);

  // MCP expose — read-only server for external LLM tools (Advanced tier)
  mcpExpose = new McpExpose();
  mcpExpose.setCaptureStore(captureStore);
  if (getPreference<boolean>("mcpExposeEnabled", false) && canUseMcp().allowed) {
    mcpExpose.start().then((r) => {
      if (!r.ok) console.error("[mcp-expose] failed to start:", r.error);
    });
  }

  // MCP Manager — user-configured external MCP servers (Advanced tier)
  mcpManager = new McpManager();
  mcpManager.setAppConnector(appConnector);
  if (canUseMcp().allowed) {
    mcpManager.init().catch((err) => console.error("[mcp-manager]", err));
  }
  mcpManager.on("changed", () => {
    mainWindow?.webContents.send("mcp-changed");
  });

  // Pipedream Connectors — managed OAuth connections (Advanced tier)
  connectorManager = new ConnectorManager();
  connectorManager.setMcpManager(mcpManager);
  connectorManager.setAppConnector(appConnector);
  connectorManager.on("changed", () => {
    mainWindow?.webContents.send("connectors-changed");
  });

  // Council — deterministic multi-model debate orchestrator
  const council = new Council();
  council.setCaptureStore(captureStore);

  // Yo agent — capture search + format assistant
  const yoAgent = new YoAgent();
  yoAgent.setCaptureStore(captureStore);
  yoAgent.setSkillEngine(skillEngine);
  yoAgent.setCouncil(council);

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});
  session.setOnRawCapture((appId, content) => {
    captureStore.ingest(appId, content).catch(() => {});
  });

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, skillEngine, session);
  yoInterceptor.setAgentMode(getPreference<string>("agentMode", "ask"));
  yoInterceptor.setCurrentModel(llmConfig.model);
  yoInterceptor.setAvailableModels(PROVIDER_PRESETS[llmConfig.provider]?.models || []);
  const initialTheme = getPreference<string>("theme", "dark");
  nativeTheme.themeSource = initialTheme === "system" ? "system" : initialTheme as "light" | "dark";
  const resolvedTheme = initialTheme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : initialTheme;
  yoInterceptor.setTheme(resolvedTheme);

  nativeTheme.on("updated", () => {
    if (getPreference<string>("theme", "dark") !== "system") return;
    const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    yoInterceptor.setTheme(resolved);
    mainWindow?.webContents.send("theme-changed", resolved);
  });

  panelManager = new PanelManager((id, wc) => {
    if (id === "term") {
      // Spawn pty when terminal page loads
      wc.on("did-finish-load", () => terminalManager.spawn(wc));
    } else {
      // Activate interceptor so yo/dip/sup work on app panels
      yoInterceptor.activate(wc, id);
      // Track URL changes in browser tabs for persistence
      if (id === "browser" || id.startsWith("browse-")) trackBrowserUrl(id, wc);
      // Track VS Code folder for persistence across restarts
      if (id === "vscode") trackVscodeFolder(wc);
    }

    // Track URL + favicon for URL bar and tab favicons
    const isBrowserPanel = id === "browser" || id.startsWith("browse-");
    if (isBrowserPanel) {
      // Browser panels use <webview> — track the guest's URL/favicon
      (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
        panelNavWc[id] = childWc;
        const trackChild = (url: string) => {
          if (url && url !== "about:blank") {
            panelUrls[id] = url;
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
          }
        };
        childWc.on("did-navigate", (_e: unknown, url: string) => {
          trackChild(url);
          actionGrabber?.onPanelNavigate(id).catch(() => {});
        });
        childWc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
          if (isMainFrame) trackChild(url);
          actionGrabber?.onInPageNavigate(id).catch(() => {});
        });
        childWc.on("did-finish-load", () => {
          actionGrabber?.onPageLoad(id).catch(() => {});
        });
        childWc.on("page-favicon-updated" as any, (_e: unknown, favicons: string[]) => {
          if (favicons?.length) {
            panelFavicons[id] = favicons[0];
            setPreference("panelFavicons", { ...panelFavicons });
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
            sendTabState();
          }
        });
      });
    } else {
      // Direct BrowserView — track its own URL/favicon
      panelNavWc[id] = wc;
      const trackDirect = (url: string) => {
        if (url && !url.startsWith("file://")) {
          panelUrls[id] = url;
          if (panelManager.activePanelId === id) sendUrlUpdate();
          sendPanelUrl(id);
        }
      };
      wc.on("did-navigate", (_e: unknown, url: string) => {
        trackDirect(url);
        actionGrabber?.onPanelNavigate(id).catch(() => {});
      });
      wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) trackDirect(url);
        actionGrabber?.onInPageNavigate(id).catch(() => {});
      });
      wc.on("did-finish-load", () => {
        actionGrabber?.onPageLoad(id).catch(() => {});
      });
      wc.on("page-favicon-updated" as any, (_e: unknown, favicons: string[]) => {
        if (favicons?.length) {
          panelFavicons[id] = favicons[0];
          setPreference("panelFavicons", { ...panelFavicons });
          if (panelManager.activePanelId === id) sendUrlUpdate();
          sendPanelUrl(id);
          sendTabState();
        }
      });
    }
  });

  // Wire action grabber to panel manager for webContents access + polling
  actionGrabber.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));
  actionGrabber.setPanelIdGetter(() => panelManager.getLoadedPanelIds());
  actionGrabber.startPolling();

  // Wire council to panel manager
  council.setPanelSwitcher((id) => panelManager.switchTo(id, mainWindow!));
  council.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Persist zoom when changed via keyboard shortcut in panels
  panelManager.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Browser panel helpers (must be before app connector loop)
  const BROWSER_HOMES: Record<string, string> = {
    claude: "https://claude.ai",
    chatgpt: "https://chatgpt.com",
    gemini: "https://gemini.google.com",
  };

  function resolveBrowserHome(): string {
    const pref = getPreference<string>("browserHomepage", "claude");
    if (pref === "custom") return getPreference<string>("browserHomepageUrl", "");
    return BROWSER_HOMES[pref] || BROWSER_HOMES.claude;
  }

  function browserHtmlUrl(initialUrl?: string): string {
    const base = `file://${path.join(__dirname, "..", "renderer", "browser.html")}`;
    if (initialUrl) return `${base}?url=${encodeURIComponent(initialUrl)}`;
    return base;
  }

  function trackBrowserUrl(panelId: string, wc: Electron.WebContents): void {
    (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
      const saveUrl = (url: string) => {
        if (url && url !== "about:blank") {
          const saved = getPreference<Record<string, string>>("browserTabUrls", {});
          saved[panelId] = url;
          setPreference("browserTabUrls", saved);
        }
      };
      childWc.on("did-navigate", (_e: unknown, url: string) => saveUrl(url));
      childWc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) saveUrl(url);
      });
    });
  }

  function trackVscodeFolder(wc: Electron.WebContents): void {
    const saveFolder = (navUrl: string) => {
      try {
        const u = new URL(navUrl);
        const folder = u.searchParams.get("folder");
        if (folder) setPreference("vscodeLastFolder", folder);
      } catch {}
    };
    wc.on("did-navigate", (_e: unknown, url: string) => saveFolder(url));
    wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) saveFolder(url);
    });
  }

  // Seed PanelManager configs from apps (apps are the source of truth)
  const terminalHtml = `file://${path.join(__dirname, "..", "renderer", "terminal.html")}`;
  const terminalPreload = path.join(__dirname, "terminal-preload.js");
  const monacoHtml = `file://${path.join(__dirname, "..", "renderer", "monaco.html")}`;
  const enableVscode = getPreference("enableVscodeServer", false);
  vscodeServer = new VSCodeServer();
  for (const app of appConnector.list()) {
    if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://monaco") {
      panelManager.addPanel(app.id, monacoHtml);
    } else if (app.url === "yo://browser") {
      const savedBrowserUrls = getPreference<Record<string, string>>("browserTabUrls", {});
      const browserUrl = savedBrowserUrls[app.id] || resolveBrowserHome();
      panelManager.addPanel(app.id, browserHtmlUrl(browserUrl), undefined, undefined, true);
    } else if (app.url === "yo://vscode" || app.url === "https://vscode.dev") {
      // VS Code uses local `code serve-web` for full file access
      if (enableVscode && vscodeServer.available) {
        panelManager.addPanel(app.id, VSCodeServer.expectedUrl());
      } else {
        // Show setup instructions instead of broken fallback
        const reason = !enableVscode
          ? "VS Code Server is disabled."
          : "VS Code CLI not found on this machine.";
        const infoPage = `data:text/html,${encodeURIComponent(`<html><head><style>
          body{background:#0a0a0a;color:#999;font-family:-apple-system,system-ui,sans-serif;
            display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
          .card{text-align:center;max-width:420px;padding:40px}
          h2{color:#ddd;font-size:18px;font-weight:600;margin:0 0 12px}
          p{font-size:14px;line-height:1.6;margin:8px 0}
          .reason{color:#777;font-size:13px;margin-bottom:16px}
          a{color:#25C75E;text-decoration:none;font-weight:500;cursor:pointer}
          a:hover{text-decoration:underline}
          .steps{text-align:left;margin:16px 0;padding:0;list-style:none}
          .steps li{padding:6px 0;font-size:13px;color:#888}
          .steps li::before{content:"→ ";color:#25C75E}
          code{font-family:"SF Mono","Fira Code",monospace;font-size:12px;
            background:#151515;padding:2px 6px;border-radius:4px;color:#ccc}
        </style></head><body><div class="card">
          <h2>VS Code Server</h2>
          <p class="reason">${reason}</p>
          <ul class="steps">
            <li>Install <a href="https://code.visualstudio.com/" target="_blank">Visual Studio Code</a></li>
            <li>Run <code>Shell Command: Install 'code' in PATH</code> from the VS Code command palette</li>
            <li>Enable <strong>VS Code Server</strong> in <a href="yo://open-settings">Settings</a></li>
            <li>Restart the app</li>
          </ul>
        </div></body></html>`)}`;
        panelManager.addPanel(app.id, infoPage);
      }
    } else {
      panelManager.addPanel(app.id, app.url!, undefined, app.forceWeb);
    }
  }

  // Start VS Code server in the background if enabled and CLI is available
  if (enableVscode && vscodeServer.available) {
    const lastFolder = getPreference<string>("vscodeLastFolder", "");
    vscodeServer.start(lastFolder || undefined).catch((err) => {
      console.log("[vscode-server] failed to start:", err.message);
    });
  }

  // Note store + memory store (flat files with keyword search)
  noteStore = new NoteStore();
  const memoryStore = new MemoryStore();

  // Transcriber — OpenAI Whisper API for voice input
  const transcriber = new Transcriber();

  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, skillEngine, layoutManager, appConnector, session);
  commandParser.setWelcomeHandler(() => {
    mainWindow?.webContents.send("show-welcome");
  });

  // LLM engine for inline yo/sup execution
  const yoChat = new YoChat(panelManager);
  applyLLMConfig(llmConfig);
  yoInterceptor.setYoChat(yoChat);
  yoInterceptor.setCaptureStore(captureStore);
  commandParser.setYoChat(yoChat);

  // Wire yo agent dependencies
  yoAgent.setSessionCache(session);
  yoAgent.setMemoryStore(memoryStore);
  yoAgent.setNoteStore(noteStore);

  // Sub-agent wiring — panel interaction callbacks
  yoAgent.setPanelLister(() => {
    const ids = panelManager.getLoadedPanelIds();
    if (ids.length === 0) return "No panels open.";
    return ids.map((id: string) => {
      const app = appConnector.get(id);
      const url = app?.url || "";
      const active = id === panelManager.activePanelId ? " [active]" : "";
      return `${id}${active} — ${app?.name || id} (${url})`;
    }).join("\n");
  });

  yoAgent.setPanelGrabber(async (panelId) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc) return null;
    const app = appConnector.get(panelId);
    let content = "";
    if (app?.commands.grab) {
      try { content = await executeCommand(wc, app.commands.grab); } catch {}
    }
    if (!content || content.startsWith("[Element not found")) {
      try { content = await smartGrab(wc) || ""; } catch {}
    }
    return content || null;
  });

  yoAgent.setPanelScanner(async (panelId) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc) return null;
    const scan = await scanPanel(wc);
    if (!scan) return null;
    let result = formatScan(scan);
    const app = appConnector.get(panelId);
    if (app && Object.keys(app.commands).length > 0) {
      const lines: string[] = ["MAPPED COMMANDS:"];
      for (const [name, cmd] of Object.entries(app.commands)) {
        const parts = [`  ${name}: ${cmd.action} "${cmd.selector}"`];
        if (cmd.description) parts.push(`— ${cmd.description}`);
        lines.push(parts.join(" "));
      }
      result += "\n" + lines.join("\n");
    }
    return result;
  });

  yoAgent.setPanelClicker(async (panelId, text, selector) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
    try {
      const result = await wc.executeJavaScript(`(function(){
        function realClick(el) {
          var rect = el.getBoundingClientRect();
          var x = rect.left + rect.width / 2;
          var y = rect.top + rect.height / 2;
          var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        }
        function findClickable(el) {
          var cur = el;
          while (cur && cur !== document.body) {
            var tag = cur.tagName.toLowerCase();
            if (tag === 'button' || tag === 'a' || cur.getAttribute('role') === 'button' ||
                cur.getAttribute('role') === 'tab' || cur.getAttribute('role') === 'menuitem' ||
                cur.onclick || cur.getAttribute('tabindex') !== null) return cur;
            cur = cur.parentElement;
          }
          return el;
        }
        ${selector && !text ? `
        var el = document.querySelector(${JSON.stringify(selector)});
        if (el) { realClick(findClickable(el)); return 'Clicked successfully.'; }
        return 'Element not found: ' + ${JSON.stringify(selector)};
        ` : ''}
        ${text ? `
        var target = ${JSON.stringify(text)};
        var targetLower = target.toLowerCase();
        var candidates = [];
        var all = document.querySelectorAll('[aria-label],[title],[data-tooltip],[placeholder],[data-testid]');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          var attrs = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.getAttribute('placeholder'), el.getAttribute('data-testid')];
          for (var j = 0; j < attrs.length; j++) {
            if (!attrs[j]) continue;
            var val = attrs[j].toLowerCase();
            if (val === targetLower) { candidates.push({ el: el, score: 0 }); break; }
            if (val.includes(targetLower)) { candidates.push({ el: el, score: val.length }); break; }
          }
        }
        if (candidates.length === 0) {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            var el = walker.currentNode;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            var t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length > 500) continue;
            var tLower = t.toLowerCase();
            if (tLower === targetLower) { candidates.push({ el: el, score: 0 }); break; }
            if (tLower.includes(targetLower) && t.length < 200) { candidates.push({ el: el, score: t.length }); }
          }
        }
        candidates.sort(function(a, b) { return a.score - b.score; });
        if (candidates.length > 0) { realClick(findClickable(candidates[0].el)); return 'Clicked successfully.'; }
        return 'Element not found: ' + target;
        ` : ''}
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      return result;
    } catch (err) {
      return `Click failed: ${err instanceof Error ? err.message : err}`;
    }
  });

  yoAgent.setPanelNavigator(async (panelId, url) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
    try {
      wc.loadURL(url);
      return `Navigating to ${url}`;
    } catch (err) {
      return `Navigation failed: ${err instanceof Error ? err.message : err}`;
    }
  });

  yoAgent.setPanelTyper(async (panelId, text, opts) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
    const shouldClear = opts.clear !== false;
    try {
      const focused = await wc.executeJavaScript(`(function(){
        var el = null;
        ${opts.selector ? `el = document.querySelector(${JSON.stringify(opts.selector)});` : ''}
        ${opts.label && !opts.selector ? `
        if (!el) {
          var labels = document.querySelectorAll('label, [aria-label]');
          for (var i = 0; i < labels.length; i++) {
            var lbl = labels[i];
            var lt = (lbl.getAttribute('aria-label') || lbl.textContent || '').trim().toLowerCase();
            if (lt.includes(${JSON.stringify(opts.label.toLowerCase())})) {
              var forId = lbl.getAttribute('for');
              if (forId) { el = document.getElementById(forId); break; }
              el = lbl.querySelector('input,textarea,[contenteditable]');
              if (el) break;
              el = lbl.nextElementSibling;
              if (el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable)) break;
              el = null;
            }
          }
        }` : ''}
        ${opts.placeholder && !opts.selector ? `
        if (!el) {
          var inputs = document.querySelectorAll('input[placeholder],textarea[placeholder]');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].placeholder.toLowerCase().includes(${JSON.stringify(opts.placeholder.toLowerCase())})) { el = inputs[i]; break; }
          }
        }` : ''}
        if (!el) {
          if (document.activeElement && (document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA'||document.activeElement.isContentEditable)) {
            el = document.activeElement;
          }
        }
        if (!el) return 'not_found';
        el.focus();
        if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') { el.select(); }
        else if (el.isContentEditable) {
          var range = document.createRange();
          range.selectNodeContents(el);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return 'focused';
      })()`);
      if (focused === 'not_found') return 'Input field not found.';
      if (shouldClear) {
        await wc.executeJavaScript(`(function(){
          var el = document.activeElement;
          if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }
          else if (el.isContentEditable) { el.textContent=''; }
        })()`);
      }
      wc.insertText(text);
      await new Promise((r) => setTimeout(r, 200));
      if (opts.submit) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        await new Promise((r) => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'char', keyCode: 'Return' });
        await new Promise((r) => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await new Promise((r) => setTimeout(r, 300));
        const clicked = await wc.executeJavaScript(`(function(){
          var selectors = [
            'button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]',
            'button[data-testid*="send"]', 'button[data-testid*="submit"]',
            'button[class*="send" i]', 'form button[type="submit"]',
          ];
          for (var i = 0; i < selectors.length; i++) {
            var btn = document.querySelector(selectors[i]);
            if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
          }
          return 'no-btn';
        })()`);
        if (clicked === 'clicked') await new Promise((r) => setTimeout(r, 200));
        return 'Typed and submitted.';
      }
      return 'Typed successfully.';
    } catch (err) {
      return `Type failed: ${err instanceof Error ? err.message : err}`;
    }
  });

  yoAgent.setPanelCommandRunner(async (panelId, command, value) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
    const app = appConnector.get(panelId);
    if (!app) return `No app config for panel "${panelId}".`;
    const mapping = app.commands[command];
    if (!mapping) return `No command "${command}" mapped for ${app.name}. Available: ${Object.keys(app.commands).join(", ") || "none"}`;
    try {
      return await executeCommand(wc, mapping, value);
    } catch {
      return `Command "${command}" failed.`;
    }
  });

  yoAgent.setCommandRunner(async (cmd: string) => {
    const clean = cmd.replace(/^\.(dip|drip)\b/i, "$1");
    const result = await execCommand(clean);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
    return result;
  });

  yoAgent.setPanelOpener(async (urlOrName, panelId) => {
    if (!mainWindow || mainWindow.isDestroyed()) return "Main window not available.";
    let url = urlOrName;
    let id = panelId;
    let isUrl = false;
    try { new URL(urlOrName); isUrl = true; } catch {}
    if (!isUrl) {
      const appName = urlOrName.toLowerCase().replace(/\s+/g, "");
      const app = appConnector.get(appName);
      if (app?.url) { url = app.url; id = id || app.id; }
      else if (panelManager.hasPanel(appName)) {
        const ok = panelManager.switchTo(appName, mainWindow);
        return ok ? `Switched to panel "${appName}".` : `Failed to switch to "${appName}".`;
      } else {
        return `Unknown app "${urlOrName}". Provide a full URL starting with https://.`;
      }
    }
    id = id || new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    if (!panelManager.hasPanel(id)) panelManager.addPanel(id, url);
    const ok = panelManager.switchTo(id, mainWindow);
    if (!ok) return `Failed to open panel "${id}".`;
    await new Promise((r) => setTimeout(r, 2000));
    return `Opened panel "${id}" at ${url}.`;
  });

  yoAgent.setBackgroundOpener(async (urlOrName, panelId) => {
    if (!mainWindow || mainWindow.isDestroyed()) return "Main window not available.";
    let url = urlOrName;
    let id = panelId;
    let isUrl = false;
    try { new URL(urlOrName); isUrl = true; } catch {}
    if (!isUrl) {
      const appName = urlOrName.toLowerCase().replace(/\s+/g, "");
      const app = appConnector.get(appName);
      if (app?.url) { url = app.url; id = id || "bg-" + app.id; }
      else return `Unknown app "${urlOrName}". Provide a full URL starting with https://.`;
    }
    id = id || "bg-" + new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    if (!panelManager.hasPanel(id)) panelManager.addPanel(id, url);
    const view = panelManager.getOrCreateView(id, mainWindow);
    if (!view) return `Failed to create background panel "${id}".`;
    await new Promise((r) => setTimeout(r, 2000));
    return `Background panel "${id}" loaded at ${url}.`;
  });

  yoAgent.setPanelScreenshotter(async (panelId) => {
    const wc = panelManager.getWebContents(panelId);
    if (!wc || wc.isDestroyed()) return null;
    try {
      const image = await wc.capturePage();
      return image.toDataURL();
    } catch { return null; }
  });

  yoAgent.setPanelRefresher(async (panelId?: string) => {
    panelManager.refresh(panelId);
    return panelId ? `Refreshed panel: ${panelId}` : "Refreshed active panel.";
  });

  yoAgent.setLayoutCallbacks({
    list: () => layoutManager.listLayouts().map((l) => ({ name: l.name, cols: l.cols, rows: l.rows, cells: l.cells })),
    save: (name, panels) => {
      const rows = panels.split("/").map((r) => r.trim().split(/\s+/).filter(Boolean));
      const numRows = rows.length;
      const numCols = Math.max(...rows.map((r) => r.length));
      const cells = rows.flatMap((row, rowIdx) =>
        row.map((pid, colIdx) => ({ panelId: pid, col: colIdx, row: rowIdx, colSpan: 1, rowSpan: 1 }))
      );
      layoutManager.saveLayout({ name, version: 2, cols: numCols, rows: numRows, colWidths: Array(numCols).fill(1 / numCols), rowHeights: Array(numRows).fill(1 / numRows), cells });
      return true;
    },
    delete: (name) => layoutManager.deleteLayout(name),
  });

  yoAgent.setLayoutStateGetter(() => {
    const grid = layoutManager.getGridInfo();
    if (!grid) return null;
    return { cols: grid.cols, rows: grid.rows, cells: grid.cells };
  });

  // Give interceptor access to visible panel IDs (for multi-panel grab)
  yoInterceptor.setVisiblePanelsGetter(() => {
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) return gridInfo.panelIds;
    return panelManager.activePanelId ? [panelManager.activePanelId] : [];
  });

  // Give command parser a way to grab panel content for yo/sup from the command bar
  commandParser.setGrabber(async (activeOnly?: boolean) => {
    let panelIds: string[];
    if (activeOnly) {
      panelIds = panelManager.activePanelId ? [panelManager.activePanelId] : [];
    } else {
      panelIds = (layoutManager.getGridInfo()?.panelIds
        ?? (panelManager.activePanelId ? [panelManager.activePanelId] : []))
        .filter((id) => id !== "term");
    }
    const sections: string[] = [];
    for (const id of panelIds) {
      const wc = panelManager.getWebContents(id);
      if (!wc) continue;
      const app = appConnector.get(id);
      let content = "";
      if (app?.commands.grab) {
        try { content = await executeCommand(wc, app.commands.grab); } catch {}
      }
      if (!content || content.startsWith("[Element not found")) {
        try { content = await smartGrab(wc) || ""; } catch {}
      }
      if (content && !content.startsWith("[Element not found")) {
        sections.push(panelIds.length > 1 ? `## ${app?.name || id}\n\n${content}` : content);
      }
      // Raw body text → capture store for search indexing
      try {
        const raw = await wc.executeJavaScript("document.body.innerText.slice(0, 30000)");
        if (raw) session.rawCapture(id, `PAGE: ${await wc.executeJavaScript("document.title")}\nURL: ${wc.getURL()}\n\n${raw}`);
      } catch {}
    }
    return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
  });

  // Give command parser access to panel WebContents for .waz
  commandParser.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Push session state to renderer
  const sendSessionState = () => {
    mainWindow?.webContents.send("session-changed", session.getInfo());
  };

  // Wire command callbacks for interceptor + chat (both need dip routing)
  const callbacks = { openYoPanel: null as ((query: string) => void) | null };

  // Council state — participants set by .council command, consumed on next agent message
  let councilParticipants: string[] | null = null;

  const execCommand = async (cmd: string, sourcePanelId?: string) => {
    const result = await commandParser.execute(cmd, sourcePanelId);

    // .yo always opens the agent side panel
    if (result.startsWith("__YO_PANEL__")) {
      const query = result.replace(/^__YO_PANEL__:?/, "");
      callbacks.openYoPanel?.(query);
      return "";
    }

    // .council — arrange panels side-by-side, set council mode, open agent panel
    if (result.startsWith("__COUNCIL__")) {
      const participantsStr = result.replace(/^__COUNCIL__:?/, "");
      councilParticipants = participantsStr.split(",").filter(Boolean);

      // Arrange participant panels side by side
      if (mainWindow && !mainWindow.isDestroyed() && councilParticipants.length >= 2) {
        if (councilParticipants.length === 2) {
          layoutManager.splitTwo(councilParticipants[0], councilParticipants[1], mainWindow);
        } else {
          layoutManager.splitN(councilParticipants, mainWindow);
        }
        const gridInfo = layoutManager.getGridInfo();
        mainWindow.webContents.send("split-state", gridInfo);
        if (gridInfo) {
          for (const id of gridInfo.panelIds) ensureTab(id);
        }
        sendTabState();
      }

      mainWindow?.webContents.send("agent-mode-changed", "council");
      yoInterceptor.setAgentMode("council");
      // Delay yo panel open to let the layout settle
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        panelManager.setRightInset(yoPanelWidth());
        mainWindow.webContents.send("yo-panel-open", `__council__:${councilParticipants!.join(",")}`);
      }, 400);
      return "";
    }

    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
    sendSessionState();
    // Sync tab state (dip commands change active panel / open grids)
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
    } else if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    sendTabState();
    return result;
  };
  yoInterceptor.setCommandHandler(execCommand);
  yoInterceptor.setSessionNotifier(sendSessionState);
  yoInterceptor.setYoClearer(() => { commandParser.clearYoHistory(); });

  // Reminder registry
  const activeReminders = new Map<string, { message: string; fireAt: number; timer: ReturnType<typeof setTimeout> }>();

  // Voice Relay — phone-to-desktop voice remote (Advanced tier, feature-flagged)
  if (getPreference<boolean>("voiceRemoteFeature", false) && canUseVoice().allowed) {
    voiceRelay = new VoiceRelay();
    if (getPreference<boolean>("remoteEnabled", false)) {
      voiceRelay.start();
    }
  }

  // Wire .yo conversational agent — slide-out panel
  const yoPanelWidth = () => getPreference<number>("yoPanelWidth", 380);

  // When inset changes (panel open/close), re-apply current layout
  panelManager.setOnInsetChange(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (panelManager.isHidden) return; // don't re-show during splash/overlay
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.resizeViews(mainWindow);
    }
  });

  // Panel opener — called by interceptor or Cmd+> when user types .yo <query>
  const openYoPanel = (query: string, _sourcePanelId?: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("yo-panel-open", query);
    panelManager.setRightInset(yoPanelWidth());
    mainWindow.webContents.focus();
  };
  yoInterceptor.setPanelOpener(openYoPanel);
  yoInterceptor.setLastAgentResult(() => yoAgent.getLastResponse());
  yoInterceptor.setFaviconsGetter(() => panelFavicons);
  yoInterceptor.setLayoutsGetter(() => layoutManager.listLayouts());

  // Command palette mode/model changers
  yoInterceptor.setModeChanger((mode) => {
    yoAgent.setMode(mode as any);
    setPreference("agentMode", mode);
    mainWindow?.webContents.send("agent-mode-changed", mode);
    yoInterceptor.setAgentMode(mode);
  });
  yoInterceptor.setModelChanger((model) => {
    const cfg = loadLLMConfig();
    cfg.model = model;
    saveLLMConfig(cfg);
    llmConfig = cfg;
    applyLLMConfig(cfg);
    yoInterceptor.setCurrentModel(model);
    mainWindow?.webContents.send("llm-config-changed", { provider: cfg.provider, model: cfg.model });
  });
  callbacks.openYoPanel = openYoPanel;

  yoChat.setCommandCallback(execCommand);

  // Terminal yo/sup/dip — route through command parser, show result in terminal
  terminalManager.setCommandHandler(async (cmd, wc) => {
    const result = await execCommand(cmd);
    if (!result || wc.isDestroyed()) return;

    // Write result to terminal in grey
    const lines = result.replace(/\r/g, "").split("\n").join("\r\n");
    wc.send("terminal:data", `\x1b[90m${lines}\x1b[0m\r\n`);
  });

  // Create window
  await createWindow();
  if (mainWindow) commandParser.setMainWindow(mainWindow);

  // Drip effects
  dripManager = new DripManager();
  if (mainWindow) dripManager.setMainWindow(mainWindow);
  commandParser.setDripManager(dripManager);
  yoInterceptor.setDripCustomsGetter(() => dripManager!.listCustoms());

  // Restore panels from last view (or default to claude)
  function restorePanels() {
    const lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][]; grid?: import("./layout-manager").GridLayout }>("lastView", null!);
    const savedTabs = getPreference<string[]>("openTabs", []);

    // Re-register any browse-* panels from saved tabs or view so they exist for restore
    const savedUrls = getPreference<Record<string, string>>("browserTabUrls", {});
    const allPanelIds: string[] = [...savedTabs];
    if (lastView) {
      if (lastView.grid?.cells) allPanelIds.push(...lastView.grid.cells.map(c => c.panelId));
      if (lastView.panels) allPanelIds.push(...lastView.panels);
      if (lastView.rows) lastView.rows.forEach(row => allPanelIds.push(...row));
      if (lastView.id) allPanelIds.push(lastView.id);
    }
    for (const id of allPanelIds) {
      if (id.startsWith("browse-") && !panelManager.hasPanel(id)) {
        const num = parseInt(id.split("-")[1], 10);
        if (num > tabBrowserCounter) tabBrowserCounter = num;
        const url = savedUrls[id] || resolveBrowserHome();
        panelManager.addPanel(id, browserHtmlUrl(url), undefined, undefined, true);
      }
    }

    if (lastView && mainWindow) {
      if (lastView.type === "grid-full" && lastView.grid) {
        layoutManager.applyGridLayout(lastView.grid, mainWindow);
        // Seed active panel so dip back works after first dip
        if (lastView.grid.cells.length > 0) {
          panelManager.setInitialActive(lastView.grid.cells[0].panelId);
        }
      } else if (lastView.type === "grid" && lastView.rows) {
        layoutManager.splitGrid(lastView.rows, mainWindow);
        if (lastView.rows.length > 0 && lastView.rows[0].length > 0) {
          panelManager.setInitialActive(lastView.rows[0][0]);
        }
      } else if (lastView.type === "split" && lastView.panels) {
        if (lastView.panels.length === 2) {
          layoutManager.splitTwo(lastView.panels[0], lastView.panels[1], mainWindow);
        } else {
          layoutManager.splitN(lastView.panels, mainWindow);
        }
        panelManager.setInitialActive(lastView.panels[0]);
      } else if (lastView.type === "layout" && lastView.name) {
        layoutManager.apply(lastView.name, mainWindow);
        // For named layouts, seed from the layout's first cell
        const grid = layoutManager.getGridInfo();
        if (grid && grid.panelIds.length > 0) {
          panelManager.setInitialActive(grid.panelIds[0]);
        }
      } else if (lastView.type === "panel" && lastView.id) {
        panelManager.switchTo(lastView.id, mainWindow);
      }
    } else if (mainWindow) {
      panelManager.switchTo("claude", mainWindow);
    }

    // Restore all saved tabs (not just those in the current view)
    for (const id of savedTabs) {
      if (!openTabs.includes(id)) {
        openTabs.push(id);
      }
    }
    // Also ensure panels from the active layout are in tabs
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
    } else if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    sendTabState();
  }

  // Helper: push grid state to renderer (for drag handles + panel chips)
  function sendSplitState() {
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
  }

  // ── Tab management ─────────���───────────────────────────────
  const openTabs: string[] = [];
  let tabBrowserCounter = 0;

  // Per-panel URL + favicon tracking
  const panelUrls: Record<string, string> = {};
  const panelFavicons: Record<string, string> = getPreference<Record<string, string>>("panelFavicons", {});
  const panelNavWc: Record<string, Electron.WebContents> = {}; // navigable webContents per panel

  function getTabName(id: string): string {
    const app = appConnector.get(id);
    return app?.name || id;
  }

  function buildTabState() {
    const visible = getPreference<boolean>("showTabs", true);
    const gridInfo = layoutManager.getGridInfo();
    const isLayout = gridInfo && gridInfo.panelIds.length > 1;

    let tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>;
    if (isLayout) {
      const layoutName = gridInfo.name || gridInfo.panelIds.map((id) => getTabName(id)).join(" + ");
      const layoutFavicons = gridInfo.panelIds.map((id) => panelFavicons[id] || "").filter(Boolean);
      const layoutTabId = "__layout__";
      const gridSet = new Set(gridInfo.panelIds);
      tabs = [
        { id: layoutTabId, name: layoutName, layoutFavicons },
        ...openTabs.filter((id) => !gridSet.has(id)).map((id) => ({
          id, name: getTabName(id), favicon: panelFavicons[id] || "",
        })),
      ];
    } else {
      tabs = openTabs.map((id) => ({ id, name: getTabName(id), favicon: panelFavicons[id] || "" }));
    }

    return {
      tabs,
      activeId: isLayout ? "__layout__" : (panelManager.activePanelId || ""),
      visible,
    };
  }

  function sendTabState() {
    mainWindow?.webContents.send("tab-state", buildTabState());
  }

  /** Push the active panel's URL + favicon + nav state to the renderer URL bar */
  function sendUrlUpdate() {
    const id = panelManager.activePanelId;
    if (!id || !mainWindow || mainWindow.isDestroyed()) return;
    const nwc = panelNavWc[id];
    const canGoBack = nwc && !nwc.isDestroyed() ? nwc.canGoBack() : false;
    const canGoForward = nwc && !nwc.isDestroyed() ? nwc.canGoForward() : false;
    mainWindow.webContents.send("url-update", {
      url: panelUrls[id] || "",
      favicon: panelFavicons[id] || "",
      canGoBack,
      canGoForward,
    });
  }

  /** Notify renderer of a specific panel's URL (for cell URL bars in grid mode) */
  function sendPanelUrl(panelId: string) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("panel-url-update", {
      id: panelId,
      url: panelUrls[panelId] || "",
      favicon: panelFavicons[panelId] || "",
    });
  }

  function ensureTab(id: string) {
    if (!openTabs.includes(id)) {
      openTabs.push(id);
      persistTabs();
    }
  }

  function persistTabs() {
    setPreference("openTabs", [...openTabs]);
  }

  // Hook into panel focus events — add tab when panel becomes active
  let lastFocusedPanel: string | null = null;
  panelManager.setOnPanelFocused((id: string) => {
    // Action capture: previous panel just lost focus — capture it
    if (lastFocusedPanel && lastFocusedPanel !== id) {
      actionGrabber?.onPanelBlur(lastFocusedPanel).catch(() => {});
    }
    lastFocusedPanel = id;

    ensureTab(id);
    // Persist lastView (only for single-panel mode — grids are saved by the layout system)
    const gridInfo = layoutManager.getGridInfo();
    if (!gridInfo || gridInfo.panelIds.length <= 1) {
      setPreference("lastView", { type: "panel", id });
    }
    sendTabState();
    sendUrlUpdate();
  });

  // Activate interceptor on browser panel guest webviews
  panelManager.setOnWebviewAttach((childWc, panelId) => {
    yoInterceptor.activate(childWc, panelId);
  });

  // Give command parser tab close/list for .dip close
  commandParser.setTabManager(
    (id) => {
      if (!mainWindow) return;
      const idx = openTabs.indexOf(id);
      if (idx >= 0) openTabs.splice(idx, 1);
      const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
      panelManager.closePanel(id, mainWindow, nextId);
      persistTabs();
      sendSplitState();
      sendTabState();
    },
    () => [...openTabs],
    (url: string) => {
      tabBrowserCounter++;
      const id = `browse-${tabBrowserCounter}`;
      panelManager.addPanel(id, browserHtmlUrl(url), undefined, undefined, true);
      if (mainWindow) panelManager.switchTo(id, mainWindow);
      ensureTab(id);
      sendSplitState();
      sendTabState();
      return id;
    },
  );

  // Wire yo agent tab manager + sub-agent model
  yoAgent.setTabManager({
    list: () => openTabs.map((id) => ({
      id,
      title: appConnector.get(id)?.name || id,
      url: appConnector.get(id)?.url,
    })),
    switch: (id) => { if (mainWindow) panelManager.switchTo(id, mainWindow); },
    close: (id) => {
      if (!mainWindow) return;
      const idx = openTabs.indexOf(id);
      if (idx >= 0) openTabs.splice(idx, 1);
      const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
      panelManager.closePanel(id, mainWindow, nextId);
    },
    create: () => {
      tabBrowserCounter++;
      const id = `browse-${tabBrowserCounter}`;
      panelManager.addPanel(id, browserHtmlUrl(""), undefined, undefined, true);
      if (mainWindow) panelManager.switchTo(id, mainWindow);
      ensureTab(id);
      return id;
    },
  });
  const subAgentModel = getPreference<string>("subAgentModel", "auto");
  yoAgent.setSubAgentModel(subAgentModel);

  // Initialize auth — restore session, schedule refresh, start heartbeat
  await initAuth();

  // Check if onboarding is needed BEFORE restoring panels
  // (BrowserViews render above HTML, so they'd cover the onboarding overlay)
  const authenticated = isAuthenticated();
  const needsOnboarding = !authenticated || !llmConfig.apiKey;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Only restore panels if not gated by onboarding
  if (!needsOnboarding) {
    restorePanels();
    panelsReady = true;
    // Hide panels during splash — renderer will show them after splash dismisses
    if (mainWindow) panelManager.hideActive(mainWindow);
  }

  // Start cloud sync if authenticated and tier allows it
  if (authenticated && canUseSync().allowed) {
    cloudSyncInstance = new CloudSync(noteStore);
    cloudSyncInstance.setCaptureStore(captureStore);
    cloudSyncInstance.start();
  }

  // Initialize Pipedream connectors if authenticated (Advanced tier)
  if (authenticated) {
    connectorManager?.init().catch((err) => console.error("[connectors]", err));
  }

  // ── Auto-updater ───────────────────────────────────────────
  const autoUpdateEnabled = getPreference<boolean>("autoUpdate", true);

  autoUpdater.autoDownload = autoUpdateEnabled;
  autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
  autoUpdater.logger = null;

  autoUpdater.on("update-available", (info: { version: string }) => {
    mainWindow?.webContents.send("update-status", {
      status: "available",
      version: info.version,
    });
  });

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    mainWindow?.webContents.send("update-status", {
      status: "downloading",
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    mainWindow?.webContents.send("update-status", {
      status: "ready",
      version: info.version,
    });
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("[auto-update] error:", err.message);
  });

  if (autoUpdateEnabled) {
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  }

  // ── Hot config sync (non-blocking, then periodic) ─
  configSync = new ConfigSync();
  configSync.fetchAll((msg) => {
    mainWindow?.webContents.send("splash-status", msg);
  }).then(() => {
    reloadRemotePatterns();
  }).catch(() => {});
  // Start periodic checks for future updates
  configSync.start(() => {
    reloadRemotePatterns();
  });

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
  ipcMain.on("update-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo?.version || null;
    } catch { return null; }
  });

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

  // IPC: force ambient context capture
  // IPC: reveal downloaded file in Finder/Explorer
  ipcMain.on("download:show", (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // IPC: panel visibility (for help overlay)
  ipcMain.on("panels-hide", () => {
    if (mainWindow) panelManager.hideActive(mainWindow);
  });
  let firstPanelReveal = true;
  ipcMain.on("panels-show", () => {
    if (!mainWindow || !panelsReady) return;
    panelManager.hidden = false;
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.showActive(mainWindow);
    }
    sendSplitState();
    // After first reveal (post-splash), reload active panel
    // — sites like Gmail don't render CSS properly when loaded at zero size
    if (firstPanelReveal && panelManager.activePanelId) {
      firstPanelReveal = false;
      const view = panelManager.getView(panelManager.activePanelId);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.reload();
      }
    }
  });

  // IPC: Command palette — toggle the injected overlay on the active panel
  ipcMain.on("cmd-palette-open", () => {
    const wc = panelManager.activeWebContents;
    if (wc && !wc.isDestroyed()) {
      wc.focus();
      wc.executeJavaScript("if(window.__yoTogglePop)window.__yoTogglePop()").catch(() => {});
    }
  });

  // IPC: Yo panel commands — route through command parser
  ipcMain.on("yo-panel-send", async (_e, message: string) => {
    const trimmed = message.trim();

    // Route dot-commands (.dip, .drip, .sup, .waz) through command parser
    if (trimmed.startsWith(".")) {
      const firstWord = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase();
      if (firstWord && ["dip", "drip", "sup", "waz", "council"].includes(firstWord)) {
        try {
          const result = await execCommand(trimmed.slice(1));
          if (firstWord !== "council") {
            mainWindow?.webContents.send("yo-panel-done", result || "done.");
          }
        } catch (err: any) {
          mainWindow?.webContents.send("yo-panel-error", err?.message || String(err));
        }
        return;
      }
    }

    const wc = mainWindow?.webContents;
    if (!wc || mainWindow!.isDestroyed()) return;

    // Council mode — if participants are queued, start the council orchestrator
    if (councilParticipants && councilParticipants.length >= 2) {
      const participants = councilParticipants;
      councilParticipants = null;
      wc.send("yo-panel-token", `Starting council with ${participants.join(", ")}...\n`);

      council.start(
        { participants, prompt: trimmed, rounds: 2 },
        (progress) => wc.send("yo-panel-token", `\n${progress}`),
      ).then((result) => {
        if (result.status === "complete" && result.totalCaptures > 0) {
          // Feed actual responses directly to the agent for synthesis
          const responseParts: string[] = [`Council complete: ${result.totalCaptures} responses from ${participants.join(", ")}.\n\nOriginal question: ${trimmed}\n`];
          for (const [participant, resps] of result.responses) {
            for (let i = 0; i < resps.length; i++) {
              responseParts.push(`--- ${participant} (round ${i + 1}) ---\n${resps[i]}\n`);
            }
          }
          responseParts.push("\nSynthesize the key findings, areas of agreement, and notable differences between the participants. Be concise.");
          const summary = responseParts.join("\n");
          yoAgent.send(summary, {
            onText: (delta) => wc.send("yo-panel-token", delta),
            onToolUse: (id, name, input) => wc.send("yo-panel-tool-use", id, name, input),
            onToolResult: (id, detail) => wc.send("yo-panel-tool-result", id, detail),
            onDone: (fullText) => wc.send("yo-panel-done", fullText),
            onError: (err) => wc.send("yo-panel-error", err),
          });
        } else {
          wc.send("yo-panel-done", `Council ${result.status}.`);
        }
      }).catch((err) => {
        wc.send("yo-panel-error", err?.message || String(err));
      });
      return;
    }

    // Everything else goes to the yo agent
    yoAgent.send(trimmed, {
      onText: (delta) => wc.send("yo-panel-token", delta),
      onToolUse: (id, name, input) => wc.send("yo-panel-tool-use", id, name, input),
      onToolResult: (id, detail) => wc.send("yo-panel-tool-result", id, detail),
      onDone: (fullText) => wc.send("yo-panel-done", fullText),
      onError: (err) => wc.send("yo-panel-error", err),
    });
  });

  ipcMain.on("yo-panel-stop", () => {
    yoAgent.abort();
    council.stop();
  });

  // Renderer-initiated panel open (Cmd+> or .yo command)
  ipcMain.on("yo-panel-open-from-renderer", (_e, query: string) => {
    yoAgent.clear();
    panelManager.setRightInset(yoPanelWidth());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.focus();
    }
    if (query) openYoPanel(query);
  });

  ipcMain.on("yo-panel-dismiss", () => {
    yoAgent.clear();
    mainWindow?.webContents.send("yo-panel-close");
    panelManager.setRightInset(0);
  });

  // IPC: Yo panel resize
  ipcMain.on("yo-panel-resize", (_e, width: number) => {
    panelManager.setRightInset(width);
  });
  ipcMain.on("yo-panel-width-save", (_e, width: number) => {
    setPreference("yoPanelWidth", width);
  });
  ipcMain.handle("yo-panel-get-width", () => {
    return getPreference<number>("yoPanelWidth", 380);
  });

  // IPC: Agent mode + guardrails
  ipcMain.handle("get-agent-mode", () => yoAgent.getMode());
  ipcMain.on("set-agent-mode", (_e, mode: string) => {
    yoAgent.setMode(mode as any);
    setPreference("agentMode", mode);
    mainWindow?.webContents.send("agent-mode-changed", mode);
    yoInterceptor.setAgentMode(mode);
  });
  ipcMain.handle("get-tool-registry", () => {
    const { getToolRegistry } = require("./action-gate");
    return getToolRegistry();
  });
  ipcMain.on("set-tool-override", (_e, toolName: string, override: string) => {
    const overrides = getPreference<Record<string, string>>("toolOverrides", {});
    if (override === "default") {
      delete overrides[toolName];
    } else {
      overrides[toolName] = override;
    }
    setPreference("toolOverrides", overrides);
  });

  // Approval system — pending approvals map + IPC
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  let approvalCounter = 0;

  yoAgent.setApprovalCallback(async (toolName, input) => {
    const id = `approval-${++approvalCounter}`;
    const { TOOL_LABELS } = require("./action-gate");
    const toolLabel = TOOL_LABELS[toolName] || toolName;
    mainWindow?.webContents.send("approval-request", id, toolName, toolLabel, input);
    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(id, resolve);
      setTimeout(() => {
        if (pendingApprovals.has(id)) {
          pendingApprovals.delete(id);
          resolve(false);
        }
      }, 60000);
    });
  });

  ipcMain.on("approval-respond", (_e, id: string, approved: boolean) => {
    const resolve = pendingApprovals.get(id);
    if (resolve) {
      pendingApprovals.delete(id);
      resolve(approved);
    }
  });

  // IPC: Voice transcription (local Whisper)
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

  // IPC: Yo chat history
  ipcMain.handle("yo-chats-list", () => yoAgent.listChats());
  ipcMain.handle("yo-chats-load", (_e, id: string) => yoAgent.loadChat(id));
  ipcMain.handle("yo-chats-delete", (_e, id: string) => yoAgent.deleteChat(id));
  ipcMain.handle("yo-chats-search", () => []);
  ipcMain.handle("yo-chat-new", () => { yoAgent.clear(); return true; });

  // IPC: skills CRUD
  ipcMain.handle("skills-list", () => skillEngine.listSkills());
  ipcMain.handle("skills-read", (_e, name: string) => skillEngine.readSkill(name));
  ipcMain.handle("skills-write", (_e, name: string, prompt: string) => {
    if (skillEngine.readSkill(name) !== null) {
      return skillEngine.updateSkill(name, prompt);
    }
    const gate = canCreateSkill(skillEngine.listSkills().length);
    if (!gate.allowed) return { error: gate.reason };
    skillEngine.createSkill(name, prompt);
    return true;
  });
  ipcMain.handle("skills-remove", (_e, name: string) => skillEngine.deleteSkill(name));
  ipcMain.handle("skills-generate", (_e, name: string, description: string) =>
    skillEngine.generatePrompt(name, description),
  );

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
    layoutManager.saveLayout({
      ...grid,
      version: 2,
    });
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

  // IPC: Capture store
  ipcMain.handle("captures-stats", () => captureStore.stats());
  ipcMain.handle("captures-list", (_e, offset: number, limit: number) => captureStore.listEntries(offset, limit));
  ipcMain.handle("captures-read", (_e, id: string) => captureStore.readContent(id));
  ipcMain.handle("captures-delete", (_e, id: string) => captureStore.deleteEntry(id));
  ipcMain.handle("captures-delete-source", (_e, source: string) => captureStore.deleteBySource(source));
  ipcMain.handle("captures-clear", () => captureStore.clear());
  ipcMain.handle("captures-search", async (_e, query: string, limit: number) => captureStore.search(query, limit));
  ipcMain.handle("captures-daily-history", (_e, days: number) => captureStore.dailyHistory(days));
  ipcMain.handle("captures-entry-size", (_e, id: string) => captureStore.entrySize(id));
  ipcMain.handle("captures-stats-source", (_e, source: string) => captureStore.statsForSource(source));
  ipcMain.handle("captures-list-source", (_e, source: string, offset: number, limit: number) => captureStore.listEntriesForSource(source, offset, limit));
  ipcMain.handle("captures-daily-history-source", (_e, source: string, days: number) => captureStore.dailyHistoryForSource(source, days));

  // IPC: grid resize (drag dividers)
  ipcMain.on("grid-drag-end", (_e, type: "col" | "row", index: number, fraction: number) => {
    if (!mainWindow) return;
    // Panels were hidden during drag (panelsHide); mark visible again so
    // window-resize keeps updating bounds via bindResize.
    panelManager.hidden = false;
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

  // IPC: apps CRUD (panel apps)
  ipcMain.handle("apps-list", () => appConnector.list());
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

  // IPC: entitlements — let renderer query current tier limits
  ipcMain.handle("get-entitlements", () => getCurrentLimits());

  // IPC: theme
  ipcMain.handle("get-theme", () => getPreference<string>("theme", "dark"));
  ipcMain.handle("set-theme", (_e, theme: string) => {
    setPreference("theme", theme);
    nativeTheme.themeSource = theme === "system" ? "system" : theme as "light" | "dark";
    const resolved = theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
    yoInterceptor.setTheme(resolved);
  });

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

  // IPC: command execution (used by Cmd+. overlay)
  ipcMain.handle("exec-command", async (_e, cmd: string) => {
    return execCommand(cmd, panelManager.activePanelId ?? undefined);
  });

  // IPC: session info (for context pill)
  ipcMain.handle("session-info", () => session.getInfo());

  // IPC: clear session
  ipcMain.handle("session-clear", () => {
    session.clear();
    sendSessionState();
    return true;
  });

  // IPC: app version
  ipcMain.handle("get-app-version", () => app.getVersion());

  // IPC: auth
  ipcMain.handle("start-auth", async (_e, mode: "register" | "login") => startAuthFlow(mode));
  ipcMain.handle("is-authenticated", () => isAuthenticated());
  ipcMain.handle("get-account-info", () => getAccountInfo());
  ipcMain.handle("get-auth-status", () => getAuthStatus());
  ipcMain.handle("refresh-auth", async () => {
    const hb = await refreshHeartbeat();
    return { tier: hb?.tier || "free", status: hb?.status || "unknown" };
  });
  ipcMain.handle("logout", () => { logout(); });
  ipcMain.handle("validate-api-key", async (_e, key: string) => {
    // Legacy handler — validates as Anthropic by default
    const config: LLMConfig = { ...llmConfig, apiKey: key };
    const result = await validateLLMConfig(config);
    if (result.valid) {
      saveLLMConfig(config);
      applyLLMConfig(config);
    }
    return result;
  });
  ipcMain.handle("get-api-key", () => llmConfig.apiKey || null);

  // LLM config — multi-provider settings
  ipcMain.handle("get-llm-config", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey ? "..." + llmConfig.apiKey.slice(-4) : "",
    baseUrl: llmConfig.baseUrl || null,
  }));
  ipcMain.handle("get-llm-presets", () => PROVIDER_PRESETS);
  ipcMain.handle("save-llm-config", async (_e, config: LLMConfig) => {
    // Skip validation if only model/provider changed (same key)
    const existing = loadLLMConfig();
    const keyChanged = config.apiKey !== existing.apiKey;
    if (keyChanged) {
      const result = await validateLLMConfig(config);
      if (!result.valid) return { ok: false, error: result.error };
    }
    saveLLMConfig(config);
    applyLLMConfig(config);
    return { ok: true };
  });

  // ── MCP Expose IPC handlers ────────────────────────────
  ipcMain.handle("mcp-expose-start", () => mcpExpose!.start());
  ipcMain.handle("mcp-expose-stop", () => { mcpExpose!.stop(); });
  ipcMain.handle("mcp-expose-status", () => ({
    running: mcpExpose!.isRunning,
    port: mcpExpose!.getPort(),
  }));
  ipcMain.handle("mcp-expose-get-tokens", () => mcpExpose!.getTokens());
  ipcMain.handle("mcp-expose-gen-token", (_e, label: string) => mcpExpose!.generateToken(label));
  ipcMain.handle("mcp-expose-revoke-token", (_e, token: string) => { mcpExpose!.revokeToken(token); });

  // ── MCP Servers IPC handlers (custom user servers) ─────
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
    if (!gate.allowed) throw new Error(gate.reason);
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
    if (!gate.allowed) return { ok: false, error: gate.reason };
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

  // ── Connectors IPC handlers (Pipedream OAuth) ──────────
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

  // ── Dashboard IPC handlers ─────────────────────────────

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
          } catch { /* no index.html */ }
          return { name: e.name, path: path.join(appsDir, e.name), modified };
        })
        .filter((a) => a.modified); // only show apps that have index.html
    } catch { return []; }
  });

  ipcMain.on("dashboard:open-app", (_e, name: string) => {
    const filePath = path.join(os.homedir(), "yo", "apps", name, "index.html");
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

  // Prompt log
  ipcMain.handle("prompts-list", (_e, offset?: number, limit?: number) => promptLog.list(offset || 0, limit || 50));
  ipcMain.handle("prompts-search", (_e, query: string, limit?: number) => promptLog.search(query, limit || 50));
  ipcMain.handle("prompts-get", (_e, id: string) => promptLog.get(id));
  ipcMain.handle("prompts-count", () => promptLog.count);

  // Billing/account managed via web dashboard — no client-side checkout needed

  // IPC: tabs
  ipcMain.handle("tab-list", () => {
    return buildTabState();
  });

  ipcMain.on("tab-switch", (_e, id: string) => {
    if (!mainWindow) return;
    if (id === "__layout__") {
      // Clicking the layout tab restores the grid
      layoutManager.restoreSplit(mainWindow);
      const gridInfo = layoutManager.getGridInfo();
      if (gridInfo) {
        setPreference("lastView", {
          type: "grid-full",
          grid: { name: "", version: 2, cols: gridInfo.cols, rows: gridInfo.rows, colWidths: gridInfo.colWidths, rowHeights: gridInfo.rowHeights, cells: gridInfo.cells },
        });
      }
    } else {
      // Switching to a non-layout tab exits the grid
      layoutManager.clearSplit();
      panelManager.switchTo(id, mainWindow);
      setPreference("lastView", { type: "panel", id });
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-close", (_e, id: string) => {
    if (!mainWindow) return;

    // Closing the layout tab closes all panels in the grid
    if (id === "__layout__") {
      const gridInfo = layoutManager.getGridInfo();
      if (gridInfo) {
        for (const panelId of gridInfo.panelIds) {
          const idx = openTabs.indexOf(panelId);
          if (idx >= 0) openTabs.splice(idx, 1);
          panelManager.closePanel(panelId, mainWindow);
        }
      }
      layoutManager.clearSplit();
      // Switch to first remaining tab
      if (openTabs.length > 0) {
        panelManager.switchTo(openTabs[0], mainWindow);
      }
      persistTabs();
      sendSplitState();
      sendTabState();
      return;
    }

    const idx = openTabs.indexOf(id);
    if (idx < 0) return;
    openTabs.splice(idx, 1);
    persistTabs();
    const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
    panelManager.closePanel(id, mainWindow, nextId);
    // Clean up saved browser URL
    if (id === "browser" || id.startsWith("browse-")) {
      const saved = getPreference<Record<string, string>>("browserTabUrls", {});
      delete saved[id];
      setPreference("browserTabUrls", saved);
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-new", () => {
    if (!mainWindow) return;
    tabBrowserCounter++;
    const id = `browse-${tabBrowserCounter}`;
    const homeUrl = resolveBrowserHome();
    panelManager.addPanel(id, browserHtmlUrl(homeUrl), undefined, undefined, true);
    panelManager.switchTo(id, mainWindow);
    ensureTab(id);
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-new-app", (_e, appId: string) => {
    if (!mainWindow) return;
    const app = appConnector.get(appId);
    if (!app?.url) return;
    if (panelManager.hasPanel(appId)) {
      panelManager.switchTo(appId, mainWindow);
    } else {
      panelManager.addPanel(appId, app.url, undefined, app.forceWeb);
      panelManager.switchTo(appId, mainWindow);
      ensureTab(appId);
    }
    sendSplitState();
    sendTabState();
  });

  // IPC: URL bar
  const URL_BAR_HEIGHT = 34;

  // Apply initial URL bar state
  if (getPreference<boolean>("showUrlBar", true)) {
    panelManager.setTopInset(URL_BAR_HEIGHT);
  }

  ipcMain.on("url-bar-navigate", (_e, url: string) => {
    if (!mainWindow) return;
    const id = panelManager.activePanelId;
    if (!id) return;

    // Normalize: add protocol if missing
    let target = url.trim();
    if (target && !/^https?:\/\//i.test(target)) {
      if (/^localhost(:\d+)?(\/|$)/i.test(target) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(target)) {
        target = "http://" + target;
      } else {
        target = "https://" + target;
      }
    }

    const isBrowser = id === "browser" || id.startsWith("browse-");
    if (isBrowser) {
      // Navigate the webview guest inside browser.html
      const wc = panelManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.executeJavaScript(`(function(){
          const wv = document.querySelector("webview");
          if (wv) { wv.loadURL(${JSON.stringify(target)}); }
          const bar = document.getElementById("url");
          if (bar) bar.value = ${JSON.stringify(target)};
        })()`).catch(() => {});
      }
    } else {
      // Navigate the BrowserView directly
      const wc = panelManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.loadURL(target).catch(() => {});
      }
    }
  });

  ipcMain.on("url-bar-back", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.goBack();
    }
  });

  ipcMain.on("url-bar-forward", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.goForward();
    }
  });

  ipcMain.on("url-bar-refresh", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.reload();
    }
  });

  // Per-panel nav (for cell URL bars in grid mode)
  ipcMain.on("panel-nav-back", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.goBack();
  });
  ipcMain.on("panel-nav-forward", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.goForward();
  });
  ipcMain.on("panel-nav-refresh", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.reload();
  });
  ipcMain.on("panel-nav-to", (_e, panelId: string, url: string) => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    const isBrowser = panelId === "browser" || panelId.startsWith("browse-");
    const nwc = panelNavWc[panelId];
    if (!nwc || nwc.isDestroyed()) return;
    if (isBrowser) {
      nwc.executeJavaScript(`(function(){
        const wv = document.querySelector("webview");
        if (wv) { wv.loadURL(${JSON.stringify(target)}); }
        const bar = document.getElementById("url");
        if (bar) bar.value = ${JSON.stringify(target)};
      })()`).catch(() => {});
    } else {
      nwc.loadURL(target).catch(() => {});
    }
  });

  ipcMain.on("url-bar-toggle", (_e, show: boolean) => {
    setPreference("showUrlBar", show);
    panelManager.setTopInset(show ? URL_BAR_HEIGHT : 0);
  });

  ipcMain.on("open-external", (_e, url: string) => {
    // Only allow http(s) and mailto URLs — block file://, javascript://, etc.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:") {
        shell.openExternal(url);
      } else {
        console.warn("[open-external] blocked unsafe protocol:", parsed.protocol, url.slice(0, 80));
      }
    } catch {
      console.warn("[open-external] blocked malformed URL:", url.slice(0, 80));
    }
  });

  // Account and billing managed via yosup.dev/dashboard

  // IPC: support ticket (uses authenticated server call)
  ipcMain.handle("submit-support-ticket", async (_e, ticket: { subject: string; description: string }) => {
    try {
      return await serverPostAuthed("/api/support/ticket", {
        ...ticket,
        appVersion: app.getVersion(),
        os: `${process.platform} ${process.arch}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
    // Live-apply remote mode toggle
    if (key === "remoteEnabled") {
      if (value) voiceRelay?.start();
      else voiceRelay?.stop();
    }
    if (key === "subAgentModel") {
      yoAgent.setSubAgentModel(value as string);
    }
  });
  ipcMain.handle("get-preference", (_e, key: string, defaultVal: unknown) => {
    return getPreference(key, defaultVal);
  });

  // IPC: relaunch app (for settings that require restart)
  ipcMain.on("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // IPC: onboarding complete — restore panels after activation
  ipcMain.handle("onboarding-complete", () => {
    restorePanels();
    panelsReady = true;
    // Hide panels immediately — the tutorial will show next and it's HTML
    // that gets painted under BrowserViews. panelsShow fires when tutorial closes.
    if (mainWindow) panelManager.hideActive(mainWindow);
    sendSplitState();
  });

  // Configure webviews embedded in the renderer (e.g. app-preview in help overlay)
  (mainWindow?.webContents as any)?.on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
    childWc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" },
        },
      };
    });
  });

  // Tell renderer to check auth gate
  mainWindow?.webContents.on("did-finish-load", () => {
    const hideWelcome = getPreference<boolean>("hideWelcome", false);
    const authStatus = getAuthStatus();
    // Recompute needsOnboarding dynamically (may have changed after logout/re-login)
    const currentNeedsOnboarding = !isAuthenticated() || !llmConfig.apiKey;
    mainWindow?.webContents.send("boot", {
      authenticated: authStatus.authenticated,
      status: authStatus.status,
      tier: authStatus.tier,
      apiKey: llmConfig.apiKey ? true : false,
      needsOnboarding: currentNeedsOnboarding,
      hideWelcome,
      theme: (() => { const t = getPreference<string>("theme", "dark"); return t === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t; })(),
    });
    if (!currentNeedsOnboarding && !panelsReady) {
      restorePanels();
      panelsReady = true;
      sendSplitState();
    } else if (!currentNeedsOnboarding) {
      sendSplitState();
    }
  });
}

app.whenReady().then(boot);

// Handle HTTP Basic Auth prompts (401 WWW-Authenticate) from any webContents
app.on("login", (event, _wc, _details, authInfo, callback) => {
  event.preventDefault();
  const authWin = new BrowserWindow({
    width: 360, height: 260,
    parent: mainWindow || undefined,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: "hidden",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const host = authInfo.host || "This site";
  const realm = authInfo.realm ? ` (${authInfo.realm})` : "";
  const html = `data:text/html,${encodeURIComponent(`<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#1a1a1a;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;padding:24px;display:flex;flex-direction:column;gap:12px}
    h3{font-size:14px;font-weight:600;color:#fff}
    p{font-size:12px;color:#888}
    input{width:100%;padding:8px 10px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none}
    input:focus{border-color:#25C75E}
    .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
    button{padding:6px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer}
    .cancel{background:#333;color:#ccc}
    .login{background:#25C75E;color:#000;font-weight:600}
  </style></head><body>
    <h3>Authentication Required</h3>
    <p>${host}${realm} requires credentials.</p>
    <input id="u" type="text" placeholder="Username" autofocus />
    <input id="p" type="password" placeholder="Password" />
    <div class="btns">
      <button class="cancel" onclick="window.close()">Cancel</button>
      <button class="login" id="go">Log In</button>
    </div>
    <script>
      document.getElementById('go').onclick=()=>{
        document.title='AUTH:'+encodeURIComponent(document.getElementById('u').value)+'|'+encodeURIComponent(document.getElementById('p').value);
      };
      document.getElementById('p').onkeydown=(e)=>{if(e.key==='Enter')document.getElementById('go').click()};
      document.getElementById('u').onkeydown=(e)=>{if(e.key==='Enter')document.getElementById('p').focus()};
    </script>
  </body></html>`)}`;
  authWin.loadURL(html);
  authWin.once("ready-to-show", () => authWin.show());
  let answered = false;
  authWin.webContents.on("page-title-updated", (_e, title) => {
    if (!title.startsWith("AUTH:")) return;
    answered = true;
    const parts = title.slice(5).split("|", 2);
    const username = decodeURIComponent(parts[0]);
    const password = decodeURIComponent(parts[1] || "");
    callback(username, password);
    authWin.close();
  });
  authWin.on("closed", () => {
    if (!answered) callback(); // cancel
  });
});

app.on("window-all-closed", () => {
  cleanupAll();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  cleanupAll();
});

let cleanedUp = false;
function cleanupAll() {
  if (cleanedUp) return;
  cleanedUp = true;
  globalShortcut.unregisterAll();
  cleanupAuthTimers();
  voiceRelay?.stop();
  cloudSyncInstance?.stop();
  cloudSyncInstance = null;
  configSync?.stop();
  configSync = null;
  terminalManager?.killAll();
  vscodeServer?.stop();
  mcpExpose?.stop();
  mcpManager?.disconnectAll();
  connectorManager?.cleanup();
  actionGrabber?.stopPolling();
  embedder?.cleanup();
  dripManager?.cleanup();
  usageTracker.flush();
  promptLog.flush();
  // Hard exit if anything keeps the process alive
  setTimeout(() => process.exit(0), 5000).unref();
}
