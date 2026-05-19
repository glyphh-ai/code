/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import "dotenv/config";

// Fix process.cwd() in packaged Electron apps — .asar is a file, not a directory,
// which causes ENOTDIR when child_process.spawn inherits cwd.
import os from "os";
try {
  const cwd = process.cwd();
  if (cwd.includes(".asar") || !require("fs").statSync(cwd).isDirectory()) {
    process.chdir(os.homedir());
  }
} catch {
  process.chdir(os.homedir());
}

import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, protocol, session as electronSession, shell, systemPreferences } from "electron";
import path from "path";
import fs from "fs";
import { PanelManager } from "./panel-manager";
import { TerminalManager, AgentSpawnConfig } from "./terminal";
import { writeAgentBriefing, ensureProjectClaudeMd, ensureProjectMcpJson, rewriteAllBriefings } from "./agent-briefing";
import { CommandParser } from "./command-parser";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, setHeartbeatObserver, PLATFORM_URL, serverPostAuthed, serverGetAuthed, getAuthToken } from "./auth";
import { CloudSync } from "./cloud-sync";
import { initCapabilities, setOfferEnabled, getCapabilitiesStatus, cleanupCapabilities } from "./capability-sync";
const CYPHER_MAESTRO_AGENT = "mistro";
import { CypherBus } from "./cypher-bus";
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
import * as providerKeysModule from "./provider-keys";
import { bootstrapStatus as ccBootstrapStatus, spawnCcLogin } from "./cc-bootstrap";
import { SessionCache } from "./session-cache";
import { NoteStore } from "./note-store";
import { MemoryStore } from "./memory-store";
import { Transcriber } from "./transcriber";
import { VoiceRelay } from "./voice-relay";
import { smartGrab } from "./smart-grab";
import { scanPanel, formatScan } from "./dom-scanner";
import { VSCodeServer } from "./vscode-server";
import { openInVscode } from "./vscode-bridge";
import { resolveShellPath } from "./shell-path";
import { WorkspaceManager } from "./workspace-manager";
import { EventLog } from "./event-log";
// WorkspaceMcpServer removed — workspace tools merged into McpExpose
import { InboxRouter } from "./inbox-router";
import { autoUpdater } from "electron-updater";

/** If a tool call touches a file, return its absolute path (else null). */
function fileFromToolCall(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  if (!/(read|edit|write|create)/i.test(name)) return null;
  const o = input as Record<string, unknown>;
  const raw = (o.file_path ?? o.path ?? o.filename ?? o.file) as unknown;
  if (typeof raw !== "string" || !raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(os.homedir(), "yo", raw);
}

/** True if semver `latest` is strictly newer than `current` (major.minor.patch). */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}
import { ConfigSync } from "./config-sync";
import { reloadRemotePatterns } from "./firewall";
import { usageTracker } from "./usage-tracker";
import { usageQueue } from "./usage-queue";
import { redactSecrets, summarizeToolInput } from "./feed-sanitize";
import { promptLog } from "./prompt-log";
import { Embedder } from "./embedder";
import { CaptureStore } from "./capture-store";
import { YoAgent } from "./yo-agent";
import { ActionGrabber } from "./action-grabber";
import { AgentRunner, AgentConfig } from "./agent-runner";
import { McpExpose, ghRequest } from "./mcp-expose";
import { McpManager } from "./mcp-manager";
import { registerFilesIpc } from "./files-ipc";
import { registerCodeIndexIpc } from "./code-index/ipc";
import { registerWorkingDirectoryIpc, getWorkingDirectory } from "./working-directory";
import { DripManager, BUILTIN_EFFECTS } from "./drip-manager";
import { ConnectorManager } from "./connectors";
import { SkillToolRouter } from "./skill-tool-router";
import { SkillScheduler } from "./skill-scheduler";
import { DataStore, closeDataStoreDb } from "./data-store";
import { closeSubstrateDb } from "./substrate/store";
import { registerSettingsIpc } from "./settings-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAppsIpc } from "./apps-ipc";
import { registerCapturesIpc } from "./captures-ipc";
import { registerMarketplaceIpc } from "./marketplace-ipc";
import { registerHomeIpc } from "./home-ipc";
import { registerTabIpc } from "./tab-ipc";
import { buildSubstrateDeps } from "./substrate-deps";
import { createCypherSession } from "./cypher-session";
import { initLocalDb, closeLocalDb } from "./local-db";
import { migrateFromFiles } from "./stores/migrate-from-files";
import { setSubstrateToolDeps, listBuiltinYoTools } from "./substrate/tools";
import { getAgentMode } from "./action-gate";
import * as threadStore from "./cypher-thread-store";


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
let wazManager: import("./waz-manager").WazManager | null = null;
let dripManager: DripManager | null = null;
let actionGrabber: ActionGrabber | null = null;
let connectorManager: ConnectorManager | null = null;
let skillToolRouter: SkillToolRouter | null = null;
let skillScheduler: SkillScheduler | null = null;

