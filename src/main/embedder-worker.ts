/**
 * Embedder Worker — runs ONNX inference in an isolated child process.
 *
 * Communicates with the parent via IPC messages:
 *   parent → worker: { type: "init" } | { type: "embed", id, text }
 *   worker → parent: { type: "status", ... } | { type: "ready" } | { type: "result", id, vector } | { type: "error", id?, message }
 */

import path from "path";
import os from "os";

const MODEL_ID = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const EMBED_DIM = 384;
// Qwen3-Embedding-0.6B supports 32k tokens. We stay generous but cap to keep
// inference fast (~8k tokens ≈ 32k chars covers nearly all real captures).
const MAX_TEXT_CHARS = 32000;
const MAX_TOKENS = 8192;

let pipe: any = null;

function send(msg: Record<string, unknown>): void {
  if (process.send) process.send(msg);
}

async function loadModel(): Promise<void> {
  send({ type: "status", state: "loading", message: "initializing..." });

  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(os.homedir(), "yo", "models");

  console.log("[embedder-worker] loading Qwen3-Embedding-0.6B…");
  pipe = await pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",
    progress_callback: (progress: any) => {
      if (progress.status === "download" || progress.status === "progress") {
        send({ type: "status", state: "downloading", progress: progress.progress });
      } else if (progress.status === "done") {
        send({ type: "status", state: "loading", message: "loading model..." });
      }
    },
  });

  console.log("[embedder-worker] ready");
  send({ type: "ready" });
}

function truncate(data: number[]): number[] {
  if (data.length <= EMBED_DIM) return data;
  const slice = data.slice(0, EMBED_DIM);
  const norm = Math.sqrt(slice.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return new Array(EMBED_DIM).fill(0);
  return slice.map((v) => v / norm);
}

async function embed(id: string, text: string): Promise<void> {
  if (!pipe) {
    send({ type: "error", id, message: "Model not loaded" });
    return;
  }
  try {
    const trimmed = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
    const output = await pipe(trimmed, {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: MAX_TOKENS,
    });
    const vector = truncate(output.tolist()[0] as number[]);
    send({ type: "result", id, vector });
  } catch (err) {
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
}

process.on("message", async (msg: any) => {
  if (msg.type === "init") {
    try {
      await loadModel();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // A missing native binding (no ONNX runtime build for this platform,
      // e.g. macOS x64) is not recoverable — report it concisely instead of
      // dumping the whole require stack, and exit cleanly.
      const unavailable = /onnxruntime_binding|Cannot find module/.test(raw);
      send({ type: "error", message: unavailable ? "no ONNX runtime binding for this platform" : raw });
      if (unavailable) process.exit(0);
    }
  } else if (msg.type === "embed") {
    await embed(msg.id, msg.text);
  }
});
