/**
 * code-index/ipc — keep the working directory's code index warm.
 *
 * Builds the index in the background on boot and exposes a manual rebuild.
 * `code_search` self-heals if the cache is missing, so this is purely an
 * optimisation (no first-query stall) — not a correctness requirement.
 */

import { ipcMain } from "electron";
import os from "os";
import path from "path";
import { buildCodeIndex } from "./builder";
import { setCurrentIndex, getCurrentIndex } from "./search";

let building = false;

/** Auto-indexing the entire home folder (or filesystem root) walks tens of
 *  thousands of files synchronously and freezes the app on the boot warm-up —
 *  and a whole-home index isn't useful anyway. Skip those; a real project dir
 *  indexes fine (and the walker is file-capped as a backstop). */
function tooBroadToAutoIndex(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.resolve(os.homedir()) || resolved === path.parse(resolved).root;
}

export function reindexFor(dir: string): void {
  if (building) return;
  if (tooBroadToAutoIndex(dir)) {
    console.log(`[code-index] skipping auto-index of broad dir: ${dir}`);
    return;
  }
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
