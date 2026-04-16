/**
 * Embedder — local vector embeddings via Qwen3-Embedding-0.6B (ONNX).
 *
 * Downloads the model on first use (~600MB), caches in ~/yo/models/.
 * Produces 384-dimension normalized embeddings via MRL truncation.
 * All inference runs locally — no API calls.
 */

import path from "path";
import os from "os";
import { BrowserWindow } from "electron";

const MODEL_ID = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const EMBED_DIM = 384;

export class Embedder {
  private pipe: any = null;
  private loading: Promise<void> | null = null;
  private _ready = false;

  get isReady(): boolean { return this._ready; }

  /** Start loading the model. Safe to call multiple times. */
  async init(): Promise<void> {
    if (this._ready) return;
    if (this.loading) return this.loading;
    this.loading = this._load();
    return this.loading;
  }

  private async _load(): Promise<void> {
    this.sendStatus("loading", "initializing...");

    // Dynamic import — @huggingface/transformers is ESM-only in v3
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(os.homedir(), "yo", "models");

    console.log("[embedder] loading Qwen3-Embedding-0.6B…");
    this.pipe = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
      progress_callback: (progress: any) => {
        if (progress.status === "download" || progress.status === "progress") {
          this.sendStatus("downloading", undefined, progress.progress);
        } else if (progress.status === "done") {
          this.sendStatus("loading", "loading model...");
        }
      },
    });
    this._ready = true;
    console.log("[embedder] ready");
    this.sendStatus("ready");
  }

  /** Send status to the renderer for splash screen updates. */
  private sendStatus(state: string, message?: string, progress?: number): void {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send("embedder-status", { state, progress, message });
      }
    } catch { /* window may not exist yet */ }
  }

  /** Embed a single text. Returns a normalized 384-dim Float32Array. */
  async embed(text: string): Promise<Float32Array> {
    if (!this._ready) await this.init();
    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    return this.truncate(output.tolist()[0] as number[]);
  }

  /** Embed multiple texts sequentially. */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const t of texts) {
      results.push(await this.embed(t));
    }
    return results;
  }

  /** MRL truncation: take first EMBED_DIM dims and re-normalize. */
  private truncate(data: number[]): Float32Array {
    if (data.length <= EMBED_DIM) {
      return new Float32Array(data);
    }
    const slice = data.slice(0, EMBED_DIM);
    const norm = Math.sqrt(slice.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return new Float32Array(EMBED_DIM);
    return new Float32Array(slice.map((v) => v / norm));
  }
}

/** Dimension of embeddings produced by this embedder. */
export const EMBEDDING_DIM = EMBED_DIM;
