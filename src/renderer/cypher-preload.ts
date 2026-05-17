import { contextBridge, ipcRenderer } from "electron";

interface CypherPanelAPI {
  // Identity
  authMe: () => Promise<{ id?: string; email?: string; handle?: string; error?: string }>;

  // Cypher data
  cypherGet: (id: string) => Promise<unknown>;
  cypherJammers: (id: string, opts?: { limit?: number; offset?: number }) => Promise<unknown>;
  cypherEventsList: (id: string, opts?: { since?: number; limit?: number }) => Promise<unknown>;
  cypherCoverGet: (id: string) => Promise<{ ok: boolean; data_base64?: string; content_type?: string }>;

  // Agent control (owner only)
  agentStart: (agentName: string) => void;
  agentStop: (agentName: string) => void;
  agentSend: (agentName: string, message: string) => void;
  cypherSpawnJammers: (id: string) => Promise<unknown>;
  cypherWrap: (id: string) => Promise<unknown>;

  // Chat / drips
  cypherPostEvent: (id: string, kind: string, payload: Record<string, unknown>, jamId?: string, byAgentId?: string) => Promise<unknown>;

  // Live event streams
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;
  onAgentMessage: (cb: (agentName: string, msg: Record<string, unknown>) => void) => () => void;
  onAgentStatus: (cb: (agentName: string, status: string) => void) => () => void;

  // Theme
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;

  // Panel context — which cypher to open (set by main before panel loads)
  getCypherContext: () => Promise<{ cypherId: string; isOwner: boolean } | null>;

  // Leave cypher — close tab, switch to drop
  leaveCypher: () => void;

  // Thread persistence
  loadAgentThread: (cypherId: string, agentName: string) => Promise<Array<{ ts: number; kind: string; content: string }>>;
  listAgentThreads: (cypherId: string) => Promise<string[]>;
  loadFeed: (cypherId: string, limit?: number) => Promise<Array<{ ts: number; from: string; kind: string; body: string; tags?: string[] }>>;

