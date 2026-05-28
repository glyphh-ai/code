/**
 * yo://agent — Agent app panel entry.
 *
 * Mounts a YoAgentRenderer over the right-rail-replica DOM in agent.html
 * (same IDs/classes as #yo-panel in index.html, so styles.css rules carry
 * over). Wires the renderer callbacks to per-instance agent:* IPCs from
 * agent-interactive.ts. Owns the workdir bar (folder picker + recents
 * dropdown + git branch + add-folder + animated .Yo dot) — the only
 * chrome difference between this app and the right-rail .Yo.
 */

import { createYoAgentRenderer, type PermMode, type ChatSummary } from "./yo-agent-renderer.js";

interface AgentApi {
  ensureDefault: () => Promise<{ slug: string }>;
  getKind: (slug: string) => Promise<{ kind: "standard" | "spec" | "vibe" }>;
  setKind: (slug: string, kind: "standard" | "spec" | "vibe") => Promise<{ ok: boolean; error?: string }>;
  start: (opts: { instanceId: string; agentSlug: string; cwd: string }) => Promise<unknown>;
  send: (instanceId: string, message: string, model: string, perm: PermMode) => Promise<unknown>;
  stop: (instanceId: string) => Promise<unknown>;
  clear: (instanceId: string) => Promise<unknown>;
  dispose: (instanceId: string) => Promise<unknown>;
  rebind: (instanceId: string, cwd: string) => Promise<unknown>;
  getCwd: () => Promise<string>;
  pickCwd: () => Promise<string | null>;
  setCwd: (dir: string) => Promise<string>;
  getCwdRecents: () => Promise<string[]>;
  gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
  gitBranches: (root: string) => Promise<{ branches: string[]; current?: string; error?: string }>;
  gitCheckout: (root: string, branch: string) => Promise<{ ok: boolean; branch?: string; error?: string }>;
  onCwdChanged: (cb: (dir: string | null) => void) => () => void;
  onEvent: (channel: string, cb: (...args: unknown[]) => void) => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

declare global { interface Window { agent: AgentApi } }

const FOLDER_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
const CHECK_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function makeInstanceId(): string {
  return `aii-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
function getSlugFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get("slug") || "default";
  } catch {
    return "default";
  }
}
function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function homeShorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

async function init(): Promise<void> {
  if (!window.agent) return;

  const slug = getSlugFromUrl();
  const id = makeInstanceId();

  await window.agent.ensureDefault();

  let cwd = await window.agent.getCwd().catch(() => "");

  // ── Workdir bar ──
  const workdirBtn = document.getElementById("workdir-btn") as HTMLButtonElement | null;
  const workdirName = document.getElementById("workdir-name");
  const workdirAdd = document.getElementById("workdir-add-btn") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("workdir-branch-wrap");
  const branchEl = document.getElementById("workdir-branch");

  // Dropdown lives at document level so it can escape the panel's overflow.
  const dropdown = document.createElement("div");
  dropdown.className = "yo-workdir-menu";
  dropdown.setAttribute("role", "menu");
  document.body.appendChild(dropdown);

  function closeDropdown(): void { dropdown.classList.remove("open"); }
  function isDropdownOpen(): boolean { return dropdown.classList.contains("open"); }

  async function paintWorkdirBar(dir: string): Promise<void> {
    if (workdirName) {
      workdirName.textContent = dir ? basename(dir) : "Pick a folder";
    }
    if (workdirBtn) workdirBtn.title = dir ? `working directory: ${dir}` : "Pick a folder";
    if (!dir) {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
      return;
    }
    try {
      const info = await window.agent.gitInfo(dir);
      if (info.isRepo && info.branch && branchWrap && branchEl) {
        branchEl.textContent = info.branch;
        (branchWrap as HTMLElement).style.display = "";
      } else if (branchWrap) {
        (branchWrap as HTMLElement).style.display = "none";
      }
    } catch {
      if (branchWrap) (branchWrap as HTMLElement).style.display = "none";
    }
  }

  async function openDropdown(): Promise<void> {
    const recents = await window.agent.getCwdRecents().catch(() => []);
    dropdown.innerHTML = "";
    const list = recents.length ? recents : (cwd ? [cwd] : []);
    for (const dir of list) {
      const item = document.createElement("button");
      item.className = "yo-workdir-menu-item";
      item.innerHTML =
        `<span class="check">${dir === cwd ? CHECK_SVG : ""}</span>` +
        `<span class="ic">${FOLDER_SVG}</span>` +
        `<span class="nm"></span>`;
      (item.querySelector(".nm") as HTMLElement).textContent = homeShorten(dir);
      item.title = dir;
      item.addEventListener("click", async () => {
        closeDropdown();
        if (dir !== cwd) {
          await window.agent.setCwd(dir);
          // setCwd broadcasts working-dir-changed which the onCwdChanged
          // subscriber below handles (paint + rebind).
        }
      });
      dropdown.appendChild(item);
    }
    const sep = document.createElement("div");
    sep.className = "yo-workdir-menu-sep";
    dropdown.appendChild(sep);
    const choose = document.createElement("button");
    choose.className = "yo-workdir-menu-item";
    choose.textContent = "Choose folder…";
    choose.addEventListener("click", async () => {
      closeDropdown();
      const picked = await window.agent.pickCwd();
      if (picked) {
        // pickCwd already sets the working dir; broadcast triggers onCwdChanged.
        void picked;
      }
    });
    dropdown.appendChild(choose);

    if (workdirBtn) {
      const r = workdirBtn.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      // Opens UPWARD — anchored to the bottom edge of the button, growing up.
      dropdown.style.top = "auto";
      dropdown.style.bottom = `${window.innerHeight - r.top + 4}px`;
    }
    dropdown.classList.add("open");
  }

  // ── Branch picker dropdown ──
  const branchDropdown = document.createElement("div");
  branchDropdown.className = "yo-workdir-menu yo-branch-menu";
  document.body.appendChild(branchDropdown);

  function closeBranchDropdown(): void { branchDropdown.classList.remove("open"); }
  function isBranchDropdownOpen(): boolean { return branchDropdown.classList.contains("open"); }

  async function openBranchDropdown(): Promise<void> {
    if (!cwd) return;
    const info = await window.agent.gitBranches(cwd).catch(() => ({ branches: [] as string[] }));
    const branches = info.branches;
    const current = info.current;

    branchDropdown.innerHTML = "";
    const listWrap = document.createElement("div");
    listWrap.className = "yo-branch-list";
    branchDropdown.appendChild(listWrap);
    const searchWrap = document.createElement("div");
    searchWrap.className = "yo-branch-search-wrap";
    searchWrap.innerHTML = `<span class="yo-branch-search-icon">🔍</span><input class="yo-branch-search" type="text" placeholder="Search branches…" spellcheck="false" />`;
    branchDropdown.appendChild(searchWrap);
    const search = searchWrap.querySelector(".yo-branch-search") as HTMLInputElement;

    function paintList(filter = ""): void {
      const q = filter.trim().toLowerCase();
      listWrap.innerHTML = "";
      const visible = q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches;
      if (visible.length === 0) {
        const empty = document.createElement("div");
        empty.className = "yo-branch-empty";
        empty.textContent = q ? "No matching branches." : "No branches.";
        listWrap.appendChild(empty);
        return;
      }
      for (const b of visible) {
        const item = document.createElement("button");
        item.className = "yo-branch-item";
        item.type = "button";
        const isCurrent = b === current;
        item.innerHTML = `<span class="nm"></span><span class="check">${isCurrent ? CHECK_SVG : ""}</span>`;
        (item.querySelector(".nm") as HTMLElement).textContent = b;
        if (isCurrent) item.classList.add("yo-branch-current");
        item.addEventListener("click", async () => {
          closeBranchDropdown();
          if (b === current) return;
          const res = await window.agent.gitCheckout(cwd, b);
          if (res.ok) {
            void paintWorkdirBar(cwd); // refresh git branch label
          } else {
            // Surface failure inline as a status row. Keep it simple — a
            // toast would need extra plumbing.
            alert(`git checkout ${b} failed:\n${res.error || "unknown error"}`);
          }
        });
        listWrap.appendChild(item);
      }
    }
    paintList("");
    search.addEventListener("input", () => paintList(search.value));

    if (branchWrap) {
      const r = (branchWrap as HTMLElement).getBoundingClientRect();
      branchDropdown.style.left = `${r.left}px`;
      branchDropdown.style.top = "auto";
      branchDropdown.style.bottom = `${window.innerHeight - r.top + 4}px`;
    }
    branchDropdown.classList.add("open");
    setTimeout(() => search.focus(), 0);
  }

  branchWrap?.addEventListener("click", (e) => {
    e.stopPropagation();
    if ((branchWrap as HTMLElement).style.display === "none") return;
    isBranchDropdownOpen() ? closeBranchDropdown() : void openBranchDropdown();
  });
  document.addEventListener("click", (e) => {
    if (!isBranchDropdownOpen()) return;
    if (branchDropdown.contains(e.target as Node)) return;
    if (branchWrap?.contains(e.target as Node)) return;
    closeBranchDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isBranchDropdownOpen()) closeBranchDropdown();
  });

  workdirBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    isDropdownOpen() ? closeDropdown() : void openDropdown();
  });
  workdirAdd?.addEventListener("click", (e) => {
    e.stopPropagation();
    void window.agent.pickCwd();
  });
  document.addEventListener("click", (e) => {
    if (!isDropdownOpen()) return;
    if (dropdown.contains(e.target as Node)) return;
    if (workdirBtn?.contains(e.target as Node)) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDropdownOpen()) closeDropdown();
  });

  // ── Chat renderer ──
  const renderer = createYoAgentRenderer({
    callbacks: {
      send: (text, model, perm) => { void window.agent.send(id, text, model, perm); },
      stop: () => { void window.agent.stop(id); },
      newChat: async () => {
        await window.agent.clear(id);
        renderer.clearChat();
      },
      listChats: async (): Promise<ChatSummary[]> => [],
      loadChat: async () => { /* TODO */ },
      deleteChat: async () => { /* TODO */ },
      respondApproval: () => { /* TODO */ },
      kindChanged: (kind) => { void window.agent.setKind(slug, kind); },
    },
  });

  // Seed the type dropdown from the saved AgentConfig.kind so the UI
  // reflects what's actually persisted. Silent init — won't echo back.
  void window.agent.getKind(slug).then(({ kind }) => renderer.initAgentKind(kind));

  // Initial paint + engine start.
  void paintWorkdirBar(cwd);
  await window.agent.start({ instanceId: id, agentSlug: slug, cwd: cwd || "" });

  // Folder change (from picker, recents click, or external) → repaint bar +
  // rebind engine to the new cwd.
  window.agent.onCwdChanged((dir) => {
    cwd = dir || "";
    void paintWorkdirBar(cwd);
    if (cwd) void window.agent.rebind(id, cwd);
  });

  // ── Engine event stream ──
  window.agent.onEvent(`agent:${id}:token`, (delta: unknown) => {
    renderer.appendToken(String(delta));
  });
  window.agent.onEvent(`agent:${id}:tool-use`, (toolId: unknown, name: unknown, input: unknown) => {
    renderer.showToolUse(String(toolId), String(name), input);
  });
  window.agent.onEvent(`agent:${id}:tool-result`, (toolId: unknown, detail: unknown) => {
    renderer.showToolResult(String(toolId), detail);
  });
  window.agent.onEvent(`agent:${id}:done`, (full: unknown) => {
    renderer.finalizeMessage(typeof full === "string" ? full : undefined);
  });
  window.agent.onEvent(`agent:${id}:error`, (err: unknown) => {
    renderer.showError(String(err));
  });

  window.addEventListener("beforeunload", () => { void window.agent.dispose(id); });
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
