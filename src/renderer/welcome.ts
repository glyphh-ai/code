/**
 * Welcome — empty-state landing app.
 *
 * Shows the .Yo brand, two dev-plane cards (Vibe, Spec), and recent folders.
 * Used as the boot fallback when there's no panel state to restore.
 */

interface WelcomeApi {
  getRecents: () => Promise<string[]>;
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

function homeShorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
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

async function renderRecents(api: WelcomeApi): Promise<void> {
  const list = document.getElementById("recents-list");
  if (!list) return;
  const recents = await api.getRecents();
  if (!recents.length) {
    list.innerHTML = `<div class="recent-empty">No recent folders yet.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const dir of recents.slice(0, 20)) {
    const row = document.createElement("button");
    row.className = "recent-row";
    row.type = "button";
    row.title = dir;
    row.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
      <span class="recent-folder"><strong>${basename(dir)}</strong> <span style="color:var(--text-3);font-size:11px;">${homeShorten(dir)}</span></span>
    `;
    row.addEventListener("click", () => void api.openFolder(dir));
    list.appendChild(row);
  }
}

async function init(): Promise<void> {
  const api = (window as unknown as { welcome?: WelcomeApi }).welcome;
  if (!api) return;

  rotateTagline();
  void renderRecents(api);

  document.getElementById("card-vibe")?.addEventListener("click", () => void api.openVibe());
  document.getElementById("card-spec")?.addEventListener("click", () => void api.openSpec());

  const cb = document.getElementById("show-on-startup") as HTMLInputElement | null;
  if (cb) {
    cb.checked = await api.getShowOnStartup();
    cb.addEventListener("change", () => void api.setShowOnStartup(cb.checked));
  }
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