  // File system (host/jammer — local files)
  listDir: (dirPath: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  readFile: (filePath: string) => Promise<{ content: string; binary: boolean }>;
  getCypherWorkspacePath: (cypherId: string) => Promise<string | null>;

  // GitHub repo files
  ghTree: () => Promise<Array<{ path: string; type: string; size?: number }> | null>;
  ghFile: (filePath: string) => Promise<{ content: string; binary: boolean } | null>;

  // Project info (repo URL, linked repos)
  projectInfo: (cypherId: string) => Promise<{
    gh_project_url: string | null;
    linked_repos: string[];
  } | null>;

  // Project board
  projectBoard: (cypherId: string) => Promise<{
    items: Array<{ id: string; title: string; status: string; assignee?: string; pr_url?: string | null }>;
  }>;
  itemDetail: (cypherId: string, itemId: string) => Promise<{
    number: number;
    title: string;
    body: string | null;
    status: string | null;
    assignees: string[];
    url: string;
    state: string;
    labels: string[];
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    comments: Array<{
      id: number;
      user: string;
      avatar_url: string;
      body: string;
      created_at: string;
      updated_at: string;
    }>;
  } | null>;
  onProjectItemUpdate: (cb: (item: { id: string; title?: string; status?: string; assignee?: string }) => void) => () => void;

  // Open in VS Code
  openInVSCode: (filePath: string) => void;

  // Jammer activity feed (from CypherBus)
  onJammerActivity: (cb: (event: { cypherId?: string; seq?: number; from: string; to?: string; kind: string; body: string; tags?: string[]; ts: number; meta?: Record<string, unknown> }) => void) => () => void;

  // Leader completion — prompt mistro to wrap
  onLeaderDone: (cb: (info: { agentId: string; agentName: string; body: string }) => void) => () => void;

  // Open external URL in default browser
  openExternal: (url: string) => void;

  // Jammer preview navigation
  openJammerPreview: (agentId: string, url: string) => void;

  // Drip effects
  dripsPreview: (recipe: string) => Promise<string>;

  // Fired when context changes (panel should re-init)
  onContextReady: (cb: () => void) => () => void;
}

const api: CypherPanelAPI = {
  authMe: () => ipcRenderer.invoke("auth-me"),
  cypherGet: (id) => ipcRenderer.invoke("cypher-get", id),
  cypherJammers: (id, opts) => ipcRenderer.invoke("cypher-jammers", id, opts),
  cypherEventsList: (id, opts) => ipcRenderer.invoke("cypher-events-list", id, opts),
  cypherCoverGet: (id) => ipcRenderer.invoke("cypher-cover-get", id),

  agentStart: (name) => ipcRenderer.send("cw:agent:start", name),
  agentStop: (name) => ipcRenderer.send("cw:agent:stop", name),
  agentSend: (name, message) => ipcRenderer.send("cw:agent:send", name, message),
  cypherSpawnJammers: (id) => ipcRenderer.invoke("cypher-spawn-jammers", id),
  cypherWrap: (id) => ipcRenderer.invoke("cypher-wrap", id),

  cypherPostEvent: (id, kind, payload, jamId, byAgentId) =>
    ipcRenderer.invoke("cypher-event-post", id, kind, payload, jamId, byAgentId),

  onCypherEvent: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, cypherId: string, kind: string, payload: Record<string, unknown>) =>
      cb(cypherId, kind, payload);
    ipcRenderer.on("cypher-event", handler);
    return () => { ipcRenderer.removeListener("cypher-event", handler); };
  },
  onAgentMessage: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, agentName: string, msg: Record<string, unknown>) =>
      cb(agentName, msg);
    ipcRenderer.on("cw:agent:message", handler);
    return () => { ipcRenderer.removeListener("cw:agent:message", handler); };
  },
  onAgentStatus: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, agentName: string, status: string) =>
      cb(agentName, status);
    ipcRenderer.on("cw:agent:status", handler);
    return () => { ipcRenderer.removeListener("cw:agent:status", handler); };
  },

  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },

  getCypherContext: () => ipcRenderer.invoke("cypher-panel-context"),

  leaveCypher: () => ipcRenderer.send("cypher-panel-leave"),

  loadAgentThread: (cypherId: string, agentName: string) => ipcRenderer.invoke("cypher-thread-load-agent", cypherId, agentName),
  listAgentThreads: (cypherId: string) => ipcRenderer.invoke("cypher-thread-list-agents", cypherId),
  loadFeed: (cypherId, limit) => ipcRenderer.invoke("cypher-feed-load", cypherId, limit),

  listDir: (dirPath) => ipcRenderer.invoke("cypher-list-dir", dirPath),
  readFile: (filePath) => ipcRenderer.invoke("cypher-read-file", filePath),
  getCypherWorkspacePath: (cypherId) => ipcRenderer.invoke("cypher-workspace-path", cypherId),

  ghTree: () => ipcRenderer.invoke("cypher-gh-tree"),
  ghFile: (filePath) => ipcRenderer.invoke("cypher-gh-file", filePath),

  projectInfo: (cypherId) => ipcRenderer.invoke("cypher-project-info", cypherId),
  projectBoard: (cypherId) => ipcRenderer.invoke("cypher-project-board", cypherId),
  itemDetail: (cypherId, itemId) => ipcRenderer.invoke("cypher-item-detail", cypherId, itemId),
  onProjectItemUpdate: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, item: { id: string; title: string; status: string; assignee?: string }) =>
      cb(item);
    ipcRenderer.on("cypher-project-item-update", handler);
    return () => { ipcRenderer.removeListener("cypher-project-item-update", handler); };
  },

  openInVSCode: (filePath) => ipcRenderer.send("cypher-open-vscode", filePath),

  onLeaderDone: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { agentId: string; agentName: string; body: string }) =>
      cb(info);
    ipcRenderer.on("cypher-leader-done", handler);
    return () => { ipcRenderer.removeListener("cypher-leader-done", handler); };
  },

  openExternal: (url) => ipcRenderer.send("open-external", url),

  openJammerPreview: (agentId, url) => ipcRenderer.send("cypher-open-jammer-preview", agentId, url),

  dripsPreview: (recipe) => ipcRenderer.invoke("drips-preview", recipe) as Promise<string>,

  onJammerActivity: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { cypherId?: string; seq?: number; from: string; to?: string; kind: string; body: string; tags?: string[]; ts: number; meta?: Record<string, unknown> }) =>
      cb(event);
    ipcRenderer.on("jammer-activity", handler);
    return () => { ipcRenderer.removeListener("jammer-activity", handler); };
  },

  onContextReady: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("cypher-context-ready", handler);
    return () => { ipcRenderer.removeListener("cypher-context-ready", handler); };
  },
};

contextBridge.exposeInMainWorld("cypher", api);
