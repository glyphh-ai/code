/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell, webContents } from "electron";
import path from "path";
import { PanelManager } from "./panel-manager";
import { TerminalManager } from "./terminal";
import { CommandParser } from "./command-parser";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { MCPServer } from "./mcp-server";
import { checkLicense, activateLicense, revalidateLicense, getCheckoutUrl, getBillingPortalUrl } from "./license";
import { CloudSync } from "./cloud-sync";
import { Library } from "./library";
import { loadLLMConfig, saveLLMConfig, validateLLMConfig, PROVIDER_PRESETS, LLMConfig } from "./llm-config";
import { LayoutManager } from "./layout-manager";
import { AppConnector, CommandMapping } from "./app-connector";
import { ConnectorAgent } from "./connector-agent";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./preferences";
import { YoInterceptor } from "./yo-interceptor";
import { YoChat } from "./yo-chat";
import { SessionCache } from "./session-cache";
import { ContextStore } from "./context-store";
import { AmbientCapture } from "./ambient-capture";
import { VSCodeServer } from "./vscode-server";

let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let skillEngine: SkillEngine;
let mcpServer: MCPServer;
let appConnector: AppConnector;
let connectorAgent: ConnectorAgent;
let terminalManager: TerminalManager;
let vscodeServer: VSCodeServer;
let contextStore: ContextStore;
let ambientCapture: AmbientCapture;

// ── Drip effects ────────────────────────────────────────────
// All CSS-animation-only (no JS rAF) — macOS transparent windows
// don't repaint with JS-driven animation.

const DRIP_COLORS = ["#25C75E", "#1ae052", "#10a37f", "#00ffcc", "#4fffb0", "#fff", "#cff5e0", "#88ffbb", "#33ff99", "#a0ffd0"];
const DRIP_WARM = ["#ff4444", "#ff1493", "#ff6b6b", "#ff9ff3", "#feca57", "#ff9f43", "#ee5a24", "#f368e0", "#ff4757", "#ff69b4"];
const DRIP_COOL = ["#25C75E", "#00ffcc", "#48dbfb", "#0abde3", "#a0ffd0", "#fff", "#54a0ff", "#c8d6e5"];
const DRIP_RAINBOW = ["#ff0000", "#ff8800", "#ffff00", "#00ff00", "#00ffff", "#0088ff", "#8800ff", "#ff00ff"];
const DRIP_FIREWORK = ["#ff4444", "#ffaa00", "#ffee44", "#44ff44", "#44ffff", "#ff44ff", "#ff6600", "#ffffff", "#ff69b4", "#44aaff", "#ffd700", "#ff1493"];

function dripWrap(w: number, h: number, keyframes: string, divs: string, dur: number): string {
  return `<html><head><style>
*{margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:rgba(0,0,0,0)}
${keyframes}
</style></head><body>
${divs}
<script>setTimeout(function(){console.log("__drip_close__")},${dur})</${"script"}>
</body></html>`;
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rng(min: number, max: number): number { return min + Math.random() * (max - min); }

// 1. fireworks — realistic multi-color bursts with trails and secondary explosions
function dripFireworks(w: number, h: number): string {
  const bursts = [
    { x: w * 0.5, y: h * 0.22, d: 0 },
    { x: w * 0.15, y: h * 0.18, d: 300 },
    { x: w * 0.82, y: h * 0.2, d: 500 },
    { x: w * 0.35, y: h * 0.35, d: 800 },
    { x: w * 0.68, y: h * 0.3, d: 1000 },
    { x: w * 0.1, y: h * 0.4, d: 1300 },
    { x: w * 0.9, y: h * 0.38, d: 1500 },
    { x: w * 0.5, y: h * 0.15, d: 1800 },
    { x: w * 0.25, y: h * 0.5, d: 2100 },
    { x: w * 0.75, y: h * 0.45, d: 2300 },
  ];
  let kf = "", dv = "", id = 0;

  for (const b of bursts) {
    // Each burst gets its own random color palette (1-2 colors)
    const c1 = pick(DRIP_FIREWORK), c2 = Math.random() > 0.4 ? pick(DRIP_FIREWORK) : c1;

    // Launch trail — a streak rising from the bottom to the burst point
    const tn = `t${id++}`;
    kf += `@keyframes ${tn}{0%{height:0;opacity:0.9;bottom:0}70%{opacity:0.7}100%{height:${h - b.y + 40}px;opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${b.x}px;bottom:0;width:2px;background:linear-gradient(to top,transparent,${c1});animation:${tn} ${0.4 + b.d / 4000}s ease-in ${Math.max(0, b.d - 300)}ms forwards;opacity:0"></div>`;

    // Main burst — 70 particles radiating outward
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, sp = rng(120, 600);
      const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
      const gravity = rng(180, 350); // particles fall after burst
      const sz = rng(3, 8), c = Math.random() > 0.5 ? c1 : c2;
      const dur = rng(1.2, 2.2), n = `p${id++}`;
      const trail = sz > 5 ? `box-shadow:0 0 ${sz * 2}px ${c},0 0 ${sz * 4}px ${c}66;` : `box-shadow:0 0 ${sz}px ${c};`;
      kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1.2);opacity:1}40%{opacity:0.9}70%{opacity:0.5}100%{transform:translate(${dx}px,${dy + gravity}px) scale(0.1);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};${trail}animation:${n} ${dur}s ease-out ${b.d}ms forwards;opacity:0"></div>`;
    }

    // Secondary mini-bursts — a few particles explode again mid-flight
    for (let s = 0; s < 3; s++) {
      const sa = Math.random() * Math.PI * 2, ssp = rng(100, 250);
      const sx = b.x + Math.cos(sa) * ssp, sy = b.y + Math.sin(sa) * ssp * 0.6;
      const sDelay = b.d + rng(600, 1000);
      const sc = pick(DRIP_FIREWORK);
      for (let j = 0; j < 15; j++) {
        const ja = Math.random() * Math.PI * 2, jsp = rng(40, 150);
        const jdx = Math.cos(ja) * jsp, jdy = Math.sin(ja) * jsp + rng(30, 80);
        const jsz = rng(2, 5), jn = `q${id++}`;
        kf += `@keyframes ${jn}{0%{transform:translate(0,0);opacity:1}100%{transform:translate(${jdx}px,${jdy}px);opacity:0}}\n`;
        dv += `<div style="position:absolute;left:${sx}px;top:${sy}px;width:${jsz}px;height:${jsz}px;border-radius:50%;background:${sc};box-shadow:0 0 ${jsz * 2}px ${sc};animation:${jn} 0.8s ease-out ${sDelay}ms forwards;opacity:0"></div>`;
      }
    }
  }

  // Flash — brief white flash behind each burst
  for (const b of bursts) {
    const fn = `fl${id++}`;
    kf += `@keyframes ${fn}{0%{opacity:0}10%{opacity:0.15}100%{opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${b.x - 150}px;top:${b.y - 150}px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,#fff,transparent 70%);animation:${fn} 0.4s ease-out ${b.d}ms forwards;opacity:0"></div>`;
  }

  return dripWrap(w, h, kf, dv, 4800);
}

