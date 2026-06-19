/**
 * work-package-fetcher — pull a cypher's work package zip from yo-server
 * (server proxies from R2 in prod, FS in dev) and extract it into a session-
 * scoped sandbox dir.
 *
 * v1: server-proxied download (matches /api/work-packages/:id/download).
 * Phase 3.5: presigned R2 GET URL so the client downloads direct (no server
 * bandwidth, faster for big packages).
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { net } from "electron";
import AdmZip from "adm-zip";
import { getAuthToken } from "./auth";

const AUTH_SERVER = process.env.YO_AUTH_SERVER || "https://api.glyphh.ai";

export interface FetchOpts {
  workPackageId: string;
  /** Where to put the extracted contents. Created if missing. */
  destDir: string;
  /** Expected sha256 — verified against downloaded bytes; throws if mismatch. */
  expectedSha256?: string;
}

export interface FetchResult {
  destDir: string;
  size_bytes: number;
  sha256: string;
  files: number;
}

export async function fetchAndExtractWorkPackage(opts: FetchOpts): Promise<FetchResult> {
  const token = getAuthToken();
  if (!token) throw new Error("Not authenticated");
  fs.mkdirSync(opts.destDir, { recursive: true });

  const bytes = await downloadBinary(`/api/work-packages/${encodeURIComponent(opts.workPackageId)}/download`, token);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
    throw new Error(`work-package sha256 mismatch (expected ${opts.expectedSha256}, got ${sha256})`);
  }

  // Stage to tmp file then unzip — adm-zip handles in-memory but writing first
  // gives clean file handles and avoids holding the buffer twice.
  const tmpZip = path.join(os.tmpdir(), `yo-wp-${process.pid}-${Date.now()}.zip`);
  fs.writeFileSync(tmpZip, bytes);
  try {
    const zip = new AdmZip(tmpZip);
    const entries = zip.getEntries();
    let files = 0;
    for (const e of entries) {
      // Defense against zip-slip: refuse entries that escape the dest dir.
      const target = path.resolve(opts.destDir, e.entryName);
      if (!target.startsWith(path.resolve(opts.destDir) + path.sep) && target !== path.resolve(opts.destDir)) {
        throw new Error(`zip entry escapes dest: ${e.entryName}`);
      }
      if (e.isDirectory) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, e.getData());
        files++;
      }
    }
    return { destDir: opts.destDir, size_bytes: bytes.length, sha256, files };
  } finally {
    try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
  }
}

function downloadBinary(endpoint: string, token: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: `${AUTH_SERVER}${endpoint}`, method: "GET" });
    req.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { req.abort(); reject(new Error("Download timeout")); }, 60_000);

    const chunks: Buffer[] = [];
    req.on("response", (response) => {
      const status = response.statusCode ?? 500;
      response.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
      response.on("end", () => {
        clearTimeout(timer);
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status} downloading work package`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}
