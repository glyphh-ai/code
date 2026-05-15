/**
 * Cypher CRUD IPC handlers — extracted from main.ts.
 *
 * Registers all ipcMain.handle calls for cypher lifecycle,
 * cover images, avatar generation, and auth-me.
 */

import { ipcMain, net } from "electron";
import path from "path";
import os from "os";
import type { AgentMode } from "./action-gate";
import fs from "fs";

const SERVER = process.env.YO_AUTH_SERVER || "https://api.yosup.dev";

export interface CypherCrudDeps {
  serverGetAuthed: typeof import("./auth").serverGetAuthed;
  serverPostAuthed: typeof import("./auth").serverPostAuthed;
  getAuthToken: () => string | null;
  getDropAccessToken: () => string | null;
  subscribeCypher: (id: string, agentId: string) => void;
  unsubscribeCypher: (id: string) => void;
  getCypherPanelContext: () => { cypherId: string } | null;
  setCypherPanelContext: (ctx: { cypherId: string; isOwner: boolean; title?: string } | null) => void;
  setPreference: (key: string, val: unknown) => void;
  /**
   * Bind the active workspace to a cypher (writes the `workspaceCypher` pref
   * map). This binding is what `CypherBus.getCypherForWorkspace` and
   * `buildAgentConfig` read — without it, outbound bus events are dropped and
   * agents fall back to the file inbox instead of the cypher bus.
   */
  bindWorkspaceToCypher: (cypherId: string) => void;
  getMainWindow: () => import("electron").BrowserWindow | null;
  panelManager: {
    closePanel: (id: string, parent: import("electron").BrowserWindow, fallback: string) => void;
    switchTo: (id: string, parent: import("electron").BrowserWindow) => void;
    getView: (id: string) => { webContents: import("electron").WebContents } | null;
  };
  jammerPreviewPanels: Set<string>;
  getProviderKey: (provider: string) => string | null;
  yoAgent: { clear: () => void; setCypherMode: (on: boolean) => void; setMode: (m: AgentMode) => void };
  yoInterceptor: { setAgentMode: (m: string) => void };
  openYoPanel: (query: string) => void;
  activateCypherSession: (cypId: string) => Promise<void>;
}

function buildCoverPrompt(title: string, goal?: string, vibe?: string): string {
  const vibeStyle: Record<string, string> = {
    open: "vibrant open-world atmosphere, collaborative energy, warm neon glow",
    bounty: "intense bounty-hunter aesthetic, dark dramatic lighting, reward poster vibe",
    coop: "team coordination feel, interconnected nodes, cooperative synergy",
    sponsored: "premium corporate event poster, sleek and polished, gold accents",
  };
  const mood = vibeStyle[vibe || "open"] || vibeStyle.open;
  const goalClause = goal ? ` The project goal: "${goal.slice(0, 120)}".` : "";
  return `Digital art, wide cinematic composition (3:2 aspect ratio). A visually striking cover image for a coding cypher called "${title}".${goalClause} Style: ${mood}. Abstract tech-art with depth, NOT a screenshot or UI mockup. No text or lettering in the image. Rich color palette, high contrast, atmospheric lighting.`;
}

