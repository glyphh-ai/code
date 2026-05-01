/**
 * VSCodeServer — manages a local `code serve-web` process.
 *
 * Spawns VS Code's built-in web server so the BrowserView panel gets
 * full local file access without the File System Access API.
 */

import { spawn, execSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envWithShellPath } from "./shell-path";

const PORT = 9437;
const HOST = "127.0.0.1";
const DATA_DIR = `${os.homedir()}/yo/vscode`;

/** Where `code serve-web` expects its User config files. The directory layout
 *  matches Desktop VS Code's `~/Library/Application Support/Code/User/`. */
const USER_DIR = path.join(DATA_DIR, "data", "User");

/** Per-platform path to the user's Desktop VS Code User dir. We copy from
 *  here into the code-server data dir so the in-app editor feels like the
 *  user's editor on first launch (Phase 5 — see MULTI-AGENT-PLAN §3.8). */
function userConfigSourceDir(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin": return path.join(home, "Library", "Application Support", "Code", "User");
    case "win32": return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User");
    case "linux": return path.join(home, ".config", "Code", "User");
    default: return null;
  }
}

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

      // Kill any stale process holding our port from a previous crash
      try {
        const pid = execSync(`lsof -ti :${PORT}`, { encoding: "utf-8" }).trim();
        if (pid) {
          console.log(`[vscode-server] killing stale process ${pid} on port ${PORT}`);
          process.kill(Number(pid), "SIGKILL");
        }
      } catch { /* no process on port — expected */ }

      // Ensure data dirs exist for state persistence
      fs.mkdirSync(DATA_DIR, { recursive: true });

      // Phase 5: copy user's Desktop VS Code settings into the code-server
      // data dir so the embedded editor inherits their preferences on first
      // launch. Only runs once per machine (skipped if files already exist).
      VSCodeServer.seedUserConfig();

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
        // Use resolved shell PATH so VS Code's git extension (and any other
        // child it spawns — npm, language servers) can find user-installed
        // binaries from Homebrew/asdf/nvm, etc.
        env: envWithShellPath(),
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

      // Timeout — if no ready signal in 60s, give up
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error("code serve-web timed out waiting for ready signal"));
        }
      }, 60000);
    });
  }

  /** Stop the server — SIGTERM first, SIGKILL after 3s if still alive */
  stop(): void {
    if (this.proc) {
      console.log("[vscode-server] stopping");
      const p = this.proc;
      p.kill("SIGTERM");
      // Force kill if SIGTERM doesn't work within 3 seconds
      const forceKill = setTimeout(() => {
        try { if (!p.killed) p.kill("SIGKILL"); } catch {}
      }, 3000);
      p.on("exit", () => clearTimeout(forceKill));
      this.proc = null;
      this._url = null;
      this.readyPromise = null;
    }
  }

  /** Get the expected URL (even before server starts) */
  static expectedUrl(): string {
    return `http://${HOST}:${PORT}`;
  }

  /** Copy the user's Desktop VS Code `settings.json` and `keybindings.json`
   *  into the code-server User dir on first launch. No-op if either the
   *  source is missing or the destination already exists (we never overwrite
   *  the user's tweaks once they've started using the embedded editor). */
  static seedUserConfig(): void {
    const src = userConfigSourceDir();
    if (!src || !fs.existsSync(src)) return;

    fs.mkdirSync(USER_DIR, { recursive: true });
    for (const name of ["settings.json", "keybindings.json"]) {
      const from = path.join(src, name);
      const to = path.join(USER_DIR, name);
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) continue; // never clobber existing
      try {
        fs.copyFileSync(from, to);
        console.log(`[vscode-server] seeded ${name} from Desktop VS Code`);
      } catch (err) {
        console.warn(`[vscode-server] failed to seed ${name}:`, (err as Error).message);
      }
    }
  }
}
