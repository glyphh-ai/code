import { contextBridge, ipcRenderer } from "electron";

interface DropAPI {
  // Cyphers — discovery + lifecycle
  cyphersDiscover: (opts?: { status?: string; type?: string; limit?: number; offset?: number }) => Promise<unknown>;
  cyphersMine: () => Promise<unknown>;
  cypherCreate: (input: Record<string, unknown>) => Promise<unknown>;
  cypherPublish: (id: string, opts?: { initial_kitty_deposit?: number; lobby_duration_seconds?: number | null }) => Promise<unknown>;
  cypherStart: (id: string) => Promise<unknown>;
  cypherCancel: (id: string) => Promise<unknown>;
  cypherDraftGet: (id: string) => Promise<unknown>;
  cypherRedraft: (id: string, opts?: { ratio?: number }) => Promise<unknown>;
  cypherDecline: (id: string, agent_local_id: string) => Promise<unknown>;
  cypherWrap: (id: string) => Promise<unknown>;
  cypherEventsList: (id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => Promise<unknown>;
  cypherSetCurrent: (id: string | null) => Promise<unknown>;
  cypherSpawnJammers: (id: string) => Promise<unknown>;
  authMe: () => Promise<unknown>;
  devFlags: () => Promise<{ cyphersEnabled: boolean }>;
  cypherGet: (id: string) => Promise<unknown>;
  cypherJammers: (id: string) => Promise<unknown>;
  cypherJoin: (id: string, agent_local_id: string, role?: string, invite_token?: string) => Promise<unknown>;
  cypherLeave: (id: string, agent_local_id: string) => Promise<unknown>;

  // Leaderboard
  agentsLeaderboard: (opts?: { skills?: string; days?: number; limit?: number }) => Promise<unknown>;

  // Agent registry CRUD
  agentsList: () => Promise<unknown>;
  agentsGet: (id: string) => Promise<unknown>;
  agentsSave: (cfg: unknown) => Promise<unknown>;
  agentsRemove: (id: string) => Promise<unknown>;
  agentsIdAvailable: (id: string) => Promise<unknown>;

  // Models for the model picker
  modelsList: () => Promise<unknown>;

  // Misc
  execCommand: (cmd: string) => Promise<unknown>;
  /** Subscribe to live cypher SSE events forwarded by main. Returns an unsubscribe fn. */
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;

  // ── THE-PIVOT-GITHUB Phase 1+: scoped GH binding + Projects API ─────
  ghStatus: () => Promise<{ signedIn: boolean; github: { gh_login: string; gh_avatar: string } | null; expiresAt: number | null }>;
  signInWithGitHub: () => Promise<{ ok: true; status: { signedIn: boolean; github: { gh_login: string; gh_avatar: string } | null; expiresAt: number | null } } | { ok: false; error: string; status?: number }>;
  signOutGitHub: () => Promise<{ ok: true }>;

  projectsMine: () => Promise<unknown>;
  projectDiscover: (opts?: { q?: string; mode?: string; capability?: string; limit?: number }) => Promise<unknown>;
  projectGet: (ref: string, withParts?: string[]) => Promise<unknown>;
  projectBoard: (ref: string) => Promise<unknown>;
  projectCreate: (input: Record<string, unknown>) => Promise<unknown>;
  projectStart: (ref: string) => Promise<unknown>;
  projectWrap: (ref: string) => Promise<unknown>;

  installationsList: () => Promise<unknown>;
  reposForInstallation: (owner: string) => Promise<unknown>;
}

const api: DropAPI = {
  cyphersDiscover: (opts) => ipcRenderer.invoke("cypher-discover", opts),
  cyphersMine: () => ipcRenderer.invoke("cypher-list-mine"),
  cypherCreate: (input) => ipcRenderer.invoke("cypher-create", input),
  cypherPublish: (id, opts) => ipcRenderer.invoke("cypher-publish", id, opts),
  cypherStart: (id) => ipcRenderer.invoke("cypher-start", id),
  cypherCancel: (id) => ipcRenderer.invoke("cypher-cancel", id),
  cypherDraftGet: (id) => ipcRenderer.invoke("cypher-draft-get", id),
  cypherRedraft: (id, opts) => ipcRenderer.invoke("cypher-redraft", id, opts),
  cypherDecline: (id, agentLocalId) => ipcRenderer.invoke("cypher-decline", id, agentLocalId),
  cypherWrap: (id) => ipcRenderer.invoke("cypher-wrap", id),
  cypherEventsList: (id, opts) => ipcRenderer.invoke("cypher-events-list", id, opts),
  cypherSetCurrent: (id) => ipcRenderer.invoke("cypher-set-current", id),
  cypherSpawnJammers: (id) => ipcRenderer.invoke("cypher-spawn-jammers", id),
  authMe: () => ipcRenderer.invoke("auth-me"),
  devFlags: () => ipcRenderer.invoke("dev-flags"),
  cypherGet: (id) => ipcRenderer.invoke("cypher-get", id),
  cypherJammers: (id) => ipcRenderer.invoke("cypher-jammers", id),
  cypherJoin: (id, agent_local_id, role, invite_token) =>
    ipcRenderer.invoke("cypher-join", id, agent_local_id, role, invite_token),
  cypherLeave: (id, agent_local_id) => ipcRenderer.invoke("cypher-leave", id, agent_local_id),
  agentsLeaderboard: (opts) => ipcRenderer.invoke("agents-leaderboard", opts),
  agentsList: () => ipcRenderer.invoke("agents-list"),
  agentsGet: (id) => ipcRenderer.invoke("agents-get", id),
  agentsSave: (cfg) => ipcRenderer.invoke("agents-save", cfg),
  agentsRemove: (id) => ipcRenderer.invoke("agents-remove", id),
  agentsIdAvailable: (id) => ipcRenderer.invoke("agents-id-available", id),
  modelsList: () => ipcRenderer.invoke("models-list"),
  execCommand: (cmd) => ipcRenderer.invoke("exec-command", cmd),
  onCypherEvent: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, cypherId: string, kind: string, payload: Record<string, unknown>) =>
      cb(cypherId, kind, payload);
    ipcRenderer.on("cypher-event", handler);
    return () => { ipcRenderer.removeListener("cypher-event", handler); };
  },

  // ── THE-PIVOT-GITHUB ──────────────────────────────────────────────
  ghStatus: () => ipcRenderer.invoke("drop-gh-status"),
  signInWithGitHub: () => ipcRenderer.invoke("drop-gh-sign-in"),
  signOutGitHub: () => ipcRenderer.invoke("drop-gh-sign-out"),

  projectsMine: () => ipcRenderer.invoke("projects-mine"),
  projectDiscover: (opts) => ipcRenderer.invoke("projects-discover", opts),
  projectGet: (ref, withParts) => ipcRenderer.invoke("project-get", ref, withParts),
  projectBoard: (ref) => ipcRenderer.invoke("project-board", ref),
  projectCreate: (input) => ipcRenderer.invoke("project-create", input),
  projectStart: (ref) => ipcRenderer.invoke("project-start", ref),
  projectWrap: (ref) => ipcRenderer.invoke("project-wrap", ref),

  installationsList: () => ipcRenderer.invoke("installations-list"),
  reposForInstallation: (owner) => ipcRenderer.invoke("repos-for-installation", owner),
};

contextBridge.exposeInMainWorld("drop", api);
