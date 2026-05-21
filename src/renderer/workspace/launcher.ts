// @ts-nocheck
/**
 * launcher.ts — the left-rail launcher: Apps grid (+ add/edit/delete modal
 * and per-card popover), Agents list, and Layouts list. Registers ctx.APPS
 * (the in-memory app registry). Depends on ctx.pushSlide and ctx.wsConfirm.
 */
export function initLauncher(ctx) {
  const $ = (id) => document.getElementById(id);
  const { pushSlide, wsConfirm } = ctx;

  // ── Apps ───────────────────────────────────────────────
  const APPS = [
    { id: "gmail",    name: "Gmail",     letter: "M",  color: "#D94235" },
    { id: "calendar", name: "Calendar",  letter: "C",  color: "#4285F4" },
    { id: "drive",    name: "Drive",     letter: "D",  color: "#0F9D58" },
    { id: "slack",    name: "Slack",     letter: "S",  color: "#4A154B" },
    { id: "linear",   name: "Linear",    letter: "L",  color: "#5E6AD2" },
    { id: "github",   name: "GitHub",    letter: "G",  color: "#1F2328" },
    { id: "notion",   name: "Notion",    letter: "N",  color: "#2A2A28" },
    { id: "figma",    name: "Figma",     letter: "F",  color: "#A259FF" },
    { id: "twitter",  name: "Twitter",   letter: "X",  color: "#000000" },
    { id: "reader",   name: "Reader",    letter: "R",  color: "#C97B47" },
    { id: "vscode",   name: "VS Code",   letter: "V",  color: "#0078D4" },
    { id: "browser",  name: "Browser",   letter: "B",  color: "#34A853", isBrowser: true },
  ];
  ctx.APPS = APPS;

  const appsListEl    = $("apps-list");
  const appsSearchEl  = $("apps-search-input");
  const appsCountEl   = $("apps-count");

  function renderAppsList(query) {
    if (!appsListEl) return;
    const q = (query || "").trim().toLowerCase();
    const filtered = q ? APPS.filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q)) : APPS;
    appsListEl.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ws-apps-empty";
      empty.textContent = "no matches";
      appsListEl.appendChild(empty);
      return;
    }
    filtered.forEach((app) => {
      const card = document.createElement("div");
      card.className = "ws-app-card";
      card.dataset.id = app.id;
      card.title = app.name;
      card.innerHTML = `
        <button class="ws-app-card-menu" title="More" aria-label="More">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6"/>
            <circle cx="12" cy="12" r="1.6"/>
            <circle cx="12" cy="19" r="1.6"/>
          </svg>
        </button>
        <span class="ws-app-avatar"></span>
        <span class="name"></span>
      `;
      const avatar = card.querySelector(".ws-app-avatar");
      avatar.textContent = app.letter;
      avatar.style.background = app.color;
      card.querySelector(".name").textContent = app.name;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".ws-app-card-menu")) return;
        launchApp(app);
      });
      card.querySelector(".ws-app-card-menu").addEventListener("click", (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 160, r.left);
        showAppCardMenu(app, x, r.bottom + 4);
      });
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showAppCardMenu(app, e.clientX, e.clientY);
      });
      appsListEl.appendChild(card);
    });
  }
  function launchApp(app) {
    try { pushSlide(app); }
    catch (err) { console.error("[apps] pushSlide failed:", err); }
  }

  if (appsSearchEl) {
    appsSearchEl.addEventListener("input", (e) => renderAppsList(e.target.value));
    appsSearchEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { appsSearchEl.value = ""; renderAppsList(""); }
    });
  }
  renderAppsList("");
  function syncAppsCount() { if (appsCountEl) appsCountEl.textContent = String(APPS.length); }
  syncAppsCount();
  if (appsListEl) new MutationObserver(syncAppsCount).observe(appsListEl, { childList: true });

  // ── Agents ─────────────────────────────────────────────
  const AGENT_BRAND_LOGOS = {
    anthropic:  "https://assets.pipedream.net/s.v0/app_1dBhqA/logo/orig",
    openai:     "https://assets.pipedream.net/s.v0/app_mWnhBo/logo/orig",
    google:     "https://assets.pipedream.net/s.v0/app_ArhjGP/logo/orig",
    xai:        "https://assets.pipedream.net/s.v0/app_9zh0ye/logo/orig",
    perplexity: "https://assets.pipedream.net/s.v0/app_7Lho0v/logo/orig",
  };
  function brandFor(provider) {
    const p = (provider || "").toLowerCase();
    if (p.startsWith("anthropic") || p === "claude") return "anthropic";
    if (p.startsWith("openai") || p === "gpt" || p.startsWith("codex")) return "openai";
    if (p.startsWith("google") || p === "gemini") return "google";
    if (p.startsWith("xai") || p === "grok") return "xai";
    if (p.startsWith("perplexity") || p === "pplx") return "perplexity";
    return "generic";
  }
  const AGENTS = [
    { id: "claude",   name: "Claude",     provider: "anthropic", model: "claude-sonnet-4-6" },
    { id: "opus",     name: "Opus",       provider: "anthropic", model: "claude-opus-4-7" },
    { id: "codex",    name: "Codex",      provider: "openai",    model: "gpt-5-codex" },
    { id: "gemini",   name: "Gemini",     provider: "google",    model: "gemini-2.5-pro" },
    { id: "grok",     name: "Grok",       provider: "xai",       model: "grok-4" },
    { id: "pplx",     name: "Perplexity", provider: "perplexity",model: "sonar-pro" },
  ];
  const agentsListEl   = $("agents-list");
  const agentsSearchEl = $("agents-search-input");
  const agentsCountEl  = $("agents-count");
  function renderAgentsList(query) {
    if (!agentsListEl) return;
    const q = (query || "").trim().toLowerCase();
    const filtered = q
      ? AGENTS.filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q) || (a.model || "").toLowerCase().includes(q))
      : AGENTS;
    agentsListEl.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ws-apps-empty";
      empty.textContent = "no matches";
      agentsListEl.appendChild(empty);
    } else {
      filtered.forEach((agent) => {
        const row = document.createElement("div");
        row.className = "ws-agent-row";
        row.dataset.id = agent.id;
        row.title = `${agent.name} · ${agent.model}`;
        row.innerHTML = `
          <span class="ws-agent-badge"></span>
          <span class="name"></span>
          <span class="model"></span>
          <button class="ws-agent-card-menu" title="More" aria-label="More">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.6"/>
              <circle cx="12" cy="12" r="1.6"/>
              <circle cx="12" cy="19" r="1.6"/>
            </svg>
          </button>
        `;
        const badge = row.querySelector(".ws-agent-badge");
        const brand = brandFor(agent.provider);
        const url = AGENT_BRAND_LOGOS[brand];
        if (url) {
          const img = document.createElement("img");
          img.src = url; img.alt = brand;
          badge.appendChild(img);
        } else {
          const ini = document.createElement("span");
          ini.className = "initial";
          ini.textContent = agent.name.charAt(0).toUpperCase();
          badge.appendChild(ini);
        }
        row.querySelector(".name").textContent  = agent.name;
        row.querySelector(".model").textContent = (agent.model || "").split("-").slice(-1)[0] || "";
        row.addEventListener("click", (e) => {
          if (e.target.closest(".ws-agent-card-menu")) return;
          console.log("[agents] launch", agent.id);
        });
        agentsListEl.appendChild(row);
      });
    }
    if (agentsCountEl) agentsCountEl.textContent = String(AGENTS.length);
  }
  if (agentsSearchEl) {
    agentsSearchEl.addEventListener("input", (e) => renderAgentsList(e.target.value));
    agentsSearchEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { agentsSearchEl.value = ""; renderAgentsList(""); }
    });
  }
  renderAgentsList("");
  const agentsAddBtn = $("agents-add-btn");
  if (agentsAddBtn) {
    agentsAddBtn.addEventListener("click", () => console.log("[agents] add — modal TBD; same shape as Add App"));
  }

  // ── Layouts ────────────────────────────────────────────
  const LAYOUTS = [
    { id: "inbox",    name: "Inbox",    apps: ["gmail", "calendar"] },
    { id: "dev",      name: "Dev",      apps: ["vscode", "browser", "linear"] },
    { id: "writing",  name: "Writing",  apps: ["notion", "drive"] },
    { id: "research", name: "Research", apps: ["browser", "notion", "drive"] },
    { id: "standup",  name: "Standup",  apps: ["linear", "slack", "calendar"] },
  ];
  const layoutsListEl   = $("layouts-list");
  const layoutsSearchEl = $("layouts-search-input");
  const layoutsCountEl  = $("layouts-count");
  const layoutsAddBtn   = $("layouts-add-btn");
  function renderLayoutsList(query) {
    if (!layoutsListEl) return;
    const q = (query || "").trim().toLowerCase();
    const filtered = q ? LAYOUTS.filter((l) => l.name.toLowerCase().includes(q) || l.id.includes(q)) : LAYOUTS;
    layoutsListEl.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ws-apps-empty";
      empty.textContent = "no matches";
      layoutsListEl.appendChild(empty);
    } else {
      filtered.forEach((layout) => {
        const row = document.createElement("div");
        row.className = "ws-agent-row";
        row.dataset.id = layout.id;
        row.title = `${layout.name} · ${layout.apps.join(" + ")}`;
        const badge = document.createElement("span");
        badge.className = "ws-layout-badge";
        layout.apps.slice(0, 3).forEach((appId) => {
          const app = APPS.find((a) => a.id === appId);
          const mini = document.createElement("span");
          mini.className = "mini";
          if (app) { mini.style.background = app.color; mini.textContent = app.letter; }
          else { mini.style.background = "var(--surface-3)"; mini.textContent = "?"; }
          badge.appendChild(mini);
        });
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = layout.name;
        const count = document.createElement("span");
        count.className = "model";
        count.textContent = `${layout.apps.length}`;
        const menu = document.createElement("button");
        menu.className = "ws-agent-card-menu";
        menu.title = "More";
        menu.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5"  r="1.6"/>
          <circle cx="12" cy="12" r="1.6"/>
          <circle cx="12" cy="19" r="1.6"/>
        </svg>`;
        row.appendChild(badge); row.appendChild(name); row.appendChild(count); row.appendChild(menu);
        row.addEventListener("click", (e) => {
          if (e.target.closest(".ws-agent-card-menu")) return;
          const apps = layout.apps.map((id) => APPS.find((a) => a.id === id)).filter(Boolean);
          if (apps.length === 0) return;
          apps.forEach(pushSlide);
        });
        layoutsListEl.appendChild(row);
      });
    }
    if (layoutsCountEl) layoutsCountEl.textContent = String(LAYOUTS.length);
  }
  if (layoutsSearchEl) {
    layoutsSearchEl.addEventListener("input", (e) => renderLayoutsList(e.target.value));
    layoutsSearchEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { layoutsSearchEl.value = ""; renderLayoutsList(""); }
    });
  }
  if (layoutsAddBtn) {
    layoutsAddBtn.addEventListener("click", () => console.log("[layouts] add — modal TBD; pick name + apps[]"));
  }
  renderLayoutsList("");

  // ── Add-app modal + per-card popover ───────────────────
  const addAppModal       = $("add-app-modal");
  const addAppBtn         = $("apps-add-btn");
  const addAppClose       = $("add-app-close");
  const addAppCancel      = $("add-app-cancel");
  const addAppSave        = $("add-app-save");
  const addAppDelete      = $("add-app-delete");
  const addAppTitle       = $("add-app-title");
  const appCardMenu       = $("app-card-menu");
  let   editingApp        = null;
  let   popoverAppId      = null;
  const addAppName        = $("add-app-name");
  const addAppSlug        = $("add-app-slug");
  const addAppUrl         = $("add-app-url");
  const addAppForceWeb    = $("add-app-force-web");
  const addAppDoNotRec    = $("add-app-do-not-record");
  const addAppPolicy      = $("add-app-capture-policy");
  const addAppError       = $("add-app-error");
  const addAppTabs        = $("add-app-tabs");
  const addAppMcpTransport= $("add-app-mcp-transport");
  const addAppMcpStdio    = $("add-app-mcp-stdio");
  const addAppMcpSse      = $("add-app-mcp-sse");
  const addAppMcpCommand  = $("add-app-mcp-command");
  const addAppMcpArgs     = $("add-app-mcp-args");
  const addAppMcpEnv      = $("add-app-mcp-env");
  const addAppMcpUrl      = $("add-app-mcp-url");

  const APP_COLORS = ["#D94235","#4285F4","#0F9D58","#5E6AD2","#A259FF","#C97B47","#2A2A28","#4A154B","#1F2328","#6FB36F"];
  function colorForName(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return APP_COLORS[h % APP_COLORS.length];
  }
  function slugifyName(name) {
    return (name || "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  }
  function openAppModal(app) {
    if (!addAppModal) return;
    editingApp = app || null;
    addAppTitle.textContent = editingApp ? "Edit App" : "Add App";
    addAppSave.textContent  = editingApp ? "Save changes" : "Add app";
    addAppDelete.classList.toggle("hidden", !editingApp);
    addAppError.classList.add("hidden");
    addAppError.textContent = "";
    if (editingApp) {
      addAppName.value = app.name || "";
      addAppSlug.value = app.id || "";
      addAppUrl.value  = app.url || "";
      addAppForceWeb.checked = !!app.forceWeb;
      addAppDoNotRec.checked = !!app.doNotRecord;
      addAppPolicy.value     = app.capturePolicy || "append";
      if (app.mcp) {
        addAppMcpTransport.value = app.mcp.transport || "";
        addAppMcpCommand.value   = app.mcp.command || "";
        addAppMcpArgs.value      = app.mcp.args || "";
        addAppMcpEnv.value       = app.mcp.env || "";
        addAppMcpUrl.value       = app.mcp.url || "";
        addAppMcpStdio.classList.toggle("hidden", app.mcp.transport !== "stdio");
        addAppMcpSse.classList.toggle("hidden",   app.mcp.transport !== "sse");
      } else {
        addAppMcpTransport.value = "";
        addAppMcpCommand.value = ""; addAppMcpArgs.value = ""; addAppMcpEnv.value = ""; addAppMcpUrl.value = "";
        addAppMcpStdio.classList.add("hidden");
        addAppMcpSse.classList.add("hidden");
      }
    } else {
      addAppName.value = ""; addAppSlug.value = ""; addAppUrl.value = "";
      addAppForceWeb.checked = false; addAppDoNotRec.checked = false;
      addAppPolicy.value = "append";
      addAppMcpTransport.value = "";
      addAppMcpCommand.value = ""; addAppMcpArgs.value = ""; addAppMcpEnv.value = ""; addAppMcpUrl.value = "";
      addAppMcpStdio.classList.add("hidden");
      addAppMcpSse.classList.add("hidden");
    }
    switchAddAppTab("dashboard");
    addAppModal.classList.add("open");
    addAppModal.setAttribute("aria-hidden", "false");
    setTimeout(() => addAppName.focus(), 30);
  }
  const openAddAppModal = () => openAppModal(null);
  function switchAddAppTab(name) {
    if (!addAppTabs) return;
    addAppTabs.querySelectorAll(".ws-modal-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    addAppModal.querySelectorAll(".ws-modal-tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === name));
  }
  if (addAppTabs) {
    addAppTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".ws-modal-tab");
      if (!btn) return;
      switchAddAppTab(btn.dataset.tab);
    });
  }
  if (addAppMcpTransport) {
    addAppMcpTransport.addEventListener("change", () => {
      const v = addAppMcpTransport.value;
      addAppMcpStdio.classList.toggle("hidden", v !== "stdio");
      addAppMcpSse.classList.toggle("hidden", v !== "sse");
    });
  }
  function closeAddAppModal() {
    if (!addAppModal) return;
    addAppModal.classList.remove("open");
    addAppModal.setAttribute("aria-hidden", "true");
  }
  function showAddAppError(msg) {
    addAppError.textContent = msg;
    addAppError.classList.remove("hidden");
  }
  function saveAddApp() {
    const name = addAppName.value.trim();
    const url  = addAppUrl.value.trim();
    let   slug = addAppSlug.value.trim() || slugifyName(name);
    if (!name) { switchAddAppTab("dashboard"); return showAddAppError("Name is required"); }
    if (!url)  { switchAddAppTab("dashboard"); return showAddAppError("URL is required"); }
    if (!/^https?:\/\//i.test(url)) { switchAddAppTab("dashboard"); return showAddAppError("URL must start with http:// or https://"); }
    if (!slug) { switchAddAppTab("dashboard"); return showAddAppError("Slug couldn't be derived from name"); }
    const dup = APPS.find((a) => a.id === slug);
    if (dup && (!editingApp || dup.id !== editingApp.id)) {
      switchAddAppTab("dashboard");
      return showAddAppError(`Slug "${slug}" already in use`);
    }
    const next = {
      id: slug, name, letter: name[0].toUpperCase(), color: colorForName(name), url,
      forceWeb: addAppForceWeb.checked, doNotRecord: addAppDoNotRec.checked, capturePolicy: addAppPolicy.value,
    };
    const transport = addAppMcpTransport.value;
    if (transport === "stdio") {
      next.mcp = { transport, command: addAppMcpCommand.value.trim(), args: addAppMcpArgs.value.trim(), env: addAppMcpEnv.value.trim() };
    } else if (transport === "sse") {
      next.mcp = { transport, url: addAppMcpUrl.value.trim() };
    }
    if (editingApp) {
      const idx = APPS.findIndex((a) => a.id === editingApp.id);
      if (idx >= 0) APPS[idx] = { ...editingApp, ...next };
      if (window.yo && window.yo.updateApp) { try { window.yo.updateApp(next); } catch (err) { console.warn("[apps] updateApp failed:", err); } }
    } else {
      APPS.push(next);
      if (window.yo && window.yo.saveApp) { try { window.yo.saveApp(next); } catch (err) { console.warn("[apps] saveApp failed:", err); } }
    }
    renderAppsList(appsSearchEl ? appsSearchEl.value : "");
    closeAddAppModal();
  }
  async function deleteAppFlow(app) {
    if (!app) return;
    const ok = await wsConfirm(`Delete "${app.name}"? This can't be undone.`);
    if (!ok) return;
    const idx = APPS.findIndex((a) => a.id === app.id);
    if (idx >= 0) APPS.splice(idx, 1);
    renderAppsList(appsSearchEl ? appsSearchEl.value : "");
    closeAddAppModal();
    if (window.yo && window.yo.deleteApp) { try { window.yo.deleteApp(app.id); } catch (err) { console.warn("[apps] deleteApp failed:", err); } }
  }

  if (addAppBtn)    addAppBtn.addEventListener("click", openAddAppModal);
  if (addAppClose)  addAppClose.addEventListener("click", closeAddAppModal);
  if (addAppCancel) addAppCancel.addEventListener("click", closeAddAppModal);
  if (addAppSave)   addAppSave.addEventListener("click", saveAddApp);
  if (addAppDelete) addAppDelete.addEventListener("click", () => deleteAppFlow(editingApp));

  function showAppCardMenu(app, x, y) {
    if (!appCardMenu) return;
    popoverAppId = app.id;
    appCardMenu.style.left = x + "px";
    appCardMenu.style.top  = y + "px";
    appCardMenu.classList.add("open");
  }
  function hideAppCardMenu() {
    if (!appCardMenu) return;
    appCardMenu.classList.remove("open");
    popoverAppId = null;
  }
  if (appCardMenu) {
    appCardMenu.addEventListener("click", (e) => {
      const btn = e.target.closest(".ws-popover-item");
      if (!btn) return;
      const app = APPS.find((a) => a.id === popoverAppId);
      const action = btn.dataset.action;
      hideAppCardMenu();
      if (!app) return;
      if (action === "edit")        openAppModal(app);
      else if (action === "delete") deleteAppFlow(app);
    });
  }
  document.addEventListener("click", (e) => {
    if (!appCardMenu || !appCardMenu.classList.contains("open")) return;
    if (appCardMenu.contains(e.target)) return;
    hideAppCardMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && appCardMenu && appCardMenu.classList.contains("open")) hideAppCardMenu();
  });
  if (addAppModal) {
    addAppModal.addEventListener("click", (e) => { if (e.target === addAppModal) closeAddAppModal(); });
  }
  document.addEventListener("keydown", (e) => {
    if (!addAppModal || !addAppModal.classList.contains("open")) return;
    if (e.key === "Escape") { e.preventDefault(); closeAddAppModal(); return; }
    if (e.key === "Enter" && e.target && e.target.tagName !== "TEXTAREA") { e.preventDefault(); saveAddApp(); }
  });
}