// 2. hearts — big hearts rise across full screen, burst into glowing sparks
function dripHearts(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const heartEmojis = ["\u2764\uFE0F", "\uD83E\uDE77", "\uD83D\uDC95", "\uD83D\uDC96", "\uD83D\uDC97", "\uD83D\uDC93"];
  for (let i = 0; i < 45; i++) {
    const x = rng(w * 0.05, w * 0.95), delay = rng(0, 2000);
    const rise = rng(h * 0.4, h * 0.8), sway = rng(-120, 120), dur = rng(2, 3.5), sz = rng(24, 56);
    const n = `h${id++}`, heart = pick(heartEmojis);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.2);opacity:0}15%{opacity:1;transform:translate(${sway*0.15}px,${-rise*0.15}px) scale(1)}70%{opacity:1;transform:translate(${sway*0.7}px,${-rise*0.7}px) scale(1.3)}85%{opacity:0.8}100%{transform:translate(${sway}px,${-rise}px) scale(0.4);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.8}px;font-size:${sz}px;filter:drop-shadow(0 0 8px rgba(255,50,100,0.6));animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0">${heart}</div>`;
    // Burst sparks
    for (let j = 0; j < 12; j++) {
      const a = Math.random() * Math.PI * 2, sp = rng(60, 180);
      const sdx = Math.cos(a) * sp, sdy = Math.sin(a) * sp - 40;
      const sn = `s${id++}`, sc = pick(DRIP_WARM), ssz = rng(3, 8);
      kf += `@keyframes ${sn}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${sdx}px,${sdy}px) scale(0.2);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x+sway}px;top:${h*0.8-rise}px;width:${ssz}px;height:${ssz}px;border-radius:50%;background:${sc};box-shadow:0 0 ${ssz*2}px ${sc};animation:${sn} 0.9s ease-out ${delay + dur*1000 - 300}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5500);
}

// 3. confetti — massive colorful rectangles + circles tumbling from top
function dripConfetti(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const shapes = ["rect", "circle", "strip"];
  for (let i = 0; i < 150; i++) {
    const x = rng(-20, w + 20), delay = rng(0, 2500), dur = rng(2.5, 5);
    const drift = rng(-180, 180), spin = rng(540, 1800);
    const c = pick(DRIP_RAINBOW), n = `c${id++}`, shape = pick(shapes);
    let style: string;
    if (shape === "circle") {
      const sz = rng(8, 18);
      style = `width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz}px ${c}88;`;
    } else if (shape === "strip") {
      style = `width:${rng(3, 6)}px;height:${rng(18, 35)}px;background:${c};border-radius:2px;box-shadow:0 0 6px ${c}66;`;
    } else {
      style = `width:${rng(10, 20)}px;height:${rng(6, 12)}px;background:${c};border-radius:2px;box-shadow:0 0 6px ${c}66;`;
    }
    kf += `@keyframes ${n}{0%{transform:translate(0,0) rotate(0deg) scaleX(1);opacity:1}25%{transform:translate(${drift*0.25}px,${(h+60)*0.25}px) rotate(${spin*0.25}deg) scaleX(0.5)}50%{transform:translate(${drift*0.5}px,${(h+60)*0.5}px) rotate(${spin*0.5}deg) scaleX(1)}75%{transform:translate(${drift*0.75}px,${(h+60)*0.75}px) rotate(${spin*0.75}deg) scaleX(0.5)}100%{transform:translate(${drift}px,${h+60}px) rotate(${spin}deg) scaleX(1);opacity:0.5}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:-30px;${style}animation:${n} ${dur}s ease-in ${delay}ms forwards;opacity:0"></div>`;
  }
  return dripWrap(w, h, kf, dv, 7500);
}

// 4. stars — big glowing stars twinkle, pulse and drift across the screen
function dripStars(w: number, h: number): string {
  const starEmojis = ["\u2B50", "\u2728", "\uD83C\uDF1F", "\u26A1"];
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 80; i++) {
    const x = rng(0, w), y = rng(h * 0.1, h * 0.95), delay = rng(0, 3000), dur = rng(2, 4);
    const drift = rng(-100, 100), rise = rng(150, 500), sz = rng(22, 52), n = `st${id++}`;
    const star = pick(starEmojis);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}20%{opacity:1;transform:translate(${drift*0.2}px,${-rise*0.2}px) scale(1.4) rotate(72deg)}50%{opacity:1;transform:translate(${drift*0.5}px,${-rise*0.5}px) scale(0.9) rotate(144deg)}75%{opacity:0.8;transform:translate(${drift*0.75}px,${-rise*0.75}px) scale(1.2) rotate(216deg)}100%{transform:translate(${drift}px,${-rise}px) scale(0.3) rotate(360deg);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${sz}px;filter:drop-shadow(0 0 12px rgba(255,215,0,0.7));animation:${n} ${dur}s ease-in-out ${delay}ms forwards;opacity:0">${star}</div>`;
  }
  return dripWrap(w, h, kf, dv, 7000);
}

