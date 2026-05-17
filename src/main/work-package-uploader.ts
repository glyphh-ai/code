/**
 * work-package-uploader — zip a jammer's sandbox and upload it to yo-server
 * as a work package.
 *
 * This is the no-VCS fallback: a jammer that cannot push to GitHub hands its
 * finished work off this way. The maestro (who has the repo + credentials)
 * downloads the package via /api/work-packages/:id/download, reviews it, and
 * integrates it. A remote jammer therefore needs only a filesystem — git is
 * an optimization, never a requirement.
 */

import fs from "fs";
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
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface UploadResult {
  id: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

function addDir(zip: AdmZip, dir: string, base: string, count: { n: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      addDir(zip, full, base, count);
    } else if (entry.isFile()) {
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        const rel = path.relative(base, full);
        const folder = path.dirname(rel);
        zip.addLocalFile(full, folder === "." ? "" : folder);
        count.n++;
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
  const zip = new AdmZip();
  const count = { n: 0 };
  addDir(zip, sandboxDir, sandboxDir, count);
  if (count.n === 0) throw new Error("nothing to submit — no files in the working directory");

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
    fileCount: count.n,
  };
}
