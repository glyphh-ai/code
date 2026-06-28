// dock-overlay-renderer.ts — runs inside the transparent Dock overlay window.
// Renders the dock strip, handles magnification config, auto-hide reveal, drag
// reorder, and — crucially — toggles the window's click-through (setIgnoreMouse)
// as the cursor enters/leaves the strip so the rest of the overlay passes clicks
// through to the workspace behind it. Bundled by `npm run build:dock-overlay`.

type DockCfg = { enabled: boolean; autoHide: boolean; scale: number; zoom: boolean; magnify: number; position: string; apps: string[]; height: number };
type AppMeta = { id: string; name: string; url?: string };

interface DockApi {
  getConfig: () => Promise<DockCfg>;
  setConfig: (patch: Partial<DockCfg>) => void;
  reorder: (order: string[]) => void;
  removeApp: (id: string) => void;
  onChanged: (cb: (cfg: DockCfg) => void) => void;
  onReveal: (cb: (info: { visible: boolean }) => void) => void;
  listApps: () => Promise<AppMeta[]>;
  openApp: (id: string) => void;
  onTabState: (cb: (s: { tabs: Array<{ id: string }>; activeId: string }) => void) => void;
  reportHitRect: (rect: { x: number; y: number; w: number; h: number } | null) => void;
  onCursor: (cb: (c: { x: number; y: number } | null) => void) => void;
  requestRemove: (id: string) => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => void;
}

const ICON_BASE = 46; // px at scale 1.0