// 5. rain — dense luminous matrix-style rain with splashes
function dripRain(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 120; i++) {
    const x = rng(0, w), delay = rng(0, 3000), dur = rng(0.6, 1.8);
    const n = `r${id++}`, c = pick(DRIP_COOL), sz = rng(2, 6);
    const streak = rng(25, 70);
    kf += `@keyframes ${n}{0%{transform:translateY(0);opacity:0.9}100%{transform:translateY(${h+30}px);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:-${streak}px;width:${sz}px;height:${streak}px;background:linear-gradient(${c},${c}88,transparent);border-radius:${sz}px;box-shadow:0 0 ${sz*2}px ${c}44;animation:${n} ${dur}s linear ${delay}ms forwards;opacity:0"></div>`;
    // Splash at bottom
    if (i < 40) {
      const sn = `rs${id++}`;
      const splashDelay = delay + dur * 1000 - 100;
      kf += `@keyframes ${sn}{0%{transform:scaleX(0.3) scaleY(1);opacity:0.8}100%{transform:scaleX(2.5) scaleY(0);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x-4}px;top:${h-4}px;width:8px;height:4px;border-radius:50%;background:${c};box-shadow:0 0 8px ${c};animation:${sn} 0.4s ease-out ${splashDelay}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5000);
}

// 6. bubbles — big iridescent bubbles float up, wobble and pop with sparkles
function dripBubbles(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 50; i++) {
    const x = rng(w * 0.02, w * 0.98), delay = rng(0, 2500), dur = rng(2.5, 5);
    const sway = rng(-140, 140), rise = rng(h * 0.5, h * 0.95), sz = rng(30, 90), n = `b${id++}`;
    const c = pick(DRIP_COOL);
    const wobble = rng(20, 50);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.2);opacity:0}10%{opacity:0.7;transform:translate(${wobble*0.3}px,${-rise*0.05}px) scale(1)}30%{transform:translate(${-wobble*0.5}px,${-rise*0.3}px) scale(1.05)}50%{transform:translate(${sway*0.4}px,${-rise*0.5}px) scale(0.95)}70%{transform:translate(${-wobble*0.3+sway*0.5}px,${-rise*0.7}px) scale(1.05)}90%{opacity:0.5;transform:translate(${sway*0.9}px,${-rise*0.9}px) scale(1.15)}100%{transform:translate(${sway}px,${-rise}px) scale(1.8);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.9}px;width:${sz}px;height:${sz}px;border-radius:50%;border:2px solid ${c}88;background:radial-gradient(circle at 35% 35%,rgba(255,255,255,0.2),transparent 50%);box-shadow:inset -${sz/3}px -${sz/3}px ${sz/2}px rgba(255,255,255,0.08),0 0 ${sz}px ${c}33,0 0 ${sz*2}px ${c}11;animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0"></div>`;
    // Pop sparkles
    const popDelay = delay + dur * 1000 - 200;
    for (let j = 0; j < 6; j++) {
      const pa = Math.random() * Math.PI * 2, psp = rng(20, sz);
      const pdx = Math.cos(pa) * psp, pdy = Math.sin(pa) * psp;
      const pn = `bp${id++}`, psz = rng(2, 5);
      kf += `@keyframes ${pn}{0%{transform:translate(0,0);opacity:1}100%{transform:translate(${pdx}px,${pdy}px);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x+sway+sz/2}px;top:${h*0.9-rise}px;width:${psz}px;height:${psz}px;border-radius:50%;background:#fff;box-shadow:0 0 6px ${c};animation:${pn} 0.5s ease-out ${popDelay}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 7500);
}

// 7. sparkle — dense sparkle field popping across the entire screen, multi-wave
function dripSparkle(w: number, h: number): string {
  const sparkEmojis = ["\u2728", "\uD83C\uDF1F", "\u2B50", "\u26A1"];
  let kf = "", dv = "", id = 0;
  // Three waves of sparkles
  for (let wave = 0; wave < 3; wave++) {
    const waveDelay = wave * 1200;
    for (let i = 0; i < 40; i++) {
      const x = rng(0, w), y = rng(0, h), delay = waveDelay + rng(0, 800), dur = rng(0.4, 1.0);
      const sz = rng(20, 50), n = `sp${id++}`, em = pick(sparkEmojis);
      kf += `@keyframes ${n}{0%{transform:scale(0) rotate(0deg);opacity:0}40%{transform:scale(1.5) rotate(90deg);opacity:1}60%{transform:scale(1.2) rotate(135deg);opacity:1}100%{transform:scale(0) rotate(360deg);opacity:0}}\n`;
      dv += `<div style="position:absolute;left:${x}px;top:${y}px;font-size:${sz}px;filter:drop-shadow(0 0 8px rgba(255,215,0,0.5));animation:${n} ${dur}s ease-in-out ${delay}ms forwards;opacity:0">${em}</div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5500);
}

// 8. spiral — galaxy of particles spiraling outward from center with trails
function dripSpiral(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2;
  const maxR = Math.min(w, h) * 0.45;
  for (let i = 0; i < 120; i++) {
    const baseAngle = (i / 120) * Math.PI * 8; // more rotations
    const r = rng(maxR * 0.3, maxR), dur = rng(1.8, 3.5), delay = (i / 120) * 2000;
    const endX = Math.cos(baseAngle) * r, endY = Math.sin(baseAngle) * r;
    const mid1 = r * 0.3, mid2 = r * 0.65;
    const m1x = Math.cos(baseAngle - 0.8) * mid1, m1y = Math.sin(baseAngle - 0.8) * mid1;
    const m2x = Math.cos(baseAngle - 0.3) * mid2, m2y = Math.sin(baseAngle - 0.3) * mid2;
    const sz = rng(4, 12), c = pick(DRIP_RAINBOW), n = `sp${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0);opacity:0}15%{opacity:1;transform:translate(${m1x}px,${m1y}px) scale(1.3)}50%{opacity:0.9;transform:translate(${m2x}px,${m2y}px) scale(1)}100%{transform:translate(${endX}px,${endY}px) scale(0.15);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c},0 0 ${sz*4}px ${c}44;animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0"></div>`;
  }
  return dripWrap(w, h, kf, dv, 6000);
}

// 9. emoji rain — big happy faces fall from top, bounce hard and scatter
function dripEmoji(w: number, h: number): string {
  const faces = ["\uD83D\uDE00", "\uD83D\uDE02", "\uD83E\uDD29", "\uD83E\uDD73", "\uD83D\uDE0E", "\uD83D\uDE1C", "\uD83E\uDD2A", "\uD83D\uDE0D", "\u270C\uFE0F", "\uD83E\uDD19", "\uD83E\uDD18", "\uD83D\uDE4C", "\uD83D\uDE80", "\uD83C\uDF89", "\uD83C\uDF8A"];
  let kf = "", dv = "", id = 0;
  for (let i = 0; i < 60; i++) {
    const x = rng(10, w - 50), delay = rng(0, 3000), dur = rng(2.5, 4);
    const bounce = h * rng(0.55, 0.82), drift = rng(-80, 80);
    const sz = rng(30, 60), n = `e${id++}`, face = pick(faces);
    const bounceH = rng(80, 160), spin1 = rng(180, 400), spin2 = rng(400, 700);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) rotate(0deg) scale(0.5);opacity:1}55%{transform:translate(${drift*0.55}px,${bounce}px) rotate(${spin1}deg) scale(1.1);opacity:1}68%{transform:translate(${drift*0.68}px,${bounce-bounceH}px) rotate(${spin1+60}deg) scale(1.2);opacity:1}80%{transform:translate(${drift*0.8}px,${bounce}px) rotate(${spin2}deg) scale(1);opacity:0.9}88%{transform:translate(${drift*0.88}px,${bounce-bounceH*0.3}px) rotate(${spin2+30}deg) scale(1.1)}95%{transform:translate(${drift*0.95}px,${bounce+10}px) rotate(${spin2+50}deg) scale(1)}100%{transform:translate(${drift}px,${bounce+40}px) rotate(${spin2+70}deg) scale(0.8);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:-60px;font-size:${sz}px;animation:${n} ${dur}s ease-in ${delay}ms forwards;opacity:0">${face}</div>`;
  }
  return dripWrap(w, h, kf, dv, 7000);
}

// 10. wave — massive concentric ripple rings expanding from center with glow
function dripWave(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2;
  const maxR = Math.max(w, h) * 0.55;
  // Three wave groups from different points
  const origins = [
    { x: cx, y: cy, d: 0 },
    { x: w * 0.25, y: h * 0.4, d: 800 },
    { x: w * 0.75, y: h * 0.6, d: 1600 },
  ];
  for (const o of origins) {
    for (let i = 0; i < 6; i++) {
      const delay = o.d + i * 200, n = `w${id++}`;
      const c = pick(DRIP_RAINBOW);
      kf += `@keyframes ${n}{0%{width:0;height:0;margin-left:0;margin-top:0;opacity:0.9;border-width:4px}50%{opacity:0.5}100%{width:${maxR*2}px;height:${maxR*2}px;margin-left:${-maxR}px;margin-top:${-maxR}px;opacity:0;border-width:1px}}\n`;
      dv += `<div style="position:absolute;left:${o.x}px;top:${o.y}px;border-radius:50%;border:4px solid ${c};box-shadow:0 0 20px ${c}66,0 0 40px ${c}22;animation:${n} 2.5s ease-out ${delay}ms forwards;opacity:0"></div>`;
    }
  }
  return dripWrap(w, h, kf, dv, 5500);
}

// 11. thumbsup — giant thumbs up burst from center with celebration particles
function dripThumbsup(w: number, h: number): string {
  let kf = "", dv = "", id = 0;
  const cx = w / 2, cy = h / 2;
  const thumbs = ["\uD83D\uDC4D", "\uD83D\uDC4D\uD83C\uDFFB", "\uD83D\uDC4D\uD83C\uDFFC", "\uD83D\uDC4D\uD83C\uDFFD", "\uD83D\uDC4D\uD83C\uDFFE", "\uD83D\uDC4D\uD83C\uDFFF"];

  // Giant center thumbs up — grows, pulses, then bursts
  kf += `@keyframes bigthumb{0%{transform:scale(0) rotate(-30deg);opacity:0}15%{transform:scale(1.8) rotate(10deg);opacity:1}25%{transform:scale(1.5) rotate(0deg)}40%{transform:scale(1.7) rotate(-5deg)}55%{transform:scale(1.5) rotate(5deg)}70%{transform:scale(2.2) rotate(0deg);opacity:1}85%{transform:scale(3) rotate(0deg);opacity:0.6}100%{transform:scale(4) rotate(0deg);opacity:0}}\n`;
  dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;font-size:120px;transform-origin:center;margin-left:-60px;margin-top:-60px;animation:bigthumb 2.5s ease-in-out forwards;opacity:0;filter:drop-shadow(0 0 30px rgba(255,200,0,0.5))">\uD83D\uDC4D</div>`;

  // Ring of thumbs bursting outward
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, sp = rng(200, 500);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
    const sz = rng(30, 60), dur = rng(1.2, 2.0), n = `tb${id++}`;
    const thumb = pick(thumbs);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0}20%{opacity:1;transform:translate(${dx*0.15}px,${dy*0.15}px) scale(1.2) rotate(${rng(-30,30)}deg)}100%{transform:translate(${dx}px,${dy+80}px) scale(0.4) rotate(${rng(-180,180)}deg);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;font-size:${sz}px;animation:${n} ${dur}s ease-out ${600 + i * 60}ms forwards;opacity:0">${thumb}</div>`;
  }

  // Celebration particles around the burst
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, sp = rng(150, 600);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp;
    const sz = rng(4, 10), c = pick([...DRIP_RAINBOW, "#ffd700", "#ffd700", "#ffaa00"]);
    const dur = rng(1.0, 2.0), n = `tc${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${dx}px,${dy + rng(50, 150)}px) scale(0.2);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c};animation:${n} ${dur}s ease-out ${rng(400, 1200)}ms forwards;opacity:0"></div>`;
  }

  // Scattered smaller thumbs drifting up across the screen
  for (let i = 0; i < 20; i++) {
    const x = rng(w * 0.05, w * 0.95), delay = rng(800, 2500), dur = rng(1.5, 3);
    const rise = rng(200, h * 0.6), sway = rng(-60, 60), sz = rng(24, 44), n = `td${id++}`;
    const thumb = pick(thumbs);
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(0.3);opacity:0}25%{opacity:1;transform:translate(${sway*0.2}px,${-rise*0.2}px) scale(1)}100%{transform:translate(${sway}px,${-rise}px) scale(0.5);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${h*0.7}px;font-size:${sz}px;animation:${n} ${dur}s ease-out ${delay}ms forwards;opacity:0">${thumb}</div>`;
  }

  return dripWrap(w, h, kf, dv, 5000);
}

