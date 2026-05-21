// @ts-nocheck
/**
 * slides.ts — the center slide stack (apps push in from the left) and the
 * special-cased Browser slide (tabs, URL bar, landing/error pages).
 *
 * Registers on ctx: slideStack, pushSlide, popSlide, popTo, clearStack,
 * renderStackDots. Depends on nothing.
 */
export function initSlides(ctx) {
  const $ = (id) => document.getElementById(id);

  // Browser-app settings (defaults; persisted to localStorage).
  const BROWSER_SETTINGS = {
    defaultSearch: localStorage.getItem("ws-browser-search") || "https://www.google.com/search?q=",
    defaultLandingPage: localStorage.getItem("ws-browser-landing") || "yo://newtab",
  };

  const slidesLayer = $("slides-layer");
  const stackDots   = $("stack-dots");
  const slideStack  = [];
  let nextSlideId   = 1;

  function pushSlide(app) {
    if (!slidesLayer) { console.warn("[slides] no slides-layer element"); return; }
    const id = nextSlideId++;
    const el = renderSlideEl(app);
    el.style.transform = "translateX(-100%)";
    slidesLayer.appendChild(el);
    slideStack.push({ id, app, el });
    slidesLayer.classList.add("has-slides");
    void el.offsetWidth;
    el.style.transform = "";
    el.classList.add("active");
    renderStackDots();
  }
  function popSlide() {
    if (slideStack.length === 0) return;
    const slide = slideStack.pop();
    slide.el.classList.remove("active");
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      slide.el.remove();
      if (slideStack.length === 0) slidesLayer.classList.remove("has-slides");
    };
    slide.el.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 320);
    renderStackDots();
  }
  function popTo(idx) {
    while (slideStack.length > idx + 1) popSlide();
  }
  function clearStack() {
    while (slideStack.length > 0) popSlide();
  }

  function renderSlideEl(app) {
    if (app.isBrowser) return renderBrowserSlideEl(app);
    const el = document.createElement("div");
    el.className = "ws-slide";
    el.setAttribute("data-debug", "SLIDE_" + app.id);
    const bodyMarkup = app.__body
      ? app.__body
      : `<div class="ws-slide-body-stub">
           <div class="big"></div>
           <div class="label"></div>
           <div class="sub">prototype slide — hookable to a webview / iframe</div>
         </div>`;
    el.innerHTML = `
      <div class="ws-slide-header">
        <span class="ws-slide-avatar"></span>
        <span class="ws-slide-name"></span>
        <button class="ws-slide-close" title="Close all apps">×</button>
      </div>
      <div class="ws-slide-body">${bodyMarkup}</div>
    `;
    const avatar = el.querySelector(".ws-slide-avatar");
    avatar.textContent = app.letter;
    avatar.style.background = app.color;
    el.querySelector(".ws-slide-name").textContent = app.name;
    const stubBig = el.querySelector(".ws-slide-body-stub .big");
    if (stubBig) {
      stubBig.textContent = app.letter;
      stubBig.style.color = app.color;
      el.querySelector(".ws-slide-body-stub .label").textContent = app.name;
    }
    el.querySelector(".ws-slide-close").addEventListener("click", clearStack);
    return el;
  }

  // ── Browser slide (special-cased app) ───────────────────
  function renderBrowserSlideEl(app) {
    const el = document.createElement("div");
    el.className = "ws-slide ws-browser";
    el.setAttribute("data-debug", "SLIDE_browser");
    el.innerHTML = `
      <div class="ws-browser-tabs">
        <div class="ws-browser-tablist"></div>
        <button class="ws-browser-newtab" title="New tab (⌘T)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <div class="ws-browser-actions">
          <button class="ws-browser-icon ws-browser-download" title="Downloads">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          <button class="ws-browser-icon ws-slide-close" title="Close all apps">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="ws-browser-toolbar">
        <button class="ws-browser-icon ws-browser-back" title="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button class="ws-browser-icon ws-browser-fwd" title="Forward">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="ws-browser-icon ws-browser-reload" title="Reload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <input class="ws-browser-url" type="text" placeholder="Search or enter URL" spellcheck="false" autocomplete="off" />
      </div>
      <div class="ws-browser-content"></div>
    `;
    const state = {
      tabs: [{ id: 1, title: "New tab", url: BROWSER_SETTINGS.defaultLandingPage, history: [] }],
      activeId: 1,
      nextId: 2,
    };
    el._browser = state;

    el.querySelector(".ws-slide-close").addEventListener("click", clearStack);

    const tabsList   = el.querySelector(".ws-browser-tablist");
    const newTabBtn  = el.querySelector(".ws-browser-newtab");
    const urlInput   = el.querySelector(".ws-browser-url");
    const backBtn    = el.querySelector(".ws-browser-back");
    const fwdBtn     = el.querySelector(".ws-browser-fwd");
    const reloadBtn  = el.querySelector(".ws-browser-reload");
    const downloadBtn= el.querySelector(".ws-browser-download");
    const contentEl  = el.querySelector(".ws-browser-content");

    function paint() {
      tabsList.innerHTML = "";
      state.tabs.forEach((tab) => {
        const tabEl = document.createElement("div");
        tabEl.className = "ws-browser-tab" + (tab.id === state.activeId ? " active" : "");
        tabEl.dataset.id = String(tab.id);
        tabEl.innerHTML = `
          <span class="favicon"></span>
          <span class="title"></span>
          <button class="close" title="Close tab">×</button>
        `;
        tabEl.querySelector(".title").textContent = tab.title || "New tab";
        tabEl.addEventListener("click", (e) => {
          if (e.target.closest(".close")) {
            e.stopPropagation();
            closeTab(tab.id);
          } else if (tab.id !== state.activeId) {
            state.activeId = tab.id;
            paint();
          }
        });
        tabsList.appendChild(tabEl);
      });
      const tab = state.tabs.find((t) => t.id === state.activeId);
      if (!tab) return;
      urlInput.value = tab.url === BROWSER_SETTINGS.defaultLandingPage ? "" : tab.url;
      contentEl.innerHTML = "";
      contentEl.appendChild(renderTabContent(tab));
    }
    function newTab(url) {
      const tab = { id: state.nextId++, title: "New tab", url: url || BROWSER_SETTINGS.defaultLandingPage, history: [] };
      state.tabs.push(tab);
      state.activeId = tab.id;
      paint();
    }
    function closeTab(id) {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      state.tabs.splice(idx, 1);
      if (state.tabs.length === 0) { newTab(); return; }
      if (state.activeId === id) state.activeId = state.tabs[Math.max(0, idx - 1)].id;
      paint();
    }
    function navigate(input) {
      const tab = state.tabs.find((t) => t.id === state.activeId);
      if (!tab) return;
      const q = (input || "").trim();
      if (!q) return;
      let url = q;
      if (q === "demo:404" || q === "demo:500" || q === "demo:offline") {
        url = q;
      } else if (!/^[a-z]+:\/\//i.test(q) && !/^yo:\/\//i.test(q)) {
        if (q.includes(" ") || !q.includes(".")) {
          url = BROWSER_SETTINGS.defaultSearch + encodeURIComponent(q);
        } else {
          url = "https://" + q;
        }
      }
      tab.history.push(tab.url);
      tab.url = url;
      tab.title = titleForUrl(url);
      paint();
    }
    function titleForUrl(url) {
      if (url === BROWSER_SETTINGS.defaultLandingPage) return "New tab";
      if (url.startsWith("demo:")) return "Error · " + url.slice(5);
      try { return new URL(url).hostname.replace(/^www\./, ""); }
      catch { return url; }
    }

    newTabBtn.addEventListener("click", () => newTab());
    backBtn.addEventListener("click", () => {
      const tab = state.tabs.find((t) => t.id === state.activeId);
      if (!tab || tab.history.length === 0) return;
      tab.url = tab.history.pop();
      tab.title = titleForUrl(tab.url);
      paint();
    });
    fwdBtn.addEventListener("click",  () => { /* forward stack TBD */ });
    reloadBtn.addEventListener("click", () => paint());
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); navigate(urlInput.value); }
    });
    downloadBtn.addEventListener("click", () => {
      console.log("[browser] downloads panel — TBD");
    });

    paint();
    return el;

    function renderTabContent(tab) {
      const wrap = document.createElement("div");
      wrap.className = "ws-browser-page";
      if (tab.url === BROWSER_SETTINGS.defaultLandingPage || !tab.url) {
        wrap.appendChild(renderBrowserLanding());
      } else if (tab.url === "demo:404") {
        wrap.appendChild(renderBrowserError({ code: "404", title: "Page not found", body: "We couldn't find that page. It may have moved, or never existed." }));
      } else if (tab.url === "demo:500") {
        wrap.appendChild(renderBrowserError({ code: "500", title: "Server error", body: "The site is having trouble. Try again in a moment." }));
      } else if (tab.url === "demo:offline") {
        wrap.appendChild(renderBrowserError({ code: "—", title: "You're offline", body: "Connect to a network to load this page." }));
      } else {
        const stub = document.createElement("div");
        stub.className = "ws-browser-stub";
        stub.innerHTML = `<div class="big">${tab.url.replace(/[<>"]/g, "")}</div><div class="sub">(prototype — content area would render a webview / iframe here)</div>`;
        wrap.appendChild(stub);
      }
      return wrap;
    }
    function renderBrowserLanding() {
      const lel = document.createElement("div");
      lel.className = "ws-browser-landing";
      lel.innerHTML = `
        <div class="logo"><span class="dot">.</span>Yo</div>
        <div class="sub">Search or type a URL.</div>
        <form class="search">
          <input type="text" placeholder="Search the web" spellcheck="false" autocomplete="off" />
        </form>
        <div class="shortcuts">
          <a href="#" data-go="demo:404">demo:404</a>
          <a href="#" data-go="demo:500">demo:500</a>
          <a href="#" data-go="demo:offline">demo:offline</a>
        </div>
      `;
      const form  = lel.querySelector("form");
      const input = lel.querySelector("input");
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        urlInput.value = input.value;
        navigate(urlInput.value);
      });
      lel.querySelectorAll("[data-go]").forEach((a) => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          urlInput.value = a.dataset.go;
          navigate(urlInput.value);
        });
      });
      return lel;
    }
    function renderBrowserError(opts) {
      const eel = document.createElement("div");
      eel.className = "ws-browser-error";
      eel.innerHTML = `
        <div class="code"></div>
        <div class="title"></div>
        <div class="body"></div>
        <button class="ws-btn">Try again</button>
      `;
      eel.querySelector(".code").textContent  = opts.code;
      eel.querySelector(".title").textContent = opts.title;
      eel.querySelector(".body").textContent  = opts.body;
      eel.querySelector(".ws-btn").addEventListener("click", () => paint());
      return eel;
    }
  }

  function renderStackDots() {
    if (!stackDots) return;
    stackDots.innerHTML = "";
    if (slideStack.length === 0) { stackDots.classList.remove("open"); return; }
    stackDots.classList.add("open");
    slideStack.forEach((s, i) => {
      const dot = document.createElement("button");
      dot.className = "ws-stack-dot" + (i === slideStack.length - 1 ? " active" : "");
      dot.title = s.app.name;
      dot.addEventListener("click", () => popTo(i));
      stackDots.appendChild(dot);
    });
  }

  ctx.slideStack = slideStack;
  ctx.pushSlide = pushSlide;
  ctx.popSlide = popSlide;
  ctx.popTo = popTo;
  ctx.clearStack = clearStack;
  ctx.renderStackDots = renderStackDots;
}
