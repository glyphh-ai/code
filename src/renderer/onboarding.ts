/**
 * Onboarding — license key + API key gate with matrix animation.
 *
 * Ported from glyphh-studio MatrixParticles (Three.js → Canvas2D).
 */

// ── Matrix animation ─────────────────────────────────────

// ── 3D→2D projection matching web hero (Three.js camera: pos=[0,0,6], fov=60) ──

const CAM_Z = 6;
const FOV_RAD = (60 / 2) * Math.PI / 180; // half-fov in radians

// Wall params (matching web MatrixParticles exactly)
const W_ROWS = 28;
const W_COLS = 18;
const WALL_HEIGHT = 8;
const WALL_DEPTH = 14;
const CORRIDOR_OUTER = 6;
const CORRIDOR_INNER = 1.0;

// Stream params
const S_COLS = 7;
const S_PER_COL = 30;
const S_SPACING = 0.6;
const S_HEIGHT = 12;
const S_Z = -8;

interface WallParticle {
  row: number; col: number; tOffset: number; speed: number;
  brightness: number; flickerRate: number; side: number;
}
interface StreamParticle {
  col: number; yOffset: number; speed: number; direction: number;
  brightness: number; flickerRate: number; size: number;
}

function project(x3: number, y3: number, z3: number, hw: number, hh: number) {
  const d = CAM_Z - z3;
  const scale = 1 / (d * Math.tan(FOV_RAD));
  return { sx: hw + x3 * hw * scale, sy: hh - y3 * hh * scale, scale: hw * scale };
}