// Easter egg: timme — long running cinematic animation
function dripTimme(w: number, h: number): string {
  const quote = "The only true currency in this bankrupt world is what you share with someone else when you're uncool.";
  const attribution = "\u2014 Lester Bangs";
  let kf = "", dv = "";

  // Background fade in
  kf += `@keyframes bgfade{0%{opacity:0}10%{opacity:1}85%{opacity:1}100%{opacity:0}}\n`;
  dv += `<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,#0a1a0f 0%,#000 70%);animation:bgfade 15s ease-in-out forwards;opacity:0"></div>`;

  // Ambient particles — slow drifting glowing dots
  let id = 0;
  for (let i = 0; i < 40; i++) {
    const x = rng(0, w), y = rng(0, h), delay = rng(0, 8000), dur = rng(4, 8);
    const drift = rng(-100, 100), rise = rng(-150, 150), sz = rng(2, 5);
    const c = pick(DRIP_COOL), n = `a${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0);opacity:0}30%{opacity:0.6}70%{opacity:0.6}100%{transform:translate(${drift}px,${rise}px);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*3}px ${c};animation:${n} ${dur}s ease-in-out ${delay}ms forwards;opacity:0"></div>`;
  }

  // Quote — type in word by word
  const words = quote.split(" ");
  let wordDivs = "";
  const startDelay = 1500;
  const wordGap = 200;
  for (let i = 0; i < words.length; i++) {
    const d = startDelay + i * wordGap;
    const wn = `tw${i}`;
    kf += `@keyframes ${wn}{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}\n`;
    wordDivs += `<span style="display:inline-block;opacity:0;animation:${wn} 0.6s ease-out ${d}ms forwards;margin-right:7px">${words[i]}</span>`;
  }

  // Attribution — fade in after quote
  const attrDelay = startDelay + words.length * wordGap + 800;
  kf += `@keyframes attrin{0%{opacity:0;transform:translateY(10px)}100%{opacity:0.6;transform:translateY(0)}}\n`;

  // Quote container
  kf += `@keyframes qfade{0%{opacity:0}8%{opacity:1}82%{opacity:1}100%{opacity:0}}\n`;
  dv += `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;animation:qfade 15s ease-in-out forwards;opacity:0;z-index:2">`;
  dv += `<div style="max-width:${Math.min(w * 0.7, 600)}px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:${Math.min(24, w * 0.03)}px;font-weight:300;color:#cff5e0;line-height:1.7;letter-spacing:0.02em;text-shadow:0 0 30px #25C75E44">${wordDivs}</div>`;
  dv += `<div style="margin-top:24px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:${Math.min(16, w * 0.02)}px;font-style:italic;color:#25C75E;letter-spacing:0.05em;animation:attrin 0.8s ease-out ${attrDelay}ms forwards;opacity:0">${attribution}</div>`;
  dv += `</div>`;

  // Finale sparkle burst
  const finaleStart = 12000;
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, sp = rng(100, 350);
    const dx = Math.cos(a) * sp, dy = Math.sin(a) * sp - 100;
    const sz = rng(3, 7), c = pick(DRIP_COLORS), dur = rng(1.2, 2.0), n = `f${id++}`;
    kf += `@keyframes ${n}{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(${dx}px,${dy+80}px) scale(0.2);opacity:0}}\n`;
    dv += `<div style="position:absolute;left:${w/2}px;top:${h/2}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${c};box-shadow:0 0 ${sz*2}px ${c};animation:${n} ${dur}s ease-out ${finaleStart + rng(0, 400)}ms forwards;opacity:0;z-index:3"></div>`;
  }

  return dripWrap(w, h, kf, dv, 16000);
}

// Effect dispatcher
const DRIP_EFFECTS: Record<string, (w: number, h: number) => string> = {
  fireworks: dripFireworks,
  hearts: dripHearts,
  confetti: dripConfetti,
  stars: dripStars,
  rain: dripRain,
  bubbles: dripBubbles,
  sparkle: dripSparkle,
  spiral: dripSpiral,
  emoji: dripEmoji,
  wave: dripWave,
  thumbsup: dripThumbsup,
  timme: dripTimme,
};

function buildDripHtml(effect: string, w: number, h: number): string {
  const builder = DRIP_EFFECTS[effect] || DRIP_EFFECTS.fireworks;
  return builder(w, h);
}