(function initDockOverlay(): void {
  const dock = window as unknown as { dock: DockApi };
  const api = dock.dock;
  const root = document.getElementById("dock");
  const strip = root?.querySelector(".dock-strip") as HTMLElement | null;
  if (!root || !strip) return;

  let cfg: DockCfg = { enabled: false, autoHide: true, scale: 1, zoom: true, magnify: 1.6, position: "bottom", apps: [], height: 68 };
  let metaById: Record<string, AppMeta> = {};
  let runningIds = new Set<string>();
  let shown = false; // whether the strip is currently revealed (main is authoritative)
  let dragId: string | null = null;
  // Base (unmagnified) centre of each icon along the main axis, measured on
  // render; the ripple is computed against these so it can't feed back on itself.
  let slots: Array<{ el: HTMLElement; center: number }> = [];

  function applyTheme(t: string): void {
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  function faviconFor(app: AppMeta): string {
    if (app.url && /^https?:\/\//i.test(app.url)) {
      try { return `https://www.google.com/s2/favicons?domain=${new URL(app.url).hostname}&sz=64`; } catch { /* */ }
    }
    return "";
  }

  function visibleNow(): boolean {
    return cfg.enabled && shown;
  }

  function render(): void {
    const pos = ["bottom", "top", "left", "right"].includes(cfg.position) ? cfg.position : "bottom";
    root!.dataset.pos = pos;
    root!.classList.toggle("dock--zoom", cfg.zoom);
    root!.style.setProperty("--dock-icon", `${Math.round(ICON_BASE * cfg.scale)}px`);
    root!.style.setProperty("--m", String(Math.max(1, cfg.magnify || 1)));
    strip!.classList.toggle("hidden", !visibleNow());

    strip!.innerHTML = "";
    if (cfg.apps.length === 0) {
      const hint = document.createElement("div");
      hint.className = "dock-empty";
      hint.textContent = "Add apps to the Dock from an app's settings";
      strip!.appendChild(hint);
      reportHit();
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

      // Remove-from-dock affordance (shown on the hovered icon).
      const x = document.createElement("button");
      x.className = "dock-x";
      x.title = "Remove from Dock";
      x.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
      x.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); api.requestRemove(id); });
      item.appendChild(x);

      item.addEventListener("click", () => api.openApp(id));
      item.addEventListener("contextmenu", (e) => { e.preventDefault(); api.removeApp(id); });
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
        api.reorder(order);
      });

      strip!.appendChild(item);
    }
    measureSlots();
    reportHit();
  }

  const horizontal = (): boolean => {
    const p = root!.dataset.pos || "bottom";
    return p === "bottom" || p === "top";
  };

  function measureSlots(): void {
    const items = Array.from(strip!.querySelectorAll<HTMLElement>(".dock-item"));
    slots = items.map((el) => {
      el.style.transform = ""; // measure unmagnified
      const r = el.getBoundingClientRect();
      return { el, center: horizontal() ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2 };
    });
  }

  function resetRipple(): void {
    for (const s of slots) { s.el.style.transform = ""; s.el.classList.remove("dock-item--hot"); }
  }

  // macOS-style ripple: each icon's scale falls off with its distance from the
  // cursor; icons are pushed away from the cursor by the growth between them so
  // they never overlap.
  function applyRipple(c: { x: number; y: number } | null): void {
    if (!c || !cfg.zoom || slots.length === 0) { resetRipple(); return; }
    const pos = root!.dataset.pos || "bottom";
    const horiz = horizontal();
    const cursor = horiz ? c.x : c.y;
    const S = Math.round(ICON_BASE * cfg.scale);
    const M = Math.max(1, cfg.magnify || 1);
    const RANGE = S * 2.2;
    const scales = slots.map((s) => 1 + (M - 1) * Math.max(0, 1 - Math.abs(cursor - s.center) / RANGE));
    // The icon nearest the cursor is "hot" — it shows its remove (×) button.
    let hot = 0;
    for (let i = 1; i < slots.length; i++) if (scales[i] > scales[hot]) hot = i;
    for (let i = 0; i < slots.length; i++) {
      slots[i].el.classList.toggle("dock-item--hot", i === hot && Math.abs(cursor - slots[i].center) < RANGE);
    }
    for (let i = 0; i < slots.length; i++) {
      let push = ((scales[i] - 1) * S) / 2; // half of own growth
      if (slots[i].center >= cursor) {
        for (let j = 0; j < i; j++) if (slots[j].center >= cursor) push += (scales[j] - 1) * S;
      } else {
        for (let j = i + 1; j < slots.length; j++) if (slots[j].center < cursor) push += (scales[j] - 1) * S;
      }
      const t = (slots[i].center >= cursor ? 1 : -1) * push;
      slots[i].el.style.transform = horiz
        ? `translateX(${t.toFixed(1)}px) scale(${scales[i].toFixed(3)})`
        : `translateY(${t.toFixed(1)}px) scale(${scales[i].toFixed(3)})`;
    }
    void pos;
  }

  async function loadMeta(): Promise<void> {
    try {
      const apps = await api.listApps();
      metaById = {};
      for (const a of apps) metaById[a.id] = a;
    } catch { /* */ }
  }

  // Click-through management: report the interactive rectangle (the strip plus
  // the headroom into which magnified icons grow) to main, which polls the OS
  // cursor against it. Reported in window-client px.
  function reportHit(): void {
    if (!visibleNow()) { api.reportHitRect(null); return; }
    const r = strip!.getBoundingClientRect();
    const grow = 150; // magnification headroom toward the canvas centre
    const pos = root!.dataset.pos || "bottom";
    let x = r.left - 2, y = r.top - 2, w = r.width + 4, h = r.height + 4;
    if (pos === "bottom") { y -= grow; h += grow; }
    else if (pos === "top") { h += grow; }
    else if (pos === "left") { w += grow; }
    else { x -= grow; w += grow; }
    api.reportHitRect({ x, y, w, h });
  }
  // Re-measure when the overlay window resizes (the centred strip moves).
  window.addEventListener("resize", () => { measureSlots(); reportHit(); });
  // Magnification follows the cursor streamed from main.
  api.onCursor((c) => applyRipple(c));

  api.onChanged((next) => { cfg = next; render(); });
  api.onReveal((info) => {
    shown = info.visible;
    render();
    // The strip slides in over ~220ms; re-measure + report once it has settled.
    setTimeout(() => { measureSlots(); reportHit(); }, 260);
  });
  api.onTabState((s) => { runningIds = new Set((s.tabs || []).map((t) => t.id)); render(); });
  api.getTheme().then(applyTheme).catch(() => { /* */ });
  api.onThemeChanged(applyTheme);

  (async () => {
    await loadMeta();
    try { cfg = await api.getConfig(); } catch { /* */ }
    // Non-auto-hide docks are shown immediately; auto-hide waits for a reveal.
    shown = cfg.enabled && !cfg.autoHide;
    render();
  })();
})();
