/**
 * TerminalManager — manages pseudo-terminal processes.
 *
 * Each terminal panel gets its own pty process. Data flows:
 * xterm.js (renderer) <-> IPC <-> node-pty (main)
 */

import * as pty from "node-pty";
import { ipcMain, WebContents } from "electron";
import os from "os";

export class TerminalManager {
  private processes = new Map<number, pty.IPty>();

  /** Register IPC handlers for terminal communication. */
  init(): void {
    ipcMain.on("terminal:write", (e, data: string) => {
      this.processes.get(e.sender.id)?.write(data);
    });
    ipcMain.on("terminal:resize", (e, cols: number, rows: number) => {
      const proc = this.processes.get(e.sender.id);
      if (proc) {
        try { proc.resize(cols, rows); } catch { /* ignore invalid sizes */ }
      }
    });
  }

  /** Spawn a new pty process and wire it to a webContents. */
  spawn(wc: WebContents): void {
    this.kill(wc.id);

    const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });

    proc.onData((data) => {
      if (!wc.isDestroyed()) wc.send("terminal:data", data);
    });
    proc.onExit(({ exitCode }) => {
      if (!wc.isDestroyed()) wc.send("terminal:exit", exitCode);
      this.processes.delete(wc.id);
    });

    this.processes.set(wc.id, proc);
  }

  /** Kill a pty process by webContents id. */
  kill(wcId: number): void {
    const proc = this.processes.get(wcId);
    if (proc) {
      proc.kill();
      this.processes.delete(wcId);
    }
  }

  /** Kill all pty processes (app shutdown). */
  killAll(): void {
    for (const [, proc] of this.processes) {
      proc.kill();
    }
    this.processes.clear();
  }
}
