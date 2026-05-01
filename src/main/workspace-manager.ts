/**
 * WorkspaceManager — global registry of workspaces.
 *
 * A workspace is { slug, name, rootDir, createdAt }. Captures, agent state,
 * and (in later phases) per-workspace event logs are scoped to the active
 * workspace's slug. The slug also identifies the workspace in MCP tool calls,
 * cross-workspace addressing, and command-line UX (`.yo .ws switch <slug>`).
 *
 * Storage:
 *   ~/yo/workspaces.json         — index of all workspaces + active slug
 *   ~/yo/workspaces/<slug>/      — per-workspace data dir (events.jsonl, etc.)
 *
 * Migration: on first init, ensures a "default" workspace exists bound to
 * the user's home directory. The legacy `activeWorkspace` preference is
 * preserved and used as the active slug if it identifies a known workspace.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getPreference, setPreference } from "./preferences";

export interface Workspace {
  slug: string;
  name: string;
  rootDir: string;
  createdAt: number;
}

interface WorkspacesIndex {
  workspaces: Workspace[];
  active: string;
}

const YO_DIR = path.join(os.homedir(), "yo");
const INDEX_FILE = path.join(YO_DIR, "workspaces.json");
const WORKSPACES_DIR = path.join(YO_DIR, "workspaces");

/** Reserved slugs that cannot be used for workspaces. Mirrors the command
 *  keyword set plus sub-mode names (`ws`, `code`) and verbs that would make
 *  `.yo .ws <verb>` ambiguous. */
const RESERVED_SLUGS = new Set([
  "yo", "sup", "dip", "drip", "peace", "waz", "council",
  "ws", "code",
  "new", "switch", "list", "delete", "rename", "help",
]);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CreateResult =
  | { ok: true; workspace: Workspace; warning?: string }
  | { ok: false; error: string };

export type SwitchResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: string };

export class WorkspaceManager {
  private index: WorkspacesIndex = { workspaces: [], active: "default" };

  init(): void {
    fs.mkdirSync(YO_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

    if (fs.existsSync(INDEX_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
        if (raw && Array.isArray(raw.workspaces) && typeof raw.active === "string") {
          this.index = raw;
        }
      } catch (err) {
        console.warn("[workspace-manager] failed to read index, recreating:", (err as Error).message);
      }
    }

    this.migrate();
  }

  /** Ensure a "default" workspace exists; align active slug with the legacy
   *  `activeWorkspace` preference if it points at a real workspace. */
  private migrate(): void {
    let dirty = false;

    if (!this.index.workspaces.find((w) => w.slug === "default")) {
      this.index.workspaces.push({
        slug: "default",
        name: "Default",
        rootDir: os.homedir(),
        createdAt: Date.now(),
      });
      dirty = true;
    }

    // Honor legacy preference if it names an existing workspace; else fall
    // back to whatever's already in the index, else "default".
    const legacy = getPreference<string>("activeWorkspace", "default");
    if (this.index.workspaces.find((w) => w.slug === legacy)) {
      if (this.index.active !== legacy) {
        this.index.active = legacy;
        dirty = true;
      }
    } else if (!this.index.workspaces.find((w) => w.slug === this.index.active)) {
      this.index.active = "default";
      dirty = true;
    }

    // Ensure the per-workspace dir exists for every workspace.
    for (const w of this.index.workspaces) {
      try { fs.mkdirSync(path.join(WORKSPACES_DIR, w.slug), { recursive: true }); } catch {}
    }

    if (dirty) this.persist();
    // Keep the legacy preference in sync with the canonical active slug.
    setPreference("activeWorkspace", this.index.active);
  }

  private persist(): void {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index, null, 2));
  }

  list(): Workspace[] {
    return [...this.index.workspaces];
  }

  get(slug: string): Workspace | null {
    return this.index.workspaces.find((w) => w.slug === slug) ?? null;
  }

  getActive(): Workspace {
    return this.get(this.index.active) ?? this.get("default")!;
  }

  getActiveSlug(): string {
    return this.getActive().slug;
  }

  /** Path to per-workspace data dir (events.jsonl, agents/, inbox/, etc.) */
  workspaceDir(slug: string): string {
    return path.join(WORKSPACES_DIR, slug);
  }

  create(slug: string, name: string, rootDir: string): CreateResult {
    const cleanSlug = slug.toLowerCase().trim();
    if (!SLUG_PATTERN.test(cleanSlug)) {
      return {
        ok: false,
        error: `Invalid slug "${slug}" — use lowercase letters, digits, and dashes (must start with a letter or digit).`,
      };
    }
    if (RESERVED_SLUGS.has(cleanSlug)) {
      return { ok: false, error: `"${cleanSlug}" is a reserved keyword.` };
    }
    if (this.index.workspaces.find((w) => w.slug === cleanSlug)) {
      return { ok: false, error: `Workspace "${cleanSlug}" already exists.` };
    }

    const expanded = expandHome(rootDir);
    const resolved = path.resolve(expanded);

    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Path does not exist: ${resolved}` };
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` };
    }

    const dup = this.index.workspaces.find((w) => path.resolve(w.rootDir) === resolved);

    const workspace: Workspace = {
      slug: cleanSlug,
      name: name.trim() || cleanSlug,
      rootDir: resolved,
      createdAt: Date.now(),
    };
    this.index.workspaces.push(workspace);
    this.persist();

    try { fs.mkdirSync(path.join(WORKSPACES_DIR, cleanSlug), { recursive: true }); } catch {}

    return dup
      ? { ok: true, workspace, warning: `Note: workspace "${dup.slug}" already targets this directory.` }
      : { ok: true, workspace };
  }

  switch(slug: string): SwitchResult {
    const ws = this.get(slug);
    if (!ws) return { ok: false, error: `No workspace "${slug}". Try .yo .ws list.` };
    this.index.active = slug;
    this.persist();
    setPreference("activeWorkspace", slug);
    return { ok: true, workspace: ws };
  }
}

/** Resolve `~` and `~/...` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