export async function registerCypherCrudIpc(deps: CypherCrudDeps): Promise<void> {
  const {
    serverGetAuthed,
    serverPostAuthed,
    getAuthToken,
    getDropAccessToken,
    subscribeCypher,
    unsubscribeCypher,
    getCypherPanelContext,
    setCypherPanelContext,
    setPreference,
    bindWorkspaceToCypher,
    getMainWindow,
    panelManager,
    jammerPreviewPanels,
    getProviderKey,
    yoAgent,
    yoInterceptor,
    openYoPanel,
    activateCypherSession,
  } = deps;

  // ── Cyphers IPC handlers ───────────────────────────────
  ipcMain.handle("cypher-create", async (_e, input: Record<string, unknown>) => {
    try { return await serverPostAuthed("/api/cyphers", input); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "create failed" }; }
  });
  ipcMain.handle("cypher-update", async (_e, id: string, patch: Record<string, unknown>) => {
    try {
      // PATCH not exposed in serverPostAuthed; reuse POST against PATCH-shaped endpoint via fetch
      // For now we emulate via a dedicated path — the server route uses app.patch, so we add a small helper.
      const token = getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      return await new Promise((resolve, reject) => {
        const req = net.request({ url: `${SERVER}/api/cyphers/${encodeURIComponent(id)}`, method: "PATCH" });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); }
          });
        });
        req.on("error", reject);
        req.write(JSON.stringify(patch));
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "update failed" }; }
  });
  ipcMain.handle("cypher-update-meta", async (_e, id: string, patch: Record<string, unknown>) => {
    try {
      const token = getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      return await new Promise((resolve, reject) => {
        const req = net.request({ url: `${SERVER}/api/cyphers/${encodeURIComponent(id)}/meta`, method: "PATCH" });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
        });
        req.on("error", reject);
        req.write(JSON.stringify(patch));
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "update failed" }; }
  });
  ipcMain.handle("cypher-publish", async (_e, id: string, opts?: Record<string, unknown>) => {
    try {
      const body: Record<string, unknown> = {
        initial_kitty_deposit: opts?.initial_kitty_deposit ?? 0,
      };
      if (opts && "lobby_duration_seconds" in opts) body.lobby_duration_seconds = opts.lobby_duration_seconds;
      if (opts?.github) body.github = opts.github;
      return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/publish`, body);
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "publish failed" }; }
  });
  ipcMain.handle("cypher-start", async (_e, id: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/start`, {}); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "start failed" }; }
  });
  ipcMain.handle("cypher-draft-get", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/draft`); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "draft fetch failed" }; }
  });
  ipcMain.handle("cypher-redraft", async (_e, id: string, opts?: { ratio?: number }) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/redraft`, opts || {}); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "redraft failed" }; }
  });
  ipcMain.handle("cypher-decline", async (_e, id: string, agent_local_id: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/decline`, { agent_local_id }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "decline failed" }; }
  });
  ipcMain.handle("cypher-wrap", async (_e, id: string) => {
    try {
      const result = await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/wrap`, {});
      if (getCypherPanelContext()?.cypherId === id) {
        setCypherPanelContext(null);
        setPreference("cypherPanelContext", null);
        const { setCurrentCypher } = await import("./current-cypher");
        setCurrentCypher(null);
      }
      // Close jammer preview panels
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        for (const pid of jammerPreviewPanels) {
          panelManager.closePanel(pid, mainWindow, "cypher");
        }
      }
      jammerPreviewPanels.clear();
      return result;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "wrap failed" }; }
  });
  ipcMain.handle("cypher-cancel", async (_e, id: string) => {
    try {
      const result = await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/cancel`, {});
      if (getCypherPanelContext()?.cypherId === id) {
        setCypherPanelContext(null);
        setPreference("cypherPanelContext", null);
        const { setCurrentCypher } = await import("./current-cypher");
        setCurrentCypher(null);
      }
      return result;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "cancel failed" }; }
  });
  ipcMain.handle("cypher-delete", async (_e, id: string) => {
    try {
      const token = getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      const result = await new Promise((resolve, reject) => {
        const req = net.request({
          url: `${SERVER}/api/cyphers/${encodeURIComponent(id)}`,
          method: "DELETE",
        });
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
        });
        req.on("error", reject);
        req.end();
      });
      if (getCypherPanelContext()?.cypherId === id) {
        setCypherPanelContext(null);
        setPreference("cypherPanelContext", null);
        const { setCurrentCypher } = await import("./current-cypher");
        setCurrentCypher(null);
      }
      // Clean up local cypher data (thread logs, feed, jammer sandboxes)
      const localDirs = [
        path.join(os.homedir(), "yo", "cyphers", id),
        path.join(os.homedir(), ".yo", "cyphers", id),
      ];
      for (const dir of localDirs) {
        fs.rm(dir, { recursive: true, force: true }, (err) => {
          if (err) console.warn(`[cypher-delete] failed to remove ${dir}:`, err.message);
          else console.log(`[cypher-delete] cleaned up ${dir}`);
        });
      }
      return result;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "delete failed" }; }
  });
  ipcMain.handle("cypher-discover", async (_e, opts?: { status?: string; type?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set("status", opts.status);
    if (opts?.type) p.set("type", opts.type);
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.offset) p.set("offset", String(opts.offset));
    const qs = p.toString();
    try { return await serverGetAuthed(`/api/cyphers/discover${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "discover failed" }; }
  });
  ipcMain.handle("cypher-list-mine", async () => {
    try { return await serverGetAuthed(`/api/cyphers/mine`); }
    catch (err) { return { error: err instanceof Error ? err.message : "list failed" }; }
  });
  ipcMain.handle("cypher-get", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "get failed" }; }
  });
  ipcMain.handle("cypher-get-by-slug", async (_e, slug: string) => {
    try { return await serverGetAuthed(`/api/cyphers/by-slug/${encodeURIComponent(slug)}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "get failed" }; }
  });
  ipcMain.handle("cypher-join", async (_e, id: string, agent_local_id: string, role?: string, invite_token?: string) => {
    try {
      const r = await serverPostAuthed<{ ok: boolean; cypher?: { id: string }; error?: string }>(
        `/api/cyphers/${encodeURIComponent(id)}/join`,
        { agent_local_id, role, invite_token },
      );
      // If join succeeded and we're not just observing, subscribe to the SSE
      // event stream AND bind the workspace to this cypher. The binding is
      // required for the outbound bus (CypherBus.post) and for agents to start
      // on the bus rather than the file inbox — see buildAgentConfig.
      if (r.ok && role !== "observer") {
        subscribeCypher(id, agent_local_id);
        bindWorkspaceToCypher(id);
      }
      return r;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "join failed" }; }
  });
  ipcMain.handle("cypher-invite-mint", async (_e, id: string, opts?: { role?: string; ttl_seconds?: number; multi_use?: boolean; invitee_user_id?: string }) => {
    try {
      return await serverPostAuthed(
        `/api/cyphers/${encodeURIComponent(id)}/invites`,
        { role: opts?.role, ttl_seconds: opts?.ttl_seconds, multi_use: opts?.multi_use, invitee_user_id: opts?.invitee_user_id },
      );
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "invite mint failed" }; }
  });
  ipcMain.handle("cypher-invite-list", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/invites`); }
    catch (err) { return { error: err instanceof Error ? err.message : "invite list failed" }; }
  });
  ipcMain.handle("cypher-invite-revoke", async (_e, id: string, jti: string) => {
    try {
      return await serverPostAuthed(
        `/api/cyphers/${encodeURIComponent(id)}/invites/${encodeURIComponent(jti)}/revoke`,
        {},
      );
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "invite revoke failed" }; }
  });
  ipcMain.handle("cypher-leave", async (_e, id: string, agent_local_id: string) => {
    try {
      const r = await serverPostAuthed<{ ok: boolean }>(`/api/cyphers/${encodeURIComponent(id)}/leave`, { agent_local_id });
      unsubscribeCypher(id);
      return r;
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "leave failed" }; }
  });
  ipcMain.handle("cypher-jammers", async (_e, id: string, opts?: { limit?: number; offset?: number }) => {
    try {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/jammers${qs ? `?${qs}` : ""}`);
    } catch (err) { return { error: err instanceof Error ? err.message : "jammers failed" }; }
  });
  ipcMain.handle("cypher-jams-list", async (_e, id: string) => {
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/jams`); }
    catch (err) { return { error: err instanceof Error ? err.message : "jams failed" }; }
  });
  ipcMain.handle("cypher-jam-create", async (_e, id: string, slug: string, title: string, description?: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/jams`, { slug, title, description }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "jam create failed" }; }
  });
  ipcMain.handle("cypher-jam-set-state", async (_e, id: string, jam_id: string, expected_version: number, state: unknown) => {
    try {
      const token = getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      return await new Promise((resolve, reject) => {
        const req = net.request({ url: `${SERVER}/api/cyphers/${encodeURIComponent(id)}/jams/${encodeURIComponent(jam_id)}/state`, method: "PUT" });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
        });
        req.on("error", reject);
        req.write(JSON.stringify({ expected_version, state }));
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "set state failed" }; }
  });
  ipcMain.handle("cypher-event-post", async (_e, id: string, kind: string, payload: unknown, jam_id?: string, by_agent_id?: string) => {
    try { return await serverPostAuthed(`/api/cyphers/${encodeURIComponent(id)}/events`, { kind, payload, jam_id, by_agent_id }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "event post failed" }; }
  });
  ipcMain.handle("cypher-events-list", async (_e, id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.since != null) p.set("since", String(opts.since));
    if (opts?.jam_id) p.set("jam_id", opts.jam_id);
    if (opts?.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    try { return await serverGetAuthed(`/api/cyphers/${encodeURIComponent(id)}/events${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "events failed" }; }
  });
  // cypher-kitty-* handlers neutralized in Phase 7 of THE-PIVOT-BYOK.
  // The server endpoints are gone; the legacy yo://cypher panel still
  // calls these, so we return zeroed shapes locally instead of fetching.
  ipcMain.handle("cypher-kitty-deposit", async () => ({ ok: true, kitty_balance: 0 }));
  ipcMain.handle("cypher-kitty-balance", async () => ({ balance: 0 }));
  ipcMain.handle("cypher-kitty-ledger", async () => ({ entries: [], count: 0 }));

  // ── Cover image: upload, delete, AI generate ────────────
  ipcMain.handle("cypher-cover-get", async (_e, id: string) => {
    try {
      const url = `${SERVER}/api/cyphers/${encodeURIComponent(id)}/cover`;
      return await new Promise((resolve) => {
        const req = net.request({ url, method: "GET" });
        const chunks: Buffer[] = [];
        req.on("response", (r) => {
          if (r.statusCode !== 200) { resolve({ ok: false }); return; }
          const ct = r.headers["content-type"];
          const contentType = Array.isArray(ct) ? ct[0] : ct || "image/png";
          r.on("data", (c) => { chunks.push(Buffer.from(c)); });
          r.on("end", () => {
            const buf = Buffer.concat(chunks);
            resolve({ ok: true, data_base64: buf.toString("base64"), content_type: contentType });
          });
        });
        req.on("error", () => { resolve({ ok: false }); });
        req.end();
      });
    } catch { return { ok: false }; }
  });

  ipcMain.handle("cypher-cover-upload", async (_e, id: string, dataBase64: string, contentType?: string) => {
    try {
      const token = getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      return await new Promise((resolve, reject) => {
        const req = net.request({
          url: `${SERVER}/api/cyphers/${encodeURIComponent(id)}/cover`,
          method: "PUT",
        });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
        });
        req.on("error", reject);
        req.write(JSON.stringify({ data_base64: dataBase64, content_type: contentType || "image/png" }));
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "cover upload failed" }; }
  });

  ipcMain.handle("cypher-cover-delete", async (_e, id: string) => {
    try {
      const token = getAuthToken();
      if (!token) return { ok: false, error: "Not authenticated" };
      return await new Promise((resolve, reject) => {
        const req = net.request({
          url: `${SERVER}/api/cyphers/${encodeURIComponent(id)}/cover`,
          method: "DELETE",
        });
        req.setHeader("Authorization", `Bearer ${token}`);
        let body = "";
        req.on("response", (r) => {
          r.on("data", (c) => { body += c.toString(); });
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid response")); } });
        });
        req.on("error", reject);
        req.end();
      });
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "cover delete failed" }; }
  });

  ipcMain.handle("agent-avatar-generate", async (_e, opts: { name: string; role?: string; bio?: string }) => {
    try {
      const openaiKey = getProviderKey("openai");
      if (!openaiKey) return { ok: false, error: "No OpenAI key configured. Go to Settings → Providers to add one." };

      const roleClause = opts.role ? ` Their role is "${opts.role.slice(0, 80)}".` : "";
      const bioClause = opts.bio ? ` Personality: "${opts.bio.slice(0, 120)}".` : "";
      const prompt = `Digital art portrait avatar for an AI agent named "${opts.name}".${roleClause}${bioClause} Style: clean vector illustration, geometric, vibrant single accent color on dark background, no text, no lettering, abstract face or symbolic icon, suitable for a 1:1 profile picture at small sizes.`;

      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: "gpt-image-1", prompt, n: 1, size: "1024x1024", quality: "medium" }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return { ok: false, error: `OpenAI error (${resp.status}): ${err.slice(0, 300)}` };
      }
      const json = await resp.json() as { data?: Array<{ b64_json?: string }> };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) return { ok: false, error: "No image data in response" };
      return { ok: true, data_base64: b64, content_type: "image/png" };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "generation failed" }; }
  });

  ipcMain.handle("cypher-cover-generate", async (_e, opts: { title: string; goal?: string; vibe?: string; customPrompt?: string }) => {
    try {
      const openaiKey = getProviderKey("openai");
      if (!openaiKey) return { ok: false, error: "No OpenAI key configured. Go to Settings → Providers to add one." };

      const imagePrompt = opts.customPrompt || buildCoverPrompt(opts.title, opts.goal, opts.vibe);

      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: imagePrompt,
          n: 1,
          size: "1536x1024",
          quality: "high",
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return { ok: false, error: `OpenAI error (${resp.status}): ${err.slice(0, 300)}` };
      }

      const json = await resp.json() as { data?: Array<{ b64_json?: string }> };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) return { ok: false, error: "No image data in response" };

      return { ok: true, data_base64: b64, content_type: "image/png", prompt_used: imagePrompt };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : "generation failed" }; }
  });

  ipcMain.handle("auth-me", async () => {
    try {
      return await serverGetAuthed<{ id: string; email: string; role: string }>("/api/auth/me");
    } catch {
      // Yo auth session missing — try the Drop session (GitHub OAuth users)
      const dropToken = getDropAccessToken();
      if (!dropToken) return { error: "not authenticated" };
      try {
        const r = await fetch(`${SERVER}/api/auth/me`, {
          headers: { Authorization: `Bearer ${dropToken}` },
        });
        if (r.ok) return await r.json();
        return { error: `auth lookup failed (${r.status})` };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "auth lookup failed" };
      }
    }
  });

  // ── "Current cypher" — what the .yo is piloting from The Drop's Workspace.
  // Renderer calls cypher-set-current on enter/leave; substrate cypher tools
  // read getCurrentCypher() to know which cypher to operate on.
  {
    const { setCurrentCypher } = await import("./current-cypher");
    ipcMain.handle("cypher-set-current", (_e, id: string | null) => {
      setCurrentCypher(id);
      return { ok: true };
    });

    ipcMain.handle("cypher-panel-context", () => getCypherPanelContext());

    ipcMain.handle("cypher-panel-activate", async (_e, cypherId: string, isOwner: boolean, title?: string) => {
      const ctx = getCypherPanelContext();
      const isSameCypher = ctx?.cypherId === cypherId;

      setCypherPanelContext({ cypherId, isOwner, title: title || undefined });
      setCurrentCypher(cypherId);
      // Bind the active workspace to this cypher so the bus routes outbound
      // events to the server (idempotent with the bind done at join time).
      bindWorkspaceToCypher(cypherId);

      const mainWindow = getMainWindow();
      if (mainWindow) panelManager.switchTo("cypher", mainWindow);

      const cypherView = panelManager.getView("cypher");
      if (cypherView) cypherView.webContents.send("cypher-context-ready");

      if (!isSameCypher) yoAgent.clear();
      yoAgent.setCypherMode(true);
      yoAgent.setMode("acceptEdits");
      setPreference("agentMode", "cypher");
      mainWindow?.webContents.send("agent-mode-changed", "cypher");
      yoInterceptor.setAgentMode("cypher");

      if (mainWindow && !mainWindow.isDestroyed()) openYoPanel("");

      try {
        await activateCypherSession(cypherId);
      } catch (err) {
        const msg = `Cypher activation failed: ${err instanceof Error ? err.message : err}`;
        console.error("[cypher-panel-activate]", msg);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("yo-panel-token", `❌ ${msg}\n`);
          mainWindow.webContents.send("yo-panel-done", msg);
        }
        return { ok: false, error: msg };
      }

      return { ok: true };
    });
  }
}
