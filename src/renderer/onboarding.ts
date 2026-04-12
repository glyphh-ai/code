/**
 * Onboarding — license key + API key gate with matrix animation.
 *
 * Ported from glyphh-studio MatrixParticles (Three.js → Canvas2D).
 */

// ── Matrix animation ─────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  speed: number;
  brightness: number;
  flickerRate: number;
  tOffset: number;
  size: number;
  side: number; // -1 left wall, 1 right wall, 0 center stream
  col: number;
  direction: number;
}

function initAnimation(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const particles: Particle[] = [];

  function resize() {
    canvas.width = canvas.offsetWidth * devicePixelRatio;
    canvas.height = canvas.offsetHeight * devicePixelRatio;
  }
  resize();
  window.addEventListener("resize", resize);

  // Wall particles (left + right)
  for (const side of [-1, 1]) {
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 14; c++) {
        particles.push({
          x: 0, y: 0,
          speed: 0.6 + Math.random() * 0.8,
          brightness: 0.4 + Math.random() * 0.6,
          flickerRate: 1.5 + Math.random() * 3,
          tOffset: Math.random() * 20,
          size: 2 + Math.random() * 2,
          side,
          col: c,
          direction: 1,
        });
      }
    }
  }

  // Center stream particles
  const STREAM_COLS = 7;
  for (let c = 0; c < STREAM_COLS; c++) {
    for (let p = 0; p < 30; p++) {
      particles.push({
        x: 0, y: 0,
        speed: 0.4 + Math.random() * 0.6,
        brightness: 0.03 + Math.random() * 0.06,
        flickerRate: 1 + Math.random() * 3,
        tOffset: Math.random() * 14,
        size: 2 + Math.random(),
        side: 0,
        col: c,
        direction: c % 2 === 0 ? 1 : -1,
      });
    }
  }

  let running = true;
  const start = performance.now();

  function draw() {
    if (!running) return;
    const t = (performance.now() - start) / 1000;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    for (const p of particles) {
      if (p.side !== 0) {
        // Wall particles
        const cycle = ((t * p.speed + p.tOffset) % 4) / 4;
        const edgeX = p.side * (w * 0.48);
        const innerX = p.side * (w * 0.05);
        const px = cx + edgeX - cycle * (edgeX - innerX);
        const rowNorm = particles.indexOf(p) % 24 / 23;
        const py = cy + (rowNorm - 0.5) * h * 0.8;
        const jy = Math.sin(t * 1.5 + p.tOffset * 3) * 2;
        const depthNorm = p.col / 13;
        const depthDim = 0.25 + (1 - depthNorm) * 0.75;
        const headBright = 1 - cycle;
        const flicker = Math.sin(t * p.flickerRate * 2 + p.tOffset * 5) * 0.5 + 0.5;
        const b = headBright * p.brightness * depthDim;
        const isHead = cycle < 0.15;

        let r: number, g: number, bl: number;
        if (isHead) {
          r = Math.min(255, (0.8 * b + 0.2) * 255);
          g = Math.min(255, (0.6 * b + 0.15) * 255);
          bl = Math.min(255, (1.0 * b + 0.2) * 255);
        } else if (flicker > 0.7 && b > 0.3) {
          r = Math.min(255, 0.6 * b * 255);
          g = Math.min(255, 0.2 * b * 255);
          bl = Math.min(255, 1.0 * b * 255);
        } else {
          r = Math.min(255, 0.35 * b * 255);
          g = Math.min(255, 0.08 * b * 255);
          bl = Math.min(255, 0.75 * b * 255);
        }

        const sz = p.size * (0.4 + (1 - depthNorm) * 0.6);
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},0.8)`;
        ctx.fillRect(px - sz / 2, py + jy - sz / 2, sz * 1.2, sz * 1.8);
      } else {
        // Center stream particles
        const colX = cx + (p.col - 3) * w * 0.04;
        const rawY = (p.tOffset + t * p.speed * p.direction) % h;
        const py = ((rawY % h) + h) % h;
        const flicker = Math.sin(t * p.flickerRate + p.tOffset * 2) * 0.5 + 0.5;
        const b = p.brightness * (0.6 + flicker * 0.4);

        let r: number, g: number, bl: number;
        if (flicker > 0.85 && b > 0.035) {
          r = Math.min(255, b * 0.8 * 255);
          g = Math.min(255, b * 0.6 * 255);
          bl = Math.min(255, b * 255);
        } else if (p.col % 3 === 0) {
          r = Math.min(255, b * 0.6 * 255);
          g = Math.min(255, b * 0.2 * 255);
          bl = Math.min(255, b * 255);
        } else {
          r = Math.min(255, b * 0.35 * 255);
          g = Math.min(255, b * 0.08 * 255);
          bl = Math.min(255, b * 0.75 * 255);
        }

        ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},0.15)`;
        ctx.fillRect(colX - p.size / 2, py - p.size / 2, p.size, p.size);
      }
    }

    requestAnimationFrame(draw);
  }

  draw();

  return () => { running = false; };
}