// ── DOM Picker script (injected into panel webContents) ─────
const PICKER_SCRIPT = `(function(){
  if(document.getElementById('__yo_picker__')) return null;
  return new Promise(function(resolve){
  function cleanup(){overlay.remove();highlight.remove();label.remove();document.removeEventListener('keydown',esc);}
  function esc(e){if(e.key==='Escape'){cleanup();resolve(null);}}
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
    cleanup();
    resolve({selector:sel,tag:tag,text:txt,isEditable:isEditable,isClickable:isClickable});
  });
  overlay.addEventListener('contextmenu',function(e){e.preventDefault();cleanup();resolve(null);});
  document.addEventListener('keydown',esc);
  });
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

  // Cached model list from server (model_rates table)
  interface ServerModel { provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number; max_context_tokens?: number; max_output_tokens?: number }
  let serverModelsCache: ServerModel[] = [];
  let serverModelsFetchedAt = 0;
  async function fetchServerModels(): Promise<ServerModel[]> {
    if (serverModelsCache.length > 0 && Date.now() - serverModelsFetchedAt < 60_000) return serverModelsCache;
    try {
      const r = await serverGetAuthed<{ models: ServerModel[] }>("/api/models");
      if (r.models?.length) {
        serverModelsCache = r.models;
        serverModelsFetchedAt = Date.now();
      }
    } catch { /* offline / not yet authed — keep cache or fallback */ }
    return serverModelsCache;
  }

  function applyLLMConfig(config: LLMConfig) {
    llmConfig = config;
    yoChat?.setLLMConfig(config);
    skillEngine?.setLLMConfig(config);
    yoAgent?.setLLMConfig(config);
    wazManager?.setLLMConfig(config);
    yoInterceptor?.setCurrentModel(config.model);
    const modelNames = serverModelsCache.length > 0
      ? serverModelsCache.map((m) => m.model)
      : ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    yoInterceptor?.setAvailableModels(modelNames);
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
  skillEngine.setMcpManager(mcpManager);
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
      runSkill: (name, input, opts) => skillEngine.runSkill(name, input, opts),
      getRunHistory: (name) => skillEngine.getRunHistory(name) as any,
      hasRunner: (name) => skillEngine.hasRunner(name),
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

  // Waz manager — disposable agent popup windows (.waz command)
  const { WazManager } = await import("./waz-manager");
  wazManager = new WazManager();
  wazManager.setCaptureStore(captureStore);
  wazManager.setWorkspaceGetter(workspaceGetter);
  wazManager.setSkillEngine(skillEngine);

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Cypher bus — canonical message bus for inter-agent communication
  const cypherBus = new CypherBus(
    (wsSlug) => {
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      return map[wsSlug] ?? null;
    },
    eventLog,
  );

  // Track jammer preview panels so we can clean them up on cypher wrap/leave
  const jammerPreviewPanels = new Set<string>();

  // React to local bus events. NOTE: this no longer renders the cypher feed
  // or persists it — the feed is single-sourced from the SSE stream (see
  // setEventObserver). A local agent's post round-trips through the server
  // and renders once, from there, keyed by `seq`. This callback only handles
  // local side-effects: leader-completion detection and preview panels.
  cypherBus.onPost((_wsSlug, event) => {
    // Detect leader completion (no parent) — prompt mistro to wrap
    if (event.kind === "complete_task") {
      const hier = cypherBus.getHierarchyContext();
      if (hier) {
        const sender = hier.get(event.from);
        if (sender && !sender.parentAgentId) {
          const cypherView = panelManager.getView("cypher");
          if (cypherView && !cypherView.webContents.isDestroyed()) {
            cypherView.webContents.send("cypher-leader-done", {
              agentId: event.from,
              agentName: sender.agentId,
              body: event.body,
            });
          }
        }
      }
    }

    // Handle preview_url — create a browser panel for the jammer's URL
    if (event.kind === "preview_url" && event.meta?.url && mainWindow && !mainWindow.isDestroyed()) {
      const url = String(event.meta.url);
      const panelId = `jammer-preview-${event.from}`;
      const title = String(event.meta.title || `Preview: ${event.from}`);
      console.log(`[jammer-preview] opening panel="${panelId}" url="${url}" title="${title}"`);
      if (!panelManager.hasPanel(panelId)) {
        panelManager.addPanel(panelId, url);
      }
      panelManager.switchTo(panelId, mainWindow);
      jammerPreviewPanels.add(panelId);
    }
  });

  agentRunner = new AgentRunner();
  agentRunner.setBus(cypherBus);
  agentRunner.setUsagePoster((cypherId, agentId, inputTokens, outputTokens) => {
    serverPostAuthed(`/api/cyphers/${encodeURIComponent(cypherId)}/events`, {
      kind: "usage",
      by_agent_id: agentId,
      payload: { input_tokens: inputTokens, output_tokens: outputTokens, description: `turn by ${agentId}` },
    }).catch((err) => console.warn("[usage-poster] failed:", err instanceof Error ? err.message : err));
  });
  mcpExpose.setBus(cypherBus);

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});
  session.setOnRawCapture((appId, content) => {
    const ws = getPreference<string>("activeWorkspace", "default");
    captureStore.ingest(appId, content, ws).catch(() => {});
  });

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, skillEngine, session);
  {
    const savedModeRaw = getPreference<string>("agentMode", "default");
    const savedMode = savedModeRaw === "council" ? "council" : savedModeRaw === "cypher" ? "cypher" : getAgentMode();
    yoInterceptor.setAgentMode(savedMode);
    if (savedMode === "council") {
      yoAgent.setCouncilMode(true);
    } else if (savedMode === "cypher") {
      yoAgent.setCypherMode(true);
      yoAgent.setMode("acceptEdits");
    } else {
      yoAgent.setMode(savedMode as any);
    }
  }
  yoInterceptor.setCurrentModel(llmConfig.model);
  // Fetch active models from server and populate the interceptor + presets cache
  void fetchServerModels().then((models) => {
    const names = models.length > 0 ? models.map((m) => m.model) : ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    yoInterceptor.setAvailableModels(names);
  });
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
  const cwWcWorkspace = new Map<number, string>(); // cypher webContents.id → workspace slug

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
    } else if (baseAppId === "cypher") {
      // Cypher workspace: SDK-driven agent runner (not terminal PTYs)
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
      // Activate yo/dip/drip interceptor so command palette works on cypher panel
      yoInterceptor.activate(wc, id);
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
  const councilHtml = `file://${path.join(__dirname, "..", "renderer", "council.html")}`;
  const councilPreload = path.join(__dirname, "council-preload.js");
  const cypherHtml = `file://${path.join(__dirname, "..", "renderer", "cypher.html")}`;
  const cypherPreload = path.join(__dirname, "cypher-preload.js");
  const monacoHtml = `file://${path.join(__dirname, "..", "renderer", "monaco.html")}`;
  const homeHtml = `file://${path.join(__dirname, "..", "renderer", "home.html")}`;
  vscodeServer = new VSCodeServer();
  // VS Code server defaults ON when a `code` binary is found on this machine,
  // OFF otherwise. An explicit user preference always wins over the default.
  const vscodePref = getPreference<boolean | undefined>("enableVscodeServer", undefined);
  const enableVscode = vscodePref ?? vscodeServer.available;
  for (const app of appConnector.list()) {
    if (app.url === "yo://home") {
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      // webviewTag: true so the <webview id="app-preview"> inside App detail can render
      panelManager.addPanel(app.id, homeHtml, homePreload, undefined, true);
    } else if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://council") {
      panelManager.addPanel(app.id, councilHtml, councilPreload);
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

  // Cypher Mode panel — registered statically (not in app-connector)
  panelManager.addPanel("cypher", cypherHtml, cypherPreload);

  // Start VS Code server in the background if enabled and CLI is available
  if (enableVscode && vscodeServer.available) {
    // The embedded editor opens the app-wide working directory.
    vscodeServer.start(getWorkingDirectory()).catch((err) => {
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

  /** Activate the cypher workspace panel (switch to it). */
  function activateCypher(): boolean {
    if (!mainWindow) return false;
    panelManager.switchTo("cypher", mainWindow);
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

  // Wire waz manager dependencies
  wazManager.setSessionCache(session);
  wazManager.setMemoryStore(memoryStore);
  wazManager.setNoteStore(noteStore);


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

  // Give command parser access to panel WebContents for app commands
  commandParser.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Push session state to renderer
  const sendSessionState = () => {
    mainWindow?.webContents.send("session-changed", session.getInfo());
  };

  // Wire command callbacks for interceptor + chat (both need dip routing)
  const callbacks = { openYoPanel: null as ((query: string) => void) | null };

  const execCommand = async (cmd: string, sourcePanelId?: string) => {
    // .waz — spawn a disposable agent popup
    if (/^waz\b/i.test(cmd)) {
      const prompt = cmd.replace(/^waz\s*/i, "").trim();
      wazManager?.spawn(prompt);
      return ".waz spawned";
    }

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
  wazManager.setThemeFn(() => {
    const t = getPreference<string>("theme", "light");
    return t === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t;
  });
  yoInterceptor.setWazSpawner((prompt) => wazManager?.spawn(prompt));
  yoInterceptor.setFaviconsGetter(() => panelFavicons);
  yoInterceptor.setLayoutsGetter(() => layoutManager.listLayouts());

  // Command palette mode/model changers
  yoInterceptor.setModeChanger((mode) => {
    yoAgent.setMode(mode as any);
    setPreference("agentMode", mode);
    mainWindow?.webContents.send("agent-mode-changed", mode);
    yoInterceptor.setAgentMode(mode);
  });
  yoAgent.onModeChange((mode) => {
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
    let lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][]; grid?: import("./layout-manager").GridLayout }>("lastView", null!);
    // Cypher tabs are live sessions, not apps — they never survive a restart.
    // Drop them from the restored tab strip, and if the persisted view itself
    // involved a cypher, land the user on The Drop instead.
    const savedTabs = getPreference<string[]>("openTabs", []).filter(
      (id) => resolveAppId(id) !== "cypher",
    );
    if (lastView) {
      const viewPanelIds: string[] = [];
      if (lastView.id) viewPanelIds.push(lastView.id);
      if (lastView.panels) viewPanelIds.push(...lastView.panels);
      if (lastView.rows) lastView.rows.forEach((r) => viewPanelIds.push(...r));
      if (lastView.grid?.cells) viewPanelIds.push(...lastView.grid.cells.map((c) => c.panelId));
      if (viewPanelIds.some((id) => resolveAppId(id) === "cypher")) {
        lastView = { type: "panel", id: "home" };
      }
    }

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
      if (!id) continue;
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
        layoutManager.apply(lastView.name, mainWindow);
        const grid = layoutManager.getGridInfo();
        if (grid && grid.panelIds.length > 0) {
          panelManager.setInitialActive(grid.panelIds[0]);
        }
      } else if (lastView.type === "panel" && lastView.id) {
        panelManager.switchTo(lastView.id, mainWindow);
      }
    } else if (mainWindow) {
      // No persisted view — open the default app.
      const firstApp = appConnector.list().find(a => a.url && !a.url.startsWith("yo://"));
      panelManager.switchTo(firstApp?.id || "home", mainWindow);
    }

    // Restore all saved tabs (not just those in the current view).
    // Skip code panels — they're managed by the layout restore above, not as standalone tabs.
    for (const id of savedTabs) {
      if (!id) continue;
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

  function resolveAppId(panelId: string | null | undefined): string {
    if (!panelId) return "";
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
    } else if (app.url === "yo://council") {
      panelManager.addPanel(instanceId, councilHtml, councilPreload);
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
  let cypherPanelContext: { cypherId: string; isOwner: boolean; title?: string } | null =
    getPreference<{ cypherId: string; isOwner: boolean; title?: string } | null>("cypherPanelContext", null);

  function getTabName(id: string | null | undefined): string {
    if (!id) return "";
    if (id === "cypher" && cypherPanelContext?.title) return `⚡ ${cypherPanelContext.title}`;
    const app = appConnector.get(id) || appConnector.get(resolveAppId(id));
    return app?.name || id;
  }

  function buildTabState() {
    const visible = getPreference<boolean>("showTabs", true);
    const gridInfo = layoutManager.getGridInfo();
    const suspendedInfo = layoutManager.getSuspendedGridInfo();
    const layoutInfo = gridInfo || suspendedInfo;
    if (layoutInfo) layoutInfo.panelIds = layoutInfo.panelIds.filter(Boolean);
    const hasLayout = layoutInfo && layoutInfo.panelIds.length > 1;
    const isActiveLayout = gridInfo && gridInfo.panelIds.length > 1;

    // Filter stale null entries and deduplicate
    for (let i = openTabs.length - 1; i >= 0; i--) {
      if (!openTabs[i] || openTabs.indexOf(openTabs[i]) !== i) openTabs.splice(i, 1);
    }

    // "home" (Settings) is an on-demand, closable tab — opened only when the
    // user picks a section from the left-rail Settings menu. Not forced here.

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
        { id: layoutTabId, name: layoutName, layoutFavicons },
        ...openTabs.filter((id) => !gridSet.has(id)).map((id) => ({
          id, name: getTabName(id), favicon: panelFavicons[id] || "", url: urlForTab(id),
        })),
      ];
    } else {
      tabs = openTabs.map((id) => ({
        id,
        name: getTabName(id),
        favicon: panelFavicons[id] || "",
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

  function ensureTab(id: string | null | undefined) {
    if (!id) return;
    if (!openTabs.includes(id)) {
      openTabs.push(id);
      persistTabs();
    }
  }

  function persistTabs() {
    setPreference("openTabs", [...new Set(openTabs)]);
  }

  // Panel interaction + layout tools — wired via substrate-deps.ts
  setSubstrateToolDeps(buildSubstrateDeps({
    mainWindow,
    panelManager,
    appConnector,
    workspaceManager,
    yoAgent,
    yoInterceptor,
    openTabs,
    getTabBrowserCounter: () => tabBrowserCounter,
    setTabBrowserCounter: (n) => { tabBrowserCounter = n; },
    ensureTab,
    scanPanel,
    formatScan,
    smartGrab,
    executeCommand,
    browserHtmlUrl,
    councilHtml,
    councilPreload,
    execCommand,
    swarmCreate: runSwarm,
    serverGetAuthed,
    serverPostAuthed,
    fetchServerModels,
    setPreference,
    yoPanelWidth: () => getPreference("yoPanelWidth", 400),
  }));

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

  commandParser.setCypherOpener(async (slug: string) => {
    if (!mainWindow) return false;
    try {
      const r = await serverGetAuthed<{ cypher: { id: string; slug: string } }>(`/api/cyphers/by-slug/${encodeURIComponent(slug)}`);
      if (!r?.cypher?.id) return false;
      const wsSlug = workspaceManager.getActive().slug;
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      setPreference("workspaceCypher", { ...map, [wsSlug]: r.cypher.id });
      cypherPanelContext = { cypherId: r.cypher.id, isOwner: false };
      panelManager.switchTo("cypher", mainWindow);
      return true;
    } catch {
      return false;
    }
  });

  // Account gate — the heartbeat is the authoritative 14-day-trial check.
  // When it reports the trial expired (or the account disabled) we lock the
  // user out of the workspace: hide the panels and raise the lockout overlay
  // in the renderer. Registered BEFORE initAuth so the first heartbeat (fired
  // fire-and-forget inside initAuth) can never slip past us.
  let accountLocked = false;
  setHeartbeatObserver((hb) => {
    const locked = hb.status === "expired" || hb.status === "disabled";
    if (locked === accountLocked) return;
    accountLocked = locked;
    if (locked) {
      if (mainWindow) panelManager.hideActive(mainWindow);
      mainWindow?.webContents.send("account-locked", {
        status: hb.status,
        upgradeUrl: `${PLATFORM_URL}/dashboard/billing`,
      });
    } else {
      mainWindow?.webContents.send("account-unlocked");
    }
  });

  // Lockout overlay's "I've upgraded" button — force a fresh heartbeat. If the
  // account is active again the observer above fires "account-unlocked"; the
  // renderer also uses the returned status to message a still-expired account.
  ipcMain.handle("recheck-account", async () => {
    const hb = await refreshHeartbeat();
    return { status: hb?.status ?? getAuthStatus().status };
  });

  // Initialize auth — restore session, schedule refresh, start heartbeat.
  // Hard 3s timeout so splash never hangs if server is unreachable.
  await Promise.race([initAuth(), new Promise((r) => setTimeout(r, 3000))]);

  // Resume capability publishing if the user had "Offer Usage" on
  void initCapabilities();

  // Forward local swarm bus events to the swarm-view panel as `jammer-activity`.
  // The bus is in-process — this is the single, immediate source for the feed
  // and the agent cards (no server round-trip, no SSE replay, no duplicates).
  const DRIP_MIN_INTERVAL_MS = 1500;
  let lastDripRenderAt = 0;
  cypherBus.onPost((_wsSlug, event) => {
    // Drip effects play as a window-level overlay, not a feed row.
    if (event.kind === "drip") {
      const now = Date.now();
      if (now - lastDripRenderAt >= DRIP_MIN_INTERVAL_MS) {
        lastDripRenderAt = now;
        const recipe = typeof event.meta?.recipe === "string" ? event.meta.recipe : "fireworks";
        try { dripManager?.execute([recipe]); } catch { /* ignore */ }
      }
      return;
    }
    // Everything else → the swarm-view feed + agent cards.
    const cypherView = panelManager.getView("cypher");
    if (cypherView && !cypherView.webContents.isDestroyed()) {
      cypherView.webContents.send("jammer-activity", {
        from: event.from,
        to: event.to,
        kind: event.kind,
        body: event.body,
        tags: event.tags,
        ts: Date.now(),
        meta: event.meta,
      });
    }
  });

  // Sync all joinable agents to server on boot (fire-and-forget)
  if (isAuthenticated()) void syncAllAgents(listAgents());

  // ── Register cypher-panel IPC handlers BEFORE restorePanels ──
  // (The cypher panel calls these during init; if they're not yet registered
  //  we get "No handler registered" errors.)
  if (!ipcMain.listenerCount("cypher-workspace-path")) {
    ipcMain.handle("cypher-workspace-path", (_e, cypherId: string) => {
      const base = path.join(os.homedir(), ".yo", "cyphers", cypherId, "jammers");
      try { if (fs.existsSync(base)) return base; } catch {}
      return null;
    });
  }
  if (!ipcMain.listenerCount("cypher-list-dir")) {
    ipcMain.handle("cypher-list-dir", (_e, dirPath: string) => {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
      } catch { return []; }
    });
  }
  if (!ipcMain.listenerCount("cypher-read-file")) {
    ipcMain.handle("cypher-read-file", (_e, filePath: string) => {
      try {
        const buf = fs.readFileSync(filePath);
        const isBinary = buf.includes(0);
        if (isBinary) return { content: buf.toString("base64"), binary: true };
        return { content: buf.toString("utf-8"), binary: false };
      } catch { return { content: "", binary: false }; }
    });
  }
  // .Yo Editor app (yo://files) — folder explorer + Monaco + read-only git.
  if (!ipcMain.listenerCount("files:pick-folder")) registerFilesIpc();

  // Lexical code index — code_search over the working directory.
  if (!ipcMain.listenerCount("code-index:status")) {
    registerCodeIndexIpc({ getWorkingDir: getWorkingDirectory });
  }

  // Working directory — the single project folder the app is focused on.
  if (!ipcMain.listenerCount("working-dir:get")) {
    registerWorkingDirectoryIpc({
      getMainWindow: () => mainWindow,
      broadcastToPanels: (ch, ...args) => {
        for (const wc of panelManager.getAllWebContents()) {
          try { wc.send(ch, ...args); } catch { /* ignore */ }
        }
      },
      onWorkingDirChange: (dir) => {
        // Re-point the running VS Code panel at the new folder.
        if (enableVscode && vscodeServer.available) {
          const v = panelManager.getView("vscode");
          if (v && !v.webContents.isDestroyed()) {
            v.webContents.loadURL(`${VSCodeServer.expectedUrl()}/?folder=${encodeURIComponent(dir)}`);
          }
        }
      },
    });
  }

  if (!ipcMain.listenerCount("cypher-gh-tree")) {
    ipcMain.handle("cypher-gh-tree", async () => {
      return mcpExpose?.getRepoTree() ?? null;
    });
  }
  if (!ipcMain.listenerCount("cypher-gh-file")) {
    ipcMain.handle("cypher-gh-file", async (_e, filePath: string) => {
      return mcpExpose?.getRepoFile(filePath) ?? null;
    });
  }
  if (!ipcMain.listenerCount("cypher-project-info")) {
    ipcMain.handle("cypher-project-info", async (_e, cypherId: string) => {
      try {
        const r = await serverGetAuthed<{ project?: { gh_project_url?: string }; linked_repos?: string[] }>(
          `/api/projects/by-cypher/${encodeURIComponent(cypherId)}`,
        );
        return {
          gh_project_url: (r as any)?.project?.gh_project_url || null,
          linked_repos: (r as any)?.linked_repos || [],
        };
      } catch { return null; }
    });
  }
  if (!ipcMain.listenerCount("cypher-project-board")) {
    ipcMain.handle("cypher-project-board", async (_e, cypherId: string) => {
      try {
        const r = await serverGetAuthed<{ project?: { id: string }; items?: Array<{ id: string; title: string; status: string; assignee_user_id?: string; pr_url?: string | null }> }>(
          `/api/projects/by-cypher/${encodeURIComponent(cypherId)}?with=items`,
        );
        return { items: (r as any)?.items || [] };
      } catch { return { items: [] }; }
    });
  }
  if (!ipcMain.listenerCount("cypher-item-detail")) {
    ipcMain.handle("cypher-item-detail", async (_e, cypherId: string, itemId: string) => {
      try {
        const projR = await serverGetAuthed<{ project?: { slug: string } }>(`/api/projects/by-cypher/${encodeURIComponent(cypherId)}`);
        const slug = projR?.project?.slug;
        if (!slug) return null;
        return await serverGetAuthed(`/api/projects/${encodeURIComponent(slug)}/items/${encodeURIComponent(itemId)}/detail`);
      } catch { return null; }
    });
  }
  if (!ipcMain.listenerCount("cypher-open-vscode")) {
    ipcMain.on("cypher-open-vscode", (_e, filePath: string) => {
      const { exec } = require("child_process") as typeof import("child_process");
      exec(`code "${filePath}"`);
    });
  }
  if (!ipcMain.listenerCount("cypher-open-jammer-preview")) {
    ipcMain.on("cypher-open-jammer-preview", (_e, agentId: string, url: string) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const panelId = `jammer-preview-${agentId}`;
      if (!panelManager.hasPanel(panelId)) {
        panelManager.addPanel(panelId, url);
      }
      panelManager.switchTo(panelId, mainWindow);
      jammerPreviewPanels.add(panelId);
    });
  }
  if (!ipcMain.listenerCount("get-preference")) {
    ipcMain.handle("get-preference", (_e, key: string, defaultVal: unknown) => {
      return getPreference(key, defaultVal);
    });
  }
  if (!ipcMain.listenerCount("tab-list")) {
    ipcMain.handle("tab-list", () => {
      return buildTabState();
    });
  }

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

    // Cyphers are always closed on exit — no restore needed.
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

  // macOS has no install-on-quit — electron-updater's MacUpdater extends
  // AppUpdater, not BaseUpdater, so autoInstallOnAppQuit is a no-op there.
  // A downloaded update only applies when quitAndInstall() runs. Without
  // that the app re-downloads the same update every launch and never moves
  // off the old version (the "stuck downloading" loop). We auto-install a
  // downloaded update during boot, bounded to ONE attempt per version so a
  // failing install can never loop forever.
  const appStartedAt = Date.now();
  const updateAttempt = getPreference<{ version: string; tried: boolean } | null>(
    "pendingUpdateInstall",
    null,
  );
  // If a prior attempt's version is now <= the running version, the update
  // applied (or was surpassed) — clear the marker. If it's still newer the
  // install failed; keep the marker so we don't re-attempt that exact version.
  if (updateAttempt && !isNewerVersion(updateAttempt.version, app.getVersion())) {
    setPreference("pendingUpdateInstall", null);
  }

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
    if (!autoUpdateEnabled) return;
    // Don't re-attempt the exact version whose install already failed —
    // leave the in-app "restart to update" button as the manual fallback.
    if (updateAttempt?.tried && updateAttempt.version === info.version) return;
    // Only auto-restart while still near boot, so we don't yank the app out
    // from under someone mid-session. Past the window, the manual button
    // (and the next launch) still apply it.
    if (Date.now() - appStartedAt > 10 * 60 * 1000) return;
    setPreference("pendingUpdateInstall", { version: info.version, tried: true });
    // Let the splash paint "Update ready" before we restart into the update.
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        console.error("[auto-update] quitAndInstall failed:", err);
      }
    }, 1500);
  });

  autoUpdater.on("update-not-available", () => {
    // Lets the boot-gate stop holding the splash — nothing to wait for.
    mainWindow?.webContents.send("update-status", { status: "none" });
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("[auto-update] error:", err.message);
    mainWindow?.webContents.send("update-status", {
      status: "error",
      error: err.message,
    });
  });

  if (autoUpdateEnabled) {
    // Check early (small settle delay only) so that if an update is available
    // its download is surfaced on the splash — the boot-gate holds the loading
    // screen and shows a progress bar while an update is in flight.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 800);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } else {
    // Auto-update off — tell the splash there's nothing to wait for.
    mainWindow?.webContents.send("update-status", { status: "none" });
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
    // `checkForUpdates()` always resolves with the feed's *latest* version —
    // even when it equals the version we're running. Returning that blindly
    // makes the UI show "Downloading v<current>…" forever (nothing actually
    // downloads). Only report a version that is genuinely newer.
    try {
      autoUpdater.autoDownload = true;
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (latest && isNewerVersion(latest, app.getVersion())) return latest;
      return null;
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

    // Route dot-commands (.dip, .drip, .sup) through command parser
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

      // Cypher chat commands — only active during cypher mode
      if (yoAgent.isCypherMode() && firstWord && ["chat", "to", "leaders", "all", "workers"].includes(firstWord)) {
        const { getCurrentCypher: getCy } = require("./current-cypher") as { getCurrentCypher: () => string | null };
        const cyId = getCy();
        if (!cyId) { mainWindow?.webContents.send("yo-panel-error", "No active cypher"); return; }
        const account = getAccountInfo();
        const senderName = account?.firstName || "mistro";
        const rest = trimmed.slice(1 + firstWord.length).trim();

        if (firstWord === "chat") {
          if (!rest) { mainWindow?.webContents.send("yo-panel-error", "Usage: .chat <message>"); return; }
          // Chat posts to the local bus → renders in the swarm-view feed.
          void cypherBus.post(workspaceManager.getActiveSlug(), {
            from: senderName,
            kind: "chat",
            body: rest,
          });
          mainWindow?.webContents.send("yo-panel-done", "");
          return;
        }

        const wsSlug = workspaceManager.getActiveSlug();
        const hier = cypherBus.getHierarchyContext();

        if (firstWord === "to") {
          const parts = rest.split(/\s+/);
          const targetId = parts[0];
          const msg = parts.slice(1).join(" ");
          if (!targetId || !msg) { mainWindow?.webContents.send("yo-panel-error", "Usage: .to <agent_id> <message>"); return; }
          cypherBus.post(wsSlug, { from: "user", to: targetId, kind: "post_to", body: msg });
          mainWindow?.webContents.send("yo-panel-done", `Sent to ${targetId}`);
          return;
        }

        if (firstWord === "leaders" && hier) {
          if (!rest) { mainWindow?.webContents.send("yo-panel-error", "Usage: .leaders <message>"); return; }
          for (const [id, entry] of hier) {
            if (!entry.parentAgentId) {
              cypherBus.post(wsSlug, { from: "user", to: id, kind: "post_to", body: rest });
            }
          }
          mainWindow?.webContents.send("yo-panel-done", "Sent to leaders");
          return;
        }

        if (firstWord === "workers" && hier) {
          if (!rest) { mainWindow?.webContents.send("yo-panel-error", "Usage: .workers <message>"); return; }
          for (const [id, entry] of hier) {
            if (entry.parentAgentId) {
              cypherBus.post(wsSlug, { from: "user", to: id, kind: "post_to", body: rest });
            }
          }
          mainWindow?.webContents.send("yo-panel-done", "Sent to workers");
          return;
        }

        if (firstWord === "all") {
          if (!rest) { mainWindow?.webContents.send("yo-panel-error", "Usage: .all <message>"); return; }
          cypherBus.post(wsSlug, { from: "user", kind: "post", body: rest, tags: ["broadcast"] });
          mainWindow?.webContents.send("yo-panel-done", "Broadcast sent");
          return;
        }

        mainWindow?.webContents.send("yo-panel-done", "");
        return;
      }
    }

    const wc = mainWindow?.webContents;
    if (!wc || mainWindow!.isDestroyed()) return;

    // Everything goes to the yo agent (in cypher mode it has orchestration tools)
    const { getCurrentCypher: getCy } = require("./current-cypher") as { getCurrentCypher: () => string | null };
    const activeCypherId = yoAgent.isCypherMode() ? getCy() : null;
    yoAgent.send(trimmed, {
      onText: (delta) => {
        wc.send("yo-panel-token", delta);
        if (activeCypherId) threadStore.appendStage(activeCypherId, { ts: Date.now(), kind: "text", content: delta });
      },
      onToolUse: (id, name, input) => {
        wc.send("yo-panel-tool-use", id, name, input);
        if (activeCypherId) {
          threadStore.appendStage(activeCypherId, { ts: Date.now(), kind: "tool", content: JSON.stringify(input).slice(0, 200), toolId: id, toolName: name });
          // Three-layer model: the leader is a participant too. Publish the
          // maestro's tool activity to the cypher feed (sanitized label only,
          // never output) so jammers see how the DJ runs the cypher. Raw tool
          // results stay in the private yo panel.
          void cypherBus.post(workspaceManager.getActiveSlug(), {
            from: CYPHER_MAESTRO_AGENT,
            kind: "agent_tool_use",
            body: summarizeToolInput(name, input),
            meta: { tool_name: name },
          });
        }
        // Reveal the file the agent is touching: VS Code first (via the Yo
        // Bridge extension — no reload), Monaco .Yo Editor as the fallback.
        const fp = fileFromToolCall(name, input);
        if (fp) revealFileInEditor(fp);
      },
      onToolResult: (id, detail) => {
        wc.send("yo-panel-tool-result", id, detail);
        // Tool RESULTS are the private layer — they may contain file contents
        // or command output. They go to the local thread store only, never
        // the shared feed.
        if (activeCypherId) threadStore.appendStage(activeCypherId, { ts: Date.now(), kind: "tool-result", content: detail.slice(0, 500), toolId: id });
      },
      onToolProgress: (id, status) => wc.send("yo-panel-tool-progress", id, status),
      onDone: (fullText) => {
        wc.send("yo-panel-done", fullText);
        if (activeCypherId) {
          threadStore.appendStage(activeCypherId, { ts: Date.now(), kind: "done", content: "" });
          // Publish the maestro's turn narration to the feed (redacted, capped).
          if (fullText && fullText.trim()) {
            void cypherBus.post(workspaceManager.getActiveSlug(), {
              from: CYPHER_MAESTRO_AGENT,
              kind: "agent_thinking",
              body: redactSecrets(fullText.slice(0, 500)),
            });
          }
        }
      },
      onError: (err) => wc.send("yo-panel-error", err),
    });
  });

  ipcMain.on("yo-panel-stop", () => {
    yoAgent.abort();
  });

  // Reveal a file in the active editor surface — used to mirror the agent's
  // file activity. VS Code first (once its panel exists, via the Yo Bridge
  // extension — no reload); otherwise the Monaco .Yo Editor if it's open.
  // Non-intrusive: never creates or switches a panel.
  function revealFileInEditor(fp: string): void {
    const monacoMirror = () => {
      if (openTabs.some((t) => resolveAppId(t) === "files")) {
        panelManager.getView("files")?.webContents.send("files:external-open", fp);
      }
    };
    if (enableVscode && vscodeServer.available && panelManager.hasPanel("vscode")) {
      void openInVscode(fp).then((ok) => { if (!ok) monacoMirror(); });
      return;
    }
    monacoMirror();
  }

  // Open a file in the .Yo Editor (from a clickable file link in the yo panel).
  ipcMain.on("open-in-editor", (_e, filePath: string) => {
    if (!mainWindow || typeof filePath !== "string" || !filePath) return;
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(os.homedir(), "yo", filePath);
    const filesApp = appConnector.get("files");
    if (filesApp && !panelManager.hasPanel("files")) createPanelForApp("files", filesApp);
    ensureTab("files");
    panelManager.switchTo("files", mainWindow);
    sendSplitState();
    sendTabState();
    panelManager.getView("files")?.webContents.send("files:external-open", resolved);
  });

  // File-open router — the files left rail (or anything else) emits a path;
  // route it to the app that handles its type. Code/text → VS Code when the
  // server is enabled, else the Monaco .Yo Editor. PDFs / images / media →
  // a browser tab. Everything else → the .Yo Editor.
  const BROWSER_EXTS = new Set([
    "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico",
    "mp4", "webm", "mov", "mp3", "wav", "htm", "html",
  ]);
  ipcMain.on("file-open", (_e, filePath: string) => {
    if (!mainWindow || typeof filePath !== "string" || !filePath) return;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(getWorkingDirectory(), filePath);
    const ext = path.extname(resolved).slice(1).toLowerCase();

    // Media → a fresh browser tab.
    if (BROWSER_EXTS.has(ext)) {
      tabBrowserCounter++;
      const id = `browse-${tabBrowserCounter}`;
      panelManager.addPanel(id, browserHtmlUrl(`file://${resolved}`), undefined, undefined, true);
      panelManager.switchTo(id, mainWindow);
      ensureTab(id);
      sendSplitState();
      sendTabState();
      return;
    }

    // Code/text → VS Code panel when the server is enabled and available.
    if (enableVscode && vscodeServer.available) {
      const vscodeApp = appConnector.get("vscode");
      if (vscodeApp) {
        if (!panelManager.hasPanel("vscode")) createPanelForApp("vscode", vscodeApp);
        ensureTab("vscode");
        panelManager.switchTo("vscode", mainWindow);
        sendSplitState();
        sendTabState();
        // Open the exact file via the Yo Bridge extension (no reload).
        void openInVscode(resolved);
        return;
      }
    }

    // Fallback → the Monaco .Yo Editor.
    const filesApp = appConnector.get("files");
    if (filesApp && !panelManager.hasPanel("files")) createPanelForApp("files", filesApp);
    ensureTab("files");
    panelManager.switchTo("files", mainWindow);
    sendSplitState();
    sendTabState();
    panelManager.getView("files")?.webContents.send("files:external-open", resolved);
  });

  // Left-rail nav → open the Settings (home) panel at a given section.
  // `pendingHomeSection` covers the cold-start race: the home page grabs it
  // on load via `home:get-pending-section`; the live event handles the rest.
  let pendingHomeSection: { section: string; sub?: string } | null = null;
  ipcMain.on("open-home-section", (_e, section: string, sub?: string) => {
    if (!mainWindow || typeof section !== "string") return;
    pendingHomeSection = { section, sub };
    const homeApp = appConnector.get("home");
    if (homeApp && !panelManager.hasPanel("home")) createPanelForApp("home", homeApp);
    ensureTab("home");
    panelManager.switchTo("home", mainWindow);
    sendSplitState();
    sendTabState();
    panelManager.getView("home")?.webContents.send("home:goto-section", section, sub);
  });
  ipcMain.handle("home:get-pending-section", () => pendingHomeSection);

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
    if (yoAgent.isCypherMode()) {
      // Silently keep the panel open — re-open if somehow closed
      mainWindow?.webContents.send("yo-panel-open", "");
      return;
    }
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

  // IPC: Files left rail resize + width persistence
  ipcMain.on("files-rail-resize", (_e, width: number) => {
    panelManager.setLeftInset(width);
  });
  ipcMain.on("files-rail-width-save", (_e, width: number) => {
    setPreference("filesRailWidth", width);
  });
  ipcMain.handle("files-rail-get-width", () => {
    return getPreference<number>("filesRailWidth", 240);
  });

  // IPC: Agent mode + guardrails
  ipcMain.handle("get-agent-mode", () => {
    if (yoAgent.isCouncilMode()) return "council";
    if (yoAgent.isCypherMode()) return "cypher";
    return yoAgent.getMode();
  });
  ipcMain.on("set-agent-mode", (_e, mode: string) => {
    // "council" is a behavioral overlay, independent of the SDK permissionMode.
    // The renderer sends "council" to flip the flag, then immediately sends
    // the perm value (default/acceptEdits/bypassPermissions) which sets the
    // SDK mode without clearing the council flag.
    if (mode === "council") {
      yoAgent.setCouncilMode(true);
      yoAgent.setMode("default" as any);
      yoAgent.clear();
      setPreference("agentMode", "council");
      mainWindow?.webContents.send("agent-mode-changed", "council");
      yoInterceptor.setAgentMode("council");
      return;
    }
    if (mode === "exit-council") {
      yoAgent.setCouncilMode(false);
      yoAgent.clear();
      return;
    }
    if (mode === "exit-cypher") {
      yoAgent.setCypherMode(false);
      yoAgent.clear();
      return;
    }
    if (mode === "cypher") {
      yoAgent.setCypherMode(true);
      yoAgent.setMode("default" as any);
      yoAgent.clear();
      setPreference("agentMode", "cypher");
      mainWindow?.webContents.send("agent-mode-changed", "cypher");
      yoInterceptor.setAgentMode("cypher");
      return;
    }
    yoAgent.setMode(mode as any);
    if (!yoAgent.isCouncilMode() && !yoAgent.isCypherMode()) {
      setPreference("agentMode", mode);
    }
    const effectiveMode = yoAgent.isCypherMode() ? "cypher" : yoAgent.isCouncilMode() ? "council" : mode;
    mainWindow?.webContents.send("agent-mode-changed", effectiveMode);
    yoInterceptor.setAgentMode(effectiveMode);
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


  // ── Extracted IPC modules ──────────────────────────────
  registerSettingsIpc({
    getPreference, setPreference, getCurrentLimits, broadcastTheme,
    serverGetAuthed, startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    llmConfig, saveLLMConfig, applyLLMConfig, fetchServerModels,
    mcpExpose: mcpExpose!, session, sendSessionState,
    providerKeys: providerKeysModule, ccBootstrapStatus, spawnCcLogin,
    transcriber, cloudSyncInstance, execCommand,
    getMainWindow: () => mainWindow, panelManager, yoAgent,
  });

  registerSkillsIpc({ skillEngine, mcpManager, appConnector, skillScheduler, canCreateSkill, listBuiltinYoTools });

  registerAppsIpc({
    appConnector, layoutManager, dripManager, panelManager,
    canAddApp, canSaveLayout,
    getMainWindow: () => mainWindow,
    PICKER_SCRIPT,
  });

  registerCapturesIpc({
    captureStore, workspaceManager, panelManager,
    resolveAppId,
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


  registerMarketplaceIpc({
    serverGetAuthed, serverPostAuthed,
    listAgents, getAgent, saveAgent, removeAgent, idAvailable,
    pushAgentProfile, deleteAgentProfile,
    setOfferEnabled, getCapabilitiesStatus,
  });

  // Settings / home panel IPC — dashboard, MCP servers, connectors, prompts.
  registerHomeIpc({
    mcpExpose: mcpExpose!, mcpManager, connectorManager, canUseMcp,
    usageTracker, promptLog, llmConfig,
    panelManager, getMainWindow: () => mainWindow, activeReminders,
  });

  // ── Local swarm session (cypher-session.ts) ──────────────────────
  const { spawnSwarm } = createCypherSession({
    agentRunner,
    workspaceManager,
    mcpExpose: mcpExpose!,
    cypherBus,
    getAgent,
  });

  // runSwarm — the single entry shared by the create_swarm substrate tool
  // (the yo agent) and mcp-expose. Resolves a roster, drafts a manifest,
  // opens the swarm panel, spawns locally; returns a human status line.
  async function runSwarm(goal: string, agentIds?: string[], size?: number): Promise<string> {
    const g = (goal || "").trim();
    if (!g) return "A goal is required.";
    const library = listAgents();
    if (library.length === 0) {
      return "No agents in the library yet — create some in the Agents tab first.";
    }
    let roster: string[];
    if (agentIds && agentIds.length > 0) {
      const missing = agentIds.filter((id) => !library.some((a) => a.id === id));
      if (missing.length > 0) return `Unknown agent id(s): ${missing.join(", ")}.`;
      roster = agentIds;
    } else {
      const n = Math.max(1, Math.min(library.length, size || 3));
      roster = library.slice(0, n).map((a) => a.id);
    }
    const { draftSwarm } = await import("./swarm-draft");
    const manifest = draftSwarm({ goal: g, workspace: workspaceManager.getActive().slug, agentIds: roster });
    if (mainWindow) panelManager.switchTo("cypher", mainWindow);
    const wc = panelManager.getView("cypher")?.webContents;
    if (!wc || wc.isDestroyed()) return "Swarm panel unavailable.";
    const res = await spawnSwarm(manifest, wc);
    if (!res.ok) return `Swarm failed to start: ${res.error || "unknown error"}`;
    return `Swarm started — ${res.spawned ?? 0} agent(s): ${roster.join(", ")}. `
      + `The leader decomposes the goal and assigns work over the bus; watch the swarm panel.`;
  }

  mcpExpose!.setSwarmRunner(runSwarm);

  ipcMain.on("cypher-panel-leave", () => {
    cypherPanelContext = null;
    setPreference("cypherPanelContext", null);
    yoAgent.setCypherMode(false);
    setPreference("agentMode", "default");
    mainWindow?.webContents.send("agent-mode-changed", "standard");
    yoInterceptor.setAgentMode("default");
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const pid of jammerPreviewPanels) {
        panelManager.closePanel(pid, mainWindow);
      }
    }
    jammerPreviewPanels.clear();
    const idx = openTabs.indexOf("cypher");
    if (idx !== -1) { openTabs.splice(idx, 1); persistTabs(); }
    if (mainWindow) panelManager.switchTo("home", mainWindow);
    sendTabState();
  });

  ipcMain.handle("cypher-thread-load-agent", (_e, cypherId: string, agentName: string) => {
    return threadStore.loadAgent(cypherId, agentName);
  });

  ipcMain.handle("cypher-feed-load", (_e, cypherId: string, limit?: number) => {
    return threadStore.loadFeed(cypherId, limit ?? 200);
  });

  ipcMain.handle("cypher-thread-list-agents", (_e, cypherId: string) => {
    return threadStore.listAgentThreads(cypherId);
  });

  // Billing/account managed via web dashboard — no client-side checkout needed

  // IPC: cypher workspace — agents come from the user's Agents registry
  ipcMain.handle("cw:get-agents", () => {
    return listAgents().map((a) => ({
      name: a.id,
      role: a.role || a.name || "agent",
      prompt: a.systemPrompt,
    }));
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
  function buildAgentConfig(wsSlug: string, agentId: string): AgentConfig | null {
    const agent = getAgent(agentId);
    if (!agent) return null;
    const ws = workspaceManager.get(wsSlug);
    if (!ws) return null;
    const map = getPreference<Record<string, string>>("workspaceCypher", {});
    const cypherId = map[wsSlug] || undefined;
    const role = agent.role || "agent";
    const startPrompt = cypherId
      ? `You are agent "${agent.id}" (${role}). Read .yo/agents/${agent.id}.md for your role briefing. Messages from teammates arrive automatically. Say "Ready" and wait for instructions.`
      : `You are agent "${agent.id}" (${role}). Read .yo/agents/${agent.id}.md for your role briefing. Then check .yo/inbox/${agent.id}.md for pending tasks. If the inbox is empty or doesn't exist, say "Ready" and wait for instructions.`;
    return {
      name: agent.id,
      role,
      cwd: ws.rootDir,
      prompt: agent.systemPrompt,
      startPrompt,
      workspace: wsSlug,
      cypherId,
      model: agent.model_name,
      modelProvider: agent.model_provider,
      guardrails: agent.guardrails,
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

  // ── Cypher binding (workspace slug → cypher id) ──────────

  function getActiveCypherId(): string | undefined {
    const wsSlug = workspaceManager.getActive().slug;
    const map = getPreference<Record<string, string>>("workspaceCypher", {});
    return map[wsSlug] || undefined;
  }

  ipcMain.handle("cw:cypher-status", async () => {
    const wsSlug = workspaceManager.getActive().slug;
    const cypherId = getActiveCypherId();
    if (!cypherId) return { associated: false, layout_name: wsSlug };
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
        associated: true, layout_name: wsSlug,
        cypher_id: r.cypher.id, slug: r.cypher.slug, title: r.cypher.title,
        status: r.cypher.status, type: r.cypher.type,
        kitty: r.kitty_balance, jammers,
      };
    } catch (err) {
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      const next = { ...map };
      delete next[wsSlug];
      setPreference("workspaceCypher", next);
      return { associated: false, layout_name: wsSlug, error: err instanceof Error ? err.message : "fetch failed" };
    }
  });

  ipcMain.handle("cw:cypher-create-and-publish", async (_e, input: Record<string, unknown>) => {
    const wsSlug = workspaceManager.getActive().slug;
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
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      setPreference("workspaceCypher", { ...map, [wsSlug]: cypherId });
      return { ok: true, cypher: pub.cypher, kitty_balance: pub.kitty_balance };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "publish failed" };
    }
  });

  ipcMain.handle("cw:cypher-disassociate", async () => {
    const wsSlug = workspaceManager.getActive().slug;
    const map = getPreference<Record<string, string>>("workspaceCypher", {});
    const next = { ...map };
    delete next[wsSlug];
    setPreference("workspaceCypher", next);
    return { ok: true };
  });

  // IPC: tabs + URL bar (extracted to tab-ipc.ts)
  registerTabIpc({
    panelManager, layoutManager, appConnector,
    yoAgent, yoInterceptor, agentRunner,
    getMainWindow: () => mainWindow,
    openTabs,
    tabBrowserCounter: { get value() { return tabBrowserCounter; }, set value(v) { tabBrowserCounter = v; } },
    panelInstanceCounter: { get value() { return panelInstanceCounter; }, set value(v) { panelInstanceCounter = v; } },
    panelNavWc,
    cypherPanelContext: { get: () => cypherPanelContext },
    resolveAppId, resolveBrowserHome, browserHtmlUrl,
    ensureTab, persistTabs, sendSplitState, sendTabState,
    openYoPanel, createPanelForApp,
    setPreference, getPreference,
    URL_BAR_HEIGHT,
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
  // (get-preference IPC registered earlier, before restorePanels)

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
  function sendBoot() {
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
  }

  mainWindow?.webContents.on("did-finish-load", sendBoot);
  if (!mainWindow?.webContents.isLoading()) sendBoot();
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
  try {
    setPreference("cypherPanelContext", null);
    setPreference("agentMode", "default");
    const tabs = getPreference<string[]>("openTabs", []);
    if (tabs.includes("cypher")) {
      setPreference("openTabs", tabs.filter((t: string) => t !== "cypher"));
    }
  } catch {}
  voiceRelay?.stop();
  cloudSyncInstance?.stop();
  cloudSyncInstance = null;
  usageQueue.stop();
  configSync?.stop();
  configSync = null;
  terminalManager?.killAll();
  wazManager?.closeAll();
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
