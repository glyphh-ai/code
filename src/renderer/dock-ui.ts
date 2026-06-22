// dock-ui.ts — macOS-style Dock pinned to the bottom of the workspace.
//
// The dock lives in the main renderer DOM inside the bottom inset the main
// process reserves for it (see dock-ipc.ts). It shows pinned apps, magnifies the
// hovered icon (optional), opens/switches to an app on click, and supports
// reordering by drag. Auto-hide reveal is driven by the main process (cursor
// proximity) via the `dock-reveal` event.

type DockCfg = { enabled: boolean; autoHide: boolean; scale: number; zoom: boolean; apps: string[]; height: number };
type AppMeta = { id: string; name: string; url?: string };

interface DockYo {
  dockGetConfig: () => Promise<DockCfg>;
  dockSetConfig: (patch: Partial<DockCfg>) => void;
  dockReorder: (order: string[]) => void;
  dockRemoveApp: (id: string) => void;
  onDockChanged: (cb: (cfg: DockCfg) => void) => void;
  onDockReveal: (cb: (info: { visible: boolean; height: number }) => void) => void;
  appsListAll: () => Promise<AppMeta[]>;
  tabNewApp: (id: string) => void;
  canvasOpenApp: (id: string) => void;
  onTabState: (cb: (s: { tabs: Array<{ id: string }>; activeId: string }) => void) => void;
}

const ICON_BASE = 46; // px at scale 1.0

export function initDock(): void {
  const yo = window.yo as unknown as DockYo;
  const dockRoot = document.getElementById("dock");
  if (!dockRoot) return;
  const dock: HTMLElement = dockRoot;
  const strip = dock.querySelector(".dock-strip") as HTMLElement;

  let cfg: DockCfg = { enabled: false, autoHide: true, scale: 1, zoom: true, apps: [], height: 68 };
  let metaById: Record<string, AppMeta> = {};
  let runningIds = new Set<string>();
  let dragId: string | null = null;

  function faviconFor(app: AppMeta): string {
    if (app.url && /^https?:\/\//i.test(app.url)) {
      try { return `https://www.google.com/s2/favicons?domain=${new URL(app.url).hostname}&sz=64`; } catch { /* */ }
    }
    return "";
  }

  function openApp(id: string): void {
    if (document.body.classList.contains("canvas-mode")) yo.canvasOpenApp(id);
    else yo.tabNewApp(id);
  }

  function render(): void {
    dock.classList.toggle("dock--enabled", cfg.enabled);
    dock.classList.toggle("dock--zoom", cfg.zoom);
    dock.style.setProperty("--dock-icon", `${Math.round(ICON_BASE * cfg.scale)}px`);
    dock.style.setProperty("--dock-height", `${cfg.height}px`);

    strip.innerHTML = "";
    if (cfg.apps.length === 0) {
      const hint = document.createElement("div");
      hint.className = "dock-empty";
      hint.textContent = "Add apps to the Dock from an app's settings";
      strip.appendChild(hint);
      return;
    }
    for (const id of cfg.apps) {
      const app = metaById[id] || { id, name: id };
      const item = document.createElement("button");
      item.className = "dock-item";
      item.dataset.id = id;
      item.title = app.name;
      item.draggable = true;

      const fav = faviconFor(app);
      const initial = (app.name || id).charAt(0).toUpperCase();
      item.innerHTML = fav
        ? `<img class="dock-icon-img" src="${fav}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="dock-icon-initial" style="display:none">${initial}</span>`
        : `<span class="dock-icon-initial" style="display:flex">${initial}</span>`;
      const dot = document.createElement("span");
      dot.className = "dock-running-dot";
      dot.style.visibility = runningIds.has(id) ? "visible" : "hidden";
      item.appendChild(dot);

      item.addEventListener("click", () => openApp(id));
      item.addEventListener("contextmenu", (e) => { e.preventDefault(); yo.dockRemoveApp(id); });

      // Reorder via native drag within the dock.
      item.addEventListener("dragstart", () => { dragId = id; item.classList.add("dock-dragging"); });
      item.addEventListener("dragend", () => { dragId = null; item.classList.remove("dock-dragging"); });
      item.addEventListener("dragover", (e) => { e.preventDefault(); });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragId || dragId === id) return;
        const order = [...cfg.apps];
        const from = order.indexOf(dragId);
        const to = order.indexOf(id);
        if (from < 0 || to < 0) return;
        order.splice(from, 1);
        order.splice(to, 0, dragId);
        yo.dockReorder(order);
      });

      strip.appendChild(item);
    }
  }

  async function loadMeta(): Promise<void> {
    try {
      const apps = await yo.appsListAll();
      metaById = {};
      for (const a of apps) metaById[a.id] = a;
    } catch { /* */ }
  }

  yo.onDockChanged((next) => {
    cfg = next;
    if (!cfg.enabled || !cfg.autoHide) dock.classList.toggle("dock--visible", cfg.enabled && !cfg.autoHide);
    render();
  });
  yo.onDockReveal((info) => {
    dock.classList.toggle("dock--visible", info.visible);
    dock.style.setProperty("--dock-height", `${info.height}px`);
  });
  yo.onTabState((s) => {
    runningIds = new Set((s.tabs || []).map((t) => t.id));
    render();
  });

  (async () => {
    await loadMeta();
    try { cfg = await yo.dockGetConfig(); } catch { /* */ }
    // A non-auto-hide dock is visible immediately; an auto-hide dock waits for
    // the main process's reveal events (cursor proximity).
    dock.classList.toggle("dock--visible", cfg.enabled && !cfg.autoHide);
    render();
  })();
}