// ── Onboarding UI logic ──────────────────────────────────

const overlay = document.getElementById("onboarding-overlay")!;
const canvas = document.getElementById("onboarding-canvas") as HTMLCanvasElement;
const licenseInput = document.getElementById("onboarding-license") as HTMLInputElement;
const apiKeyInput = document.getElementById("onboarding-apikey") as HTMLInputElement;
const cloudTokenInput = document.getElementById("onboarding-cloud-token") as HTMLInputElement;
const activateBtn = document.getElementById("onboarding-activate") as HTMLButtonElement;
const statusEl = document.getElementById("onboarding-status")!;
const trialInfo = document.getElementById("onboarding-trial")!;

let stopAnimation: (() => void) | null = null;

document.getElementById("onboarding-close")!.addEventListener("click", () => {
  window.yo.windowClose();
});

export function showOnboarding(trialDays?: number) {
  overlay.classList.remove("hidden");
  if (trialDays !== undefined && trialDays > 0) {
    trialInfo.textContent = `${trialDays} day${trialDays === 1 ? "" : "s"} remaining in trial`;
  } else if (trialDays === 0) {
    trialInfo.textContent = "Trial expired — enter a license key";
    trialInfo.classList.add("expired");
  }
  stopAnimation = initAnimation(canvas);
}

export function hideOnboarding() {
  overlay.classList.add("hidden");
  if (stopAnimation) { stopAnimation(); stopAnimation = null; }
}

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "onboarding-error" : "onboarding-success";
}

activateBtn.addEventListener("click", async () => {
  const license = licenseInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!license) {
    setStatus("License key is required", true);
    return;
  }
  if (!apiKey) {
    setStatus("API key is required", true);
    return;
  }

  activateBtn.disabled = true;
  activateBtn.textContent = "Validating...";
  setStatus("");

  // Validate license first
  const licenseOk = await window.yo.activateLicense(license);
  if (!licenseOk) {
    setStatus("Invalid license key — must start with YO- and be 12+ chars", true);
    activateBtn.disabled = false;
    activateBtn.textContent = "Activate";
    return;
  }

  // Test API key by making a real call
  const apiResult = await window.yo.validateApiKey(apiKey);
  if (!apiResult.valid) {
    setStatus(apiResult.error || "Invalid API key", true);
    activateBtn.disabled = false;
    activateBtn.textContent = "Activate";
    return;
  }

  // Save cloud sync token if provided (optional)
  const cloudToken = cloudTokenInput.value.trim();
  if (cloudToken) {
    window.yo.setPreference("cloudToken", cloudToken);
  }

  setStatus("Activated!");
  setTimeout(() => {
    hideOnboarding();
    window.yo.onboardingComplete();
  }, 600);
});

// Enter key submits
[licenseInput, apiKeyInput, cloudTokenInput].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") activateBtn.click();
  });
});
