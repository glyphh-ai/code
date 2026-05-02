/**
 * Settings section — model config, toggles, MCP expose, tool overrides.
 */

import { closeHelp } from "./shared.js";

// ── Settings ─────────────────────────────────────────────

const settingsModelSelect = document.getElementById("settings-model-select") as HTMLSelectElement;
const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")!;

const toggleVoiceInput = document.getElementById("toggle-voice-input") as HTMLInputElement;
const voiceKeyWrap = document.getElementById("voice-key-wrap")!;
const settingsVoiceKey = document.getElementById("settings-voice-key") as HTMLInputElement;
const toggleRemote = document.getElementById("toggle-remote") as HTMLInputElement;
const toggleVscodeServer = document.getElementById("toggle-vscode-server") as HTMLInputElement;
const toggleShowTabs = document.getElementById("toggle-show-tabs") as HTMLInputElement;
const toggleShowUrlBar = document.getElementById("toggle-show-url-bar") as HTMLInputElement;
const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const toggleCypherAutoTerminate = document.getElementById("toggle-cypher-auto-terminate") as HTMLInputElement;
const toggleOfferUsage = document.getElementById("toggle-offer-usage") as HTMLInputElement;
const offerUsageStatus = document.getElementById("offer-usage-status")!;
const offerUsageClientId = document.getElementById("offer-usage-client-id")!;
const offerUsageTier = document.getElementById("offer-usage-tier")!;
const offerUsageProviders = document.getElementById("offer-usage-providers")!;
const mcpExposeStatus = document.getElementById("mcp-expose-status")!;
const mcpExposePort = document.getElementById("mcp-expose-port") as HTMLInputElement;
const mcpExposeTokensEl = document.getElementById("mcp-expose-tokens")!;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;
const settingsAgentMode = document.getElementById("settings-agent-mode") as HTMLSelectElement;
const toolOverridesBody = document.getElementById("tool-overrides-body")!;


async function refreshOfferUsageStatus() {
  const s = await window.yo.capabilitiesGetStatus();
  toggleOfferUsage.checked = s.enabled;
  offerUsageStatus.classList.toggle("hidden", !s.enabled);
  if (!s.enabled) return;
  offerUsageClientId.textContent = s.client_id || "—";
  offerUsageTier.textContent = s.derived_tier || "pending — waiting for server…";
  const report = s.report as { llm?: { providers?: Array<{ id: string }> } } | null;
  const providers = report?.llm?.providers?.map((p) => p.id).filter(Boolean) ?? [];
  offerUsageProviders.textContent = providers.length ? providers.join(", ") : "none detected";
}

async function refreshMcpExposeStatus() {
  const status = await window.yo.mcpExposeStatus();
  const port = status.port || parseInt(mcpExposePort.value, 10) || 7860;
  if (status.running) {
    mcpExposeStatus.textContent = `Running on http://127.0.0.1:${port}`;
    mcpExposeStatus.style.color = "var(--accent)";
  } else {
    mcpExposeStatus.textContent = "Starting...";
    mcpExposeStatus.style.color = "var(--text-2)";
  }
  const configEl = document.getElementById("mcp-expose-config-example");
  if (configEl) {
    configEl.textContent = `{
  "mcpServers": {
    "yo": {
      "type": "sse",
      "url": "http://127.0.0.1:${port}/sse",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}`;
  }
}

async function renderMcpTokens() {
  const tokens = await window.yo.mcpExposeGetTokens();
  mcpExposeTokensEl.innerHTML = "";
  if (tokens.length === 0) {
    mcpExposeTokensEl.innerHTML = '<span style="font-size:11px;color:var(--text-2);">No tokens yet. Generate one to connect an external tool.</span>';
    return;
  }
  for (const t of tokens) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 10px;background:var(--surface-2);border-radius:6px;";

    const label = document.createElement("span");
    label.style.cssText = "flex:1;font-size:12px;color:var(--text);";
    label.textContent = t.label || "Untitled";

    const created = document.createElement("span");
    created.style.cssText = "font-size:11px;color:var(--text-2);font-family:'SF Mono','Fira Code',monospace;";
    created.textContent = new Date(t.createdAt).toLocaleDateString();

    const expiresMs = new Date(t.expiresAt).getTime();
    const isNever = expiresMs > new Date("9990-01-01").getTime();
    const daysLeft = Math.ceil((expiresMs - Date.now()) / 86400000);
    const expires = document.createElement("span");
    expires.style.cssText = `font-size:11px;font-family:'SF Mono','Fira Code',monospace;color:${!isNever && daysLeft <= 7 ? "var(--danger)" : "var(--text-2)"};`;
    expires.textContent = isNever ? "Never expires" : `Expires ${new Date(t.expiresAt).toLocaleDateString()}`;

    const copy = document.createElement("button");
    copy.className = "action-btn";
    copy.style.cssText = "font-size:10px;padding:2px 8px;";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      window.yo.copyToClipboard(t.token);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });

    const revoke = document.createElement("button");
    revoke.className = "action-btn danger";
    revoke.style.cssText = "font-size:10px;padding:2px 8px;";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      await window.yo.mcpExposeRevokeToken(t.token);
      await renderMcpTokens();
    });

    row.appendChild(label);
    row.appendChild(created);
    row.appendChild(expires);
    row.appendChild(copy);
    row.appendChild(revoke);
    mcpExposeTokensEl.appendChild(row);
  }
}

