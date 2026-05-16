/**
 * Working directory — the single project folder the app is focused on.
 *
 * One explicit, persisted folder. The .Yo Editor opens it, the .yo agent runs
 * in it, and (todo) a cypher clones the repo into it. Changing it broadcasts
 * `working-dir-changed` to the main window and every panel so they re-point.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import path from "path";
import os from "os";
import { getPreference, setPreference } from "./preferences";

type Broadcast = (channel: string, ...args: unknown[]) => void;

let getMainWindow: () => BrowserWindow | null = () => null;
let broadcastToPanels: Broadcast = () => {};

/** The default working directory — the user's ~/yo folder (always exists; the
 *  preferences file lives inside it). Used until the user picks another. */
export function defaultWorkingDirectory(): string {
  return path.join(os.homedir(), "yo");
}

/** The current working directory. Defaults to ~/yo when none has been set. */
export function getWorkingDirectory(): string {
  return getPreference<string | null>("workingDirectory", null) || defaultWorkingDirectory();
}

/** Set the working directory and notify the renderer + every panel. */
export function setWorkingDirectory(dir: string | null): void {
  const value = dir || null;
  setPreference("workingDirectory", value);
  getMainWindow()?.webContents.send("working-dir-changed", value);
  broadcastToPanels("working-dir-changed", value);
}

export function registerWorkingDirectoryIpc(deps: {
  getMainWindow: () => BrowserWindow | null;
  broadcastToPanels: Broadcast;
}): void {
  getMainWindow = deps.getMainWindow;
  broadcastToPanels = deps.broadcastToPanels;

  ipcMain.handle("working-dir:get", () => getWorkingDirectory());

  ipcMain.handle("working-dir:pick", async () => {
    const win = getMainWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return getWorkingDirectory();
    setWorkingDirectory(result.filePaths[0]);
    return result.filePaths[0];
  });
}
