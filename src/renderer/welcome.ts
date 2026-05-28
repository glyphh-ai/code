/**
 * Welcome — empty-state landing app.
 *
 * Shows the .Yo brand, two dev-plane cards (Vibe, Spec), and a paginated
 * searchable Recents list of folder-bound app/layout instances. Used as
 * the boot fallback when there's no panel state to restore.
 */

type RecentEntry = {
  kind: "app" | "layout";
  id: string;
  name: string;
  folder: string;
  ts: number;
};

interface WelcomeApi {
  recentsList: () => Promise<RecentEntry[]>;
  recentsOpen: (entry: RecentEntry) => Promise<boolean>;
  recentsRemove: (entry: Pick<RecentEntry, "kind" | "id" | "folder">) => Promise<boolean>;
  onRecentsChanged: (cb: (list: RecentEntry[]) => void) => () => void;
  openVibe: () => Promise<void>;
  openSpec: () => Promise<void>;
  openFolder: (folder: string) => Promise<void>;
  getShowOnStartup: () => Promise<boolean>;
  setShowOnStartup: (v: boolean) => Promise<void>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const TAGLINES = [
  "your AI workspace",
  "one workspace, many panels",
  "skills, agents, vibes — yours, portable",
  ".yo · .sup · .dip · .drip · .peace",
  "let Claude do Claude",
  "spec-driven, agent-native",
];

const PAGE_SIZE = 10;

function homeShorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function rotateTagline(): void {
  const el = document.getElementById("welcome-tagline");
  if (!el) return;
  let i = 0;
  setInterval(() => {
    i = (i + 1) % TAGLINES.length;
    el.style.opacity = "0";
    setTimeout(() => {
      el.textContent = TAGLINES[i];
      el.style.opacity = "1";
    }, 240);
  }, 4000);
}

let allRecents: RecentEntry[] = [];
let query = "";
let page = 0;

function filtered(): RecentEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return allRecents;
  return allRecents.filter(
    (r) => r.name.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q),
  );
}

function renderRecentsList(api: WelcomeApi): void {
  const list = document.getElementById("recents-list");
  const more = document.getElementById("recents-more") as HTMLButtonElement | null;
  if (!list) return;

  const all = filtered();
  const shown = all.slice(0, (page + 1) * PAGE_SIZE);

  list.innerHTML = "";
  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = query
      ? `No recents matching "${query}".`
      : "No recents yet — open Vibe or Spec on a folder to start.";
    list.appendChild(empty);
    if (more) more.style.display = "none";
    return;
  }

  for (const entry of shown) {
    const row = document.createElement("button");
    row.className = "recent-row";
    row.type = "button";
    row.title = entry.folder;
    row.innerHTML = `
      <div class="recent-content">
        <div class="recent-app">${escapeHtml(entry.name)}</div>
        <div class="recent-folder">${escapeHtml(homeShorten(entry.folder))}</div>
      </div>
      <button class="recent-dismiss" type="button" title="Remove" aria-label="Remove">&times;</button>
    `;
    row.addEventListener("click", (e) => {
      // Dismiss button is inside the row — don't open if it was clicked.
      if ((e.target as HTMLElement).classList.contains("recent-dismiss")) {
        e.stopPropagation();
        return;
      }
      void api.recentsOpen(entry);
    });
    row.querySelector(".recent-dismiss")?.addEventListener("click", (e) => {
      e.stopPropagation();
      void api.recentsRemove({ kind: entry.kind, id: entry.id, folder: entry.folder });
    });
    list.appendChild(row);
  }

  if (more) {
    if (shown.length < all.length) {
      more.style.display = "";
      const remaining = Math.min(PAGE_SIZE, all.length - shown.length);
      more.textContent = `Show ${remaining} more`;
    } else {
      more.style.display = "none";
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c] as string));
}

async function refreshRecents(api: WelcomeApi): Promise<void> {
  allRecents = await api.recentsList();
  // Snap pagination back if a refresh shrinks the list past the current page.
  const maxPage = Math.max(0, Math.ceil(filtered().length / PAGE_SIZE) - 1);
  if (page > maxPage) page = maxPage;
  renderRecentsList(api);
}

async function init(): Promise<void> {
  const api = (window as unknown as { welcome?: WelcomeApi }).welcome;
  if (!api) return;

  rotateTagline();
  await refreshRecents(api);
  api.onRecentsChanged(() => { void refreshRecents(api); });

  const search = document.getElementById("recents-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    query = search.value;
    page = 0;
    renderRecentsList(api);
  });

  document.getElementById("recents-more")?.addEventListener("click", () => {
    page += 1;
    renderRecentsList(api);
  });

  document.getElementById("card-vibe")?.addEventListener("click", () => void api.openVibe());
  document.getElementById("card-spec")?.addEventListener("click", () => void api.openSpec());

  // Recents "+" dropdown — quick Vibe/Spec spawn from the header.
  const addBtn = document.getElementById("recents-add");
  const addMenu = document.getElementById("recents-add-menu");
  if (addBtn && addMenu) {
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addMenu.classList.toggle("hidden");
    });
    addMenu.querySelectorAll<HTMLButtonElement>("button[data-app]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        addMenu.classList.add("hidden");
        const slug = btn.dataset.app;
        if (slug === "vibe") void api.openVibe();
        else if (slug === "spec") void api.openSpec();
      });
    });
    document.addEventListener("click", (e) => {
      if (!addMenu.classList.contains("hidden") &&
          !addMenu.contains(e.target as Node) &&
          e.target !== addBtn) {
        addMenu.classList.add("hidden");
      }
    });
  }

  const cb = document.getElementById("show-on-startup") as HTMLInputElement | null;
  if (cb) {
    cb.checked = await api.getShowOnStartup();
    cb.addEventListener("change", () => void api.setShowOnStartup(cb.checked));
  }
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
