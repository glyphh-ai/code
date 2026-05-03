/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import "dotenv/config";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, protocol, session as electronSession, shell, systemPreferences } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { PanelManager } from "./panel-manager";
import { TerminalManager, AgentSpawnConfig } from "./terminal";
import { writeAgentBriefing, ensureProjectClaudeMd, ensureProjectMcpJson, rewriteAllBriefings } from "./agent-briefing";
import { CommandParser } from "./command-parser";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, serverPostAuthed, serverGetAuthed, getAuthToken } from "./auth";
import { CloudSync } from "./cloud-sync";
import { initCapabilities, setOfferEnabled, getCapabilitiesStatus, cleanupCapabilities } from "./capability-sync";
import { startCypherRuntime, stopCypherRuntime, subscribeCypher, unsubscribeCypher } from "./cypher-runtime";
import { listAgents, getAgent, saveAgent, removeAgent, idAvailable, type AgentConfig as AgentRegistryConfig } from "./stores/agent-store-db";
import { pushAgentProfile, deleteAgentProfile, syncAllAgents } from "./agent-sync";
import { loadLLMConfig, saveLLMConfig, LLMConfig } from "./llm-config";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { canAddApp, canCreateSkill, canSaveLayout, canUseMcp, canUseSync, canUseVoice, getCurrentLimits } from "./entitlements";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./stores/preferences-db";
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
import { resolveShellPath } from "./shell-path";
import { WorkspaceManager } from "./workspace-manager";
import { EventLog } from "./event-log";
// WorkspaceMcpServer removed — workspace tools merged into McpExpose
import { InboxRouter } from "./inbox-router";
import { autoUpdater } from "electron-updater";
import { ConfigSync } from "./config-sync";
import { reloadRemotePatterns } from "./firewall";
import { usageTracker } from "./usage-tracker";
import { usageQueue } from "./usage-queue";
import { promptLog } from "./prompt-log";
import { Embedder } from "./embedder";
import { CaptureStore } from "./capture-store";
import { YoAgent } from "./yo-agent";
import { ActionGrabber } from "./action-grabber";
import { AgentRunner, AgentConfig } from "./agent-runner";
import { McpExpose } from "./mcp-expose";
import { McpManager } from "./mcp-manager";
import { DripManager, BUILTIN_EFFECTS } from "./drip-manager";
import { ConnectorManager } from "./connectors";
import { SkillToolRouter } from "./skill-tool-router";
import { SkillScheduler } from "./skill-scheduler";
import { DataStore, closeDataStoreDb } from "./data-store";
import { closeSubstrateDb } from "./substrate/store";
import { initLocalDb, closeLocalDb } from "./local-db";
import { migrateFromFiles } from "./stores/migrate-from-files";
import { setSubstrateToolDeps, listBuiltinYoTools } from "./substrate/tools";


let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let skillEngine: SkillEngine;
let appConnector: AppConnector;