function initSettings() {
  settingsSaveBtn.addEventListener("click", saveSettings);

  // Theme picker
  const themePicker = document.getElementById("theme-picker");
  if (themePicker) {
    window.yo.getTheme().then((theme) => {
      themePicker.querySelectorAll(".theme-option").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-theme") === theme);
      });
    });
    themePicker.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".theme-option") as HTMLElement | null;
      if (!btn) return;
      const theme = btn.getAttribute("data-theme")!;
      const resolved = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : theme;
      document.documentElement.setAttribute("data-theme", resolved);
      window.yo.setTheme(theme);
      themePicker.querySelectorAll(".theme-option").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  }

  // Service toggles — show relaunch bar when changed
  const showRelaunch = () => {
    const bar = document.getElementById("settings-relaunch")!;
    if (bar) bar.classList.remove("hidden");
  };
  // Voice input toggle + key
  toggleVoiceInput.addEventListener("change", () => {
    window.yo.setPreference("voiceEnabled", toggleVoiceInput.checked);
    voiceKeyWrap.classList.toggle("hidden", !toggleVoiceInput.checked);
    // Show/hide mic button immediately
    const micBtn = document.getElementById("yo-panel-mic");
    if (micBtn) micBtn.style.display = toggleVoiceInput.checked ? "" : "none";
  });
  const voiceKeySaveBtn = document.getElementById("voice-key-save")!;
  const voiceKeyStatus = document.getElementById("voice-key-status")!;
  voiceKeySaveBtn.addEventListener("click", () => {
    window.yo.setPreference("voiceApiKey", settingsVoiceKey.value.trim());
    voiceKeyStatus.textContent = "Saved";
    voiceKeyStatus.className = "settings-success";
    setTimeout(() => { voiceKeyStatus.textContent = ""; }, 2000);
  });

  toggleRemote.addEventListener("change", () => {
    window.yo.setPreference("remoteEnabled", toggleRemote.checked);
  });

  toggleVscodeServer.addEventListener("change", () => {
    window.yo.setPreference("enableVscodeServer", toggleVscodeServer.checked);
    showRelaunch();
  });
  toggleAutoUpdate.addEventListener("change", () => {
    window.yo.setPreference("autoUpdate", toggleAutoUpdate.checked);
    showRelaunch();
  });

  toggleCypherAutoTerminate.addEventListener("change", () => {
    window.yo.setPreference("cypherAutoTerminate", toggleCypherAutoTerminate.checked);
  });

  // Offer Usage — register/withdraw this client as available worker
  toggleOfferUsage.addEventListener("change", async () => {
    const enabled = toggleOfferUsage.checked;
    toggleOfferUsage.disabled = true;
    try {
      const result = await window.yo.capabilitiesSetEnabled(enabled);
      if (!result.ok) {
        toggleOfferUsage.checked = false;
        offerUsageStatus.classList.add("hidden");
        offerUsageTier.textContent = `Error: ${result.error || "unknown"}`;
        return;
      }
      await refreshOfferUsageStatus();
    } finally {
      toggleOfferUsage.disabled = false;
    }
  });

  // MCP Expose — port save
  document.getElementById("mcp-expose-port-save")!.addEventListener("click", async () => {
    const port = parseInt(mcpExposePort.value, 10);
    if (port >= 1024 && port <= 65535) {
      window.yo.setPreference("mcpExposePort", port);
      await refreshMcpExposeStatus();
    }
  });
  document.getElementById("mcp-expose-gen-token")!.addEventListener("click", async () => {
    const labelInput = document.getElementById("mcp-expose-token-label") as HTMLInputElement;
    const ttlSelect = document.getElementById("mcp-expose-token-ttl") as HTMLSelectElement;
    const label = labelInput.value.trim() || "default";
    const ttlDays = parseInt(ttlSelect.value, 10);
    const result = await window.yo.mcpExposeGenToken(label, ttlDays);
    labelInput.value = "";
    // Show the new token in the highlighted box
    const newTokenBox = document.getElementById("mcp-expose-new-token")!;
    const newTokenValue = document.getElementById("mcp-expose-new-token-value")!;
    newTokenValue.textContent = result.token;
    newTokenBox.classList.remove("hidden");
    await renderMcpTokens();
  });

  // Copy new token
  document.getElementById("mcp-expose-copy-token")!.addEventListener("click", () => {
    const val = document.getElementById("mcp-expose-new-token-value")!.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("mcp-expose-copy-token") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  // Copy config example
  document.getElementById("mcp-expose-copy-config")!.addEventListener("click", () => {
    const val = document.getElementById("mcp-expose-config-example")!.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("mcp-expose-copy-config") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  // Agent mode
  settingsAgentMode.addEventListener("change", () => {
    window.yo.setAgentMode(settingsAgentMode.value);
    // Sync the yo panel dropdown too
    const yoModeEl = document.getElementById("yo-mode-select") as HTMLSelectElement;
    if (yoModeEl) yoModeEl.value = settingsAgentMode.value;
  });

  toggleShowTabs.addEventListener("change", () => {
    window.yo.setPreference("showTabs", toggleShowTabs.checked);
    // Immediately refresh tab visibility
    window.yo.tabList().then((state) => {
      const tabBar = document.getElementById("tab-bar");
      const tabNewBtn = document.getElementById("tab-new-btn");
      if (tabBar) tabBar.style.display = toggleShowTabs.checked ? "flex" : "none";
      if (tabNewBtn) tabNewBtn.style.display = toggleShowTabs.checked ? "" : "none";
    });
  });

  toggleShowUrlBar.addEventListener("change", () => {
    const show = toggleShowUrlBar.checked;
    window.yo.urlBarToggle(show);
    const urlBar = document.getElementById("url-bar");
    if (urlBar) urlBar.classList.toggle("hidden", !show);
    document.body.style.setProperty("--content-top", show ? "72px" : "38px");
  });

  // Browser homepage
  settingsBrowserHome.addEventListener("change", () => {
    const val = settingsBrowserHome.value;
    browserHomeCustomRow.classList.toggle("hidden", val !== "custom");
    if (val !== "custom") {
      window.yo.setPreference("browserHomepage", val);
    }
  });
  settingsBrowserHomeUrl.addEventListener("change", () => {
    const url = settingsBrowserHomeUrl.value.trim();
    if (url) {
      window.yo.setPreference("browserHomepage", "custom");
      window.yo.setPreference("browserHomepageUrl", url);
    }
  });

  // Relaunch button
  document.getElementById("settings-relaunch-btn")?.addEventListener("click", () => {
    window.yo.relaunch();
  });

  // Account dashboard — opens platform in a browser tab
  document.getElementById("account-dashboard-btn")?.addEventListener("click", () => {
    closeHelp();
    window.yo.openExternal(window.yo.platformUrl);
  });

  // Sign out
  document.getElementById("account-logout-btn")?.addEventListener("click", async () => {
    document.getElementById("help-overlay")!.classList.add("hidden");
    await window.yo.logout();
  });
}


async function loadSettings() {
  settingsStatus.textContent = "";
  const [config, accountInfo, authStatus] = await Promise.all([
    window.yo.getLLMConfig(),
    window.yo.getAccountInfo(),
    window.yo.getAuthStatus(),
  ]);

  settingsModelSelect.value = config.model;

  // Account info
  const emailEl = document.getElementById("account-email")!;
  const nameEl = document.getElementById("account-name")!;
  const orgEl = document.getElementById("account-org")!;
  const tierEl = document.getElementById("account-tier")!;
  const statusEl = document.getElementById("account-status")!;

  if (accountInfo) {
    emailEl.textContent = accountInfo.email;
    nameEl.textContent = `${accountInfo.firstName} ${accountInfo.lastName}`;
    orgEl.textContent = accountInfo.orgName;
    tierEl.textContent = accountInfo.tier || "free";
    tierEl.className = `license-value ${accountInfo.tier !== "free" ? "active" : ""}`;

    const billingStatus = accountInfo.billingStatus || authStatus.status;
    if (billingStatus === "active") {
      statusEl.textContent = "Active";
      statusEl.className = "license-value active";
    } else if (billingStatus === "expired" || authStatus.status === "expired") {
      statusEl.textContent = "Expired";
      statusEl.className = "license-value expired";
    } else {
      statusEl.textContent = billingStatus === "none" ? "Free" : billingStatus;
      statusEl.className = "license-value";
    }
  } else {
    emailEl.textContent = "Not signed in";
    nameEl.textContent = "—";
    orgEl.textContent = "—";
    tierEl.textContent = "—";
    statusEl.textContent = "—";
  }

  // Load toggle states
  toggleShowTabs.checked = await window.yo.getPreference("showTabs", true) as boolean;
  toggleShowUrlBar.checked = await window.yo.getPreference("showUrlBar", true) as boolean;
  toggleVoiceInput.checked = await window.yo.getPreference("voiceEnabled", false) as boolean;
  voiceKeyWrap.classList.toggle("hidden", !toggleVoiceInput.checked);
  settingsVoiceKey.value = await window.yo.getPreference("voiceApiKey", "") as string;
  toggleRemote.checked = await window.yo.getPreference("remoteEnabled", false) as boolean;
  toggleVscodeServer.checked = await window.yo.getPreference("enableVscodeServer", false) as boolean;
  toggleAutoUpdate.checked = await window.yo.getPreference("autoUpdate", true) as boolean;
  toggleCypherAutoTerminate.checked = await window.yo.getPreference("cypherAutoTerminate", false) as boolean;
  await refreshOfferUsageStatus();

  // MCP Expose — gate behind Advanced tier
  const mcpSectionWrap = document.getElementById("mcp-section-wrap")!;
  const mcpProGate = document.getElementById("mcp-pro-gate")!;
  if (authStatus.tier !== "advanced") {
    mcpSectionWrap.classList.add("hidden");
    mcpProGate.classList.remove("hidden");
    const mcpUpgradeBtn = document.getElementById("mcp-upgrade-btn");
    if (mcpUpgradeBtn) {
      mcpUpgradeBtn.onclick = () => {
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
    }
  } else {
    mcpSectionWrap.classList.remove("hidden");
    mcpProGate.classList.add("hidden");
    document.getElementById("mcp-expose-new-token")?.classList.add("hidden");
    mcpExposePort.value = String(await window.yo.getPreference("mcpExposePort", 7860));
    await refreshMcpExposeStatus();
    await renderMcpTokens();
  }

  // Agent mode
  const currentMode = await window.yo.getAgentMode();
  settingsAgentMode.value = currentMode;

  // Tool overrides table
  const tools = await window.yo.getToolRegistry();
  toolOverridesBody.innerHTML = "";
  for (const tool of tools) {
    const tr = document.createElement("tr");
    tr.className = "tool-row";

    const tdName = document.createElement("td");
    tdName.className = "tool-td-name";
    tdName.textContent = tool.label;

    const tdDesc = document.createElement("td");
    tdDesc.className = "tool-td-desc";
    tdDesc.textContent = tool.description;

    const tdTier = document.createElement("td");
    tdTier.className = "tool-td-tier";
    const tierBadge = document.createElement("span");
    tierBadge.className = `tool-tier-badge tier-${tool.tier}`;
    tierBadge.textContent = tool.tier;
    tdTier.appendChild(tierBadge);

    const tdPerm = document.createElement("td");
    tdPerm.className = "tool-td-perm";
    const select = document.createElement("select");
    select.className = "tool-perm-select";
    select.innerHTML =
      `<option value="default"${tool.override === "default" ? " selected" : ""}>Default</option>` +
      `<option value="auto"${tool.override === "auto" ? " selected" : ""}>Auto</option>` +
      `<option value="ask"${tool.override === "ask" ? " selected" : ""}>Ask</option>` +
      `<option value="off"${tool.override === "off" ? " selected" : ""}>Off</option>`;
    select.addEventListener("change", () => {
      window.yo.setToolOverride(tool.name, select.value);
    });
    tdPerm.appendChild(select);

    tr.appendChild(tdName);
    tr.appendChild(tdDesc);
    tr.appendChild(tdTier);
    tr.appendChild(tdPerm);
    toolOverridesBody.appendChild(tr);
  }

  // Browser homepage
  const homePref = await window.yo.getPreference("browserHomepage", "claude") as string;
  settingsBrowserHome.value = homePref === "custom" ? "custom" : homePref;
  browserHomeCustomRow.classList.toggle("hidden", homePref !== "custom");
  if (homePref === "custom") {
    settingsBrowserHomeUrl.value = await window.yo.getPreference("browserHomepageUrl", "") as string;
  }
}

async function saveSettings() {
  const model = settingsModelSelect.value;

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving...";
  settingsStatus.textContent = "";

  const config = { provider: "anthropic", model };

  const result = await window.yo.saveLLMConfig(config);
  settingsSaveBtn.disabled = false;
  settingsSaveBtn.textContent = "Save";

  if (result.ok) {
    settingsStatus.textContent = "Saved!";
    settingsStatus.className = "settings-success";
  } else {
    settingsStatus.textContent = result.error || "Save failed";
    settingsStatus.className = "settings-error";
  }
}

export { loadSettings, initSettings };
