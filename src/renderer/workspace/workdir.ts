/**
 * workdir.ts — the working-directory bar above the composer.
 *
 * Renders the current chat's folder, its git branch (when a repo), and a
 * picker popup (recent folders with a checkmark on the active one, plus
 * "Choose folder…" which opens the OS picker in the current dir). The
 * working directory is per-chat in the backend; this just reflects + drives
 * the current value via the window.yo bridge.
 */

type Yo = {
  getWorkingDir: () => Promise<string | null>;
  setWorkingDir: (dir: string) => Promise<string>;
  pickWorkingDir: (opts?: { asDefault?: boolean }) => Promise<string | null>;
  getWorkingDirRecents: () => Promise<string[]>;
  onWorkingDirChanged: (cb: (dir: string | null) => void) => void;
  gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string }>;
};

const FOLDER_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
const CHECK_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function homeShorten(p: string): string {
  // Best-effort ~ display; main owns the real path in the tooltip.
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

export function initWorkdir(): void {
  const yo = (window as unknown as { yo?: Yo }).yo;
  if (!yo) return;   // browser preview — leave the static bar as-is

  const btn        = document.getElementById("workdir-btn") as HTMLButtonElement | null;
  const nameEl     = document.getElementById("workdir-name");
  const addBtn     = document.getElementById("workdir-add-btn") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("workdir-branch-wrap");
  const branchEl   = document.getElementById("workdir-branch");
  if (!btn || !nameEl) return;

  let current = "";

  // Build the picker popover once, reuse it. Uses the shared .ws-popover look.
  const menu = document.createElement("div");
  menu.className = "ws-popover ws-workdir-menu";
  menu.setAttribute("role", "menu");
  document.body.appendChild(menu);

  function closeMenu() { menu.classList.remove("open"); }
  function isMenuOpen() { return menu.classList.contains("open"); }

  async function paintBar(dir: string) {
    current = dir;
    nameEl!.textContent = basename(dir);
    btn!.title = "working directory: " + dir;
    // Git branch — show only when the folder is a repo.
    try {
      const info = await yo!.gitInfo(dir);
      if (info.isRepo && info.branch && branchWrap && branchEl) {
        branchEl.textContent = info.branch;
        branchWrap.style.display = "";
      } else if (branchWrap) {
        branchWrap.style.display = "none";
      }
    } catch {
      if (branchWrap) branchWrap.style.display = "none";
    }
  }

  async function openMenu() {
    const recents = await yo!.getWorkingDirRecents();
    menu.innerHTML = "";
    const list = recents.length ? recents : (current ? [current] : []);
    list.forEach((dir) => {
      const item = document.createElement("button");
      item.className = "ws-popover-item ws-workdir-item";
      item.innerHTML =
        `<span class="check">${dir === current ? CHECK_SVG : ""}</span>` +
        `<span class="ic">${FOLDER_SVG}</span>` +
        `<span class="nm"></span>`;
      item.querySelector(".nm")!.textContent = homeShorten(dir);
      item.title = dir;
      item.addEventListener("click", async () => {
        closeMenu();
        if (dir !== current) await yo!.setWorkingDir(dir);
      });
      menu.appendChild(item);
    });
    const sep = document.createElement("div");
    sep.className = "ws-popover-sep";
    menu.appendChild(sep);
    const choose = document.createElement("button");
    choose.className = "ws-popover-item";
    choose.textContent = "Choose folder…";
    choose.addEventListener("click", async () => {
      closeMenu();
      await yo!.pickWorkingDir();   // OS picker, opens in current dir
    });
    menu.appendChild(choose);

    // Position above the bar button (the composer sits at the bottom).
    const r = btn!.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = "auto";
    menu.style.bottom = (window.innerHeight - r.top + 6) + "px";
    menu.classList.add("open");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    isMenuOpen() ? closeMenu() : void openMenu();
  });
  if (addBtn) {
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void yo.pickWorkingDir();
    });
  }
  document.addEventListener("click", (e) => {
    if (!isMenuOpen()) return;
    if (menu.contains(e.target as Node)) return;
    if (btn.contains(e.target as Node)) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMenuOpen()) closeMenu();
  });

  // React to backend changes (picker, chat load/new all funnel here).
  yo.onWorkingDirChanged((dir) => { if (dir) void paintBar(dir); });

  // Initial paint.
  void yo.getWorkingDir().then((dir) => { if (dir) void paintBar(dir); });
}