let terminalManager: TerminalManager;
let agentRunner: AgentRunner;
let vscodeServer: VSCodeServer;
let noteStore: NoteStore;
let voiceRelay: VoiceRelay | null = null;
let cloudSyncInstance: CloudSync | null = null;
let configSync: ConfigSync | null = null;
let embedder: Embedder | null = null;
let mcpExpose: McpExpose | null = null;
let inboxRouter: InboxRouter | null = null;
let mcpManager: McpManager | null = null;
let dripManager: DripManager | null = null;
let actionGrabber: ActionGrabber | null = null;
let connectorManager: ConnectorManager | null = null;
let skillToolRouter: SkillToolRouter | null = null;
let skillScheduler: SkillScheduler | null = null;

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

  mainWindow.setMaxListeners(30);

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

  // Resolve real shell PATH once — Electron on macOS launched from Finder
  // inherits a sanitized PATH that breaks Homebrew/asdf/nvm tools. Cached for
  // all later spawns (vscode-server, future code-terminals, etc.).
  resolveShellPath();

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

  // Initialize local SQLite database (agents, layouts, preferences)
  initLocalDb();
  const migrationResult = migrateFromFiles();
  if (migrationResult.migrated) {
    console.log(`[local-db] migrated from files: ${migrationResult.agents} agents, ${migrationResult.layouts} layouts, ${migrationResult.prefs} prefs`);
  }

  // Load LLM config (provider + model selection only)
  let llmConfig = loadLLMConfig();

  function applyLLMConfig(config: LLMConfig) {
    llmConfig = config;
    yoChat?.setLLMConfig(config);
    skillEngine?.setLLMConfig(config);
    yoAgent?.setLLMConfig(config);
    yoInterceptor?.setCurrentModel(config.model);
    yoInterceptor?.setAvailableModels(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  }

  // ── yo-asset:// protocol — serves shared assets (Chart.js etc.) to vibe panels ──
  const rendererDir = path.join(__dirname, "..", "renderer");
  protocol.handle("yo-asset", (request) => {
    const assetName = decodeURIComponent(request.url.replace(/^yo-asset:\/\//, "").replace(/^\/+/, ""));
    const filePath = path.join(rendererDir, assetName);
    if (!fs.existsSync(filePath)) {
      return new Response(`yo-asset not found: ${assetName}`, { status: 404 });
    }
    return net.fetch(`file://${filePath}`);
  });

  // Backward compat: redirect file:// requests for chart.umd.min.js from skill folders
  const yoDir = path.join(os.homedir(), "yo", "skills");
  electronSession.defaultSession.webRequest.onBeforeRequest(
    { urls: ["file://*chart.umd.min.js"] },
    (details: { url: string }, callback: (response: { redirectURL?: string }) => void) => {
      if (details.url.includes(yoDir)) {
        callback({ redirectURL: `file://${path.join(rendererDir, "chart.umd.min.js")}` });
      } else {
        callback({});
      }
    },
  );

  // Core services
  skillEngine = new SkillEngine();
  appConnector = new AppConnector();

  // Embedder + capture store
  embedder = new Embedder();
  embedder.init().catch((err) => console.error("[embedder]", err));

  const captureStore = new CaptureStore();
  captureStore.setEmbedder(embedder);
  captureStore.setPolicyResolver((source) => appConnector.getCapturePolicy(source));

  const dataStore = new DataStore();

  // Workspace registry — { slug, name, rootDir } per workspace, persisted to
  // ~/yo/workspaces.json. Single source of truth for the active workspace.
  // On first init, migrates from the legacy `activeWorkspace` preference and
  // ensures a "default" workspace bound to the user's home dir.
  const workspaceManager = new WorkspaceManager();
  workspaceManager.init();

  // Every component that writes to captureStore needs this to tag entries so
  // capture-store search / listeners scope correctly.
  const workspaceGetter = (): string => workspaceManager.getActiveSlug();

  // Phase 3: workspace event log + MCP server. The server is started on-demand
  // when the first code-terminal launches (no need to bind a port if no agent
  // is running). EventLog is the canonical writer for events.jsonl.
  const eventLog = new EventLog((slug) => workspaceManager.workspaceDir(slug));
  // Phase 4: orchestrator-mediated push. Watches each workspace's events.jsonl
  // and drains subscription-matched events into per-agent inbox files.
  inboxRouter = new InboxRouter(workspaceManager, eventLog);

  // Action-driven capture — grabs content on blur/navigate + polls chat panels
  actionGrabber = new ActionGrabber();
  actionGrabber.setCaptureStore(captureStore);
  actionGrabber.setAppConnector(appConnector);

  // MCP expose — always-on local server for agent tool access
  mcpExpose = new McpExpose();
  mcpExpose.setCaptureStore(captureStore);
  mcpExpose.setWorkspaceGetter(workspaceGetter);
  mcpExpose.setWorkspaceBackend(eventLog, workspaceManager);
  mcpExpose.start().then((r) => {
    if (r.ok) {
      console.log("[mcp-expose] started on launch");
    } else {
      console.error("[mcp-expose] failed to start:", r.error);
    }
  });

  // MCP Manager — always init so tools are ready when the agent needs them.
  // Tier gates apply at the UI level (add/connect), not at boot.
  mcpManager = new McpManager();
  mcpManager.setAppConnector(appConnector);
  mcpManager.init().catch((err) => console.error("[mcp-manager]", err));
  mcpManager.on("changed", () => {
    mainWindow?.webContents.send("mcp-changed");
  });

  // Skill system — tool router, runner dependencies, scheduler
  skillToolRouter = new SkillToolRouter();
  skillToolRouter.setYoTools(listBuiltinYoTools());
  skillToolRouter.setMcpManager(mcpManager);
  skillScheduler = new SkillScheduler(skillEngine);
  skillScheduler.start();

  // Tool registry deps — provides dependencies to substrate/tools.ts
  setSubstrateToolDeps({
    captureStore: { search: (q, n) => captureStore.search(q, n) },
    sessionCache: { get: () => session.get() },
    noteStore: {
      search: (q, n) => noteStore.search(q, n),
      write: (title, content, source) => noteStore.write(title, content, source),
    },
    memoryStore: { save: (content, category) => memoryStore.save(content, category as any) },
    skillEngine: {
      process: (content, skillName) => skillEngine.process(content, skillName),
      listSkillsDetailed: () => skillEngine.listSkillsDetailed(),
      getSkill: (name) => { const s = skillEngine.getSkill(name); return s ? { manifest: s.manifest as any, prompt: s.prompt, folderPath: s.folderPath } : null; },
      writeSkill: (name, manifest, prompt) => skillEngine.writeSkill(name, manifest as any, prompt),
      deleteSkill: (name) => skillEngine.deleteSkill(name),
      readSkillFile: (name, rel) => skillEngine.readSkillFile(name, rel),
      writeSkillFile: (name, rel, content) => skillEngine.writeSkillFile(name, rel, content),
      listSkillFiles: (name) => skillEngine.listSkillFiles(name),
    },
    dripManager: {
      listCustoms: () => dripManager!.listCustoms(),
      saveCustom: (name: string, recipe: string) => dripManager!.saveCustom(name, recipe),
      deleteCustom: (name: string) => dripManager!.deleteCustom(name),
      listBuiltinEffects: () => BUILTIN_EFFECTS.slice(),
    },
    layoutManager: {
      listLayouts: () => layoutManager.listLayouts() as any,
      getLayout: (name: string) => layoutManager.getLayout(name) as any,
      saveLayout: (grid: any) => layoutManager.saveLayout(grid),
      deleteLayout: (name: string) => layoutManager.deleteLayout(name),
    },
    dataStore: {
      get: (ns, key) => dataStore.get(ns, key),
      set: (ns, key, val) => dataStore.set(ns, key, val),
      delete: (ns, key) => dataStore.delete(ns, key),
      list: (ns, prefix?, limit?) => dataStore.list(ns, prefix, limit),
      query: (ns, filter, limit?) => dataStore.query(ns, filter, limit),
      keys: (ns) => dataStore.keys(ns),
      count: (ns) => dataStore.count(ns),
      clear: (ns) => dataStore.clear(ns),
      listNamespaces: () => dataStore.listNamespaces(),
    },
    mcpRouter: (() => {
      const shortToQualified = new Map<string, string>();
      return {
        resolveAll: () => {
          if (!mcpManager) {
            console.warn("[mcp-router] mcpManager not available");
            return [];
          }
          shortToQualified.clear();
          const allTools = mcpManager.getAllTools();
          if (allTools.length === 0) {
            const servers = mcpManager.getServerStates();
            const summary = servers.map(s => `${s.config.id}: ${s.status}`).join(", ");
            if (servers.length > 0) {
              console.warn(`[mcp-router] 0 tools resolved. Server states: ${summary}`);
            }
          }
          return allTools.map((t) => {
            const short = `${t.serverId.replace(/-/g, "_")}__${t.name.replace(/-/g, "_")}`;
            shortToQualified.set(short, t.qualifiedName);
            return { name: short, description: t.description || "", input_schema: t.inputSchema };
          });
        },
        callMcp: (name: string, input: Record<string, unknown>) => {
          const qualified = shortToQualified.get(name) || name;
          return mcpManager!.callTool(qualified, input);
        },
        hasTool: (name: string) => shortToQualified.has(name),
      };
    })(),
    workspace: {
      teamStatus: () => {
        const wsSlug = workspaceGetter();
        const ws = workspaceManager.get(wsSlug);
        if (!ws) return `Unknown workspace: ${wsSlug}`;
        const agents = workspaceManager.listAgents(wsSlug);
        const status = eventLog.teamStatus(wsSlug, agents);
        return JSON.stringify({
          workspace: ws.slug,
          rootDir: ws.rootDir,
          agents: status.map((s) => ({ ...s, lastPostAt: s.lastPostTs ? new Date(s.lastPostTs).toISOString() : null })),
        }, null, 2);
      },
      readLog: (filter: Record<string, unknown>) => {
        const wsSlug = workspaceGetter();
        const events = eventLog.read(wsSlug, {
          tags: Array.isArray(filter.tags) ? filter.tags as string[] : undefined,
          from: Array.isArray(filter.from) ? filter.from as string[] : undefined,
          to: typeof filter.to === "string" ? filter.to : undefined,
          since: typeof filter.since === "number" ? filter.since : undefined,
          until: typeof filter.until === "number" ? filter.until : undefined,
          kinds: Array.isArray(filter.kinds) ? filter.kinds as any : undefined,
          limit: typeof filter.limit === "number" ? filter.limit : undefined,
        });
        return JSON.stringify({ count: events.length, events }, null, 2);
      },
      postTo: (agent: string, body: string, kind?: string) => {
        const wsSlug = workspaceGetter();
        const evt = eventLog.append(wsSlug, {
          from: ".yo",
          to: agent,
          tags: [`to:${agent}`],
          kind: (kind as any) || "post",
          body,
        });
        return JSON.stringify({ sent: true, ts: evt.ts });
      },
      post: (body: string, tags?: string[], kind?: string) => {
        const wsSlug = workspaceGetter();
        const evt = eventLog.append(wsSlug, {
          from: ".yo",
          tags: tags || ["broadcast"],
          kind: (kind as any) || "post",
          body,
        });
        return JSON.stringify({ sent: true, ts: evt.ts });
      },
      readAgent: (name: string, kind?: string) => {
        const wsSlug = workspaceGetter();
        if (kind === "log") {
          const events = eventLog.read(wsSlug, { from: [name] });
          return JSON.stringify({ agent: name, events }, null, 2);
        }
        const text = eventLog.readScratchpad(wsSlug, name);
        return text || `(${name} has no scratchpad yet)`;
      },
      broadcastAndWait: async (body: string, tags: string[], kind: string | undefined, timeoutMs: number) => {
        const wsSlug = workspaceGetter();
        const evt = eventLog.append(wsSlug, {
          from: ".yo",
          tags,
          kind: (kind as any) || "question",
          body,
        });
        const sentTs = evt.ts;
        const deadline = Date.now() + timeoutMs;
        const pollInterval = 2000;
        const responses: Array<{ from: string; body: string; ts: number; kind: string }> = [];
        const seenTs = new Set<number>();

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const recent = eventLog.read(wsSlug, { since: sentTs, limit: 50 });
          for (const r of recent) {
            if (r.from === ".yo" || r.from === "user") continue;
            if (r.ts <= sentTs) continue;
            if (seenTs.has(r.ts)) continue;
            seenTs.add(r.ts);
            responses.push({ from: r.from, body: r.body, ts: r.ts, kind: r.kind });
          }
        }

        return JSON.stringify({
          broadcast: { body, ts: sentTs },
          responses,
          waitedMs: Date.now() - sentTs,
          timedOut: responses.length === 0,
        }, null, 2);
      },
    },
  });

  // Pipedream Connectors — managed OAuth connections (Advanced tier)
  connectorManager = new ConnectorManager();
  connectorManager.setMcpManager(mcpManager);
  connectorManager.setAppConnector(appConnector);
  connectorManager.on("changed", () => {
    mainWindow?.webContents.send("connectors-changed");
  });

  // Yo agent — capture search + format assistant
  const yoAgent = new YoAgent();
  yoAgent.setCaptureStore(captureStore);
  yoAgent.setWorkspaceGetter(workspaceGetter);
  yoAgent.setSkillEngine(skillEngine);

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();
  agentRunner = new AgentRunner();

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});
  session.setOnRawCapture((appId, content) => {
    const ws = getPreference<string>("activeWorkspace", "default");
    captureStore.ingest(appId, content, ws).catch(() => {});
  });

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, skillEngine, session);
  yoInterceptor.setAgentMode(getPreference<string>("agentMode", "ask"));
  yoInterceptor.setCurrentModel(llmConfig.model);
  yoInterceptor.setAvailableModels(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  const initialTheme = getPreference<string>("theme", "light");
  nativeTheme.themeSource = initialTheme === "system" ? "system" : initialTheme as "light" | "dark";
  const resolvedTheme = initialTheme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : initialTheme;
  yoInterceptor.setTheme(resolvedTheme);

  nativeTheme.on("updated", () => {
    if (getPreference<string>("theme", "light") !== "system") return;
    const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    broadcastTheme(resolved);
  });

  // Helper: send theme to main window + all panel webContents (home, etc.)
  function broadcastTheme(resolved: string) {
    yoInterceptor.setTheme(resolved);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("theme-changed", resolved);
    }
    for (const wc of panelManager.getAllWebContents()) {
      wc.send("theme-changed", resolved);
    }
  }

  // Track code-terminal panels (Phase 2): panel id → spawn config used when
  // the panel's webContents finishes loading.
  const panelIdToAgentConfig = new Map<string, AgentSpawnConfig>();
  const cwWcWorkspace = new Map<number, string>(); // code-workspace webContents.id → workspace slug

  panelManager = new PanelManager((id, wc) => {
    const baseAppId = resolveAppId(id);
    console.log(`[onCreated] panel="${id}" baseApp="${baseAppId}" wcId=${wc.id}`);
    if (baseAppId === "term") {
      wc.on("did-finish-load", () => {
        console.log(`[terminal] did-finish-load panel="${id}" wcId=${wc.id} — spawning pty`);
        terminalManager.spawn(wc);
      });
      yoInterceptor.activateBarOnly(wc, id);
    } else if (baseAppId === "code") {
      // Code-terminal: spawn the named agent CLI (claude) with role env vars
      const cfg = panelIdToAgentConfig.get(id);
      if (cfg) {
        wc.on("did-finish-load", () => terminalManager.spawnAgent(wc, cfg));
      } else {
        console.warn(`[code-terminal] no agent config for panel "${id}" — falling back to plain terminal`);
        wc.on("did-finish-load", () => terminalManager.spawn(wc));
      }
      yoInterceptor.activateBarOnly(wc, id);
    } else if (baseAppId === "code-workspace") {
      // Code workspace: SDK-driven agent runner (not terminal PTYs)
      const wsSlug = workspaceManager.getActive().slug;
      cwWcWorkspace.set(wc.id, wsSlug);
      wc.on("destroyed", () => {
        cwWcWorkspace.delete(wc.id);
        agentRunner.stopAll(wc.id);
      });
      const ws = workspaceManager.getActive();
      const wsAgents = workspaceManager.listAgents(wsSlug);
      // Ensure briefings + MCP config
      rewriteAllBriefings(ws, wsAgents);
      try { ensureProjectClaudeMd(ws); } catch { /* */ }
      if (mcpExpose?.isRunning) {
        const url = `http://127.0.0.1:${mcpExpose.getPort()}/mcp`;
        const tokens = mcpExpose.getTokens();
        const token = tokens.length > 0 ? tokens[0].token : mcpExpose.generateToken("workspace-agent").token;
        try { ensureProjectMcpJson(ws, url, token); } catch { /* */ }
      }
      inboxRouter?.watch(wsSlug);
    } else {
      // Activate interceptor so yo/dip/sup work on app panels
      yoInterceptor.activate(wc, id);
      // Track URL changes in browser tabs for persistence
      if (baseAppId === "browser") trackBrowserUrl(id, wc);
      // Track VS Code folder for persistence across restarts
      if (baseAppId === "vscode") trackVscodeFolder(wc);
    }

    // Track URL + favicon for URL bar and tab favicons
    const isBrowserPanel = baseAppId === "browser";
    if (isBrowserPanel) {
      // Browser panels use <webview> — track the guest's URL/favicon
      (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
        panelNavWc[id] = childWc;
        const trackChild = (url: string) => {
          if (url && url !== "about:blank") {
            panelUrls[id] = url;
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
            sendTabState();
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
          sendTabState();
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
  actionGrabber.setWorkspaceGetter(() => getPreference<string>("activeWorkspace", "default"));
  actionGrabber.startPolling();

  // Persist zoom when changed via keyboard shortcut in panels
  panelManager.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Browser panel helpers (must be before app connector loop)
  const BROWSER_HOMES: Record<string, string> = {
    google: "https://www.google.com",
    claude: "https://claude.ai",
    chatgpt: "https://chatgpt.com",
    gemini: "https://gemini.google.com",
  };

  function resolveBrowserHome(): string {
    const pref = getPreference<string>("browserHomepage", "google");
    if (pref === "custom") return getPreference<string>("browserHomepageUrl", "");
    return BROWSER_HOMES[pref] || BROWSER_HOMES.google;
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
  const codeWorkspaceHtml = `file://${path.join(__dirname, "..", "renderer", "code-workspace.html")}`;
  const codeWorkspacePreload = path.join(__dirname, "code-workspace-preload.js");
  const monacoHtml = `file://${path.join(__dirname, "..", "renderer", "monaco.html")}`;
  const homeHtml = `file://${path.join(__dirname, "..", "renderer", "home.html")}`;
  const enableVscode = getPreference("enableVscodeServer", false);
  vscodeServer = new VSCodeServer();
  for (const app of appConnector.list()) {
    if (app.url === "yo://home") {
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      // webviewTag: true so the <webview id="app-preview"> inside App detail can render
      panelManager.addPanel(app.id, homeHtml, homePreload, undefined, true);
    } else if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://code-workspace") {
      panelManager.addPanel(app.id, codeWorkspaceHtml, codeWorkspacePreload, undefined, true);
    } else if (app.url === "yo://monaco") {
      panelManager.addPanel(app.id, monacoHtml);
    } else if (app.url === "yo://browser") {
      const savedBrowserUrls = getPreference<Record<string, string>>("browserTabUrls", {});
      const browserUrl = savedBrowserUrls[app.id] || resolveBrowserHome();
      panelManager.addPanel(app.id, browserHtmlUrl(browserUrl), undefined, undefined, true);
    } else if (app.url === "yo://context") {
      const contextHtml = `file://${path.join(__dirname, "..", "renderer", "context.html")}`;
      const renderPreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(app.id, contextHtml, renderPreload);
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
  let restoring = false;

  /** Activate the code workspace panel (switch to it). */
  function activateCodeWorkspace(): boolean {
    if (!mainWindow) return false;
    panelManager.switchTo("code-workspace", mainWindow);
    return true;
  }

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

  // Panel interaction + layout tools — wired directly to substrate deps
  setSubstrateToolDeps({
    panels: {
      list: () => {
        const ids = panelManager.getLoadedPanelIds();
        if (ids.length === 0) return "No panels open.";
        return ids.map((id: string) => {
          const app = appConnector.get(id);
          const url = app?.url || "";
          const active = id === panelManager.activePanelId ? " [active]" : "";
          return `${id}${active} — ${app?.name || id} (${url})`;
        }).join("\n");
      },
      scan: async (panelId) => {
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
      },
      grab: async (panelId) => {
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
      },
      click: async (panelId, text, selector) => {
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
      },
      navigate: async (panelId, url) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        try { wc.loadURL(url); return `Navigating to ${url}`; }
        catch (err) { return `Navigation failed: ${err instanceof Error ? err.message : err}`; }
      },
      type: async (panelId, text, opts) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        const shouldClear = opts.clear !== false;
        try {
          const focused = await wc.executeJavaScript(`(function(){
            var el = null;
            ${opts.selector ? `el = document.querySelector(${JSON.stringify(opts.selector)});` : ''}
            ${opts.label && !opts.selector ? `
            if (!el) { var labels = document.querySelectorAll('label, [aria-label]'); for (var i = 0; i < labels.length; i++) { var lbl = labels[i]; var lt = (lbl.getAttribute('aria-label') || lbl.textContent || '').trim().toLowerCase(); if (lt.includes(${JSON.stringify(opts.label.toLowerCase())})) { var forId = lbl.getAttribute('for'); if (forId) { el = document.getElementById(forId); break; } el = lbl.querySelector('input,textarea,[contenteditable]'); if (el) break; el = lbl.nextElementSibling; if (el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable)) break; el = null; } } }` : ''}
            ${opts.placeholder && !opts.selector ? `if (!el) { var inputs = document.querySelectorAll('input[placeholder],textarea[placeholder]'); for (var i = 0; i < inputs.length; i++) { if (inputs[i].placeholder.toLowerCase().includes(${JSON.stringify(opts.placeholder.toLowerCase())})) { el = inputs[i]; break; } } }` : ''}
            if (!el) { if (document.activeElement && (document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA'||document.activeElement.isContentEditable)) { el = document.activeElement; } }
            if (!el) return 'not_found';
            el.focus();
            if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') { el.select(); }
            else if (el.isContentEditable) { var range = document.createRange(); range.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
            return 'focused';
          })()`);
          if (focused === 'not_found') return 'Input field not found.';
          if (shouldClear) {
            await wc.executeJavaScript(`(function(){ var el = document.activeElement; if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } else if (el.isContentEditable) { el.textContent=''; } })()`);
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
            const clicked = await wc.executeJavaScript(`(function(){ var selectors = ['button[aria-label*="Send" i]','button[aria-label*="Submit" i]','button[data-testid*="send"]','button[data-testid*="submit"]','button[class*="send" i]','form button[type="submit"]']; for (var i = 0; i < selectors.length; i++) { var btn = document.querySelector(selectors[i]); if (btn && !btn.disabled) { btn.click(); return 'clicked'; } } return 'no-btn'; })()`);
            if (clicked === 'clicked') await new Promise((r) => setTimeout(r, 200));
            return 'Typed and submitted.';
          }
          return 'Typed successfully.';
        } catch (err) { return `Type failed: ${err instanceof Error ? err.message : err}`; }
      },
      open: async (urlOrName, panelId) => {
        if (!mainWindow || mainWindow.isDestroyed()) return "Main window not available.";
        let url = urlOrName; let id = panelId; let isUrl = false;
        try { new URL(urlOrName); isUrl = true; } catch {}
        if (!isUrl) {
          const appName = urlOrName.toLowerCase().replace(/\s+/g, "");
          const app = appConnector.get(appName);
          if (app?.url) { url = app.url; id = id || app.id; }
          else if (panelManager.hasPanel(appName)) {
            const ok = panelManager.switchTo(appName, mainWindow);
            return ok ? `Switched to panel "${appName}".` : `Failed to switch to "${appName}".`;
          } else { return `Unknown app "${urlOrName}". Provide a full URL starting with https://.`; }
        }
        id = id || new URL(url).hostname.replace(/^www\./, "").split(".")[0];
        if (!panelManager.hasPanel(id)) panelManager.addPanel(id, url);
        const ok = panelManager.switchTo(id, mainWindow);
        if (!ok) return `Failed to open panel "${id}".`;
        await new Promise((r) => setTimeout(r, 2000));
        return `Opened panel "${id}" at ${url}.`;
      },
      openBackground: async (urlOrName, panelId) => {
        if (!mainWindow || mainWindow.isDestroyed()) return "Main window not available.";
        let url = urlOrName; let id = panelId; let isUrl = false;
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
      },
      runCommand: async (panelId, command, value) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return `Panel "${panelId}" not found or not loaded.`;
        const app = appConnector.get(panelId);
        if (!app) return `No app config for panel "${panelId}".`;
        const mapping = app.commands[command];
        if (!mapping) return `No command "${command}" mapped for ${app.name}. Available: ${Object.keys(app.commands).join(", ") || "none"}`;
        try { return await executeCommand(wc, mapping, value); }
        catch { return `Command "${command}" failed.`; }
      },
      screenshot: async (panelId) => {
        const wc = panelManager.getWebContents(panelId);
        if (!wc || wc.isDestroyed()) return null;
        try { const image = await wc.capturePage(); return image.toDataURL(); }
        catch { return null; }
      },
      refresh: async (panelId) => {
        panelManager.refresh(panelId);
        return panelId ? `Refreshed panel: ${panelId}` : "Refreshed active panel.";
      },
    },
    tabs: {
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
    },
    execCommand: async (cmd: string) => {
      const clean = cmd.replace(/^\.(dip|drip)\b/i, "$1");
      const result = await execCommand(clean);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
      return result;
    },
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

  const execCommand = async (cmd: string, sourcePanelId?: string) => {
    const result = await commandParser.execute(cmd, sourcePanelId);

    // .yo always opens the agent side panel
    if (result.startsWith("__YO_PANEL__")) {
      const query = result.replace(/^__YO_PANEL__:?/, "");
      callbacks.openYoPanel?.(query);
      return "";
    }

    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
    sendSessionState();
    // Sync tab state (dip commands change active panel / open grids)
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
      setPreference("suspendedLayout", null);
    } else if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    // Persist suspended grid if command suspended it
    const suspended = layoutManager.getSuspendedGridInfo();
    if (suspended) {
      setPreference("suspendedLayout", {
        version: 2, name: suspended.name, cols: suspended.cols, rows: suspended.rows,
        colWidths: suspended.colWidths, rowHeights: suspended.rowHeights, cells: suspended.cells,
      });
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

  function deduplicateRestorePanels(ids: string[]): string[] {
    const seen = new Set<string>();
    return ids.map((id) => {
      if (!seen.has(id)) { seen.add(id); return id; }
      const app = appConnector.get(resolveAppId(id));
      if (!app?.url) return id;
      panelInstanceCounter++;
      const instanceId = `${id}-${panelInstanceCounter}`;
      createPanelForApp(instanceId, app);
      ensureTab(instanceId);
      seen.add(instanceId);
      return instanceId;
    });
  }

  // Restore panels from last view (or default to claude)
  function restorePanels() {
    const lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][]; grid?: import("./layout-manager").GridLayout }>("lastView", null!);
    const savedTabs = getPreference<string[]>("openTabs", []);

    // Re-register instance panels from saved tabs/view so they exist for restore
    const allPanelIds: string[] = [...savedTabs];
    if (lastView) {
      if (lastView.grid?.cells) allPanelIds.push(...lastView.grid.cells.map(c => c.panelId));
      if (lastView.panels) allPanelIds.push(...lastView.panels);
      if (lastView.rows) lastView.rows.forEach(row => allPanelIds.push(...row));
      if (lastView.id) allPanelIds.push(lastView.id);
    }
    console.log(`[restorePanels] allPanelIds:`, allPanelIds);
    for (const id of allPanelIds) {
      if (panelManager.hasPanel(id)) { console.log(`[restorePanels] skip "${id}" — already registered`); continue; }
      const baseId = resolveAppId(id);
      if (baseId === id) { console.log(`[restorePanels] skip "${id}" — is base app, already registered at boot`); continue; }
      // Code-terminal panels need special handling — re-create via codeTerminalLauncher
      if (baseId === "code") {
        console.log(`[restorePanels] skip code panel "${id}" — will restore via layout`);
        continue;
      }
      const app = appConnector.get(baseId);
      if (!app?.url) continue;
      // Track counters so new instances don't collide
      const dash = id.lastIndexOf("-");
      const num = dash > 0 ? parseInt(id.slice(dash + 1), 10) : 0;
      if (num > panelInstanceCounter) panelInstanceCounter = num;
      if (baseId === "browser" && num > tabBrowserCounter) tabBrowserCounter = num;
      createPanelForApp(id, app);
    }

    if (lastView && mainWindow) {
      if (lastView.type === "grid-full" && lastView.grid) {
        const allCellIds = lastView.grid.cells.map(c => c.panelId);
        const dedupedCellIds = deduplicateRestorePanels(allCellIds);
        const dedupedGrid = { ...lastView.grid, cells: lastView.grid.cells.map((c, i) => ({ ...c, panelId: dedupedCellIds[i] })) };
        layoutManager.applyGridLayout(dedupedGrid, mainWindow);
        if (dedupedGrid.cells.length > 0) {
          panelManager.setInitialActive(dedupedGrid.cells[0].panelId);
        }
      } else if (lastView.type === "grid" && lastView.rows) {
        const flatIds = lastView.rows.flat();
        const dedupedFlat = deduplicateRestorePanels(flatIds);
        let idx = 0;
        const dedupedRows = lastView.rows.map(row => row.map(() => dedupedFlat[idx++]));
        layoutManager.splitGrid(dedupedRows, mainWindow);
        if (dedupedRows.length > 0 && dedupedRows[0].length > 0) {
          panelManager.setInitialActive(dedupedRows[0][0]);
        }
      } else if (lastView.type === "split" && lastView.panels) {
        const deduped = deduplicateRestorePanels(lastView.panels);
        if (deduped.length === 2) {
          layoutManager.splitTwo(deduped[0], deduped[1], mainWindow);
        } else if (deduped.length > 2) {
          layoutManager.splitN(deduped, mainWindow);
        }
        panelManager.setInitialActive(deduped[0]);
      } else if (lastView.type === "layout" && lastView.name) {
        const savedLayout = layoutManager.getLayout(lastView.name);
        if (savedLayout?.type === "code") {
          // Code layout: just switch to code-workspace; slots render empty until bound
          setPreference("codeWorkspaceLayout", lastView.name);
          panelManager.switchTo("code-workspace", mainWindow);
          panelManager.setInitialActive("code-workspace");
        } else {
          layoutManager.apply(lastView.name, mainWindow);
          const grid = layoutManager.getGridInfo();
          if (grid && grid.panelIds.length > 0) {
            panelManager.setInitialActive(grid.panelIds[0]);
          }
        }
      } else if (lastView.type === "panel" && lastView.id) {
        panelManager.switchTo(lastView.id, mainWindow);
      }
    } else if (mainWindow) {
      panelManager.switchTo("home", mainWindow);
    }

    // Restore all saved tabs (not just those in the current view).
    // Skip code panels — they're managed by the layout restore above, not as standalone tabs.
    for (const id of savedTabs) {
      if (!openTabs.includes(id) && resolveAppId(id) !== "code") {
        openTabs.push(id);
      }
    }
    // Restore suspended layout from previous session
    const savedSuspended = getPreference<import("./layout-manager").GridLayout | null>("suspendedLayout", null);
    if (savedSuspended && !layoutManager.hasSplit) {
      layoutManager.setSuspendedGrid(savedSuspended);
    }

    // Also ensure panels from the active/suspended layout are in tabs
    const gridInfo = layoutManager.getGridInfo();
    const suspendedInfo = layoutManager.getSuspendedGridInfo();
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
    } else if (suspendedInfo) {
      for (const id of suspendedInfo.panelIds) ensureTab(id);
    }
    if (panelManager.activePanelId) {
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
  let panelInstanceCounter = 0;

  function resolveAppId(panelId: string): string {
    if (appConnector.hasDirect(panelId)) return panelId;
    if (panelId.startsWith("browse-")) return "browser";
    if (panelId.startsWith("code-")) return "code";
    const dash = panelId.lastIndexOf("-");
    if (dash > 0) {
      const base = panelId.slice(0, dash);
      const suffix = panelId.slice(dash + 1);
      if (/^\d+$/.test(suffix) && appConnector.hasDirect(base)) return base;
    }
    return panelId;
  }

  function createPanelForApp(instanceId: string, app: { id: string; url?: string; forceWeb?: boolean }): void {
    if (!app.url) return;
    if (app.url === "yo://home") {
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(instanceId, homeHtml, homePreload, undefined, true);
    } else if (app.url === "yo://terminal") {
      panelManager.addPanel(instanceId, terminalHtml, terminalPreload);
    } else if (app.url === "yo://monaco") {
      panelManager.addPanel(instanceId, monacoHtml);
    } else if (app.url === "yo://browser") {
      const savedBrowserUrls = getPreference<Record<string, string>>("browserTabUrls", {});
      const browserUrl = savedBrowserUrls[instanceId] || resolveBrowserHome();
      panelManager.addPanel(instanceId, browserHtmlUrl(browserUrl), undefined, undefined, true);
    } else if (app.url === "yo://context") {
      const contextHtml = `file://${path.join(__dirname, "..", "renderer", "context.html")}`;
      const renderPreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(instanceId, contextHtml, renderPreload);
    } else if (app.url === "yo://vscode" || app.url === "https://vscode.dev") {
      if (enableVscode && vscodeServer.available) {
        panelManager.addPanel(instanceId, VSCodeServer.expectedUrl());
      } else {
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
        panelManager.addPanel(instanceId, infoPage);
      }
    } else {
      panelManager.addPanel(instanceId, app.url!, undefined, app.forceWeb);
    }
  }

  // Per-panel URL + favicon tracking
  const panelUrls: Record<string, string> = {};
  const panelFavicons: Record<string, string> = getPreference<Record<string, string>>("panelFavicons", {});
  const panelNavWc: Record<string, Electron.WebContents> = {}; // navigable webContents per panel

  function getTabName(id: string): string {
    const app = appConnector.get(id) || appConnector.get(resolveAppId(id));
    return app?.name || id;
  }

  function buildTabState() {
    const visible = getPreference<boolean>("showTabs", true);
    const gridInfo = layoutManager.getGridInfo();
    const suspendedInfo = layoutManager.getSuspendedGridInfo();
    const layoutInfo = gridInfo || suspendedInfo;
    const hasLayout = layoutInfo && layoutInfo.panelIds.length > 1;
    const isActiveLayout = gridInfo && gridInfo.panelIds.length > 1;

    // Ensure "home" is always the leftmost tab
    if (!openTabs.includes("home")) {
      openTabs.unshift("home");
    } else if (openTabs[0] !== "home") {
      const idx = openTabs.indexOf("home");
      openTabs.splice(idx, 1);
      openTabs.unshift("home");
    }

    const urlForTab = (id: string): string | undefined => {
      const isBrowser = resolveAppId(id) === "browser";
      return isBrowser ? (panelUrls[id] || undefined) : undefined;
    };

    let tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string }>;
    if (hasLayout) {
      const layoutName = layoutInfo.panelIds.map((id) => getTabName(id)).join(" + ");
      const layoutFavicons = layoutInfo.panelIds.map((id) => panelFavicons[id] || "").filter(Boolean);
      const layoutTabId = "__layout__";
      const gridSet = new Set(layoutInfo.panelIds);
      tabs = [
        ...(openTabs.includes("home") ? [{ id: "home", name: "Home", favicon: "", pinned: true }] : []),
        { id: layoutTabId, name: layoutName, layoutFavicons },
        ...openTabs.filter((id) => id !== "home" && !gridSet.has(id)).map((id) => ({
          id, name: getTabName(id), favicon: panelFavicons[id] || "", url: urlForTab(id),
        })),
      ];
    } else {
      tabs = openTabs.map((id) => ({
        id,
        name: id === "home" ? "Home" : getTabName(id),
        favicon: panelFavicons[id] || "",
        pinned: id === "home",
        url: urlForTab(id),
      }));
    }

    return {
      tabs,
      activeId: isActiveLayout ? "__layout__" : (panelManager.activePanelId || ""),
      visible,
    };
  }

  function sendTabState() {
    mainWindow?.webContents.send("tab-state", buildTabState());
  }

  const URL_BAR_HEIGHT = 34;

  /** Push the active panel's URL + favicon + nav state to the renderer URL bar */
  function sendUrlUpdate() {
    const id = panelManager.activePanelId;
    if (!id || !mainWindow || mainWindow.isDestroyed()) return;
    const nwc = panelNavWc[id];
    const canGoBack = nwc && !nwc.isDestroyed() ? nwc.navigationHistory.canGoBack() : false;
    const canGoForward = nwc && !nwc.isDestroyed() ? nwc.navigationHistory.canGoForward() : false;
    mainWindow.webContents.send("url-update", {
      url: panelUrls[id] || "",
      favicon: panelFavicons[id] || "",
      canGoBack,
      canGoForward,
    });
    // In grid mode, per-cell URL bars are handled by the layout manager — don't
    // change the global topInset or it will trigger restoreSplit and re-apply the grid,
    // stealing focus in a loop.
    if (!layoutManager.hasSplit) {
      const isBrowser = resolveAppId(id) === "browser";
      const urlBarPref = getPreference<boolean>("showUrlBar", true);
      if (isBrowser || urlBarPref) {
        panelManager.setTopInset(URL_BAR_HEIGHT);
        mainWindow.webContents.send("url-bar-force", true);
      } else {
        panelManager.setTopInset(0);
        mainWindow.webContents.send("url-bar-force", false);
      }
    }
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

  // When a browser panel's webview guest attaches, focus it so clicks pass through
  panelManager.setOnPanelReady((id, wc) => {
    if (resolveAppId(id) === "browser") {
      const focusWebview = () => {
        if (wc.isDestroyed()) return;
        wc.executeJavaScript(`(function(){
          var wv = document.getElementById("webview");
          if (wv) { wv.focus(); }
        })()`).catch(() => {});
      };
      // Focus immediately (for already-attached guests) and again after a delay
      // to handle the case where the guest process attaches after the host loads
      focusWebview();
      setTimeout(focusWebview, 500);
      setTimeout(focusWebview, 1500);
    }
  });

  // Activate interceptor on browser panel guest webviews and ensure they're focusable
  panelManager.setOnWebviewAttach((childWc, panelId) => {
    yoInterceptor.activate(childWc, panelId);
    if (resolveAppId(panelId) === "browser") {
      childWc.on("did-finish-load", () => {
        if (!childWc.isDestroyed()) childWc.focus();
      });
    }
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

  commandParser.setInstanceCreator((appId: string) => {
    const app = appConnector.get(appId);
    if (!app?.url) return null;
    panelInstanceCounter++;
    const instanceId = `${appId}-${panelInstanceCounter}`;
    createPanelForApp(instanceId, app);
    ensureTab(instanceId);
    return instanceId;
  });


  // Initialize auth — restore session, schedule refresh, start heartbeat
  await initAuth();

  // Resume capability publishing if the user had "Offer Usage" on
  void initCapabilities();

  // Start the cypher runtime — polls joined cyphers for prompt events.
  // Brain is unwired (Phase 3.5 hooks the Agent SDK); for v1 the loop just
  // tracks subscriptions so the protocol scaffolding is exercised.
  if (isAuthenticated()) startCypherRuntime();

  // Sync all joinable agents to server on boot (fire-and-forget)
  if (isAuthenticated()) void syncAllAgents(listAgents());

  // Check if onboarding is needed BEFORE restoring panels
  // (BrowserViews render above HTML, so they'd cover the onboarding overlay)
  const authenticated = isAuthenticated();
  const needsOnboarding = !authenticated;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Only restore panels if not gated by onboarding
  if (!needsOnboarding) {
    restoring = true;
    restorePanels();
    restoring = false;
    panelsReady = true;
    // Hide panels during splash — renderer will show them after splash dismisses
    if (mainWindow) panelManager.hideActive(mainWindow);
  }

  // Start cloud sync if authenticated and tier allows it
  if (authenticated && canUseSync().allowed) {
    cloudSyncInstance = new CloudSync(noteStore);
    cloudSyncInstance.setCaptureStore(captureStore);
    cloudSyncInstance.setWorkspaceGetter(workspaceGetter);
    cloudSyncInstance.start();
  }

  // Usage queue — durable write-ahead log for usage reporting
  usageQueue.setTokenGetter(getAuthToken);
  usageQueue.start();

  // Initialize Pipedream connectors — always attempt so MCP tools are available.
  connectorManager?.init().catch((err) => console.error("[connectors]", err));

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
    sendTabState();
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
    // Cmd+. now opens the yo agent panel
    mainWindow?.webContents.send("yo-panel-open", "");
  });

  // IPC: Yo panel commands — route through command parser
  ipcMain.on("yo-panel-send", async (_e, message: string) => {
    const trimmed = message.trim();

    // Route dot-commands (.dip, .drip, .sup, .waz) through command parser
    if (trimmed.startsWith(".")) {
      const firstWord = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase();
      if (firstWord && ["dip", "drip", "sup", "waz"].includes(firstWord)) {
        try {
          const result = await execCommand(trimmed.slice(1));
          mainWindow?.webContents.send("yo-panel-done", result || "done.");
        } catch (err: any) {
          mainWindow?.webContents.send("yo-panel-error", err?.message || String(err));
        }
        return;
      }
    }

    const wc = mainWindow?.webContents;
    if (!wc || mainWindow!.isDestroyed()) return;

    // Everything else goes to the yo agent
    yoAgent.send(trimmed, {
      onText: (delta) => wc.send("yo-panel-token", delta),
      onToolUse: (id, name, input) => wc.send("yo-panel-tool-use", id, name, input),
      onToolResult: (id, detail) => wc.send("yo-panel-tool-result", id, detail),
      onToolProgress: (id, status) => wc.send("yo-panel-tool-progress", id, status),
      onDone: (fullText) => wc.send("yo-panel-done", fullText),
      onError: (err) => wc.send("yo-panel-error", err),
    });
  });

  ipcMain.on("yo-panel-stop", () => {
    yoAgent.abort();
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
    let toolLabel = TOOL_LABELS[toolName] || toolName;
    const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
    if (mcpMatch) toolLabel = TOOL_LABELS[mcpMatch[1]] || mcpMatch[1].replace(/_/g, " ");
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

  // IPC: skills CRUD (legacy-compatible signatures)
  ipcMain.handle("skills-list", () => skillEngine.listSkills());
  ipcMain.handle("skills-list-detailed", () => skillEngine.listSkillsDetailed());
  ipcMain.handle("skills-read", (_e, name: string) => skillEngine.readSkill(name));
  ipcMain.handle("skills-get", (_e, name: string) => {
    const s = skillEngine.getSkill(name);
    if (!s) return null;
    return {
      name: s.name,
      manifest: s.manifest,
      prompt: s.prompt,
    };
  });
  ipcMain.handle("skills-write", (_e, name: string, prompt: string) => {
    // Legacy signature: writes prompt only, preserves manifest if exists
    const existing = skillEngine.getSkill(name);
    if (existing) {
      skillEngine.writeSkill(name, existing.manifest, prompt);
      return true;
    }
    const gate = canCreateSkill(skillEngine.listSkills().length);
    if (!gate.allowed) return { error: gate.reason };
    skillEngine.writeSkill(name, { name, description: "" }, prompt);
    return true;
  });
  ipcMain.handle("skills-write-full", (_e, name: string, manifest: any, prompt: string) => {
    const existing = skillEngine.getSkill(name);
    if (!existing) {
      const gate = canCreateSkill(skillEngine.listSkills().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    skillEngine.writeSkill(name, manifest, prompt);
    skillScheduler?.refresh();
    return true;
  });
  ipcMain.handle("skills-remove", (_e, name: string) => skillEngine.deleteSkill(name));
  ipcMain.handle("skills-generate", (_e, name: string, description: string) =>
    skillEngine.generatePrompt(name, description),
  );
  ipcMain.handle("skills-available-tools", () => {
    const groups: Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }> = [];
    const yoTools = listBuiltinYoTools();
    if (yoTools.length) {
      groups.push({ namespace: "yo", label: "yo (built-in)", tools: yoTools.map(t => ({ name: t.name, description: t.description })) });
    }
    if (mcpManager) {
      const byApp = new Map<string, { label: string; tools: Array<{ name: string; description: string }> }>();
      for (const t of mcpManager.getAllTools()) {
        const appId = t.serverId;
        const app = appConnector?.get(appId);
        const label = app?.name || appId;
        if (!byApp.has(appId)) byApp.set(appId, { label, tools: [] });
        byApp.get(appId)!.tools.push({ name: t.name, description: t.description });
      }
      for (const [appId, group] of byApp) {
        groups.push({ namespace: appId, label: group.label, tools: group.tools });
      }
    }
    return groups;
  });
  // File operations within a skill folder
  ipcMain.handle("skills-list-files", (_e, name: string) => skillEngine.listSkillFiles(name));
  ipcMain.handle("skills-read-file", (_e, name: string, rel: string) => skillEngine.readSkillFile(name, rel));
  ipcMain.handle("skills-write-file", (_e, name: string, rel: string, content: string) =>
    skillEngine.writeSkillFile(name, rel, content),
  );
  ipcMain.handle("skills-delete-file", (_e, name: string, rel: string) => skillEngine.deleteSkillFile(name, rel));
  // Run a skill (LLM call with skill's prompt)
  ipcMain.handle("skills-run", async (_e, name: string, input: unknown) => {
    try {
      const content = typeof input === "string" ? input : JSON.stringify(input);
      const output = await skillEngine.process(content, name);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Export/import .yo bundles
  ipcMain.handle("skills-export", (_e, name: string) => {
    const buf = skillEngine.exportSkill(name);
    return buf ? buf.toString("base64") : null;
  });
  ipcMain.handle("skills-import", (_e, base64: string, overwrite?: boolean) => {
    try {
      const buf = Buffer.from(base64, "base64");
      return skillEngine.importSkill(buf, { overwrite });
    } catch (err) {
      return { imported: [], skipped: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Scheduler
  ipcMain.handle("skills-schedule-status", () => skillScheduler?.status() ?? []);
  ipcMain.handle("skills-pause-schedule", (_e, name: string) => { skillScheduler?.pause(name); });
  ipcMain.handle("skills-resume-schedule", (_e, name: string) => { skillScheduler?.resume(name); });

  // IPC: layouts CRUD
  ipcMain.handle("layouts-list", () =>
    layoutManager.listLayouts().map((l) => ({
      name: l.name,
      cols: l.cols,
      rows: l.rows,
      colWidths: l.colWidths,
      rowHeights: l.rowHeights,
      splits: l.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan })),
      type: l.type || "standard",
      rootDir: l.rootDir,
      slots: l.slots,
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
  ipcMain.handle("layouts-save-grid", (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>; type?: string; rootDir?: string; slots?: Array<{ slotId: string; enableInput?: boolean }> }) => {
    const existing = layoutManager.listLayouts().find(l => l.name === grid.name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    layoutManager.saveLayout({
      ...grid,
      version: 2,
      type: (grid.type as "standard" | "code") || undefined,
      rootDir: grid.rootDir || undefined,
      slots: grid.slots || undefined,
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

  // IPC: Context panel — workspace management
  ipcMain.handle("workspace-get", () => workspaceManager.getActiveSlug());
  ipcMain.handle("workspace-set", (_e, name: string) => {
    // Backward-compat with the legacy context-panel UX: any name becomes a
    // workspace. If it doesn't exist yet, auto-create it bound to ~ before
    // switching. Explicit creation from the Workspaces page lets the user
    // pick a real rootDir.
    const slug = String(name || "").trim().toLowerCase();
    if (!slug) return;
    if (!workspaceManager.get(slug)) {
      workspaceManager.create(slug, slug, os.homedir());
    }
    workspaceManager.switch(slug);
  });
  ipcMain.handle("workspace-list", () => captureStore.listWorkspaces());
  // New: full workspace registry with rootDir (for upcoming UI in Phase 6)
  ipcMain.handle("workspaces-registry", () => workspaceManager.list());

  // IPC: Context panel — live feed
  ipcMain.handle("context-recent", (_e, workspace: string, limit: number) => {
    return captureStore.recentByWorkspace(workspace, limit || 50).map(c => ({
      id: c.meta.id,
      source: c.meta.source,
      created: c.meta.created,
      workspace: c.meta.workspace,
      snippet: c.content.slice(0, 500),
    }));
  });

  ipcMain.handle("context-search", async (_e, workspace: string, query: string, limit: number) => {
    const results = await captureStore.searchWorkspace(workspace, query, limit || 20);
    return results.map(r => ({
      id: r.meta.id,
      source: r.meta.source,
      created: r.meta.created,
      workspace: r.meta.workspace,
      snippet: r.content.slice(0, 500),
      score: r.score,
    }));
  });

  ipcMain.handle("context-read", (_e, id: string) => {
    return captureStore.readContent(id) || "";
  });

  // Push live capture updates to any context panel
  captureStore.onCapture((meta) => {
    for (const id of panelManager.getLoadedPanelIds()) {
      if (resolveAppId(id) !== "context") continue;
      const wc = panelManager.getGuestOrWebContents(id);
      if (wc && !wc.isDestroyed()) {
        wc.send("context-update", {
          id: meta.id,
          source: meta.source,
          created: meta.created,
          workspace: meta.workspace,
        });
      }
    }
  });

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
  ipcMain.handle("get-theme", () => getPreference<string>("theme", "light"));
  ipcMain.handle("set-theme", (_e, theme: string) => {
    setPreference("theme", theme);
    nativeTheme.themeSource = theme === "system" ? "system" : theme as "light" | "dark";
    const resolved = theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
    broadcastTheme(resolved);
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
    if (hb) cloudSyncInstance?.resetAuth();
    return { tier: hb?.tier || "free", status: hb?.status || "unknown" };
  });
  ipcMain.handle("copy-to-clipboard", (_e, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("logout", () => {
    logout();
    if (mainWindow) panelManager.hideActive(mainWindow);
    mainWindow?.webContents.send("show-onboarding");
  });
  ipcMain.handle("validate-api-key", async () => ({ valid: true }));
  ipcMain.handle("get-api-key", () => null);

  // LLM config — model selection (no keys)
  ipcMain.handle("get-llm-config", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
  }));
  ipcMain.handle("get-llm-presets", () => ({
    anthropic: {
      name: "Anthropic",
      models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      defaultModel: "claude-sonnet-4-6",
    },
  }));
  ipcMain.handle("save-llm-config", async (_e, config: LLMConfig) => {
    saveLLMConfig(config);
    applyLLMConfig(config);
    return { ok: true };
  });

  // ── Directory picker (for workspace creation) ──────────
  ipcMain.handle("pick-directory", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose project directory",
      buttonLabel: "Select",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ── MCP Expose IPC handlers ────────────────────────────
  ipcMain.handle("mcp-expose-start", async () => {
    const result = await mcpExpose!.start();
    if (result.ok) setPreference("mcpExposeRunning", true);
    return result;
  });
  ipcMain.handle("mcp-expose-stop", () => {
    mcpExpose!.stop();
    setPreference("mcpExposeRunning", false);
  });
  ipcMain.handle("mcp-expose-status", () => ({
    running: mcpExpose!.isRunning,
    port: mcpExpose!.getPort(),
  }));
  // ── Capability Offer (distributed work) IPC handlers ───
  ipcMain.handle("capabilities-set-enabled", async (_e, enabled: boolean) => {
    return setOfferEnabled(!!enabled);
  });
  ipcMain.handle("capabilities-get-status", async () => {
    return getCapabilitiesStatus();
  });

  // ── Agents Registry IPC handlers ───────────────────────
  ipcMain.handle("agents-list", async () => listAgents());
  ipcMain.handle("agents-get", async (_e, id: string) => getAgent(id));
  ipcMain.handle("agents-save", async (_e, cfg: AgentRegistryConfig) => {
    const saved = saveAgent(cfg);
    // Auto-sync to server: push profile if joinable, delete otherwise.
    void (saved.joinable
      ? pushAgentProfile(saved)
      : deleteAgentProfile(saved.id));
    return saved;
  });
  ipcMain.handle("agents-remove", async (_e, id: string) => {
    const ok = removeAgent(id);
    if (ok) void deleteAgentProfile(id);
    return ok;
  });
  ipcMain.handle("agents-id-available", async (_e, id: string) => idAvailable(id));

  // ── Marketplace + Reservations IPC handlers ────────────
  ipcMain.handle("yos-balance", async () => {
    try {
      const r = await serverGetAuthed<{ user_id: string; balance: number }>("/api/yos/balance");
      usageQueue.updateBalance(r.balance);
      return r;
    } catch (err) { return { error: err instanceof Error ? err.message : "fetch failed" }; }
  });
  ipcMain.handle("yos-rate-cards", async () => {
    try { return await serverGetAuthed<{ cards: Array<{ tier: string; yos_per_1k_input: number; yos_per_1k_output: number; yos_per_idle_minute: number }> }>("/api/yos/rate-cards"); }
    catch (err) { return { error: err instanceof Error ? err.message : "fetch failed" }; }
  });
  // All payment lives on the platform — desktop just deep-links so the user
  // gets the same checkout/invoice/portal experience whether they came from
  // the web or the app. Returns the URL the renderer should send to.
  ipcMain.handle("yos-buy-url", () => {
    const base = process.env.YO_PLATFORM_URL || "https://platform.yosup.dev";
    return { url: `${base}/dashboard/billing#yos` };
  });
  ipcMain.handle("marketplace-available", async (_e, opts?: { tier?: string; provider?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.tier) params.set("tier", opts.tier);
    if (opts?.provider) params.set("provider", opts.provider);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    try {
      return await serverGetAuthed<{ entries: unknown[]; count: number; ts: string }>(
        `/api/marketplace/available${qs ? "?" + qs : ""}`,
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : "fetch failed" };
    }
  });
  ipcMain.handle("reservation-create", async (_e, body: { provider_handle: string; idle_minutes: number; guardrails?: unknown }) => {
    try { return await serverPostAuthed("/api/marketplace/reservations", body as Record<string, unknown>); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "reservation failed" }; }
  });
  ipcMain.handle("reservation-release", async (_e, id: string, reason?: string) => {
    try { return await serverPostAuthed(`/api/marketplace/reservations/${encodeURIComponent(id)}/release`, { reason }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "release failed" }; }
  });
  ipcMain.handle("reservation-list", async (_e, opts?: { status?: string }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    const qs = params.toString();
    try { return await serverGetAuthed(`/api/marketplace/reservations/mine${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "fetch failed" }; }
  });

  // ── Cyphers IPC handlers ───────────────────────────────
  ipcMain.handle("cypher-create", async (_e, input: Record<string, unknown>) => {
    try { return await serverPostAuthed("/api/cyphers", input); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "create failed" }; }
  });
  ipcMain.handle("cypher-update", async (_e, id: string, patch: Record<string, unknown>) => {
    try {
      // PATCH not exposed in serverPostAuthed; reuse POST against PATCH-shaped endpoint via fetch
      // For now we emulate via a dedicated path — the server route uses app.patch, so we add a small helper.
      const token = (await import("./auth")).getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      const { net } = await import("electron");
      return await new Promise((resolve, reject) => {
        const req = net.request({ url: `${process.env.YO_AUTH_SERVER || "https://api.yosup.dev"}/api/cyphers/${encodeURIComponent(id)}`, method: "PATCH" });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); }
          });
        });
        req.on("error", reject);
        req.write(JSON.stringify(patch));
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "update failed" }; }
  });
  ipcMain.handle("cypher-publish", async (_e, id: string, initial_kitty_deposit: number) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/publish`, { initial_kitty_deposit }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "publish failed" }; }
  });
  ipcMain.handle("cypher-wrap", async (_e, id: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/wrap`, {}); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "wrap failed" }; }
  });
  ipcMain.handle("cypher-cancel", async (_e, id: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/cancel`, {}); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "cancel failed" }; }
  });
  ipcMain.handle("cypher-discover", async (_e, opts?: { status?: string; type?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set("status", opts.status);
    if (opts?.type) p.set("type", opts.type);
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.offset) p.set("offset", String(opts.offset));
    const qs = p.toString();
    try { return await serverGetAuthed(`/api/cyphers/discover${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "discover failed" }; }
  });
  ipcMain.handle("cypher-list-mine", async () => {
    try { return await serverGetAuthed(`/api/cyphers/mine`); }
    catch (err) { return { error: err instanceof Error ? err.message : "list failed" }; }
  });
  ipcMain.handle("cypher-get", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "get failed" }; }
  });
  ipcMain.handle("cypher-get-by-slug", async (_e, slug: string) => {
    try { return await serverGetAuthed(`/api/cyphers/by-slug/${encodeURIComponent(slug)}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "get failed" }; }
  });
  ipcMain.handle("cypher-join", async (_e, id: string, agent_local_id: string, role?: string) => {
    try {
      const r = await serverPostAuthed<{ ok: boolean; cypher?: { id: string }; error?: string }>(
        `/api/cyphers/${encodeURIComponent(id)}/join`,
        { agent_local_id, role },
      );
      // If join succeeded and we're not just observing, start polling this cypher.
      if (r.ok && role !== "observer") subscribeCypher(id, agent_local_id);
      return r;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "join failed" }; }
  });
  ipcMain.handle("cypher-leave", async (_e, id: string, agent_local_id: string) => {
    try {
      const r = await serverPostAuthed<{ ok: boolean }>(`/api/cyphers/${encodeURIComponent(id)}/leave`, { agent_local_id });
      unsubscribeCypher(id);
      return r;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "leave failed" }; }
  });
  ipcMain.handle("cypher-jammers", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/jammers`); }
    catch (err) { return { error: err instanceof Error ? err.message : "jammers failed" }; }
  });
  ipcMain.handle("cypher-jams-list", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/jams`); }
    catch (err) { return { error: err instanceof Error ? err.message : "jams failed" }; }
  });
  ipcMain.handle("cypher-jam-create", async (_e, id: string, slug: string, title: string, description?: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/jams`, { slug, title, description }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "jam create failed" }; }
  });
  ipcMain.handle("cypher-jam-set-state", async (_e, id: string, jam_id: string, expected_version: number, state: unknown) => {
    try {
      const token = (await import("./auth")).getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      const { net } = await import("electron");
      return await new Promise((resolve, reject) => {
        const req = net.request({ url: `${process.env.YO_AUTH_SERVER || "https://api.yosup.dev"}/api/cyphers/${encodeURIComponent(id)}/jams/${encodeURIComponent(jam_id)}/state`, method: "PUT" });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
        });
        req.on("error", reject);
        req.write(JSON.stringify({ expected_version, state }));
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "set state failed" }; }
  });
  ipcMain.handle("cypher-event-post", async (_e, id: string, kind: string, payload: unknown, jam_id?: string, by_agent_id?: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/events`, { kind, payload, jam_id, by_agent_id }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "event post failed" }; }
  });
  ipcMain.handle("cypher-events-list", async (_e, id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.since != null) p.set("since", String(opts.since));
    if (opts?.jam_id) p.set("jam_id", opts.jam_id);
    if (opts?.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/events${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "events failed" }; }
  });
  ipcMain.handle("cypher-kitty-deposit", async (_e, id: string, amount: number) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/kitty/deposit`, { amount }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "deposit failed" }; }
  });
  ipcMain.handle("cypher-kitty-balance", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/kitty/balance`); }
    catch (err) { return { error: err instanceof Error ? err.message : "balance failed" }; }
  });
  ipcMain.handle("cypher-kitty-ledger", async (_e, id: string, opts?: { limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/kitty/ledger${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "ledger failed" }; }
  });

  ipcMain.handle("mcp-expose-get-tokens", () => mcpExpose!.getTokens());
  ipcMain.handle("mcp-expose-gen-token", (_e, label: string, ttlDays?: number) => mcpExpose!.generateToken(label, ttlDays));
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

  let usageSummaryCache: { ts: number; data: any } | null = null;
  const USAGE_CACHE_TTL = 30_000;

  async function fetchUsageSummary(days: number) {
    if (usageSummaryCache && Date.now() - usageSummaryCache.ts < USAGE_CACHE_TTL && days <= 30) {
      return usageSummaryCache.data;
    }
    try {
      const data = await serverGetAuthed<any>(`/api/usage/summary?days=${days}`);
      if (days <= 30) usageSummaryCache = { ts: Date.now(), data };
      return data;
    } catch {
      return usageTracker.getAllTime() ? { today: usageTracker.getToday(), history: usageTracker.getHistory(days), allTime: usageTracker.getAllTime() } : null;
    }
  }

  ipcMain.handle("dashboard:today", async () => {
    const summary = await fetchUsageSummary(30);
    return summary?.today || null;
  });
  ipcMain.handle("dashboard:history", async (_e, days?: number) => {
    const summary = await fetchUsageSummary(days || 30);
    return summary?.history || [];
  });
  ipcMain.handle("dashboard:all-time", async () => {
    const summary = await fetchUsageSummary(90);
    return summary?.allTime || { agents: {}, total: { yos: 0, calls: 0 } };
  });

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

  // IPC: code workspace
  ipcMain.handle("cw:get-agents", (e) => {
    const wsSlug = cwWcWorkspace.get(e.sender.id) || workspaceManager.getActive().slug;
    return workspaceManager.listAgents(wsSlug).map((a) => ({ name: a.name, role: a.role, prompt: a.prompt }));
  });

  ipcMain.handle("cw:add-agent", (e, name: string, role: string, prompt?: string) => {
    const wsSlug = cwWcWorkspace.get(e.sender.id) || workspaceManager.getActive().slug;
    const result = workspaceManager.createAgent(wsSlug, { name, role, prompt });
    if (!result.ok) return { ok: false, error: result.error };
    const agent = result.agent;
    const ws = workspaceManager.get(wsSlug)!;
    const allAgents = workspaceManager.listAgents(wsSlug);
    rewriteAllBriefings(ws, allAgents);
    writeAgentBriefing(ws, agent, allAgents);
    return { ok: true };
  });

  // Agent runner IPC: start/stop SDK-driven agents
  function buildAgentConfig(wsSlug: string, agentName: string): AgentConfig | null {
    const agent = workspaceManager.getAgent(wsSlug, agentName);
    if (!agent) return null;
    return {
      name: agent.name,
      role: agent.role,
      cwd: agent.cwd,
      prompt: agent.prompt,
      startPrompt: `You are agent "${agent.name}" (${agent.role}). Read .yo/agents/${agent.name}.md for your role briefing. Then check .yo/inbox/${agent.name}.md for pending tasks. If the inbox is empty or doesn't exist, say "Ready" and wait for instructions.`,
      workspace: wsSlug,
    };
  }

  ipcMain.on("cw:agent:start", (e, agentName: string) => {
    const wsSlug = cwWcWorkspace.get(e.sender.id) || workspaceManager.getActive().slug;
    const config = buildAgentConfig(wsSlug, agentName);
    if (!config) return;
    agentRunner.startAgent(e.sender, config).catch((err) => {
      console.error(`[agent-runner] failed to start agent "${agentName}":`, err);
    });
  });

  ipcMain.on("cw:agent:stop", (e, agentName: string) => {
    agentRunner.stopAgent(e.sender.id, agentName);
  });

  ipcMain.on("cw:agent:send", (e, agentName: string, message: string) => {
    agentRunner.sendMessage(e.sender.id, agentName, message);
  });

  ipcMain.handle("cw:vscode-url", () => {
    if (vscodeServer?.available) return VSCodeServer.expectedUrl();
    return null;
  });

  function getActiveCodeLayout(): import("./layout-manager").GridLayout | undefined {
    const lastView = getPreference<{ type: string; name?: string }>("lastView", null!);
    if (lastView?.type === "layout" && lastView.name) {
      const layout = layoutManager.getLayout(lastView.name);
      if (layout?.type === "code") return layout;
    }
    const cwName = getPreference<string>("codeWorkspaceLayout", "");
    if (cwName) {
      const layout = layoutManager.getLayout(cwName);
      if (layout?.type === "code") return layout;
    }
    return undefined;
  }

  ipcMain.handle("cw:get-layout", () => {
    const layout = getActiveCodeLayout();
    if (!layout) return null;
    return {
      name: layout.name,
      cells: layout.cells,
      cols: layout.cols,
      rows: layout.rows,
      colWidths: layout.colWidths,
      rowHeights: layout.rowHeights,
      slots: layout.slots || [],
    };
  });

  // ── Cypher overlay (workspace ↔ cypher binding) ──────────
  ipcMain.handle("cw:cypher-status", async () => {
    const layout = getActiveCodeLayout();
    const layoutName = layout?.name ?? null;
    if (!layoutName) return { associated: false, layout_name: null };
    const map = getPreference<Record<string, string>>("codeWorkspaceCypher", {});
    const cypherId = map[layoutName];
    if (!cypherId) return { associated: false, layout_name: layoutName };
    try {
      const r = await serverGetAuthed<{
        cypher: { id: string; slug: string; title: string; status: string; type: string };
        kitty_balance: number;
      }>(`/api/cyphers/${encodeURIComponent(cypherId)}`);
      let jammers = 0;
      try {
        const j = await serverGetAuthed<{ jammers: Array<{ left_at: string | null }> }>(
          `/api/cyphers/${encodeURIComponent(cypherId)}/jammers`,
        );
        jammers = j.jammers.filter((x) => !x.left_at).length;
      } catch { /* ignore */ }
      return {
        associated: true, layout_name: layoutName,
        cypher_id: r.cypher.id, slug: r.cypher.slug, title: r.cypher.title,
        status: r.cypher.status, type: r.cypher.type,
        kitty: r.kitty_balance, jammers,
      };
    } catch (err) {
      // Server says the cypher's gone or we can't see it — clear local binding
      const next = { ...map };
      delete next[layoutName];
      setPreference("codeWorkspaceCypher", next);
      return { associated: false, layout_name: layoutName, error: err instanceof Error ? err.message : "fetch failed" };
    }
  });

  ipcMain.handle("cw:cypher-create-and-publish", async (_e, input: Record<string, unknown>) => {
    const layout = getActiveCodeLayout();
    const layoutName = layout?.name;
    if (!layoutName) return { ok: false, error: "No active code layout" };
    try {
      const create = await serverPostAuthed<{ ok: boolean; cypher?: { id: string }; error?: string }>(
        "/api/cyphers", input,
      );
      if (!create.ok || !create.cypher) return { ok: false, error: create.error || "create failed" };
      const cypherId = create.cypher.id;
      const deposit = Number(input.initial_kitty_deposit ?? 0);
      const pub = await serverPostAuthed<{ ok: boolean; cypher?: { id: string; slug: string }; kitty_balance?: number; error?: string }>(
        `/api/cyphers/${encodeURIComponent(cypherId)}/publish`,
        { initial_kitty_deposit: deposit },
      );
      if (!pub.ok) return { ok: false, error: pub.error || "publish failed" };
      // Persist the workspace ↔ cypher association so reloads show the cypher.
      const map = getPreference<Record<string, string>>("codeWorkspaceCypher", {});
      setPreference("codeWorkspaceCypher", { ...map, [layoutName]: cypherId });
      return { ok: true, cypher: pub.cypher, kitty_balance: pub.kitty_balance };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "publish failed" };
    }
  });

  ipcMain.handle("cw:cypher-disassociate", async () => {
    const layout = getActiveCodeLayout();
    const layoutName = layout?.name;
    if (!layoutName) return { ok: false };
    const map = getPreference<Record<string, string>>("codeWorkspaceCypher", {});
    const next = { ...map };
    delete next[layoutName];
    setPreference("codeWorkspaceCypher", next);
    return { ok: true };
  });

  ipcMain.handle("cw:save-layout-sizes", (_e, colWidths: number[], rowHeights: number[]) => {
    const layout = getActiveCodeLayout();
    if (layout) {
      layout.colWidths = colWidths;
      layout.rowHeights = rowHeights;
      layoutManager.saveLayout(layout);
      return true;
    }
    return false;
  });

  // (cw:add-agent-to-layout removed — slots are static after layout save)

  // IPC: tabs
  ipcMain.handle("tab-list", () => {
    return buildTabState();
  });

  ipcMain.on("tab-switch", (_e, id: string) => {
    if (!mainWindow) return;
    if (id === "__layout__") {
      // Clicking the layout tab restores the grid (from active or suspended)
      if (!layoutManager.hasSplit) {
        layoutManager.resumeSplit(mainWindow);
      } else {
        layoutManager.restoreSplit(mainWindow);
      }
      const gridInfo = layoutManager.getGridInfo();
      if (gridInfo) {
        setPreference("lastView", {
          type: "grid-full",
          grid: { name: "", version: 2, cols: gridInfo.cols, rows: gridInfo.rows, colWidths: gridInfo.colWidths, rowHeights: gridInfo.rowHeights, cells: gridInfo.cells },
        });
        setPreference("suspendedLayout", null);
      }
    } else {
      // Suspend grid so the layout tab persists
      layoutManager.suspendSplit();
      panelManager.switchTo(id, mainWindow);
      setPreference("lastView", { type: "panel", id });
      // Persist suspended grid for restart
      const suspended = layoutManager.getSuspendedGridInfo();
      if (suspended) {
        setPreference("suspendedLayout", {
          version: 2, name: suspended.name, cols: suspended.cols, rows: suspended.rows,
          colWidths: suspended.colWidths, rowHeights: suspended.rowHeights, cells: suspended.cells,
        });
      }
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-reorder", (_e, newOrder: string[]) => {
    // Filter to ids that actually exist in openTabs, always keeping home first
    const existing = new Set(openTabs);
    const sanitized = newOrder.filter((id) => existing.has(id) && id !== "__layout__");
    // Preserve any open tabs the renderer didn't include (shouldn't happen, but safe)
    for (const id of openTabs) {
      if (!sanitized.includes(id)) sanitized.push(id);
    }
    // Home always first
    const homeIdx = sanitized.indexOf("home");
    if (homeIdx > 0) {
      sanitized.splice(homeIdx, 1);
      sanitized.unshift("home");
    } else if (homeIdx < 0) {
      sanitized.unshift("home");
    }
    openTabs.length = 0;
    openTabs.push(...sanitized);
    persistTabs();
    sendTabState();
  });

  ipcMain.on("tab-close", (_e, id: string) => {
    if (!mainWindow) return;

    // Home tab is pinned — cannot be closed
    if (id === "home") return;

    // Closing the layout tab clears the grid (active or suspended)
    if (id === "__layout__") {
      const gridInfo = layoutManager.getGridInfo() || layoutManager.getSuspendedGridInfo();
      if (gridInfo) {
        for (const panelId of gridInfo.panelIds) {
          const idx = openTabs.indexOf(panelId);
          if (idx >= 0) openTabs.splice(idx, 1);
          panelManager.closePanel(panelId, mainWindow);
        }
      }
      layoutManager.clearSplit();
      layoutManager.clearSuspended();
      setPreference("suspendedLayout", null);
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
    if (resolveAppId(id) === "browser") {
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

    layoutManager.suspendSplit();

    if (appId === "home") {
      if (!panelManager.hasPanel(appId)) createPanelForApp(appId, app);
      panelManager.switchTo(appId, mainWindow);
      ensureTab(appId);
    } else {
      const alreadyOpen = openTabs.some(t => t === appId || resolveAppId(t) === appId);
      if (alreadyOpen) {
        panelInstanceCounter++;
        const instanceId = `${appId}-${panelInstanceCounter}`;
        createPanelForApp(instanceId, app);
        panelManager.switchTo(instanceId, mainWindow);
        ensureTab(instanceId);
      } else {
        if (!panelManager.hasPanel(appId)) createPanelForApp(appId, app);
        panelManager.switchTo(appId, mainWindow);
        ensureTab(appId);
      }
    }
    setPreference("lastView", { type: "panel", id: openTabs[openTabs.length - 1] });
    sendSplitState();
    sendTabState();
  });

  // IPC: URL bar
  // Apply initial URL bar state
  if (getPreference<boolean>("showUrlBar", true)) {
    panelManager.setTopInset(URL_BAR_HEIGHT);
  }

  ipcMain.on("url-bar-navigate", (_e, url: string) => {
    if (!mainWindow) return;
    const id = panelManager.activePanelId;
    if (!id) return;

    // Normalize: add protocol if missing, or search if not a URL
    let target = url.trim();
    if (target && !/^https?:\/\//i.test(target)) {
      if (/^localhost(:\d+)?(\/|$)/i.test(target) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(target)) {
        target = "http://" + target;
      } else if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+/i.test(target)) {
        target = "https://" + target;
      } else {
        target = "https://www.google.com/search?q=" + encodeURIComponent(target);
      }
    }

    const isBrowser = resolveAppId(id) === "browser";
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
      nwc.navigationHistory.goBack();
    }
  });

  ipcMain.on("url-bar-forward", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.navigationHistory.goForward();
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
    if (nwc && !nwc.isDestroyed()) nwc.navigationHistory.goBack();
  });
  ipcMain.on("panel-nav-forward", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.navigationHistory.goForward();
  });
  ipcMain.on("panel-nav-refresh", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.reload();
  });
  ipcMain.on("panel-nav-to", (_e, panelId: string, url: string) => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    const isBrowser = resolveAppId(panelId) === "browser";
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
    const id = panelManager.activePanelId;
    const isBrowser = id ? resolveAppId(id) === "browser" : false;
    const showBar = show || isBrowser;
    panelManager.setTopInset(showBar ? URL_BAR_HEIGHT : 0);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("url-bar-force", showBar);
    }
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
    const currentNeedsOnboarding = !isAuthenticated();
    mainWindow?.webContents.send("boot", {
      authenticated: authStatus.authenticated,
      status: authStatus.status,
      tier: authStatus.tier,
      needsOnboarding: currentNeedsOnboarding,
      hideWelcome,
      theme: (() => { const t = getPreference<string>("theme", "light"); return t === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t; })(),
    });
    if (!currentNeedsOnboarding && !panelsReady) {
      restoring = true;
      restorePanels();
      restoring = false;
      panelsReady = true;
      sendSplitState();
    } else if (!currentNeedsOnboarding) {
      sendSplitState();
    }
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: "yo-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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
  cleanupCapabilities();
  stopCypherRuntime();
  voiceRelay?.stop();
  cloudSyncInstance?.stop();
  cloudSyncInstance = null;
  usageQueue.stop();
  configSync?.stop();
  configSync = null;
  terminalManager?.killAll();
  // agentRunner instances are aborted when their webContents are destroyed
  vscodeServer?.stop();
  mcpExpose?.stop();
  inboxRouter?.stop();
  mcpManager?.disconnectAll();
  connectorManager?.cleanup();
  actionGrabber?.stopPolling();
  embedder?.cleanup();
  dripManager?.cleanup();
  closeLocalDb();
  closeDataStoreDb();
  closeSubstrateDb();
  usageTracker.flush();
  promptLog.flush();
  // Hard exit if anything keeps the process alive
  setTimeout(() => process.exit(0), 5000).unref();
}
