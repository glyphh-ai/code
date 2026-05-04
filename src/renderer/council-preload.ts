import { contextBridge, ipcRenderer } from "electron";

interface CouncilAPI {
  modelsList: () => Promise<unknown>;
  authMe: () => Promise<unknown>;

  // Council session lifecycle
  councilCreate: (config: {
    name: string;
    council_prompt: string;
    style: "chained" | "free_for_all" | "debate";
    round_cap: number;
    members: Array<{ provider: string; model: string; startup_prompt: string }>;
  }) => Promise<{ ok: boolean; council_id?: string; error?: string }>;
  councilStop: (councilId: string) => Promise<{ ok: boolean; error?: string }>;
  councilEnd: (councilId: string) => Promise<{ ok: boolean; error?: string }>;
  councilSetCurrent: (councilId: string | null) => Promise<{ ok: boolean }>;

  // Stream subscription — main forwards round events / agent tokens
  onCouncilEvent: (cb: (event: {
    council_id: string;
    kind:
      | "member_ready" | "round_start" | "agent_turn_start" | "agent_token"
      | "agent_turn_end" | "round_end" | "moderator" | "stopped" | "error" | "summary";
    member_id?: string;
    round?: number;
    text?: string;
    error?: string;
  }) => void) => () => void;

  // Convened externally (via agent tool path)
  onCouncilConvened: (cb: (info: {
    council_id: string;
    name: string;
    council_prompt: string;
    members: Array<{ provider: string; model: string }>;
    style: string;
    round_cap: number;
  }) => void) => () => void;

  // Theme
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: CouncilAPI = {
  modelsList: () => ipcRenderer.invoke("models-list"),
  authMe: () => ipcRenderer.invoke("auth-me"),
  councilCreate: (config) => ipcRenderer.invoke("council-create", config),
  councilStop: (id) => ipcRenderer.invoke("council-stop", id),
  councilEnd: (id) => ipcRenderer.invoke("council-end", id),
  councilSetCurrent: (id) => ipcRenderer.invoke("council-set-current", id),
  onCouncilEvent: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event);
    ipcRenderer.on("council-event", handler);
    return () => { ipcRenderer.removeListener("council-event", handler); };
  },
  onCouncilConvened: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, info: Parameters<typeof cb>[0]) => cb(info);
    ipcRenderer.on("council-convened", handler);
    return () => { ipcRenderer.removeListener("council-convened", handler); };
  },
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("council", api);
