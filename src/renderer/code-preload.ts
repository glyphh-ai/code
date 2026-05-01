import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("codeWorkspace", {
  // Agent message stream
  onAgentMessage: (cb: (agent: string, msg: any) => void) => {
    ipcRenderer.on("cw:agent:message", (_e, agent, msg) => cb(agent, msg));
  },
  onAgentStatus: (cb: (agent: string, status: string) => void) => {
    ipcRenderer.on("cw:agent:status", (_e, agent, status) => cb(agent, status));
  },

  // Agent control
  startAgent: (agent: string) => ipcRenderer.send("cw:agent:start", agent),
  stopAgent: (agent: string) => ipcRenderer.send("cw:agent:stop", agent),
  sendMessage: (agent: string, message: string) => ipcRenderer.send("cw:agent:send", agent, message),

  // Agent management
  getAgents: () => ipcRenderer.invoke("cw:get-agents") as Promise<Array<{ name: string; role: string; prompt?: string }>>,
  addAgent: (name: string, role: string, prompt?: string) => ipcRenderer.invoke("cw:add-agent", name, role, prompt) as Promise<{ ok: boolean; error?: string }>,

  // Dashboard
  dashboardToday: () => ipcRenderer.invoke("dashboard:today") as Promise<any>,
  dashboardAllTime: () => ipcRenderer.invoke("dashboard:all-time") as Promise<{ agents: Record<string, any>; total: any }>,
  dashboardHistory: (days?: number) => ipcRenderer.invoke("dashboard:history", days) as Promise<any[]>,

  // VS Code URL
  getVscodeUrl: () => ipcRenderer.invoke("cw:vscode-url") as Promise<string | null>,

  // Layout config
  getLayout: () => ipcRenderer.invoke("cw:get-layout") as Promise<{
    cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
    cols: number; rows: number; colWidths: number[]; rowHeights: number[];
  } | null>,
  saveLayoutSizes: (colWidths: number[], rowHeights: number[]) => ipcRenderer.invoke("cw:save-layout-sizes", colWidths, rowHeights),
  addAgentToLayout: (name: string, role: string, prompt?: string) => ipcRenderer.invoke("cw:add-agent-to-layout", name, role, prompt),
});
