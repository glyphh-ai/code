/**
 * work-package-uploader — zip a jammer's sandbox and upload it to yo-server
 * as a work package.
 *
 * This is the no-VCS fallback: a jammer that cannot push to GitHub hands its
 * finished work off this way. The maestro (who has the repo + credentials)
 * downloads the package via /api/work-packages/:id/download, reviews it, and
 * integrates it. A remote jammer therefore needs only a filesystem — git is
 * an optimization, never a requirement.
 *
 * IMPORTANT: this runs in the Electron MAIN process. The directory walk and
 * file reads are async (fs.promises) so they yield to the event loop and
 * never freeze the app UI, and the payload is hard-bounded (file count +
 * total bytes) so the one unavoidable sync step — zip compression — stays
 * small and quick. An earlier version walked + read + compressed synchronously
 * and froze the whole app on any non-trivial project.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import AdmZip from "adm-zip";
import { serverPostAuthed } from "./auth";

/** Directories never worth shipping in a work package. */
const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".yo", "dist", "build", ".next",
  ".cache", ".turbo", "out", "coverage", ".venv", "__pycache__",
]);

/** Skip individual files larger than this — a work package is a diff, not a release. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Hard cap on the whole payload, so zip compression stays a quick step. */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Hard cap on file count. */
const MAX_FILES = 1500;

export interface UploadResult {
  id: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  truncated: boolean;
}

interface CollectedFile { rel: string; buf: Buffer; }

interface Accumulator {
  files: CollectedFile[];
  bytes: number;
  truncated: boolean;
}

/**
 * Async, bounded directory walk. `Dirent.isDirectory()` is false for symlinks,
 * so symlinked directories are never followed — no risk of an infinite loop.
 */
async function collect(dir: string, base: string, acc: Accumulator): Promise<void> {
  if (acc.files.length >= MAX_FILES || acc.bytes >= MAX_TOTAL_BYTES) {
    acc.truncated = true;
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.files.length >= MAX_FILES || acc.bytes >= MAX_TOTAL_BYTES) {
      acc.truncated = true;
      return;
    }
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, base, acc);
    } else if (entry.isFile()) {
      try {
        const st = await fsp.stat(full);
        if (st.size > MAX_FILE_BYTES) { acc.truncated = true; continue; }
        if (acc.bytes + st.size > MAX_TOTAL_BYTES) { acc.truncated = true; continue; }
        const buf = await fsp.readFile(full);
        acc.files.push({ rel: path.relative(base, full), buf });
        acc.bytes += st.size;
      } catch {
        /* skip unreadable file */
      }
    }
  }
}

/**
 * Zip `sandboxDir` and upload it as a work package. Returns the package id
 * to embed in a `work_package_submitted` cypher event so the maestro can
 * fetch it.
 */
export async function uploadWorkPackage(sandboxDir: string, label: string): Promise<UploadResult> {
  if (!fs.existsSync(sandboxDir)) {
    throw new Error(`sandbox directory not found: ${sandboxDir}`);
  }
  const acc: Accumulator = { files: [], bytes: 0, truncated: false };
  await collect(sandboxDir, sandboxDir, acc);
  if (acc.files.length === 0) throw new Error("nothing to submit — no files in the working directory");

  const zip = new AdmZip();
  for (const f of acc.files) {
    // adm-zip stores the in-memory buffer; entry paths use forward slashes.
    zip.addFile(f.rel.split(path.sep).join("/"), f.buf);
  }
  const bytes = zip.toBuffer();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = `${label.replace(/[^a-zA-Z0-9_-]/g, "_") || "work"}.zip`;

  const res = await serverPostAuthed<{ ok: boolean; work_package: { id: string; size_bytes: number } }>(
    "/api/work-packages",
    { filename, data_base64: bytes.toString("base64"), sha256 },
  );
  return {
    id: res.work_package.id,
    sha256,
    sizeBytes: res.work_package.size_bytes,
    fileCount: acc.files.length,
    truncated: acc.truncated,
  };
}
