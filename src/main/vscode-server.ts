/**
 * VSCodeServer — manages a local `code serve-web` process.
 *
 * Spawns VS Code's built-in web server so the BrowserView panel gets
 * full local file access without the File System Access API.
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";

const PORT = 9437;
const HOST = "127.0.0.1";
const DATA_DIR = `${os.homedir()}/yo/vscode`;

/** Paths to check for the VS Code CLI on macOS */
const CODE_PATHS = [
  "/usr/local/bin/code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  `${os.homedir()}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
  "/opt/homebrew/bin/code",
  // Insiders variant
  "/usr/local/bin/code-insiders",
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
];

export class VSCodeServer {
  private proc: ChildProcess | null = null;
  private _url: string | null = null;
  private _codePath: string | null = null;
  private readyPromise: Promise<string> | null = null;

  /** The URL to load in the panel (null if not started) */
  get url(): string | null { return this._url; }

  /** Whether VS Code CLI was found on this machine */
  get available(): boolean { return this.findCode() !== null; }

  /** Find the `code` CLI binary */
  private findCode(): string | null {
    if (this._codePath) return this._codePath;

    // Check PATH first
    for (const p of CODE_PATHS) {
      if (fs.existsSync(p)) {
        this._codePath = p;
        return p;
      }
    }
    return null;
  }

  /**
   * Start the server. Returns the URL when ready.
   * If already running, returns the existing URL.
   */
  start(folder?: string): Promise<string> {
    if (this._url) return Promise.resolve(this._url);
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this._start(folder);
    return this.readyPromise;
  }

  private _start(folder?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const codePath = this.findCode();
      if (!codePath) {
        reject(new Error(
          "VS Code not found. Install VS Code and run 'Shell Command: Install code command in PATH' from the command palette."
        ));
        return;
      }

      // Ensure data dirs exist for state persistence
      fs.mkdirSync(DATA_DIR, { recursive: true });

      const args = [
        "serve-web",
        "--port", String(PORT),
        "--host", HOST,
        "--without-connection-token",
        "--accept-server-license-terms",
        "--server-data-dir", DATA_DIR,
      ];
      if (folder) {
        args.push("--default-folder", folder);
      }

      console.log(`[vscode-server] starting: ${codePath} ${args.join(" ")}`);

      this.proc = spawn(codePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let resolved = false;

      const onData = (data: Buffer) => {
        const line = data.toString();
        console.log("[vscode-server]", line.trim());

        // Look for the ready signal: "Web UI available at http://..."
        const match = line.match(/Web UI available at (https?:\/\/\S+)/);
        if (match && !resolved) {
          resolved = true;
          this._url = match[1];
          console.log("[vscode-server] ready at", this._url);
          resolve(this._url);
        }
      };

      this.proc.stdout?.on("data", onData);
      this.proc.stderr?.on("data", onData);

      this.proc.on("error", (err) => {
        console.log("[vscode-server] spawn error:", err.message);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.proc.on("exit", (code) => {
        console.log("[vscode-server] exited with code", code);
        this._url = null;
        this.readyPromise = null;
        this.proc = null;
        if (!resolved) {
          resolved = true;
          reject(new Error(`code serve-web exited with code ${code}`));
        }
      });

      // Timeout — if no ready signal in 30s, give up
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error("code serve-web timed out waiting for ready signal"));
        }
      }, 30000);
    });
  }

  /** Stop the server */
  stop(): void {
    if (this.proc) {
      console.log("[vscode-server] stopping");
      this.proc.kill();
      this.proc = null;
      this._url = null;
      this.readyPromise = null;
    }
  }

  /** Get the expected URL (even before server starts) */
  static expectedUrl(): string {
    return `http://${HOST}:${PORT}`;
  }
}
