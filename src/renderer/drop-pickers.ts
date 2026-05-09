/**
 * drop-pickers — owner + repo selector widgets for the new Drop-a-Cypher
 * wizard Step 2.
 *
 * THE-PIVOT-GITHUB Phase 3 prereq. Backed by hardcoded fixtures in this
 * commit (so the wizard can be authored against the shape today). The data
 * source flips to `installationsList()` / `reposForInstallation()` once
 * server Phase 11 lands — no UI changes required, only swap the
 * `loadInstallations` impl.
 */

export interface OwnerOption {
  installation_id: number;
  account_kind: "user" | "organization";
  account_login: string;
  account_avatar: string;
  member_count: number | null;
}

export interface RepoOption {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  has_ci: boolean;
  pushed_at: string | null;
}

// ── Fixtures (replace with real data once server Phase 11 lands) ─────────

export const FIXTURE_OWNERS: OwnerOption[] = [
  {
    installation_id: 1,
    account_kind: "user",
    account_login: "<your-github-handle>",
    account_avatar: "https://avatars.githubusercontent.com/u/0?v=4",
    member_count: null,
  },
  {
    installation_id: 2,
    account_kind: "organization",
    account_login: "acme",
    account_avatar: "https://avatars.githubusercontent.com/u/1?v=4",
    member_count: 12,
  },
];

export const FIXTURE_REPOS: Record<string, RepoOption[]> = {
  "<your-github-handle>": [
    { id: 1, name: "yo-client", full_name: "<your-github-handle>/yo-client", private: false, default_branch: "main", has_ci: true, pushed_at: new Date().toISOString() },
    { id: 2, name: "scratch", full_name: "<your-github-handle>/scratch", private: true, default_branch: "main", has_ci: false, pushed_at: null },
  ],
  "acme": [
    { id: 10, name: "api", full_name: "acme/api", private: true, default_branch: "main", has_ci: true, pushed_at: new Date().toISOString() },
    { id: 11, name: "web", full_name: "acme/web", private: true, default_branch: "main", has_ci: true, pushed_at: new Date().toISOString() },
    { id: 12, name: "vector-store", full_name: "acme/vector-store", private: true, default_branch: "main", has_ci: false, pushed_at: null },
  ],
};

// ── Data source switcher ────────────────────────────────────────────────

interface DropFetchers {
  installationsList?: () => Promise<unknown>;
  reposForInstallation?: (owner: string) => Promise<unknown>;
}
const drop = () => (window as unknown as { drop?: DropFetchers }).drop;

/**
 * Load installations. Tries the live endpoint first; on 501/error falls
 * back to fixtures so the UI can still be exercised. Once server Phase 11
 * lands and returns 200s, fixtures are dead code.
 */
export async function loadOwners(): Promise<OwnerOption[]> {
  try {
    const r = await drop()?.installationsList?.();
    if (isOk<{ installations: OwnerOption[] }>(r) && Array.isArray(r.data?.installations)) {
      return r.data.installations;
    }
  } catch { /* fallthrough */ }
  return FIXTURE_OWNERS;
}

export async function loadRepos(ownerLogin: string): Promise<RepoOption[]> {
  try {
    const r = await drop()?.reposForInstallation?.(ownerLogin);
    if (isOk<{ repos: RepoOption[] }>(r) && Array.isArray(r.data?.repos)) {
      return r.data.repos;
    }
  } catch { /* fallthrough */ }
  return FIXTURE_REPOS[ownerLogin] ?? [];
}

function isOk<T>(r: unknown): r is { ok: true; data: T } {
  return !!r && typeof r === "object" && (r as { ok?: unknown }).ok === true && "data" in (r as object);
}

// ── DOM widgets ─────────────────────────────────────────────────────────

export interface OwnerPickerOpts {
  selected?: string;
  onChange: (owner: OwnerOption) => void;
}

export function renderOwnerPicker(host: HTMLElement, opts: OwnerPickerOpts): { setOwners: (owners: OwnerOption[]) => void } {
  host.innerHTML = "";
  host.classList.add("yo-owner-picker");
  const sel = document.createElement("select");
  sel.className = "yo-owner-picker-select";
  sel.innerHTML = `<option value="">Choose an owner…</option>`;
  host.appendChild(sel);

  let owners: OwnerOption[] = [];

  const setOwners = (next: OwnerOption[]) => {
    owners = next;
    sel.innerHTML = `<option value="">Choose an owner…</option>` +
      next.map((o) => {
        const label = o.account_kind === "organization"
          ? `🐙 @${o.account_login} · org · ${o.member_count ?? "?"} members`
          : `🐙 @${o.account_login} · personal`;
        return `<option value="${escapeHtml(o.account_login)}"${o.account_login === opts.selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
      }).join("");
  };

  sel.addEventListener("change", () => {
    const o = owners.find(x => x.account_login === sel.value);
    if (o) opts.onChange(o);
  });

  return { setOwners };
}

export interface RepoPickerOpts {
  selected?: string[];
  onChange: (repos: RepoOption[]) => void;
}

export function renderRepoPicker(host: HTMLElement, opts: RepoPickerOpts): { setRepos: (repos: RepoOption[]) => void } {
  host.innerHTML = "";
  host.classList.add("yo-repo-picker");
  const list = document.createElement("div");
  list.className = "yo-repo-picker-list";
  const empty = document.createElement("div");
  empty.className = "yo-repo-picker-empty";
  empty.textContent = "Pick an owner above to load repos.";
  host.appendChild(empty);
  host.appendChild(list);

  const selected = new Set(opts.selected ?? []);
  let repos: RepoOption[] = [];

  const emit = () => {
    opts.onChange(repos.filter(r => selected.has(r.full_name)));
  };

  const setRepos = (next: RepoOption[]) => {
    repos = next;
    list.innerHTML = "";
    if (next.length === 0) {
      empty.style.display = "block";
      empty.textContent = "yo-cypher App isn't installed on any repos for this owner. Skip → draft-only cypher.";
      return;
    }
    empty.style.display = "none";
    for (const r of next) {
      const row = document.createElement("label");
      row.className = "yo-repo-picker-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(r.full_name);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(r.full_name); else selected.delete(r.full_name);
        emit();
      });
      const label = document.createElement("span");
      label.className = "yo-repo-picker-label";
      label.innerHTML = `<strong>${escapeHtml(r.name)}</strong>` +
        ` <span class="yo-repo-picker-meta">${r.private ? "🔒 private · " : ""}${r.has_ci ? "✓ CI" : "no CI"}</span>`;
      row.appendChild(cb);
      row.appendChild(label);
      list.appendChild(row);
    }
  };

  return { setRepos };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
