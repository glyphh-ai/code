import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("terminalAPI", {
  write: (data: string) => ipcRenderer.send("terminal:write", data),
  resize: (cols: number, rows: number) => ipcRenderer.send("terminal:resize", cols, rows),
  onData: (cb: (data: string) => void) => {
    ipcRenderer.on("terminal:data", (_e, data) => cb(data));
  },
  onExit: (cb: (code: number) => void) => {
    ipcRenderer.on("terminal:exit", (_e, code) => cb(code));
  },
});
