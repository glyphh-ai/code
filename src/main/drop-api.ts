/**
 * drop-api — fetch wrappers for the Drop's GH-bound session.
 *
 * THE-PIVOT-GITHUB Phase 1. Mirrors `serverGetAuthed` / `serverPostAuthed`
 * from auth.ts but pulls the Bearer token from the Drop session
 * (`~/yo/.session.drop`) instead of the main yo session. This is what makes
 * Drop reads/writes carry the gh_user_id claim — required by every Phase 11+
 * endpoint.
 *
 * Returns a tagged result so callers don't need to throw/catch in IPC
 * handlers: `{ ok: true, data }` or `{ ok: false, error, status? }`.
 */

import { getDropAccessToken } from "./drop-auth";

const AUTH_SERVER = process.env.YO_AUTH_SERVER || "https://api.yosup.dev";

export type DropApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; needsSignIn?: boolean };

async function dropFetch<T>(method: string, pathname: string, body?: unknown): Promise<DropApiResult<T>> {
  const token = getDropAccessToken();
  if (!token) {
    return { ok: false, error: "not signed into GitHub", needsSignIn: true };
  }
  let res: Response;
  try {
    res = await fetch(`${AUTH_SERVER}${pathname}`, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const detail = (parsed && typeof parsed === "object" && "error" in parsed)
      ? String((parsed as Record<string, unknown>).error)
      : (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
    return { ok: false, error: detail, status: res.status };
  }
  return { ok: true, data: parsed as T };
}

export const dropApi = {
  // ── Projects (Phase 11 + 14 + 15 — all server-side 501 today) ─────────
  projectsMine: () => dropFetch<unknown>("GET", "/api/projects/mine"),
  projectDiscover: (opts?: { q?: string; mode?: string; capability?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.q) p.set("q", opts.q);
    if (opts?.mode) p.set("mode", opts.mode);
    if (opts?.capability) p.set("capability", opts.capability);
    if (opts?.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    return dropFetch<unknown>("GET", `/api/projects/discover${qs ? "?" + qs : ""}`);
  },
  projectGet: (ref: string, withParts?: string[]) => {
    const p = new URLSearchParams();
    if (withParts?.length) p.set("with", withParts.join(","));
    const qs = p.toString();
    return dropFetch<unknown>("GET", `/api/projects/${encodeURIComponent(ref)}${qs ? "?" + qs : ""}`);
  },
  projectBoard: (ref: string) =>
    dropFetch<unknown>("GET", `/api/projects/${encodeURIComponent(ref)}/board`),
  projectCreate: (input: Record<string, unknown>) =>
    dropFetch<unknown>("POST", "/api/projects", input),
  projectStart: (ref: string) =>
    dropFetch<unknown>("POST", `/api/projects/${encodeURIComponent(ref)}/start`, {}),
  projectWrap: (ref: string) =>
    dropFetch<unknown>("POST", `/api/projects/${encodeURIComponent(ref)}/wrap`, {}),

  // ── Installations + repos (Phase 11) ──────────────────────────────────
  installationsList: () =>
    dropFetch<unknown>("GET", "/api/me/installations"),
  reposForInstallation: (ownerLogin: string) =>
    dropFetch<unknown>("GET", `/api/me/installations/${encodeURIComponent(ownerLogin)}/repos`),

  // ── Heartbeat (Phase 12) ──────────────────────────────────────────────
  heartbeat: (loadout: { id: string; capabilities: string[]; max_concurrent: number }) =>
    dropFetch<unknown>("POST", "/api/me/heartbeat", loadout),
};
