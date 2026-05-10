import { contextBridge, ipcRenderer } from "electron";

interface CypherPanelAPI {
  // Identity
  authMe: () => Promise<{ id?: string; email?: string; handle?: string; error?: string }>;

  // Cypher data
  cypherGet: (id: string) => Promise<unknown>;
  cypherJammers: (id: string) => Promise<unknown>;
  cypherEventsList: (id: string, opts?: { since?: number; limit?: number }) => Promise<unknown>;
  cypherCoverGet: (id: string) => Promise<{ ok: boolean; data_base64?: string; content_type?: string }>;

  // Agent control (owner only)
  agentStart: (agentName: string) => void;
  agentStop: (agentName: string) => void;
  agentSend: (agentName: string, message: string) => void;
  cypherSpawnJammers: (id: string) => Promise<unknown>;

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

  // Thread persistence — load stored stage/agent threads
  loadStageThread: (cypherId: string) => Promise<Array<{ ts: number; kind: string; content: string; toolId?: string; toolName?: string }>>;
  loadAgentThread: (cypherId: string, agentName: string) => Promise<Array<{ ts: number; kind: string; content: string }>>;
  listAgentThreads: (cypherId: string) => Promise<string[]>;

  // Fired when context changes (panel should re-init)
  onContextReady: (cb: () => void) => () => void;
}

const api: CypherPanelAPI = {
  authMe: () => ipcRenderer.invoke("auth-me"),
  cypherGet: (id) => ipcRenderer.invoke("cypher-get", id),
  cypherJammers: (id) => ipcRenderer.invoke("cypher-jammers", id),
  cypherEventsList: (id, opts) => ipcRenderer.invoke("cypher-events-list", id, opts),
  cypherCoverGet: (id) => ipcRenderer.invoke("cypher-cover-get", id),

  agentStart: (name) => ipcRenderer.send("cw:agent:start", name),
  agentStop: (name) => ipcRenderer.send("cw:agent:stop", name),
  agentSend: (name, message) => ipcRenderer.send("cw:agent:send", name, message),
  cypherSpawnJammers: (id) => ipcRenderer.invoke("cypher-spawn-jammers", id),

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

  // Stage stream — orchestrator (.yo agent) output mirrored here
  onStageToken: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, delta: string) => cb(delta);
    ipcRenderer.on("cypher-stage-token", handler);
    return () => { ipcRenderer.removeListener("cypher-stage-token", handler); };
  },
  onStageTool: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, name: string, input: unknown) => cb(id, name, input);
    ipcRenderer.on("cypher-stage-tool", handler);
    return () => { ipcRenderer.removeListener("cypher-stage-tool", handler); };
  },
  onStageToolResult: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, detail: string) => cb(id, detail);
    ipcRenderer.on("cypher-stage-tool-result", handler);
    return () => { ipcRenderer.removeListener("cypher-stage-tool-result", handler); };
  },
  onStageDone: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, fullText: string) => cb(fullText);
    ipcRenderer.on("cypher-stage-done", handler);
    return () => { ipcRenderer.removeListener("cypher-stage-done", handler); };
  },

  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },

  getCypherContext: () => ipcRenderer.invoke("cypher-panel-context"),

  leaveCypher: () => ipcRenderer.send("cypher-panel-leave"),

  loadStageThread: (cypherId: string) => ipcRenderer.invoke("cypher-thread-load-stage", cypherId),
  loadAgentThread: (cypherId: string, agentName: string) => ipcRenderer.invoke("cypher-thread-load-agent", cypherId, agentName),
  listAgentThreads: (cypherId: string) => ipcRenderer.invoke("cypher-thread-list-agents", cypherId),

  onContextReady: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("cypher-context-ready", handler);
    return () => { ipcRenderer.removeListener("cypher-context-ready", handler); };
  },
};

contextBridge.exposeInMainWorld("cypher", api);
