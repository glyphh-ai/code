/**
 * Working directory — the single project folder the app is focused on.
 *
 * One explicit, persisted folder. The .yo agent runs in it, and (todo) a
 * cypher clones the repo into it. Changing it broadcasts `working-dir-changed`
 * to the main window and every panel so they re-point.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import os from "os";
import { getPreference, setPreference } from "./preferences";

type Broadcast = (channel: string, ...args: unknown[]) => void;

let getMainWindow: () => BrowserWindow | null = () => null;
let broadcastToPanels: Broadcast = () => {};
let onWorkingDirChange: (dir: string) => void = () => {};

const RECENTS_CAP = 8;

/** The fallback working directory — the user's OS home folder. A user can
 *  override the default later (workingDirDefault); until then we land on
 *  ~ rather than prompting on first run. */
export function defaultWorkingDirectory(): string {
  return getPreference<string | null>("workingDirDefault", null) || os.homedir();
}

/** Set the user's default working folder (e.g. from a settings screen).
 *  Also becomes the current dir if none is set yet. */
export function setDefaultWorkingDirectory(dir: string): void {
  setPreference("workingDirDefault", dir);
  if (!getPreference<string | null>("workingDirectory", null)) {
    setWorkingDirectory(dir);
  }
}

/** The current working directory. Defaults to the configured default when
 *  none has been set. This doubles as "last used" — it persists across chats
 *  so a new chat inherits it. */
export function getWorkingDirectory(): string {
  return getPreference<string | null>("workingDirectory", null) || defaultWorkingDirectory();
}

/** Most-recently-used folders, newest first. */
export function getWorkingDirRecents(): string[] {
  return getPreference<string[]>("workingDirRecents", []) || [];
}

function pushRecent(dir: string): void {
  const recents = getWorkingDirRecents().filter((d) => d !== dir);
  recents.unshift(dir);
  setPreference("workingDirRecents", recents.slice(0, RECENTS_CAP));
}

/** Set the working directory and notify the renderer + every panel. */
export function setWorkingDirectory(dir: string | null): void {
  const value = dir || null;
  setPreference("workingDirectory", value);
  if (value) pushRecent(value);
  getMainWindow()?.webContents.send("working-dir-changed", value);
  broadcastToPanels("working-dir-changed", value);
  onWorkingDirChange(getWorkingDirectory());
}

export function registerWorkingDirectoryIpc(deps: {
  getMainWindow: () => BrowserWindow | null;
  broadcastToPanels: Broadcast;
  onWorkingDirChange?: (dir: string) => void;
}): void {
  getMainWindow = deps.getMainWindow;
  broadcastToPanels = deps.broadcastToPanels;
  if (deps.onWorkingDirChange) onWorkingDirChange = deps.onWorkingDirChange;

  ipcMain.handle("working-dir:get", () => getWorkingDirectory());
  ipcMain.handle("working-dir:recents", () => getWorkingDirRecents());

  // Set the current dir to an already-known path (e.g. picked from recents).
  ipcMain.handle("working-dir:set", (_e, dir: string) => {
    if (dir) setWorkingDirectory(dir);
    return getWorkingDirectory();
  });

  // OS folder picker. `opts.startIn` opens the dialog in the current dir;
  // `opts.asDefault` also stores the pick as the first-run default.
  ipcMain.handle("working-dir:pick", async (_e, opts?: { asDefault?: boolean }) => {
    const win = getMainWindow();
    const dialogOpts = {
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      defaultPath: getWorkingDirectory(),
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || result.filePaths.length === 0) return getWorkingDirectory();
    const picked = result.filePaths[0];
    if (opts?.asDefault) setDefaultWorkingDirectory(picked);
    setWorkingDirectory(picked);
    return picked;
  });
}
