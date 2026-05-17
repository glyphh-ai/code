/**
 * code-index/ipc — keep the working directory's code index warm.
 *
 * Builds the index in the background on boot and exposes a manual rebuild.
 * `code_search` self-heals if the cache is missing, so this is purely an
 * optimisation (no first-query stall) — not a correctness requirement.
 */

import { ipcMain } from "electron";
import { buildCodeIndex } from "./builder";
import { setCurrentIndex, getCurrentIndex } from "./search";

let building = false;

export function reindexFor(dir: string): void {
  if (building) return;
  building = true;
  try {
    setCurrentIndex(buildCodeIndex(dir));
    console.log(`[code-index] ${getCurrentIndex()?.size ?? 0} chunks for ${dir}`);
  } catch (err) {
    console.error("[code-index] build failed:", err);
  } finally {
    building = false;
  }
}

export function registerCodeIndexIpc(deps: { getWorkingDir: () => string }): void {
  // Warm the index shortly after boot, off the critical path.
  setTimeout(() => reindexFor(deps.getWorkingDir()), 3000);

  if (!ipcMain.listenerCount("code-index:rebuild")) {
    ipcMain.handle("code-index:rebuild", () => {
      reindexFor(deps.getWorkingDir());
      return { ok: true, chunks: getCurrentIndex()?.size ?? 0 };
    });
  }
  if (!ipcMain.listenerCount("code-index:status")) {
    ipcMain.handle("code-index:status", () => ({
      ready: !!getCurrentIndex(),
      chunks: getCurrentIndex()?.size ?? 0,
      building,
    }));
  }
}
