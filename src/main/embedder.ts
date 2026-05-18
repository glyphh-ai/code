/**
 * Embedder — local vector embeddings via Qwen3-Embedding-0.6B (ONNX).
 *
 * ONNX inference runs in a forked child process for crash isolation.
 * If the worker OOMs or crashes, the main app survives and search
 * falls back to keyword matching.
 */

import path from "path";
import { fork, type ChildProcess } from "child_process";
import { BrowserWindow, app } from "electron";

const EMBED_DIM = 384;
const WORKER_SCRIPT = path.join(__dirname, "embedder-worker.js");

interface PendingEmbed {
  resolve: (vec: Float32Array) => void;
  reject: (err: Error) => void;
}

export class Embedder {
  private worker: ChildProcess | null = null;
  private pending = new Map<string, PendingEmbed>();
  private nextId = 0;
  private _ready = false;
  private loading: Promise<void> | null = null;
  private crashed = false;

  get isReady(): boolean { return this._ready; }

  async init(): Promise<void> {
    if (this._ready || this.crashed) return;
    if (this.loading) return this.loading;
    this.loading = this.spawnWorker();
    return this.loading;
  }

  private spawnWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sendStatus("loading", "initializing...");

      this.worker = fork(WORKER_SCRIPT, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      this.worker.stdout?.on("data", (chunk: Buffer) => {
        console.log(`[embedder-worker] ${chunk.toString().trim()}`);
      });
      this.worker.stderr?.on("data", (chunk: Buffer) => {
        console.error(`[embedder-worker] ${chunk.toString().trim()}`);
      });

      this.worker.on("message", (msg: any) => {
        if (msg.type === "status") {
          this.sendStatus(msg.state, msg.message, msg.progress);
        } else if (msg.type === "ready") {
          this._ready = true;
          this.sendStatus("ready");
          resolve();
        } else if (msg.type === "result") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(new Float32Array(msg.vector));
          }
        } else if (msg.type === "error") {
          if (msg.id) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              p.reject(new Error(msg.message));
            }
          } else {
            // Fatal worker error (e.g. no ONNX runtime binding for this
            // platform). Degrade to keyword search — don't restart, don't
            // throw. resolve() so there's no unhandled rejection.
            if (!this.crashed) {
              this.crashed = true;
              this.sendStatus("error", "semantic search unavailable — using keyword search");
              console.warn(`[embedder] semantic search unavailable (${msg.message}) — using keyword search`);
            }
            resolve();
          }
        }
      });

      this.worker.on("exit", (code) => {
        const wasReady = this._ready;
        this._ready = false;
        this.worker = null;

        for (const [, p] of this.pending) {
          p.reject(new Error("Embedder worker crashed"));
        }
        this.pending.clear();

        if (wasReady) {
          console.error(`[embedder] worker exited (code ${code}) — attempting restart`);
          this.loading = null;
          this.restartAfterDelay();
        } else if (!this.crashed) {
          console.warn(`[embedder] worker unavailable (code ${code}) — using keyword search`);
          this.crashed = true;
          this.sendStatus("error", "semantic search unavailable — using keyword search");
        }
      });

      this.worker.send({ type: "init" });
    });
  }

  private restartAfterDelay(): void {
    setTimeout(() => {
      if (!this._ready && !this.crashed) {
        console.log("[embedder] restarting worker...");
        this.init().catch((err) => {
          console.error("[embedder] restart failed:", err);
          this.crashed = true;
          this.sendStatus("error", "model unavailable — search disabled");
        });
      }
    }, 5000);
  }

  private sendStatus(state: string, message?: string, progress?: number): void {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send("embedder-status", { state, progress, message });
      }
    } catch { /* window may not exist yet */ }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this._ready) await this.init();
    if (!this.worker || this.crashed) throw new Error("Embedder not available");

    const id = String(this.nextId++);
    return new Promise<Float32Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Embed timed out"));
      }, 30000);

      this.pending.set(id, {
        resolve: (vec) => { clearTimeout(timeout); resolve(vec); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      this.worker!.send({ type: "embed", id, text });
    });
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const t of texts) {
      results.push(await this.embed(t));
    }
    return results;
  }

  cleanup(): void {
    if (this.worker) {
      this.crashed = true;
      this.worker.kill();
      this.worker = null;
    }
  }
}

export const EMBEDDING_DIM = EMBED_DIM;
