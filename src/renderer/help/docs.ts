/**
 * Docs section — loadDocs, legal constants, support, about.
 */


function loadDocs() {
  // Docs sub-nav is handled above (docsSubNav click handlers)
  // Nothing dynamic to load — all content is static HTML
}

// ── About ─────────────────────────────────────────────────
async function loadAbout() {
  // Version from package.json via main process
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    const ver = await window.yo.getAppVersion();
    versionEl.textContent = `Version ${ver}`;
  }

  const updateBtn = document.getElementById("about-check-update") as HTMLButtonElement | null;
  const progressWrap = document.getElementById("about-progress");
  const progressFill = document.getElementById("about-progress-fill");
  const progressText = document.getElementById("about-progress-text");
  const restartWrap = document.getElementById("about-restart");
  const restartBtn = document.getElementById("about-restart-btn");

  if (updateBtn) {
    updateBtn.addEventListener("click", async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = "Checking...";
      const ver = await window.yo.checkForUpdates();
      if (ver) {
        updateBtn.textContent = `Downloading v${ver}...`;
      } else {
        updateBtn.textContent = "You're up to date";
        setTimeout(() => {
          updateBtn.textContent = "Check for Updates";
          updateBtn.disabled = false;
        }, 3000);
      }
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      window.yo.updateInstall();
    });
  }

  window.yo.onUpdateStatus((info) => {
    if (info.status === "available" && updateBtn) {
      updateBtn.disabled = true;
      updateBtn.textContent = `Downloading v${info.version}...`;
    }
    if (info.status === "downloading" && progressWrap && progressFill && progressText) {
      progressWrap.classList.remove("hidden");
      restartWrap?.classList.add("hidden");
      progressFill.style.width = `${info.percent ?? 0}%`;
      progressText.textContent = `Downloading... ${info.percent ?? 0}%`;
    }
    if (info.status === "ready") {
      progressWrap?.classList.add("hidden");
      if (restartWrap) restartWrap.classList.remove("hidden");
      if (updateBtn) {
        updateBtn.disabled = true;
        updateBtn.textContent = `v${info.version} ready`;
      }
    }
  });
}

export { loadDocs, loadAbout };
