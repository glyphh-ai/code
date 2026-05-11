import { contextBridge, ipcRenderer } from "electron";

interface DropAPI {
  // Cyphers — discovery + lifecycle
  cyphersDiscover: (opts?: { status?: string; type?: string; limit?: number; offset?: number }) => Promise<unknown>;
  cyphersMine: () => Promise<unknown>;
  cypherCreate: (input: Record<string, unknown>) => Promise<unknown>;
  cypherPublish: (id: string, opts?: { initial_kitty_deposit?: number; lobby_duration_seconds?: number | null }) => Promise<unknown>;
  cypherStart: (id: string) => Promise<unknown>;
  cypherCancel: (id: string) => Promise<unknown>;
  cypherDelete: (id: string) => Promise<unknown>;
  cypherUpdateMeta: (id: string, patch: { title?: string; goal?: string; description?: string; max_jammers?: number | null }) => Promise<unknown>;
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
  leaderboardTopCyphers: (limit?: number) => Promise<unknown>;
  leaderboardTopJammers: (limit?: number) => Promise<unknown>;

  // Agent registry CRUD
  agentsList: () => Promise<unknown>;
  agentsGet: (id: string) => Promise<unknown>;
  agentsSave: (cfg: unknown) => Promise<unknown>;
  agentsRemove: (id: string) => Promise<unknown>;
  agentsIdAvailable: (id: string) => Promise<unknown>;

  // Cover image
  cypherCoverGenerate: (opts: { title: string; goal?: string; vibe?: string; customPrompt?: string }) =>
    Promise<{ ok: true; data_base64: string; content_type: string; prompt_used: string } | { ok: false; error: string }>;
  cypherCoverGet: (id: string) => Promise<{ ok: boolean; data_base64?: string; content_type?: string }>;
  cypherCoverUpload: (id: string, dataBase64: string, contentType?: string) => Promise<unknown>;
  cypherCoverDelete: (id: string) => Promise<unknown>;

  // Apps (for jammer app picker)
  appsList: () => Promise<Array<{
    id: string; name: string; url?: string; connected: boolean;
    commands: Record<string, { description: string }>;
    connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
    mcp?: { enabled: boolean };
    meta?: { description: string; capabilities: string[] };
  }>>;

  // MCP tools per connected server
  mcpToolsList: () => Promise<Array<{
    serverId: string; serverName: string;
    name: string; qualifiedName: string; description: string;
  }>>;

  // Avatar generation
  agentAvatarGenerate: (opts: { name: string; role?: string; bio?: string }) =>
    Promise<{ ok: true; data_base64: string; content_type: string } | { ok: false; error: string }>;

  // Models for the model picker
  modelsList: () => Promise<unknown>;

  // Skills
  skillsList: () => Promise<string[]>;
  skillsListDetailed: () => Promise<Array<{
    name: string; description?: string;
    requires?: string[]; allowedTools?: string[];
  }>>;

  // Config
  getApiBase: () => string;

  // Cypher Mode panel
  cypherPanelActivate: (cypherId: string, isOwner: boolean, title?: string) => Promise<unknown>;

  // Misc
  execCommand: (cmd: string) => Promise<unknown>;
  ghAppInstall: () => Promise<{ ok: boolean; installed?: boolean; error?: string }>;
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
  cypherDelete: (id) => ipcRenderer.invoke("cypher-delete", id),
  cypherUpdateMeta: (id, patch) => ipcRenderer.invoke("cypher-update-meta", id, patch),
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
  leaderboardTopCyphers: (limit) => ipcRenderer.invoke("leaderboard-top-cyphers", limit),
  leaderboardTopJammers: (limit) => ipcRenderer.invoke("leaderboard-top-jammers", limit),
  agentsList: () => ipcRenderer.invoke("agents-list"),
  agentsGet: (id) => ipcRenderer.invoke("agents-get", id),
  agentsSave: (cfg) => ipcRenderer.invoke("agents-save", cfg),
  agentsRemove: (id) => ipcRenderer.invoke("agents-remove", id),
  agentsIdAvailable: (id) => ipcRenderer.invoke("agents-id-available", id),
  appsList: () => ipcRenderer.invoke("apps-list"),
  mcpToolsList: () => ipcRenderer.invoke("mcp-tools-list"),
  agentAvatarGenerate: (opts) => ipcRenderer.invoke("agent-avatar-generate", opts),
  cypherCoverGenerate: (opts) => ipcRenderer.invoke("cypher-cover-generate", opts),
  cypherCoverGet: (id) => ipcRenderer.invoke("cypher-cover-get", id),
  cypherCoverUpload: (id, dataBase64, contentType) => ipcRenderer.invoke("cypher-cover-upload", id, dataBase64, contentType),
  cypherCoverDelete: (id) => ipcRenderer.invoke("cypher-cover-delete", id),
  modelsList: () => ipcRenderer.invoke("models-list"),
  skillsList: () => ipcRenderer.invoke("skills-list"),
  skillsListDetailed: () => ipcRenderer.invoke("skills-list-detailed"),
  getApiBase: () => process.env.YO_AUTH_SERVER || "https://api.yosup.dev",
  cypherPanelActivate: (cypherId, isOwner, title) => ipcRenderer.invoke("cypher-panel-activate", cypherId, isOwner, title),
  execCommand: (cmd) => ipcRenderer.invoke("exec-command", cmd),
  ghAppInstall: () => ipcRenderer.invoke("gh-app-install"),
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

ipcRenderer.on("theme-changed", (_e, resolved: string) => {
  document.documentElement.setAttribute("data-theme", resolved);
  try { localStorage.setItem("yoTheme", resolved); } catch {}
});
