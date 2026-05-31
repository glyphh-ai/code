/**
 * GlyphDreamLoop — the Electron-main half of the dual dream loop. Owns the dream
 * worker_thread, schedules the two cycles, and is the *only* writer back into the
 * authoritative substrate.
 *
 *   localized (REM)  — every ~3s while not paused. Fast associative wander over a
 *                      random working set. Suggests Hebbian reinforcement.
 *   deep (slow-wave) — every ~30s, idle-gated: only fires when no absorb has
 *                      landed in the last DEEP_IDLE_MS (mirrors ada waiting for a
 *                      quiet substrate before the expensive sweep). Surveys up to
 *                      200 thoughts, connects, crystallizes, finds gaps, and the
 *                      cycle end triggers a gentle global decay.
 *
 * The worker does the cosine-heavy work on serializable rows; this manager
 * gathers rows from the authoritative space (stripping the non-serializable
 * glyph), applies returned reinforce/decay against that space, and queues
 * insights for drainInsights(). Worker construction is wrapped so a failure (no
 * worker support, bad path) degrades to a silent no-op rather than crashing
 * substrate init.
 */

import path from "path";
import { Worker } from "worker_threads";
import type { ThoughtGlyphSpace, ThoughtRow } from "../thought/space";
import type { SerInsight, WorkerIn, WorkerOut } from "./protocol";

const LOCALIZED_MS = 3_000;
const DEEP_MS = 30_000;
const DEEP_IDLE_MS = 10_000;
const LOCALIZED_ROWS = 50;
const DEEP_ROWS = 200;
const MAX_QUEUED_INSIGHTS = 200;

export class GlyphDreamLoop {
  private worker: Worker | null = null;
  private localizedTimer: NodeJS.Timeout | null = null;
  private deepTimer: NodeJS.Timeout | null = null;
  private paused = false;
  private running = false;
  private busy = false;
  private lastAbsorb = 0;
  private insights: SerInsight[] = [];
  private cyclesRun = 0;

  constructor(private space: ThoughtGlyphSpace) {}

  /** Spin up the worker and start both cycle timers. Idempotent; no-op on a
   *  worker-construction failure. */
  start(): void {
    if (this.running) return;
    try {
      this.worker = new Worker(path.join(__dirname, "worker.js"));
      this.worker.on("message", (out: WorkerOut) => this.onResult(out));
      this.worker.on("error", () => this.stop());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[adaL dream] worker unavailable, dream loop disabled:", err instanceof Error ? err.message : err);
      this.worker = null;
      return;
    }
    this.running = true;
    this.localizedTimer = setInterval(() => this.tickLocalized(), LOCALIZED_MS);
    this.deepTimer = setInterval(() => this.tickDeep(), DEEP_MS);
  }

  stop(): void {
    this.running = false;
    if (this.localizedTimer) clearInterval(this.localizedTimer);
    if (this.deepTimer) clearInterval(this.deepTimer);
    this.localizedTimer = null;
    this.deepTimer = null;
    if (this.worker) {
      this.worker.removeAllListeners();
      void this.worker.terminate();
      this.worker = null;
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Called by Adal.tell so the deep cycle can wait for a quiet substrate. */
  notifyAbsorb(): void {
    this.lastAbsorb = Date.now();
  }

  /** Drain the accumulated insights (FIFO), clearing the queue. */
  drainInsights(): SerInsight[] {
    const out = this.insights;
    this.insights = [];
    return out;
  }

  stats(): { running: boolean; paused: boolean; cyclesRun: number; queuedInsights: number } {
    return { running: this.running, paused: this.paused, cyclesRun: this.cyclesRun, queuedInsights: this.insights.length };
  }

  // ── Cycle ticks ────────────────────────────────────────────────────────────

  private tickLocalized(): void {
    if (!this.shouldRun()) return;
    this.post({ type: "localized", rows: this.gatherRows(LOCALIZED_ROWS, "recent") });
  }

  private tickDeep(): void {
    if (!this.shouldRun()) return;
    // Idle-gate: only sweep when the substrate has been quiet for a beat.
    if (Date.now() - this.lastAbsorb < DEEP_IDLE_MS) return;
    this.post({ type: "deep", rows: this.gatherRows(DEEP_ROWS, "all") });
  }

  private shouldRun(): boolean {
    return this.running && !this.paused && !this.busy && this.worker != null && this.space.count > 1;
  }

  private post(msg: WorkerIn): void {
    if (!this.worker) return;
    this.busy = true;
    this.worker.postMessage(msg);
  }

  // ── Worker result → authoritative space ─────────────────────────────────────

  private onResult(out: WorkerOut): void {
    this.busy = false;
    this.cyclesRun++;

    for (const r of out.reinforce) this.space.reinforce(r.id, r.amount);
    if (out.cycle === "deep") this.space.decayAll(0.98);

    if (out.insights.length) {
      this.insights.push(...out.insights);
      if (this.insights.length > MAX_QUEUED_INSIGHTS) {
        this.insights = this.insights.slice(-MAX_QUEUED_INSIGHTS);
      }
    }
  }

  // ── Row gathering (strip the non-serializable glyph) ────────────────────────

  private gatherRows(limit: number, strategy: "recent" | "all"): ThoughtRow[] {
    const src =
      strategy === "all"
        ? this.space.allThoughts().slice(0, limit)
        : this.space.loadWorkingSet("recent", limit);
    return src.map((t) => ({
      thoughtId: t.thoughtId,
      content: t.content,
      speaker: t.speaker,
      strength: t.strength,
      createdAt: t.createdAt,
      lastAccessed: t.lastAccessed,
      accessCount: t.accessCount,
      key: t.key,
      version: t.version,
      metadata: t.metadata,
    }));
  }
}
