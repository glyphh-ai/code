/**
 * TerminalManager — manages pseudo-terminal processes.
 *
 * Each terminal panel gets its own pty process. Data flows:
 * xterm.js (renderer) <-> IPC <-> node-pty (main)
 *
 * Shell functions yo/sup/dip are injected on spawn so commands
 * typed in the terminal route through the Electron command handler.
 */

import * as pty from "node-pty";
import { ipcMain, WebContents } from "electron";
import os from "os";

/** Marker wrapping command output from injected shell functions */
const CMD_MARKER_START = "\x1b]7770;";
const CMD_MARKER_END = "\x07";

export type TerminalCommandHandler = (cmd: string, wc: WebContents) => void;

export class TerminalManager {
  private processes = new Map<number, pty.IPty>();
  private onCommand: TerminalCommandHandler | null = null;

  /** Set handler for yo/sup/dip commands typed in the terminal. */
  setCommandHandler(handler: TerminalCommandHandler): void {
    this.onCommand = handler;
  }

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
    const isLogin = os.platform() !== "win32";
    const proc = pty.spawn(shell, isLogin ? ["-l"] : [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });

    // Buffer for detecting split markers across chunks
    let outBuf = "";

    proc.onData((data) => {
      if (wc.isDestroyed()) return;

      outBuf += data;

      // Process all complete markers in the buffer
      while (true) {
        const start = outBuf.indexOf(CMD_MARKER_START);
        if (start === -1) break;
        const end = outBuf.indexOf(CMD_MARKER_END, start + CMD_MARKER_START.length);
        if (end === -1) break; // incomplete marker — wait for more data

        // Send everything before the marker to the terminal
        const before = outBuf.slice(0, start);
        if (before) wc.send("terminal:data", before);

        // Extract and route the command
        const cmdStr = outBuf.slice(start + CMD_MARKER_START.length, end).trim();
        if (cmdStr) this.onCommand?.(cmdStr, wc);

        // Continue after marker (skip trailing newline if present)
        outBuf = outBuf.slice(end + CMD_MARKER_END.length);
        if (outBuf.startsWith("\r\n")) outBuf = outBuf.slice(2);
        else if (outBuf.startsWith("\n")) outBuf = outBuf.slice(1);
      }

      // Flush buffer if no partial marker is pending
      if (!outBuf.includes("\x1b]7770")) {
        if (outBuf) wc.send("terminal:data", outBuf);
        outBuf = "";
      }
    });

    proc.onExit(({ exitCode }) => {
      if (!wc.isDestroyed()) wc.send("terminal:exit", exitCode);
      this.processes.delete(wc.id);
    });

    this.processes.set(wc.id, proc);

    // Inject shell functions after prompt appears, then clear the noise
    setTimeout(() => {
      proc.write(
        `yo()  { printf '\\033]7770;yo %s\\007' "$*"; };` +
        `sup() { printf '\\033]7770;sup %s\\007' "$*"; };` +
        `dip() { printf '\\033]7770;dip %s\\007' "$*"; };` +
        `drip(){ printf '\\033]7770;drip %s\\007' "$*"; };` +
        `clear\r`,
      );
    }, 400);
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