function initAnimation(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;

  function resize() {
    canvas.width = canvas.offsetWidth * devicePixelRatio;
    canvas.height = canvas.offsetHeight * devicePixelRatio;
  }
  resize();
  window.addEventListener("resize", resize);

  // Build wall particles (left + right)
  const walls: WallParticle[] = [];
  for (const side of [-1, 1]) {
    for (let r = 0; r < W_ROWS; r++) {
      for (let c = 0; c < W_COLS; c++) {
        walls.push({
          row: r, col: c, side,
          tOffset: Math.random() * 20,
          speed: 0.6 + Math.random() * 0.8,
          brightness: 0.4 + Math.random() * 0.6,
          flickerRate: 1.5 + Math.random() * 3,
        });
      }
    }
  }

  // Build stream particles
  const streams: StreamParticle[] = [];
  for (let c = 0; c < S_COLS; c++) {
    const dir = c % 2 === 0 ? 1 : -1;
    for (let p = 0; p < S_PER_COL; p++) {
      streams.push({
        col: c, direction: dir,
        yOffset: Math.random() * S_HEIGHT,
        speed: 0.4 + Math.random() * 0.6,
        brightness: 0.15 + Math.random() * 0.2,
        flickerRate: 1 + Math.random() * 3,
        size: 0.08 + Math.random() * 0.04,
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
    const hw = w / 2;
    const hh = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Draw walls
    for (const wp of walls) {
      const yNorm = wp.row / (W_ROWS - 1);
      const y3 = (yNorm - 0.5) * WALL_HEIGHT;
      const cycle = ((t * wp.speed + wp.tOffset) % 4) / 4;
      const x3 = wp.side * (CORRIDOR_OUTER - cycle * (CORRIDOR_OUTER - CORRIDOR_INNER));
      const zNorm = wp.col / (W_COLS - 1);
      const z3 = -zNorm * WALL_DEPTH + 3;
      const jy = Math.sin(t * 1.5 + wp.tOffset * 3) * 0.03;

      const { sx, sy, scale } = project(x3, y3 + jy, z3, hw, hh);
      const depthScale = 0.4 + (1 - zNorm) * 0.6;
      const pulse = 1 + Math.sin(t * wp.flickerRate + wp.tOffset) * 0.1;
      const sz = 0.07 * depthScale * pulse * scale;

      const headBright = 0.2 + (1 - cycle) * 0.8;  // floor at 0.2, never fully dark
      const depthDim = 0.35 + (1 - zNorm) * 0.65;
      const b = headBright * wp.brightness * depthDim;
      const flicker = Math.sin(t * wp.flickerRate * 2 + wp.tOffset * 5) * 0.5 + 0.5;
      const isHead = cycle < 0.15;
      const isBright = flicker > 0.7 && b > 0.3;

      let r: number, g: number, bl: number;
      if (isHead) {
        r = (0.8 * b + 0.2) * 255; g = (0.85 * b + 0.22) * 255; bl = (0.8 * b + 0.2) * 255;
      } else if (isBright) {
        r = 0.55 * b * 255; g = 0.65 * b * 255; bl = 0.55 * b * 255;
      } else {
        r = 0.4 * b * 255; g = 0.48 * b * 255; bl = 0.4 * b * 255;
      }

      ctx.fillStyle = `rgba(${Math.min(255, r) | 0},${Math.min(255, g) | 0},${Math.min(255, bl) | 0},0.85)`;
      ctx.fillRect(sx - sz * 0.5, sy - sz * 0.75, sz, sz * 1.5);
    }

    // Draw streams
    for (const sp of streams) {
      const x3 = (sp.col - (S_COLS - 1) / 2) * S_SPACING;
      const rawY = (sp.yOffset + t * sp.speed * sp.direction) % S_HEIGHT;
      const y3 = ((rawY + S_HEIGHT) % S_HEIGHT) - S_HEIGHT / 2;

      const { sx, sy, scale } = project(x3, y3, S_Z, hw, hh);
      const sz = sp.size * scale;

      const flicker = Math.sin(t * sp.flickerRate + sp.yOffset * 2) * 0.5 + 0.5;
      const b = sp.brightness * (0.6 + flicker * 0.4);
      const normY = ((rawY + S_HEIGHT) % S_HEIGHT) / S_HEIGHT;
      const headGlow = normY < 0.1 ? 1.5 : 1;
      const finalB = Math.min(b * headGlow, 0.7);

      let r: number, g: number, bl: number;
      const whiteChance = flicker > 0.85 && finalB > 0.25;
      if (whiteChance) {
        r = finalB * 1.2 * 255; g = finalB * 1.3 * 255; bl = finalB * 1.2 * 255;
      } else if (sp.col % 3 === 0) {
        r = finalB * 0.7 * 255; g = finalB * 0.85 * 255; bl = finalB * 0.7 * 255;
      } else {
        r = finalB * 0.5 * 255; g = finalB * 0.6 * 255; bl = finalB * 0.5 * 255;
      }

      ctx.fillStyle = `rgba(${Math.min(255, r) | 0},${Math.min(255, g) | 0},${Math.min(255, bl) | 0},0.35)`;
      ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
    }

    requestAnimationFrame(draw);
  }

  draw();

  return () => { running = false; };
}

// ── Onboarding UI logic ──────────────────────────────────

const overlay = document.getElementById("onboarding-overlay")!;
const canvas = document.getElementById("onboarding-canvas") as HTMLCanvasElement;
const stepAuth = document.getElementById("onboarding-step-auth")!;
const stepApiKey = document.getElementById("onboarding-step-apikey")!;
const signinBtn = document.getElementById("onboarding-signin") as HTMLButtonElement;
const registerBtn = document.getElementById("onboarding-register") as HTMLButtonElement;
const providerSelect = document.getElementById("onboarding-provider") as HTMLSelectElement;
const apiKeyInput = document.getElementById("onboarding-apikey") as HTMLInputElement;
const baseUrlInput = document.getElementById("onboarding-base-url") as HTMLInputElement;
const modelInput = document.getElementById("onboarding-model") as HTMLInputElement;
const activateBtn = document.getElementById("onboarding-activate") as HTMLButtonElement;
const statusEl = document.getElementById("onboarding-status")!;
const trialInfo = document.getElementById("onboarding-trial")!;
const welcomeMsg = document.getElementById("onboarding-welcome-msg")!;

// Provider change -> update placeholders
let presets: Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }> | null = null;

window.yo.getLLMPresets().then((p) => { presets = p; });

providerSelect.addEventListener("change", () => {
  const p = providerSelect.value;
  const preset = presets?.[p];
  if (preset) {
    apiKeyInput.placeholder = `${preset.name} API key (${preset.keyPlaceholder})`;
  }
  const isCustom = p === "custom";
  baseUrlInput.classList.toggle("hidden", !isCustom);
  modelInput.classList.toggle("hidden", !isCustom);
});

let stopAnimation: (() => void) | null = null;

document.getElementById("onboarding-close")!.addEventListener("click", () => {
  window.yo.windowClose();
});

export function showOnboarding(needsAuth: boolean) {
  overlay.classList.remove("hidden");
  if (needsAuth) {
    trialInfo.textContent = "Sign in to your account or create one to get started.";
    stepAuth.classList.remove("hidden");
    stepApiKey.classList.add("hidden");
  } else {
    // Already authenticated, just need API key
    trialInfo.textContent = "One more step — set up your AI provider.";
    stepAuth.classList.add("hidden");
    stepApiKey.classList.remove("hidden");
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

// Step 1: Sign in / Register via BrowserWindow
signinBtn.addEventListener("click", async () => {
  signinBtn.disabled = true;
  signinBtn.textContent = "Opening...";
  setStatus("");

  const ok = await window.yo.startAuth("login");
  signinBtn.disabled = false;
  signinBtn.textContent = "Sign in";

  if (ok) {
    // Auth succeeded — move to API key step
    const account = await window.yo.getAccountInfo();
    if (account) {
      welcomeMsg.textContent = `Welcome back, ${account.firstName}! Enter your AI API key to get started.`;
    }
    stepAuth.classList.add("hidden");
    stepApiKey.classList.remove("hidden");
    trialInfo.textContent = "One more step — set up your AI provider.";
    apiKeyInput.focus();
  } else {
    setStatus("Sign in was cancelled or failed", true);
  }
});

registerBtn.addEventListener("click", async () => {
  registerBtn.disabled = true;
  registerBtn.textContent = "Opening...";
  setStatus("");

  const ok = await window.yo.startAuth("register");
  registerBtn.disabled = false;
  registerBtn.textContent = "Create Account";

  if (ok) {
    const account = await window.yo.getAccountInfo();
    if (account) {
      welcomeMsg.textContent = `Welcome, ${account.firstName}! Enter your AI API key to get started.`;
    }
    stepAuth.classList.add("hidden");
    stepApiKey.classList.remove("hidden");
    trialInfo.textContent = "One more step — set up your AI provider.";
    apiKeyInput.focus();
  } else {
    setStatus("Registration was cancelled or failed", true);
  }
});

// Step 2: API key validation
activateBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const provider = providerSelect.value;

  if (!apiKey) {
    setStatus("API key is required", true);
    return;
  }

  activateBtn.disabled = true;
  activateBtn.textContent = "Validating...";
  setStatus("");

  const preset = presets?.[provider];
  const model = provider === "custom" ? modelInput.value.trim() : (preset?.defaultModel || "");
  const config: { provider: string; model: string; apiKey: string; baseUrl?: string } = {
    provider,
    model,
    apiKey,
  };
  if (provider === "custom" && baseUrlInput.value.trim()) {
    config.baseUrl = baseUrlInput.value.trim();
  }

  const result = await window.yo.saveLLMConfig(config);
  if (!result.ok) {
    setStatus(result.error || "Invalid API key", true);
    activateBtn.disabled = false;
    activateBtn.textContent = "Continue";
    return;
  }

  setStatus("All set!");
  setTimeout(() => {
    hideOnboarding();
    window.yo.onboardingComplete();
    window.dispatchEvent(new Event("yo-onboarding-done"));
  }, 600);
});

// Enter key submits
[apiKeyInput, baseUrlInput, modelInput].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") activateBtn.click();
  });
});

// Policy links
document.getElementById("onboarding-terms-link")?.addEventListener("click", () => {
  window.yo.openExternal("https://yosup.dev/terms");
});
document.getElementById("onboarding-privacy-link")?.addEventListener("click", () => {
  window.yo.openExternal("https://yosup.dev/privacy");
});
document.getElementById("onboarding-refund-link")?.addEventListener("click", () => {
  window.yo.openExternal("https://yosup.dev/refund");
});
