import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("grpAPI", {
  /** Send a message from the user to all participants. */
  send: (text: string) => ipcRenderer.send("grp:send", text),

  /** Add a participant to the active group. */
  addParticipant: (id: string) => ipcRenderer.send("grp:add", id),

  /** Remove a participant from the active group. */
  removeParticipant: (id: string) => ipcRenderer.send("grp:remove", id),

  /** Get the current participant list. */
  getParticipants: () => ipcRenderer.invoke("grp:participants") as Promise<string[]>,

  /** Listen for incoming messages (from any participant or system). */
  onMessage: (cb: (msg: { from: string; text: string; type: "user" | "model" | "system" }) => void) => {
    ipcRenderer.on("grp:message", (_e, msg) => cb(msg));
  },

  /** Listen for participant list changes. */
  onParticipantsChanged: (cb: (participants: string[]) => void) => {
    ipcRenderer.on("grp:participants-changed", (_e, list) => cb(list));
  },

  /** Listen for a model starting to "type" (thinking indicator). */
  onTyping: (cb: (modelId: string, typing: boolean) => void) => {
    ipcRenderer.on("grp:typing", (_e, modelId, typing) => cb(modelId, typing));
  },

  /** Listen for panel becoming visible. */
  onVisible: (cb: () => void) => {
    ipcRenderer.on("grp:visible", () => cb());
  },
});