async function createWindow() {
  const saved = getPreference<{ x?: number; y?: number; width: number; height: number; maximized?: boolean }>("windowBounds", { width: 1200, height: 800 });

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    frame: false,
    transparent: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  if (saved.maximized) mainWindow.maximize();

  mainWindow.loadFile(
    path.join(__dirname, "..", "renderer", "index.html")
  );

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Persist window position and size
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const maximized = mainWindow.isMaximized();
      const bounds = maximized ? (getPreference<any>("windowBounds", null) || mainWindow.getBounds()) : mainWindow.getBounds();
      setPreference("windowBounds", { ...bounds, maximized });
    }, 500);
  };
  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  // Load LLM config (auto-migrates from legacy .apikey if needed)
  let llmConfig = loadLLMConfig();
  if (llmConfig.provider === "anthropic" && llmConfig.apiKey) {
    process.env.ANTHROPIC_API_KEY = llmConfig.apiKey;
  }

  function applyLLMConfig(config: LLMConfig) {
    llmConfig = config;
    if (config.provider === "anthropic" && config.apiKey) {
      process.env.ANTHROPIC_API_KEY = config.apiKey;
    }
    yoChat?.setLLMConfig(config);
    skillEngine?.setLLMConfig(config);
    connectorAgent?.setLLMConfig(config);
    if (ambientCapture) ambientCapture.setLLMConfig(config);
  }

  // Core services
  skillEngine = new SkillEngine();
  appConnector = new AppConnector();
  connectorAgent = new ConnectorAgent();

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, skillEngine, session);

  panelManager = new PanelManager((id, wc) => {
    if (id === "term") {
      // Spawn pty when terminal page loads
      wc.on("did-finish-load", () => terminalManager.spawn(wc));
    } else {
      // Activate interceptor so yo/dip/sup work on app panels
      yoInterceptor.activate(wc, id);
    }
  });

  // Persist zoom when changed via keyboard shortcut in panels
  panelManager.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Seed PanelManager configs from apps (apps are the source of truth)
  const terminalHtml = `file://${path.join(__dirname, "..", "renderer", "terminal.html")}`;
  const terminalPreload = path.join(__dirname, "terminal-preload.js");
  const monacoHtml = `file://${path.join(__dirname, "..", "renderer", "monaco.html")}`;
  const browserHtml = `file://${path.join(__dirname, "..", "renderer", "browser.html")}`;
  const enableVscode = getPreference("enableVscodeServer", false);
  vscodeServer = new VSCodeServer();
  for (const app of appConnector.list()) {
    if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://monaco") {
      panelManager.addPanel(app.id, monacoHtml);
    } else if (app.url === "yo://browser") {
      panelManager.addPanel(app.id, browserHtml, undefined, undefined, true);
    } else if (app.url === "yo://vscode" || app.url === "https://vscode.dev") {
      // VS Code uses local `code serve-web` for full file access
      if (enableVscode && vscodeServer.available) {
        panelManager.addPanel(app.id, VSCodeServer.expectedUrl());
      } else {
        // Show setup instructions instead of broken fallback
        const reason = !enableVscode
          ? "VS Code Server is disabled."
          : "VS Code CLI not found on this machine.";
        const infoPage = `data:text/html,${encodeURIComponent(`<html><head><style>
          body{background:#0a0a0a;color:#999;font-family:-apple-system,system-ui,sans-serif;
            display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
          .card{text-align:center;max-width:420px;padding:40px}
          h2{color:#ddd;font-size:18px;font-weight:600;margin:0 0 12px}
          p{font-size:14px;line-height:1.6;margin:8px 0}
          .reason{color:#777;font-size:13px;margin-bottom:16px}
          a{color:#25C75E;text-decoration:none;font-weight:500;cursor:pointer}
          a:hover{text-decoration:underline}
          .steps{text-align:left;margin:16px 0;padding:0;list-style:none}
          .steps li{padding:6px 0;font-size:13px;color:#888}
          .steps li::before{content:"→ ";color:#25C75E}
          code{font-family:"SF Mono","Fira Code",monospace;font-size:12px;
            background:#151515;padding:2px 6px;border-radius:4px;color:#ccc}
        </style></head><body><div class="card">
          <h2>VS Code Server</h2>
          <p class="reason">${reason}</p>
          <ul class="steps">
            <li>Install <a href="https://code.visualstudio.com/" target="_blank">Visual Studio Code</a></li>
            <li>Run <code>Shell Command: Install 'code' in PATH</code> from the VS Code command palette</li>
            <li>Enable <strong>VS Code Server</strong> in <a href="yo://open-settings">Settings</a></li>
            <li>Restart the app</li>
          </ul>
        </div></body></html>`)}`;
        panelManager.addPanel(app.id, infoPage);
      }
    } else {
      panelManager.addPanel(app.id, app.url, undefined, app.forceWeb);
    }
  }

  // Start VS Code server in the background if enabled and CLI is available
  if (enableVscode && vscodeServer.available) {
    vscodeServer.start().catch((err) => {
      console.log("[vscode-server] failed to start:", err.message);
    });
  }

  // Context store + ambient capture
  contextStore = new ContextStore();
  ambientCapture = new AmbientCapture(panelManager, appConnector, contextStore);

  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, skillEngine, layoutManager, appConnector, session, contextStore);
  commandParser.setWelcomeHandler(() => {
    mainWindow?.webContents.send("show-welcome");
  });

  // LLM engine for inline yo execution
  const yoChat = new YoChat(panelManager);
  yoChat.setSkillEngine(skillEngine);
  yoChat.setAppConnector(appConnector);
  applyLLMConfig(llmConfig);
  yoInterceptor.setYoChat(yoChat);
  commandParser.setYoChat(yoChat);

  // Give interceptor access to visible panel IDs (for multi-panel grab)
  yoInterceptor.setVisiblePanelsGetter(() => {
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) return gridInfo.panelIds;
    return panelManager.activePanelId ? [panelManager.activePanelId] : [];
  });

  // Give command parser a way to grab panel content for yo/sup from the command bar
  commandParser.setGrabber(async (activeOnly?: boolean) => {
    let panelIds: string[];
    if (activeOnly) {
      panelIds = panelManager.activePanelId ? [panelManager.activePanelId] : [];
    } else {
      panelIds = (layoutManager.getGridInfo()?.panelIds
        ?? (panelManager.activePanelId ? [panelManager.activePanelId] : []))
        .filter((id) => id !== "term");
    }
    const sections: string[] = [];
    for (const id of panelIds) {
      const wc = panelManager.getWebContents(id);
      if (!wc) continue;
      const app = appConnector.get(id);
      let content = "";
      if (app?.commands.grab) {
        try { content = await executeCommand(wc, app.commands.grab); } catch {}
      } else {
        try { content = await wc.executeJavaScript("document.body.innerText.slice(0,10000)"); } catch {}
      }
      if (content && !content.startsWith("[Element not found")) {
        sections.push(panelIds.length > 1 ? `## ${app?.name || id}\n\n${content}` : content);
      }
    }
    return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
  });

  // Push session state to renderer
  const sendSessionState = () => {
    mainWindow?.webContents.send("session-changed", session.getInfo());
  };

  // Wire command callbacks for interceptor + chat (both need dip routing)
  const execCommand = async (cmd: string, sourcePanelId?: string) => {
    const result = await commandParser.execute(cmd, sourcePanelId);
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
    sendSessionState();
    // Sync tab state (dip commands change active panel / open grids)
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
    } else if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    sendTabState();
    return result;
  };
  yoInterceptor.setCommandHandler(execCommand);
  yoInterceptor.setSessionNotifier(sendSessionState);
  yoChat.setCommandCallback(execCommand);

  // Terminal yo/sup/dip — route through command parser, show result in terminal
  terminalManager.setCommandHandler(async (cmd, wc) => {
    const result = await execCommand(cmd);
    if (!result || wc.isDestroyed()) return;

    // Write result to terminal in grey
    const lines = result.replace(/\r/g, "").split("\n").join("\r\n");
    wc.send("terminal:data", `\x1b[90m${lines}\x1b[0m\r\n`);
  });

  // Local server — /sup push, /yo search, /sup/capture, /mcp tools
  mcpServer = new MCPServer(contextStore, ambientCapture);
  await mcpServer.start();

  // Create window
  await createWindow();
  if (mainWindow) commandParser.setMainWindow(mainWindow);

  // Drip effects — transparent child window renders on top of everything
  commandParser.setDripHandler((effect) => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    const overlay = new BrowserWindow({
      parent: mainWindow,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      skipTaskbar: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    overlay.setIgnoreMouseEvents(true);
    overlay.once("ready-to-show", () => {
      if (!overlay.isDestroyed()) overlay.showInactive();
    });
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDripHtml(effect, bounds.width, bounds.height))}`);
    overlay.webContents.on("console-message", (_e, _level, msg) => {
      if (msg === "__drip_close__") {
        if (!overlay.isDestroyed()) overlay.close();
      }
    });
    // Safety: auto-close (17s for timmetime, 5s for others)
    const safetyMs = effect === "timme" ? 17000 : 8000;
    setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, safetyMs);
  });

  // Restore panels from last view (or default to claude)
  function restorePanels() {
    const lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][]; grid?: import("./layout-manager").GridLayout }>("lastView", null!);
    if (lastView && mainWindow) {
      if (lastView.type === "grid-full" && lastView.grid) {
        layoutManager.applyGridLayout(lastView.grid, mainWindow);
        // Seed active panel so dip back works after first dip
        if (lastView.grid.cells.length > 0) {
          panelManager.setInitialActive(lastView.grid.cells[0].panelId);
        }
      } else if (lastView.type === "grid" && lastView.rows) {
        layoutManager.splitGrid(lastView.rows, mainWindow);
        if (lastView.rows.length > 0 && lastView.rows[0].length > 0) {
          panelManager.setInitialActive(lastView.rows[0][0]);
        }
      } else if (lastView.type === "split" && lastView.panels) {
        if (lastView.panels.length === 2) {
          layoutManager.splitTwo(lastView.panels[0], lastView.panels[1], mainWindow);
        } else {
          layoutManager.splitN(lastView.panels, mainWindow);
        }
        panelManager.setInitialActive(lastView.panels[0]);
      } else if (lastView.type === "layout" && lastView.name) {
        layoutManager.apply(lastView.name, mainWindow);
        // For named layouts, seed from the layout's first cell
        const grid = layoutManager.getGridInfo();
        if (grid && grid.panelIds.length > 0) {
          panelManager.setInitialActive(grid.panelIds[0]);
        }
      } else if (lastView.type === "panel" && lastView.id) {
        panelManager.switchTo(lastView.id, mainWindow);
      }
    } else if (mainWindow) {
      panelManager.switchTo("claude", mainWindow);
    }
    // Seed tabs from restored panels
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
    } else if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    sendTabState();
  }

  // Helper: push grid state to renderer (for drag handles + panel chips)
  function sendSplitState() {
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
  }

  // ── Tab management ─────────────────────────────────────────
  const openTabs: string[] = [];
  let tabBrowserCounter = 0;

  function getTabName(id: string): string {
    const app = appConnector.get(id);
    return app?.name || id;
  }

  function sendTabState() {
    const visible = getPreference<boolean>("showTabs", true);
    mainWindow?.webContents.send("tab-state", {
      tabs: openTabs.map((id) => ({ id, name: getTabName(id) })),
      activeId: panelManager.activePanelId || "",
      visible,
    });
  }

  function ensureTab(id: string) {
    if (!openTabs.includes(id)) {
      openTabs.push(id);
    }
  }

  // Hook into panel focus events — add tab when panel becomes active
  panelManager.setOnPanelFocused((id: string) => {
    ensureTab(id);
    sendTabState();
  });

  // Check if onboarding is needed BEFORE restoring panels
  // (BrowserViews render above HTML, so they'd cover the onboarding overlay)
  const bootLicense = checkLicense();
  const needsOnboarding = bootLicense.status === "expired" || !llmConfig.apiKey;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Only restore panels if not gated by onboarding
  if (!needsOnboarding) {
    restorePanels();
    panelsReady = true;
    ambientCapture.start();
  }

  // Revalidate license on boot (async, non-blocking)
  if (bootLicense.status === "licensed") {
    revalidateLicense().then((valid) => {
      if (!valid) {
        mainWindow?.webContents.send("license-expired");
      }
    });
  }

  // Start cloud sync if licensed with a cloud token
  const cloudToken = getPreference<string>("cloudToken", null!);
  if (bootLicense.status === "licensed" && cloudToken) {
    const library = new Library();
    const cloudSync = new CloudSync(library);
    cloudSync.start();
  }

  // Daily prune of old context chunks (every 24h)
  setInterval(() => contextStore.prune(), 24 * 60 * 60 * 1000);

  // Revalidate license every 24h
  setInterval(async () => {
    const license = checkLicense();
    if (license.status === "licensed") {
      const valid = await revalidateLicense();
      if (!valid) {
        mainWindow?.webContents.send("license-expired");
      }
    }
  }, 24 * 60 * 60 * 1000);

  // Global hotkey: Cmd+Y / Ctrl+Y
  registerHotkey(mainWindow!);

  // App menu (Cmd+Q, Cmd+W, etc.)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Toggle Panel DevTools",
            accelerator: "CmdOrCtrl+Alt+I",
            click: () => panelManager.toggleDevTools(),
          },
          {
            label: "Toggle App DevTools",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => {
              if (mainWindow) {
                if (mainWindow.webContents.isDevToolsOpened()) {
                  mainWindow.webContents.closeDevTools();
                } else {
                  mainWindow.webContents.openDevTools({ mode: "detach" });
                }
              }
            },
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" },
        ],
      },
    ])
  );

  // IPC: window controls
  ipcMain.on("window-close", () => mainWindow?.close());
  ipcMain.on("window-minimize", () => mainWindow?.minimize());
  ipcMain.on("window-maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  // IPC: refresh panels
  ipcMain.on("panels-refresh", (_e, id?: string) => {
    panelManager.refresh(id);
  });

  // IPC: zoom
  ipcMain.on("panels-zoom", (_e, factor: number) => {
    panelManager.setZoom(factor);
    setPreference("zoom", factor);
  });
  ipcMain.handle("panels-get-zoom", () => panelManager.getZoom());

  // IPC: capture panel screenshots (freeze-frame before hiding)
  ipcMain.handle("capture-panels", async () => {
    if (!mainWindow) return [];
    return panelManager.captureScreenshots(mainWindow);
  });

  // IPC: force ambient context capture
  ipcMain.handle("capture-context", async (_e, panelId?: string) => {
    if (!ambientCapture) return 0;
    return ambientCapture.captureNow(panelId);
  });

  // IPC: reveal downloaded file in Finder/Explorer
  ipcMain.on("download:show", (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // IPC: panel visibility (for help overlay)
  ipcMain.on("panels-hide", () => {
    if (mainWindow) panelManager.hideActive(mainWindow);
  });
  ipcMain.on("panels-show", () => {
    if (!mainWindow || !panelsReady) return;
    panelManager.hidden = false;
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.showActive(mainWindow);
    }
    sendSplitState();
  });

  // IPC: skills CRUD
  ipcMain.handle("skills-list", () => skillEngine.listSkills());
  ipcMain.handle("skills-read", (_e, name: string) => skillEngine.readSkill(name));
  ipcMain.handle("skills-write", (_e, name: string, prompt: string) => {
    if (skillEngine.readSkill(name) !== null) {
      return skillEngine.updateSkill(name, prompt);
    }
    skillEngine.createSkill(name, prompt);
    return true;
  });
  ipcMain.handle("skills-remove", (_e, name: string) => skillEngine.deleteSkill(name));

  // IPC: layouts CRUD
  ipcMain.handle("layouts-list", () =>
    layoutManager.listLayouts().map((l) => ({
      name: l.name,
      cols: l.cols,
      rows: l.rows,
      colWidths: l.colWidths,
      rowHeights: l.rowHeights,
      splits: l.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan })),
    }))
  );
  ipcMain.handle("layouts-save", (_e, name: string, panelIds: string[]) => {
    const count = panelIds.length;
    layoutManager.saveLayout({
      name,
      version: 2,
      cols: count,
      rows: 1,
      colWidths: Array(count).fill(1 / count),
      rowHeights: [1],
      cells: panelIds.map((id, i) => ({
        panelId: id,
        col: i,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      })),
    });
    return true;
  });
  ipcMain.handle("layouts-save-grid", (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => {
    layoutManager.saveLayout({
      ...grid,
      version: 2,
    });
    return true;
  });
  ipcMain.handle("layouts-delete", (_e, name: string) => layoutManager.deleteLayout(name));

  // IPC: grid resize (drag dividers)
  ipcMain.on("grid-drag-end", (_e, type: "col" | "row", index: number, fraction: number) => {
    if (!mainWindow) return;
    // Panels were hidden during drag (panelsHide); mark visible again so
    // window-resize keeps updating bounds via bindResize.
    panelManager.hidden = false;
    if (type === "col") {
      layoutManager.updateColWidth(index, fraction, mainWindow);
    } else {
      layoutManager.updateRowHeight(index, fraction, mainWindow);
    }
    sendSplitState();
    // Persist updated proportions so they survive restart
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) {
      setPreference("lastView", {
        type: "grid-full",
        grid: {
          name: "",
          version: 2,
          cols: gridInfo.cols,
          rows: gridInfo.rows,
          colWidths: gridInfo.colWidths,
          rowHeights: gridInfo.rowHeights,
          cells: gridInfo.cells,
        },
      });
    }
  });

  // IPC: apps CRUD + connect + pick
  ipcMain.handle("apps-list", () => appConnector.list());
  ipcMain.handle("apps-add", (_e, id: string, name: string, url: string) => {
    const app = appConnector.add(id, name, url);
    panelManager.addPanel(id, url);
    return app;
  });
  ipcMain.handle("apps-remove", (_e, id: string) => appConnector.remove(id));
  ipcMain.handle("apps-update-name", (_e, id: string, name: string) => appConnector.updateName(id, name));
  ipcMain.handle("apps-update-id", (_e, oldId: string, newId: string) => {
    const ok = appConnector.updateId(oldId, newId);
    if (ok) {
      // Re-register panel with new ID
      const app = appConnector.get(newId);
      if (app) panelManager.addPanel(newId, app.url);
    }
    return ok;
  });
  ipcMain.handle("apps-connect", async (_e, id: string, webContentsId?: number) => {
    const appConfig = appConnector.get(id);
    if (!appConfig) return { ok: false, error: "App not found" };

    // Use embedded webview's webContents if provided, else fall back to panel
    let wc = webContentsId ? webContents.fromId(webContentsId) : null;
    if (!wc) {
      if (!mainWindow) return { ok: false, error: "No window" };
      if (!panelManager.hasPanel(id)) panelManager.addPanel(id, appConfig.url);
      const view = panelManager.getOrCreateView(id, mainWindow);
      if (!view) return { ok: false, error: "Could not create panel" };
      wc = view.webContents;
    }

    if (wc.isLoading()) {
      await new Promise<void>((resolve) => wc!.once("did-finish-load", () => resolve()));
    }

    try {
      const result = await connectorAgent.analyze(wc, appConfig.name, appConfig.url);
      appConnector.updateCommands(id, result.commands, result.meta);

      // Activate yo/sup interception on the panel's BrowserView
      const panelWc = panelManager.getWebContents(id);
      if (panelWc) yoInterceptor.activate(panelWc, id);

      return { ok: true, commandCount: Object.keys(result.commands).length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });
  ipcMain.handle("apps-set-command", (_e, id: string, commandKey: string, mapping: CommandMapping) => {
    return appConnector.setCommand(id, commandKey, mapping);
  });
  ipcMain.handle("apps-remove-command", (_e, id: string, commandKey: string) => {
    return appConnector.removeCommand(id, commandKey);
  });
  ipcMain.handle("apps-test-command", async (_e, id: string, commandKey: string, webContentsId?: number) => {
    const appConfig = appConnector.get(id);
    if (!appConfig) return "App not found";
    const mapping = appConfig.commands[commandKey];
    if (!mapping) return "Command not mapped";

    // Use embedded webview if provided, else panel
    let wc = webContentsId ? webContents.fromId(webContentsId) : panelManager.getWebContents(id);
    if (!wc) return "App not loaded.";

    try {
      // For setValue/push, send a test string so the user can see it working
      const testValue = mapping.action === "setValue" ? "Hello from yo!" : undefined;
      return await executeCommand(wc, mapping, testValue);
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  // IPC: DOM picker — inject picker script into a webContents, receive result via console-message
  // (executeJavaScript doesn't properly await Promises in Electron 35, so we use a message channel)
  ipcMain.on("start-picker", (_e, webContentsId: number) => {
    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      mainWindow?.webContents.send("picker-result", null);
      return;
    }

    // Listen for the picker result via console.log message
    const handler = (_event: Electron.Event, _level: number, message: string) => {
      if (!message.startsWith("__YO_PICK__:")) return;
      wc.removeListener("console-message", handler);
      try {
        const json = message.slice("__YO_PICK__:".length);
        const result = JSON.parse(json);
        mainWindow?.webContents.send("picker-result", result);
      } catch {
        mainWindow?.webContents.send("picker-result", null);
      }
    };
    wc.on("console-message", handler);

    // Timeout: cancel after 30s if no pick
    setTimeout(() => {
      wc.removeListener("console-message", handler);
    }, 30000);

    // Inject the picker script (fire-and-forget, no return value needed)
    const pickerScript = `
      (function() {
        var overlay = document.createElement('div');
        overlay.id = '__yo_picker_overlay__';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;cursor:crosshair;';

        var highlight = document.createElement('div');
        highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;' +
          'border:2px solid #25C75E;background:rgba(37,199,94,0.08);border-radius:3px;' +
          'transition:all 0.05s ease;box-shadow:0 0 12px rgba(37,199,94,0.3);display:none;';
        document.body.appendChild(highlight);

        var label = document.createElement('div');
        label.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;' +
          'background:#1a1a1a;color:#e0e0e0;font:12px monospace;' +
          'padding:4px 8px;border-radius:4px;border:1px solid #25C75E;' +
          'box-shadow:0 4px 12px rgba(0,0,0,0.5);max-width:400px;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;display:none;';
        document.body.appendChild(label);

        var lastTarget = null;

        function getEl(e) {
          overlay.style.pointerEvents = 'none';
          var el = document.elementFromPoint(e.clientX, e.clientY);
          overlay.style.pointerEvents = 'auto';
          return el;
        }

        // Filter out dynamic/framework-generated class names
        var DYNAMIC_CLASS_RE = /^(ng-tns-|ng-star-|ng-trigger-|ng-animating|ng-untouched|ng-touched|ng-pristine|ng-dirty|ng-valid|ng-invalid|cdk-|mat-|css-|sc-|_|jsx-|svelte-|\\d)/;
        var STATE_CLASS_RE = /^(is-|has-|with-|no-|not-|height-|width-|show-|hide-|visible-|hidden-|active$|focused$|disabled$|selected$|expanded$|collapsed$|open$|closed$)/;
        function isStableClass(c) {
          if (c.length <= 1 || c.length >= 50) return false;
          if (DYNAMIC_CLASS_RE.test(c)) return false;
          if (STATE_CLASS_RE.test(c)) return false;
          // Skip classes that look like generated hashes (contain long digit sequences)
          if (/\d{4,}/.test(c)) return false;
          return true;
        }

        function buildSelector(el) {
          if (!el || !el.tagName) return 'body';
          if (el === document.body || el === document.documentElement) return 'body';
          if (el.id) return '#' + CSS.escape(el.id);

          // Prefer stable attributes over classes
          try {
            var tid = el.getAttribute('data-testid');
            if (tid) return '[data-testid="' + tid + '"]';
          } catch(e) {}
          try {
            var role = el.getAttribute('role');
            if (role) {
              var rs = el.tagName.toLowerCase() + '[role="' + role + '"]';
              try { if (document.querySelectorAll(rs).length === 1) return rs; } catch(e) {}
            }
          } catch(e) {}
          try {
            var aria = el.getAttribute('aria-label');
            if (aria) {
              var s = el.tagName.toLowerCase() + '[aria-label="' + aria.replace(/"/g, '\\\\\\"') + '"]';
              try { if (document.querySelectorAll(s).length === 1) return s; } catch(e) {}
            }
          } catch(e) {}
          try {
            if (el.getAttribute('contenteditable') === 'true') {
              var ce = el.tagName.toLowerCase() + '[contenteditable="true"]';
              try { if (document.querySelectorAll(ce).length === 1) return ce; } catch(e) {}
            }
          } catch(e) {}
          try {
            var ph = el.getAttribute('placeholder');
            if (ph) {
              var ps = el.tagName.toLowerCase() + '[placeholder="' + ph.replace(/"/g, '\\\\\\"') + '"]';
              try { if (document.querySelectorAll(ps).length === 1) return ps; } catch(e) {}
            }
          } catch(e) {}

          var parts = [];
          var cur = el;
          while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 5) {
            var tag = cur.tagName ? cur.tagName.toLowerCase() : '?';
            if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
            var cls = '';
            try {
              var stable = Array.from(cur.classList || []).filter(isStableClass).slice(0, 3);
              cls = stable.map(function(c) { return '.' + CSS.escape(c); }).join('');
            } catch(e) {}
            // Also try role/contenteditable at this level for path segments
            var attrSel = '';
            try {
              var r2 = cur.getAttribute('role');
              if (r2) attrSel = '[role="' + r2 + '"]';
              else if (cur.getAttribute('contenteditable') === 'true') attrSel = '[contenteditable="true"]';
            } catch(e) {}
            var seg = tag + cls + attrSel;
            if (cur.parentElement) {
              try {
                var sibs = Array.from(cur.parentElement.children).filter(function(s) { return s.tagName === cur.tagName; });
                if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
              } catch(e) {}
            }
            parts.unshift(seg);
            cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
          }
          return parts.join(' > ') || el.tagName.toLowerCase();
        }

        overlay.addEventListener('mousemove', function(e) {
          var el = getEl(e);
          if (el === lastTarget) return;
          lastTarget = el;
          if (!el || el === overlay) { highlight.style.display = 'none'; label.style.display = 'none'; return; }
          try {
            var r = el.getBoundingClientRect();
            highlight.style.display = 'block';
            highlight.style.left = r.left + 'px'; highlight.style.top = r.top + 'px';
            highlight.style.width = r.width + 'px'; highlight.style.height = r.height + 'px';
            var info = (el.tagName || '?').toLowerCase();
            if (el.id) info += '#' + el.id;
            else if (el.className && typeof el.className === 'string') info += '.' + el.className.split(' ')[0];
            try { var role = el.getAttribute('role'); if (role) info += ' [' + role + ']'; } catch(x) {}
            label.textContent = info;
            label.style.display = 'block';
            label.style.left = r.left + 'px';
            label.style.top = Math.max(0, r.top - 28) + 'px';
          } catch(x) { highlight.style.display = 'none'; label.style.display = 'none'; }
        });

        overlay.addEventListener('click', function(e) {
          e.preventDefault(); e.stopPropagation();
          var el = getEl(e);
          cleanup();
          if (!el) { console.log('__YO_PICK__:null'); return; }
          var tag = (el.tagName || 'unknown').toLowerCase();
          var ce = false; try { ce = el.getAttribute('contenteditable') === 'true'; } catch(x) {}
          var role = ''; try { role = el.getAttribute('role') || ''; } catch(x) {}
          console.log('__YO_PICK__:' + JSON.stringify({
            selector: buildSelector(el), tag: tag,
            text: (el.innerText || el.textContent || '').trim().slice(0, 100),
            isEditable: ce || tag === 'input' || tag === 'textarea',
            isClickable: tag === 'button' || tag === 'a' || role === 'button',
          }));
        });

        function onKey(e) {
          if (e.key === 'Escape') { cleanup(); console.log('__YO_PICK__:null'); }
        }
        document.addEventListener('keydown', onKey);

        function cleanup() { overlay.remove(); highlight.remove(); label.remove(); document.removeEventListener('keydown', onKey); }
        document.body.appendChild(overlay);
      })();
    `;
    wc.executeJavaScript(pickerScript).catch(() => {});
  });

  // IPC: command execution (used by Cmd+K overlay)
  ipcMain.handle("exec-command", async (_e, cmd: string) => {
    return execCommand(cmd, panelManager.activePanelId ?? undefined);
  });

  // IPC: session info (for context pill)
  ipcMain.handle("session-info", () => session.getInfo());

  // IPC: clear session
  ipcMain.handle("session-clear", () => {
    session.clear();
    sendSessionState();
    return true;
  });

  // IPC: license + API key
  ipcMain.handle("check-license", () => checkLicense());
  ipcMain.handle("activate-license", (_e, key: string) => activateLicense(key));
  ipcMain.handle("validate-api-key", async (_e, key: string) => {
    // Legacy handler — validates as Anthropic by default
    const config: LLMConfig = { ...llmConfig, apiKey: key };
    const result = await validateLLMConfig(config);
    if (result.valid) {
      saveLLMConfig(config);
      applyLLMConfig(config);
    }
    return result;
  });
  ipcMain.handle("get-api-key", () => llmConfig.apiKey || null);

  // LLM config — multi-provider settings
  ipcMain.handle("get-llm-config", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey ? "..." + llmConfig.apiKey.slice(-4) : "",
    baseUrl: llmConfig.baseUrl || null,
  }));
  ipcMain.handle("get-llm-presets", () => PROVIDER_PRESETS);
  ipcMain.handle("save-llm-config", async (_e, config: LLMConfig) => {
    const result = await validateLLMConfig(config);
    if (result.valid) {
      saveLLMConfig(config);
      applyLLMConfig(config);
      return { ok: true };
    }
    return { ok: false, error: result.error };
  });

  ipcMain.handle("get-checkout-url", async (_e, plan?: string) => {
    const url = await getCheckoutUrl(plan || "basic");
    if (url) {
      shell.openExternal(url);
    }
    return url;
  });

  // IPC: tabs
  ipcMain.handle("tab-list", () => {
    const visible = getPreference<boolean>("showTabs", true);
    return {
      tabs: openTabs.map((id) => ({ id, name: getTabName(id) })),
      activeId: panelManager.activePanelId || "",
      visible,
    };
  });

  ipcMain.on("tab-switch", (_e, id: string) => {
    if (!mainWindow) return;
    panelManager.switchTo(id, mainWindow);
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-close", (_e, id: string) => {
    if (!mainWindow) return;
    const idx = openTabs.indexOf(id);
    if (idx < 0) return;
    openTabs.splice(idx, 1);
    panelManager.closePanel(id, mainWindow);
    // Switch to adjacent tab if closing the active one
    if (panelManager.activePanelId === id || panelManager.activePanelId === null) {
      const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
      if (nextId) {
        panelManager.switchTo(nextId, mainWindow);
      }
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-new", () => {
    if (!mainWindow) return;
    tabBrowserCounter++;
    const id = `browse-${tabBrowserCounter}`;
    const browserHtmlPath = `file://${path.join(__dirname, "..", "renderer", "browser.html")}`;
    panelManager.addPanel(id, browserHtmlPath, undefined, undefined, true);
    panelManager.switchTo(id, mainWindow);
    ensureTab(id);
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("open-external", (_e, url: string) => {
    shell.openExternal(url);
  });

  // IPC: license info (for settings display)
  ipcMain.handle("get-license-info", () => {
    const license = checkLicense();
    return {
      status: license.status,
      key: license.key ? license.key.slice(0, 4) + "..." + license.key.slice(-4) : undefined,
      tier: license.tier,
      daysRemaining: license.daysRemaining,
    };
  });

  // IPC: billing portal (Stripe manage/cancel)
  ipcMain.handle("get-billing-portal-url", async () => {
    const url = await getBillingPortalUrl();
    if (url) {
      shell.openExternal(url);
    }
    return url;
  });

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
  });
  ipcMain.handle("get-preference", (_e, key: string, defaultVal: unknown) => {
    return getPreference(key, defaultVal);
  });

  // IPC: relaunch app (for settings that require restart)
  ipcMain.on("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // IPC: onboarding complete — restore panels after activation
  ipcMain.handle("onboarding-complete", () => {
    restorePanels();
    panelsReady = true;
    ambientCapture.start();
    sendSplitState();
  });

  // Tell renderer to check license gate
  mainWindow?.webContents.on("did-finish-load", () => {
    const hideWelcome = getPreference<boolean>("hideWelcome", false);
    mainWindow?.webContents.send("boot", {
      license: bootLicense,
      apiKey: llmConfig.apiKey ? true : false,
      needsOnboarding,
      hideWelcome,
    });
    if (!needsOnboarding) sendSplitState();
  });
}

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  if (ambientCapture) ambientCapture.stop();
  if (contextStore) contextStore.close();
  mcpServer?.stop();
  terminalManager?.killAll();
  vscodeServer?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  vscodeServer?.stop();
});
