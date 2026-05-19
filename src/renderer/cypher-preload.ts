import { contextBridge, ipcRenderer } from "electron";

/** One agent in the swarm roster, as the panel renders it. */
export interface SwarmPanelAgent {
  id: string;
  position: string;
  parentAgentId: string | null;
  area?: string;
  role?: string;
  provider?: string;
  model?: string;
}

export interface SwarmPanelManifest {
  id: string;
  title: string;
  goal: string;
  agents: SwarmPanelAgent[];
}

/** A bus event forwarded from the local CypherBus. */
export interface SwarmActivity {
  from: string;
  to?: string;
  kind: string;
  body: string;
  tags?: string[];
  ts: number;
  meta?: Record<string, unknown>;
}

interface SwarmPanelAPI {
  // The swarm roster + goal — pushed by main, also pullable on (re)load.
  getSwarmManifest: () => Promise<SwarmPanelManifest | null>;
  onSwarmManifest: (cb: (m: SwarmPanelManifest) => void) => () => void;

  // Live bus feed + per-agent status.
  onActivity: (cb: (event: SwarmActivity) => void) => () => void;
  onAgentStatus: (cb: (agentName: string, status: string) => void) => () => void;
  onLeaderDone: (cb: (info: { agentId: string; agentName: string; body: string }) => void) => () => void;

  // Agent control — start / stop a single agent (start-all / stop-all loop
  // these in the renderer).
  agentStart: (agentName: string) => void;
  agentStop: (agentName: string) => void;

  // Theme.
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;

  // Open an external URL in the default browser.
  openExternal: (url: string) => void;
}

const api: SwarmPanelAPI = {
  getSwarmManifest: () => ipcRenderer.invoke("swarm-get-manifest"),
  onSwarmManifest: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, m: SwarmPanelManifest) => cb(m);
    ipcRenderer.on("swarm-manifest", handler);
    return () => { ipcRenderer.removeListener("swarm-manifest", handler); };
  },

  onActivity: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, event: SwarmActivity) => cb(event);
    ipcRenderer.on("jammer-activity", handler);
    return () => { ipcRenderer.removeListener("jammer-activity", handler); };
  },
  onAgentStatus: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, agentName: string, status: string) =>
      cb(agentName, status);
    ipcRenderer.on("cw:agent:status", handler);
    return () => { ipcRenderer.removeListener("cw:agent:status", handler); };
  },
  onLeaderDone: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { agentId: string; agentName: string; body: string }) =>
      cb(info);
    ipcRenderer.on("cypher-leader-done", handler);
    return () => { ipcRenderer.removeListener("cypher-leader-done", handler); };
  },

  agentStart: (name) => ipcRenderer.send("cw:agent:start", name),
  agentStop: (name) => ipcRenderer.send("cw:agent:stop", name),

  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },

  openExternal: (url) => ipcRenderer.send("open-external", url),
};

contextBridge.exposeInMainWorld("swarm", api);
