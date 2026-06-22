// canvas-ui.ts — Canvas mode window chrome.
//
// In canvas mode each open app is a free-floating window. The window CONTENT is
// a native BrowserView positioned by the main process; this module draws the DOM
// chrome (titlebar + resize frame) in the uncovered strips around each view and
// drives move/resize/collapse/close/focus over IPC. Mirrors the grid-ui drag
// pattern (DOM chrome positioned from main-provided bounds).

type CanvasWin = { id: string; name: string; favicon: string; x: number; y: number; w: number; h: number; z: number; collapsed: boolean };
type CanvasState = { mode: boolean; titlebarH: number; frame: number; active: string | null; windows: CanvasWin[] };

interface CanvasYo {
  canvasGetState: () => Promise<CanvasState>;
  canvasSetMode: (on: boolean) => void;
  canvasSetBounds: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;
  canvasFocus: (id: string) => void;
  canvasCollapse: (id: string) => void;
  canvasRestore: (id: string) => void;
  canvasClose: (id: string) => void;
  canvasMaximize: (id: string) => void;
  onCanvasState: (cb: (s: CanvasState) => void) => void;
  panelsHide: () => void;
  panelsShow: () => void;
}

const MIN_W = 240, MIN_H = 160;

export function initCanvas(): void {
  const yo = window.yo as unknown as CanvasYo;
  const chrome = document.getElementById("canvas-chrome");
  const tray = document.getElementById("canvas-collapsed-tray");
  if (!chrome || !tray) return;

  let state: CanvasState = { mode: false, titlebarH: 30, frame: 8, active: null, windows: [] };
  // While the user is dragging/resizing we move the DOM locally and ignore the
  // echoed canvas-state so the two don't fight.
  let interacting = false;

  function svg(path: string): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  function render(): void {
    document.body.classList.toggle("canvas-mode", state.mode);
    if (!state.mode) { chrome!.innerHTML = ""; tray!.innerHTML = ""; tray!.classList.add("hidden"); return; }
    if (interacting) return;

    chrome!.innerHTML = "";
    const t = state.titlebarH, f = state.frame;

    for (const win of state.windows) {
      if (win.collapsed) continue;
      const el = document.createElement("div");
      el.className = "canvas-win" + (win.id === state.active ? " canvas-win--active" : "");
      el.dataset.id = win.id;
      el.style.left = `${win.x}px`;
      el.style.top = `${win.y}px`;
      el.style.width = `${win.w}px`;
      el.style.height = `${win.h}px`;
      el.style.zIndex = String(100 + win.z);

      const initial = (win.name || win.id).charAt(0).toUpperCase();
      const favHtml = win.favicon
        ? `<img class="canvas-fav" src="${win.favicon}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'" /><span class="canvas-fav-initial" style="display:none">${initial}</span>`
        : `<span class="canvas-fav-initial" style="display:inline-flex">${initial}</span>`;

      el.innerHTML = `
        <div class="canvas-titlebar" style="height:${t}px">
          ${favHtml}
          <span class="canvas-title">${escapeHtml(win.name || win.id)}</span>
          <span class="canvas-tb-spacer"></span>
          <button class="canvas-tb-btn canvas-tb-collapse" title="Collapse">${svg('<polyline points="6 9 12 15 18 9"/>')}</button>
          <button class="canvas-tb-btn canvas-tb-max" title="Expand">${svg('<rect x="4" y="4" width="16" height="16" rx="1"/>')}</button>
          <button class="canvas-tb-btn canvas-tb-close" title="Close">${svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>')}</button>
        </div>
        <div class="canvas-rz canvas-rz-r" style="width:${f}px"></div>
        <div class="canvas-rz canvas-rz-b" style="height:${f}px"></div>
        <div class="canvas-rz canvas-rz-br" style="width:${f + 6}px;height:${f + 6}px"></div>`;

      const titlebar = el.querySelector(".canvas-titlebar") as HTMLElement;
      titlebar.addEventListener("mousedown", (e) => startMove(e, win, el));
      titlebar.addEventListener("dblclick", () => yo.canvasMaximize(win.id));
      (el.querySelector(".canvas-tb-collapse") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); yo.canvasCollapse(win.id); });
      (el.querySelector(".canvas-tb-max") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); yo.canvasMaximize(win.id); });
      (el.querySelector(".canvas-tb-close") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); yo.canvasClose(win.id); });
      (el.querySelector(".canvas-rz-r") as HTMLElement).addEventListener("mousedown", (e) => startResize(e, win, el, "r"));
      (el.querySelector(".canvas-rz-b") as HTMLElement).addEventListener("mousedown", (e) => startResize(e, win, el, "b"));
      (el.querySelector(".canvas-rz-br") as HTMLElement).addEventListener("mousedown", (e) => startResize(e, win, el, "br"));

      chrome!.appendChild(el);
    }

    // Collapsed tray (above the dock / bottom of the app).
    const collapsed = state.windows.filter((w) => w.collapsed);
    tray!.innerHTML = "";
    tray!.classList.toggle("hidden", collapsed.length === 0);
    for (const win of collapsed) {
      const pill = document.createElement("button");
      pill.className = "canvas-tray-pill";
      pill.title = win.name;
      const initial = (win.name || win.id).charAt(0).toUpperCase();
      pill.innerHTML = (win.favicon
        ? `<img src="${win.favicon}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'" /><span class="canvas-fav-initial" style="display:none">${initial}</span>`
        : `<span class="canvas-fav-initial" style="display:inline-flex">${initial}</span>`)
        + `<span class="canvas-tray-name">${escapeHtml(win.name || win.id)}</span>`;
      pill.addEventListener("click", () => yo.canvasRestore(win.id));
      tray!.appendChild(pill);
    }
  }

  // -- Move --
  function startMove(e: MouseEvent, win: CanvasWin, el: HTMLElement): void {
    if ((e.target as HTMLElement).closest(".canvas-tb-btn")) return;
    e.preventDefault();
    yo.canvasFocus(win.id);
    interacting = true;
    yo.panelsHide(); // detach views so chrome drags smoothly
    el.classList.add("canvas-win--dragging");
    const startX = e.clientX, startY = e.clientY;
    const origX = win.x, origY = win.y;
    let nx = origX, ny = origY;

    const onMove = (ev: MouseEvent) => {
      nx = origX + (ev.clientX - startX);
      ny = origY + (ev.clientY - startY);
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("canvas-win--dragging");
      yo.canvasSetBounds(win.id, { x: nx, y: ny, w: win.w, h: win.h });
      interacting = false;
      yo.panelsShow();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // -- Resize --
  function startResize(e: MouseEvent, win: CanvasWin, el: HTMLElement, edge: "r" | "b" | "br"): void {
    e.preventDefault();
    e.stopPropagation();
    yo.canvasFocus(win.id);
    interacting = true;
    yo.panelsHide();
    el.classList.add("canvas-win--dragging");
    const startX = e.clientX, startY = e.clientY;
    const origW = win.w, origH = win.h;
    let nw = origW, nh = origH;

    const onMove = (ev: MouseEvent) => {
      if (edge === "r" || edge === "br") nw = Math.max(MIN_W, origW + (ev.clientX - startX));
      if (edge === "b" || edge === "br") nh = Math.max(MIN_H, origH + (ev.clientY - startY));
      el.style.width = `${nw}px`;
      el.style.height = `${nh}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("canvas-win--dragging");
      yo.canvasSetBounds(win.id, { x: win.x, y: win.y, w: nw, h: nh });
      interacting = false;
      yo.panelsShow();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }

  yo.onCanvasState((s) => { state = s; render(); });
  yo.canvasGetState().then((s) => { state = s; render(); }).catch(() => { /* */ });
}
