/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import "dotenv/config";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, shell, systemPreferences } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { PanelManager } from "./panel-manager";
import { TerminalManager } from "./terminal";
import { CommandParser } from "./command-parser";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, serverPostAuthed } from "./auth";
import { CloudSync } from "./cloud-sync";
import { loadLLMConfig, saveLLMConfig, validateLLMConfig, PROVIDER_PRESETS, LLMConfig } from "./llm-config";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./preferences";
import { YoInterceptor } from "./yo-interceptor";
import { YoChat } from "./yo-chat";
import { SessionCache } from "./session-cache";
import { NoteStore } from "./note-store";
import { MemoryStore } from "./memory-store";
import { Transcriber } from "./transcriber";
import { VoiceRelay } from "./voice-relay";
import { smartGrab } from "./smart-grab";
import { VSCodeServer } from "./vscode-server";
import { autoUpdater } from "electron-updater";
import { ConfigSync } from "./config-sync";
import { reloadRemotePatterns } from "./firewall";
import { usageTracker } from "./usage-tracker";
import { Embedder } from "./embedder";
import { CaptureStore } from "./capture-store";
import { YoAgent } from "./yo-agent";
import { ActionGrabber } from "./action-grabber";
import { Council } from "./council";
import { McpExpose } from "./mcp-expose";


let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let skillEngine: SkillEngine;
let appConnector: AppConnector;

let terminalManager: TerminalManager;
let vscodeServer: VSCodeServer;
let noteStore: NoteStore;
let voiceRelay: VoiceRelay | null = null;
let cloudSyncInstance: CloudSync | null = null;
let configSync: ConfigSync | null = null;
let embedder: Embedder | null = null;
let mcpExpose: McpExpose | null = null;

// ── DOM Picker script (injected into panel webContents) ─────
const PICKER_SCRIPT = `(function(){
  if(document.getElementById('__yo_picker__')) return;
  const overlay=document.createElement('div');
  overlay.id='__yo_picker__';
  overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
  const highlight=document.createElement('div');
  highlight.style.cssText='position:fixed;pointer-events:none;border:2px solid #a855f7;background:rgba(168,85,247,0.08);z-index:2147483646;transition:all 0.05s;display:none;';
  const label=document.createElement('div');
  label.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#a855f7;color:#fff;font:11px/1.3 monospace;padding:2px 6px;border-radius:3px;display:none;max-width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
  document.body.appendChild(highlight);
  document.body.appendChild(label);
  document.body.appendChild(overlay);
  let current=null;
  function buildSelector(el){
    if(el.dataset && el.dataset.testid) return '[data-testid="'+el.dataset.testid+'"]';
    if(el.getAttribute('role')&&el.getAttribute('aria-label')) return '[role="'+el.getAttribute('role')+'"][aria-label="'+el.getAttribute('aria-label')+'"]';
    if(el.id&&!/\\d{4,}/.test(el.id)&&!/^[:.]/.test(el.id)&&el.id.length>3&&!/^(ember|react|ng|mat-|cdk-|gb_)/.test(el.id)&&!/^[a-z]{1,2}\\d/.test(el.id)) return '#'+CSS.escape(el.id);
    if(el.getAttribute('placeholder')) return el.tagName.toLowerCase()+'[placeholder="'+el.getAttribute('placeholder')+'"]';
    if(el.getAttribute('aria-label')) return '[aria-label="'+el.getAttribute('aria-label')+'"]';
    if(el.getAttribute('role')) return el.tagName.toLowerCase()+'[role="'+el.getAttribute('role')+'"]';
    if(el.getAttribute('name')&&!el.getAttribute('name').match(/\\d{4,}/)) return el.tagName.toLowerCase()+'[name="'+el.getAttribute('name')+'"]';
    const parts=[];
    let node=el;
    while(node&&node!==document.body){
      let tag=node.tagName.toLowerCase();
      const parent=node.parentElement;
      if(parent){
        const siblings=Array.from(parent.children).filter(c=>c.tagName===node.tagName);
        if(siblings.length>1) tag+=':nth-of-type('+(siblings.indexOf(node)+1)+')';
      }
      parts.unshift(tag);
      node=parent;
      if(parts.length>=4) break;
    }
    return parts.join(' > ');
  }
  overlay.addEventListener('mousemove',function(e){
    overlay.style.pointerEvents='none';
    const target=document.elementFromPoint(e.clientX,e.clientY);
    overlay.style.pointerEvents='auto';
    if(!target||target===overlay||target===highlight||target===label){highlight.style.display='none';label.style.display='none';current=null;return;}
    current=target;
    const r=target.getBoundingClientRect();
    highlight.style.display='block';
    highlight.style.left=r.left+'px';highlight.style.top=r.top+'px';highlight.style.width=r.width+'px';highlight.style.height=r.height+'px';
    const sel=buildSelector(target);
    const txt=(target.textContent||'').trim().slice(0,40);
    label.textContent=target.tagName.toLowerCase()+(txt?' — '+txt:'');
    label.style.display='block';
    label.style.left=Math.min(r.left,window.innerWidth-310)+'px';
    label.style.top=Math.max(0,r.top-22)+'px';
  });
  overlay.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    if(!current) return;
    const sel=buildSelector(current);
    const tag=current.tagName.toLowerCase();
    const txt=(current.textContent||'').trim().slice(0,80);
    const isEditable=tag==='input'||tag==='textarea'||current.isContentEditable||current.getAttribute('role')==='textbox';
    const isClickable=tag==='button'||tag==='a'||current.getAttribute('role')==='button'||current.onclick!=null||window.getComputedStyle(current).cursor==='pointer';
    console.log('__YO_PICK__:'+JSON.stringify({selector:sel,tag:tag,text:txt,isEditable:isEditable,isClickable:isClickable}));
    overlay.remove();highlight.remove();label.remove();
  });
  overlay.addEventListener('contextmenu',function(e){e.preventDefault();overlay.remove();highlight.remove();label.remove();});
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){overlay.remove();highlight.remove();label.remove();document.removeEventListener('keydown',esc);}});
})()`;

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

  // Request macOS mic entitlement (triggers OS permission dialog on first use)
  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("microphone").catch(() => {});
  }

  // Allow microphone access in the main window renderer (for voice input)
  const mainSes = mainWindow.webContents.session;
  mainSes.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  mainSes.setPermissionCheckHandler((_wc, permission) => permission === "media");

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
  app.setName("Yo");

  // Clear stale IndexedDB locks from previous crashes
  try {
    const idbDir = path.join(app.getPath("userData"), "Partitions", "yo", "IndexedDB");
    const fs = require("fs");
    if (fs.existsSync(idbDir)) {
      for (const entry of fs.readdirSync(idbDir)) {
        const lockPath = path.join(idbDir, entry, "LOCK");
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
    }
  } catch { /* non-critical */ }

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
    yoAgent?.setLLMConfig(config);
  }

  // Core services
  skillEngine = new SkillEngine();
  appConnector = new AppConnector();

  // Embedder + capture store
  embedder = new Embedder();
  embedder.init().catch((err) => console.error("[embedder]", err));

  const captureStore = new CaptureStore();
  captureStore.setEmbedder(embedder);

  // Action-driven capture — grabs content on blur/navigate
  const actionGrabber = new ActionGrabber();
  actionGrabber.setCaptureStore(captureStore);
  actionGrabber.setAppConnector(appConnector);

  // MCP expose — read-only server for external LLM tools (pro feature)
  mcpExpose = new McpExpose();
  mcpExpose.setCaptureStore(captureStore);
  if (getPreference<boolean>("mcpExposeEnabled", false)) {
    mcpExpose.start().then((r) => {
      if (!r.ok) console.error("[mcp-expose] failed to start:", r.error);
    });
  }

  // Council — deterministic multi-model debate orchestrator
  const council = new Council();
  council.setCaptureStore(captureStore);

  // Yo agent — capture search + format assistant
  const yoAgent = new YoAgent();
  yoAgent.setCaptureStore(captureStore);
  yoAgent.setSkillEngine(skillEngine);
  yoAgent.setCouncil(council);

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});
  session.setOnRawCapture((appId, content) => {
    captureStore.ingest(appId, content).catch(() => {});
  });

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, skillEngine, session);
  yoInterceptor.setModeColor("#25C75E");

  panelManager = new PanelManager((id, wc) => {
    if (id === "term") {
      // Spawn pty when terminal page loads
      wc.on("did-finish-load", () => terminalManager.spawn(wc));
    } else {
      // Activate interceptor so yo/dip/sup work on app panels
      yoInterceptor.activate(wc, id);
      // Track URL changes in browser tabs for persistence
      if (id === "browser" || id.startsWith("browse-")) trackBrowserUrl(id, wc);
      // Track VS Code folder for persistence across restarts
      if (id === "vscode") trackVscodeFolder(wc);
    }

    // Track URL + favicon for URL bar and tab favicons
    const isBrowserPanel = id === "browser" || id.startsWith("browse-");
    if (isBrowserPanel) {
      // Browser panels use <webview> — track the guest's URL/favicon
      (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
        panelNavWc[id] = childWc;
        const trackChild = (url: string) => {
          if (url && url !== "about:blank") {
            panelUrls[id] = url;
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
          }
        };
        childWc.on("did-navigate", (_e: unknown, url: string) => {
          trackChild(url);
          actionGrabber.onPanelNavigate(id).catch(() => {});
        });
        childWc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
          if (isMainFrame) trackChild(url);
        });
        childWc.on("page-favicon-updated" as any, (_e: unknown, favicons: string[]) => {
          if (favicons?.length) {
            panelFavicons[id] = favicons[0];
            setPreference("panelFavicons", { ...panelFavicons });
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
            sendTabState();
          }
        });
      });
    } else {
      // Direct BrowserView — track its own URL/favicon
      panelNavWc[id] = wc;
      const trackDirect = (url: string) => {
        if (url && !url.startsWith("file://")) {
          panelUrls[id] = url;
          if (panelManager.activePanelId === id) sendUrlUpdate();
          sendPanelUrl(id);
        }
      };
      wc.on("did-navigate", (_e: unknown, url: string) => {
        trackDirect(url);
        actionGrabber.onPanelNavigate(id).catch(() => {});
      });
      wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) trackDirect(url);
      });
      wc.on("page-favicon-updated" as any, (_e: unknown, favicons: string[]) => {
        if (favicons?.length) {
          panelFavicons[id] = favicons[0];
          setPreference("panelFavicons", { ...panelFavicons });
          if (panelManager.activePanelId === id) sendUrlUpdate();
          sendPanelUrl(id);
          sendTabState();
        }
      });
    }
  });

  // Wire action grabber to panel manager for webContents access
  actionGrabber.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Wire council to panel manager
  council.setPanelSwitcher((id) => panelManager.switchTo(id, mainWindow!));
  council.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Persist zoom when changed via keyboard shortcut in panels
  panelManager.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Browser panel helpers (must be before app connector loop)
  const BROWSER_HOMES: Record<string, string> = {
    claude: "https://claude.ai",
    chatgpt: "https://chatgpt.com",
    gemini: "https://gemini.google.com",
  };

  function resolveBrowserHome(): string {
    const pref = getPreference<string>("browserHomepage", "claude");
    if (pref === "custom") return getPreference<string>("browserHomepageUrl", "");
    return BROWSER_HOMES[pref] || BROWSER_HOMES.claude;
  }

  function browserHtmlUrl(initialUrl?: string): string {
    const base = `file://${path.join(__dirname, "..", "renderer", "browser.html")}`;
    if (initialUrl) return `${base}?url=${encodeURIComponent(initialUrl)}`;
    return base;
  }

  function trackBrowserUrl(panelId: string, wc: Electron.WebContents): void {
    (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
      const saveUrl = (url: string) => {
        if (url && url !== "about:blank") {
          const saved = getPreference<Record<string, string>>("browserTabUrls", {});
          saved[panelId] = url;
          setPreference("browserTabUrls", saved);
        }
      };
      childWc.on("did-navigate", (_e: unknown, url: string) => saveUrl(url));
      childWc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) saveUrl(url);
      });
    });
  }

  function trackVscodeFolder(wc: Electron.WebContents): void {
    const saveFolder = (navUrl: string) => {
      try {
        const u = new URL(navUrl);
        const folder = u.searchParams.get("folder");
        if (folder) setPreference("vscodeLastFolder", folder);
      } catch {}
    };
    wc.on("did-navigate", (_e: unknown, url: string) => saveFolder(url));
    wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) saveFolder(url);
    });
  }

  // Seed PanelManager configs from apps (apps are the source of truth)
  const terminalHtml = `file://${path.join(__dirname, "..", "renderer", "terminal.html")}`;
  const terminalPreload = path.join(__dirname, "terminal-preload.js");
  const dashboardHtml = `file://${path.join(__dirname, "..", "renderer", "dashboard.html")}`;
  const dashboardPreload = path.join(__dirname, "dashboard-preload.js");
  const monacoHtml = `file://${path.join(__dirname, "..", "renderer", "monaco.html")}`;
  const enableVscode = getPreference("enableVscodeServer", false);
  vscodeServer = new VSCodeServer();
  for (const app of appConnector.list()) {
    if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://dashboard") {
      panelManager.addPanel(app.id, dashboardHtml, dashboardPreload);
    } else if (app.url === "yo://monaco") {
      panelManager.addPanel(app.id, monacoHtml);
    } else if (app.url === "yo://browser") {
      const savedBrowserUrls = getPreference<Record<string, string>>("browserTabUrls", {});
      const browserUrl = savedBrowserUrls[app.id] || resolveBrowserHome();
      panelManager.addPanel(app.id, browserHtmlUrl(browserUrl), undefined, undefined, true);
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
    const lastFolder = getPreference<string>("vscodeLastFolder", "");
    vscodeServer.start(lastFolder || undefined).catch((err) => {
      console.log("[vscode-server] failed to start:", err.message);
    });
  }

  // Note store + memory store (flat files with keyword search)
  noteStore = new NoteStore();
  const memoryStore = new MemoryStore();

  // Transcriber — OpenAI Whisper API for voice input
  const transcriber = new Transcriber();

  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, skillEngine, layoutManager, appConnector, session);
  commandParser.setWelcomeHandler(() => {
    mainWindow?.webContents.send("show-welcome");
  });

  // LLM engine for inline yo/sup execution
  const yoChat = new YoChat(panelManager);
  applyLLMConfig(llmConfig);
  yoInterceptor.setYoChat(yoChat);
  yoInterceptor.setCaptureStore(captureStore);
  commandParser.setYoChat(yoChat);

  // Wire yo agent dependencies
  yoAgent.setSessionCache(session);
  yoAgent.setMemoryStore(memoryStore);
  yoAgent.setNoteStore(noteStore);

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
      }
      if (!content || content.startsWith("[Element not found")) {
        try { content = await smartGrab(wc) || ""; } catch {}
      }
      if (content && !content.startsWith("[Element not found")) {
        sections.push(panelIds.length > 1 ? `## ${app?.name || id}\n\n${content}` : content);
      }
      // Raw body text → capture store for search indexing
      try {
        const raw = await wc.executeJavaScript("document.body.innerText.slice(0, 30000)");
        if (raw) session.rawCapture(id, `PAGE: ${await wc.executeJavaScript("document.title")}\nURL: ${wc.getURL()}\n\n${raw}`);
      } catch {}
    }
    return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
  });

  // Give command parser access to panel WebContents for .waz
  commandParser.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Push session state to renderer
  const sendSessionState = () => {
    mainWindow?.webContents.send("session-changed", session.getInfo());
  };

  // Wire command callbacks for interceptor + chat (both need dip routing)
  const callbacks = { openYoPanel: null as ((query: string) => void) | null };

  // Council state — participants set by .council command, consumed on next agent message
  let councilParticipants: string[] | null = null;

  const execCommand = async (cmd: string, sourcePanelId?: string) => {
    const result = await commandParser.execute(cmd, sourcePanelId);

    // .yo always opens the agent side panel
    if (result.startsWith("__YO_PANEL__")) {
      const query = result.replace(/^__YO_PANEL__:?/, "");
      callbacks.openYoPanel?.(query);
      return "";
    }

    // .council — arrange panels side-by-side, set council mode, open agent panel
    if (result.startsWith("__COUNCIL__")) {
      const participantsStr = result.replace(/^__COUNCIL__:?/, "");
      councilParticipants = participantsStr.split(",").filter(Boolean);

      // Arrange participant panels side by side
      if (mainWindow && !mainWindow.isDestroyed() && councilParticipants.length >= 2) {
        if (councilParticipants.length === 2) {
          layoutManager.splitTwo(councilParticipants[0], councilParticipants[1], mainWindow);
        } else {
          layoutManager.splitN(councilParticipants, mainWindow);
        }
        const gridInfo = layoutManager.getGridInfo();
        mainWindow.webContents.send("split-state", gridInfo);
        if (gridInfo) {
          for (const id of gridInfo.panelIds) ensureTab(id);
        }
        sendTabState();
      }

      mainWindow?.webContents.send("agent-mode-changed", "council");
      // Delay yo panel open to let the layout settle
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        panelManager.setRightInset(yoPanelWidth());
        mainWindow.webContents.send("yo-panel-open", `__council__:${councilParticipants!.join(",")}`);
      }, 400);
      return "";
    }

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
  yoInterceptor.setYoClearer(() => { commandParser.clearYoHistory(); });

  // Reminder registry
  const activeReminders = new Map<string, { message: string; fireAt: number; timer: ReturnType<typeof setTimeout> }>();

  // Voice Relay — phone-to-desktop voice remote (feature-flagged, disabled by default)
  if (getPreference<boolean>("voiceRemoteFeature", false)) {
    voiceRelay = new VoiceRelay();
    if (getPreference<boolean>("remoteEnabled", false)) {
      voiceRelay.start();
    }
  }

  // Wire .yo conversational agent — slide-out panel
  const yoPanelWidth = () => getPreference<number>("yoPanelWidth", 380);

  // When inset changes (panel open/close), re-apply current layout
  panelManager.setOnInsetChange(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (panelManager.isHidden) return; // don't re-show during splash/overlay
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.resizeViews(mainWindow);
    }
  });

  // Panel opener — called by interceptor or Cmd+. when user types .yo <query>
  const openYoPanel = (query: string, _sourcePanelId?: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("yo-panel-open", query);
    panelManager.setRightInset(yoPanelWidth());
    mainWindow.webContents.focus();
  };
  yoInterceptor.setPanelOpener(openYoPanel);
  yoInterceptor.setLastAgentResult(() => yoAgent.getLastResponse());
  callbacks.openYoPanel = openYoPanel;

  yoChat.setCommandCallback(execCommand);

  // Terminal yo/sup/dip — route through command parser, show result in terminal
  terminalManager.setCommandHandler(async (cmd, wc) => {
    const result = await execCommand(cmd);
    if (!result || wc.isDestroyed()) return;

    // Write result to terminal in grey
    const lines = result.replace(/\r/g, "").split("\n").join("\r\n");
    wc.send("terminal:data", `\x1b[90m${lines}\x1b[0m\r\n`);
  });

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
    const savedTabs = getPreference<string[]>("openTabs", []);

    // Re-register any browse-* panels from saved tabs or view so they exist for restore
    const savedUrls = getPreference<Record<string, string>>("browserTabUrls", {});
    const allPanelIds: string[] = [...savedTabs];
    if (lastView) {
      if (lastView.grid?.cells) allPanelIds.push(...lastView.grid.cells.map(c => c.panelId));
      if (lastView.panels) allPanelIds.push(...lastView.panels);
      if (lastView.rows) lastView.rows.forEach(row => allPanelIds.push(...row));
      if (lastView.id) allPanelIds.push(lastView.id);
    }
    for (const id of allPanelIds) {
      if (id.startsWith("browse-") && !panelManager.hasPanel(id)) {
        const num = parseInt(id.split("-")[1], 10);
        if (num > tabBrowserCounter) tabBrowserCounter = num;
        const url = savedUrls[id] || resolveBrowserHome();
        panelManager.addPanel(id, browserHtmlUrl(url), undefined, undefined, true);
      }
    }

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

    // Restore all saved tabs (not just those in the current view)
    for (const id of savedTabs) {
      if (!openTabs.includes(id)) {
        openTabs.push(id);
      }
    }
    // Also ensure panels from the active layout are in tabs
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

  // ── Tab management ─────────���───────────────────────────────
  const openTabs: string[] = [];
  let tabBrowserCounter = 0;

  // Per-panel URL + favicon tracking
  const panelUrls: Record<string, string> = {};
  const panelFavicons: Record<string, string> = getPreference<Record<string, string>>("panelFavicons", {});
  const panelNavWc: Record<string, Electron.WebContents> = {}; // navigable webContents per panel

  function getTabName(id: string): string {
    const app = appConnector.get(id);
    return app?.name || id;
  }

  function buildTabState() {
    const visible = getPreference<boolean>("showTabs", true);
    const gridInfo = layoutManager.getGridInfo();
    const isLayout = gridInfo && gridInfo.panelIds.length > 1;

    let tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>;
    if (isLayout) {
      const layoutName = gridInfo.name || gridInfo.panelIds.map((id) => getTabName(id)).join(" + ");
      const layoutFavicons = gridInfo.panelIds.map((id) => panelFavicons[id] || "").filter(Boolean);
      const layoutTabId = "__layout__";
      const gridSet = new Set(gridInfo.panelIds);
      tabs = [
        { id: layoutTabId, name: layoutName, layoutFavicons },
        ...openTabs.filter((id) => !gridSet.has(id)).map((id) => ({
          id, name: getTabName(id), favicon: panelFavicons[id] || "",
        })),
      ];
    } else {
      tabs = openTabs.map((id) => ({ id, name: getTabName(id), favicon: panelFavicons[id] || "" }));
    }

    return {
      tabs,
      activeId: isLayout ? "__layout__" : (panelManager.activePanelId || ""),
      visible,
    };
  }

  function sendTabState() {
    mainWindow?.webContents.send("tab-state", buildTabState());
  }

  /** Push the active panel's URL + favicon + nav state to the renderer URL bar */
  function sendUrlUpdate() {
    const id = panelManager.activePanelId;
    if (!id || !mainWindow || mainWindow.isDestroyed()) return;
    const nwc = panelNavWc[id];
    const canGoBack = nwc && !nwc.isDestroyed() ? nwc.canGoBack() : false;
    const canGoForward = nwc && !nwc.isDestroyed() ? nwc.canGoForward() : false;
    mainWindow.webContents.send("url-update", {
      url: panelUrls[id] || "",
      favicon: panelFavicons[id] || "",
      canGoBack,
      canGoForward,
    });
  }

  /** Notify renderer of a specific panel's URL (for cell URL bars in grid mode) */
  function sendPanelUrl(panelId: string) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("panel-url-update", {
      id: panelId,
      url: panelUrls[panelId] || "",
      favicon: panelFavicons[panelId] || "",
    });
  }

  function ensureTab(id: string) {
    if (!openTabs.includes(id)) {
      openTabs.push(id);
      persistTabs();
    }
  }

  function persistTabs() {
    setPreference("openTabs", [...openTabs]);
  }

  // Hook into panel focus events — add tab when panel becomes active
  let lastFocusedPanel: string | null = null;
  panelManager.setOnPanelFocused((id: string) => {
    // Action capture: previous panel just lost focus — capture it
    if (lastFocusedPanel && lastFocusedPanel !== id) {
      actionGrabber.onPanelBlur(lastFocusedPanel).catch(() => {});
    }
    lastFocusedPanel = id;

    ensureTab(id);
    // Persist lastView (only for single-panel mode — grids are saved by the layout system)
    const gridInfo = layoutManager.getGridInfo();
    if (!gridInfo || gridInfo.panelIds.length <= 1) {
      setPreference("lastView", { type: "panel", id });
    }
    sendTabState();
    sendUrlUpdate();
    // Notify dashboard to refresh when it becomes visible
    if (id === "dashboard") {
      const wc = panelManager.getWebContents("dashboard");
      if (wc && !wc.isDestroyed()) wc.send("dashboard:visible");
    }
  });

  // Activate interceptor on browser panel guest webviews
  panelManager.setOnWebviewAttach((childWc, panelId) => {
    yoInterceptor.activate(childWc, panelId);
  });

  // Give command parser tab close/list for .dip close
  commandParser.setTabManager(
    (id) => {
      if (!mainWindow) return;
      const idx = openTabs.indexOf(id);
      if (idx >= 0) openTabs.splice(idx, 1);
      const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
      panelManager.closePanel(id, mainWindow, nextId);
      persistTabs();
      sendSplitState();
      sendTabState();
    },
    () => [...openTabs],
  );

  // Initialize auth — restore session, schedule refresh, start heartbeat
  await initAuth();

  // Check if onboarding is needed BEFORE restoring panels
  // (BrowserViews render above HTML, so they'd cover the onboarding overlay)
  const authenticated = isAuthenticated();
  const needsOnboarding = !authenticated || !llmConfig.apiKey;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Only restore panels if not gated by onboarding
  if (!needsOnboarding) {
    restorePanels();
    panelsReady = true;
    // Hide panels during splash — renderer will show them after splash dismisses
    if (mainWindow) panelManager.hideActive(mainWindow);
  }

  // Start cloud sync if authenticated
  if (authenticated) {
    cloudSyncInstance = new CloudSync(noteStore);
    cloudSyncInstance.setCaptureStore(captureStore);
    cloudSyncInstance.start();
  }

  // ── Auto-updater ───────────────────────────────────────────
  const autoUpdateEnabled = getPreference<boolean>("autoUpdate", true);

  autoUpdater.autoDownload = autoUpdateEnabled;
  autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
  autoUpdater.logger = null;

  autoUpdater.on("update-available", (info: { version: string }) => {
    mainWindow?.webContents.send("update-status", {
      status: "available",
      version: info.version,
    });
  });

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    mainWindow?.webContents.send("update-status", {
      status: "downloading",
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    mainWindow?.webContents.send("update-status", {
      status: "ready",
      version: info.version,
    });
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("[auto-update] error:", err.message);
  });

  if (autoUpdateEnabled) {
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  }

  // ── Hot config sync (non-blocking, then periodic) ─
  configSync = new ConfigSync();
  configSync.fetchAll((msg) => {
    mainWindow?.webContents.send("splash-status", msg);
  }).then(() => {
    reloadRemotePatterns();
  }).catch(() => {});
  // Start periodic checks for future updates
  configSync.start(() => {
    reloadRemotePatterns();
  });

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
  ipcMain.on("update-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

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
    const wasHidden = panelManager.isHidden;
    panelManager.hidden = false;
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.showActive(mainWindow);
    }
    sendSplitState();
    // After first reveal (post-splash), reload active panel
    // — sites like Gmail don't render CSS properly when loaded at zero size
    if (wasHidden && panelManager.activePanelId) {
      const view = panelManager.getView(panelManager.activePanelId);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.reload();
      }
    }
  });

  // IPC: Command palette — transparent child window above BrowserViews
  let cmdPaletteWin: BrowserWindow | null = null;

  function closeCmdPalette() {
    if (cmdPaletteWin && !cmdPaletteWin.isDestroyed()) cmdPaletteWin.close();
    cmdPaletteWin = null;
  }

  ipcMain.on("cmd-palette-open", () => {
    if (cmdPaletteWin && !cmdPaletteWin.isDestroyed()) { closeCmdPalette(); return; }
    if (!mainWindow) return;
    const bounds = mainWindow.getContentBounds();
    cmdPaletteWin = new BrowserWindow({
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
      resizable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const html = `<!DOCTYPE html><html><head><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:rgba(0,0,0,0.35);display:flex;align-items:flex-start;justify-content:center;padding-top:18vh;height:100vh;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
      .modal{width:min(520px,80vw);background:#141414;border:1px solid #25C75E;border-radius:14px;padding:4px;box-shadow:0 16px 48px rgba(0,0,0,0.6)}
      input{width:100%;background:transparent;border:none;border-radius:10px;padding:14px 16px;color:#e0e0e0;font-size:15px;font-family:inherit;outline:none;caret-color:#25C75E}
      input::placeholder{color:#555}
    </style></head><body>
      <div class="modal"><input id="inp" placeholder="Type a command..." spellcheck="false" autocomplete="off" autofocus /></div>
      <script>
        const inp=document.getElementById("inp");
        inp.focus();
        document.addEventListener("keydown",e=>{
          if(e.key==="Escape"){e.preventDefault();window.close()}
          if(e.key==="Enter"){e.preventDefault();const v=inp.value.trim();if(v)console.log("__cmd__"+v);window.close()}
        });
        document.body.addEventListener("click",e=>{if(e.target===document.body)window.close()});
      </script>
    </body></html>`;
    cmdPaletteWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    cmdPaletteWin.once("ready-to-show", () => {
      if (cmdPaletteWin && !cmdPaletteWin.isDestroyed()) cmdPaletteWin.show();
    });
    cmdPaletteWin.webContents.on("console-message", (_e, _level, msg) => {
      if (msg.startsWith("__cmd__")) {
        const cmd = msg.slice(7);
        const clean = cmd.startsWith(".") ? cmd.slice(1) : cmd;
        mainWindow?.webContents.send("exec-command-from-palette", clean);
      }
    });
    cmdPaletteWin.on("closed", () => { cmdPaletteWin = null; });
  });

  ipcMain.on("cmd-palette-close", () => closeCmdPalette());

  // IPC: Yo panel commands — route through command parser
  ipcMain.on("yo-panel-send", async (_e, message: string) => {
    const trimmed = message.trim();

    // Route dot-commands (.dip, .drip, .sup, .waz) through command parser
    if (trimmed.startsWith(".")) {
      const firstWord = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase();
      if (firstWord && ["dip", "drip", "sup", "waz", "council"].includes(firstWord)) {
        try {
          const result = await execCommand(trimmed.slice(1));
          if (firstWord !== "council") {
            mainWindow?.webContents.send("yo-panel-done", result || "done.");
          }
        } catch (err: any) {
          mainWindow?.webContents.send("yo-panel-error", err?.message || String(err));
        }
        return;
      }
    }

    const wc = mainWindow?.webContents;
    if (!wc || mainWindow!.isDestroyed()) return;

    // Council mode — if participants are queued, start the council orchestrator
    if (councilParticipants && councilParticipants.length >= 2) {
      const participants = councilParticipants;
      councilParticipants = null;
      wc.send("yo-panel-token", `Starting council with ${participants.join(", ")}...\n`);

      council.start(
        { participants, prompt: trimmed, rounds: 2 },
        (progress) => wc.send("yo-panel-token", `\n${progress}`),
      ).then((result) => {
        if (result.status === "complete" && result.totalCaptures > 0) {
          // Feed actual responses directly to the agent for synthesis
          const responseParts: string[] = [`Council complete: ${result.totalCaptures} responses from ${participants.join(", ")}.\n\nOriginal question: ${trimmed}\n`];
          for (const [participant, resps] of result.responses) {
            for (let i = 0; i < resps.length; i++) {
              responseParts.push(`--- ${participant} (round ${i + 1}) ---\n${resps[i]}\n`);
            }
          }
          responseParts.push("\nSynthesize the key findings, areas of agreement, and notable differences between the participants. Be concise.");
          const summary = responseParts.join("\n");
          yoAgent.send(summary, {
            onText: (delta) => wc.send("yo-panel-token", delta),
            onToolUse: (id, name, input) => wc.send("yo-panel-tool-use", id, name, input),
            onToolResult: (id, detail) => wc.send("yo-panel-tool-result", id, detail),
            onDone: (fullText) => wc.send("yo-panel-done", fullText),
            onError: (err) => wc.send("yo-panel-error", err),
          });
        } else {
          wc.send("yo-panel-done", `Council ${result.status}.`);
        }
      }).catch((err) => {
        wc.send("yo-panel-error", err?.message || String(err));
      });
      return;
    }

    // Everything else goes to the yo agent
    yoAgent.send(trimmed, {
      onText: (delta) => wc.send("yo-panel-token", delta),
      onToolUse: (id, name, input) => wc.send("yo-panel-tool-use", id, name, input),
      onToolResult: (id, detail) => wc.send("yo-panel-tool-result", id, detail),
      onDone: (fullText) => wc.send("yo-panel-done", fullText),
      onError: (err) => wc.send("yo-panel-error", err),
    });
  });

  ipcMain.on("yo-panel-stop", () => {
    yoAgent.abort();
    council.stop();
  });

  // Renderer-initiated panel open (Cmd+.)
  ipcMain.on("yo-panel-open-from-renderer", (_e, query: string) => {
    yoAgent.clear();
    panelManager.setRightInset(yoPanelWidth());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.focus();
    }
    if (query) openYoPanel(query);
  });

  ipcMain.on("yo-panel-dismiss", () => {
    yoAgent.clear();
    mainWindow?.webContents.send("yo-panel-close");
    panelManager.setRightInset(0);
  });

  // IPC: Yo panel resize
  ipcMain.on("yo-panel-resize", (_e, width: number) => {
    panelManager.setRightInset(width);
  });
  ipcMain.on("yo-panel-width-save", (_e, width: number) => {
    setPreference("yoPanelWidth", width);
  });
  ipcMain.handle("yo-panel-get-width", () => {
    return getPreference<number>("yoPanelWidth", 380);
  });

  // IPC: Agent mode + guardrails
  ipcMain.handle("get-agent-mode", () => yoAgent.getMode());
  ipcMain.on("set-agent-mode", (_e, mode: string) => {
    yoAgent.setMode(mode as any);
    setPreference("agentMode", mode);
    mainWindow?.webContents.send("agent-mode-changed", mode);
  });
  ipcMain.handle("get-tool-registry", () => {
    const { getToolRegistry } = require("./action-gate");
    return getToolRegistry();
  });
  ipcMain.on("set-tool-override", (_e, toolName: string, override: string) => {
    const overrides = getPreference<Record<string, string>>("toolOverrides", {});
    if (override === "default") {
      delete overrides[toolName];
    } else {
      overrides[toolName] = override;
    }
    setPreference("toolOverrides", overrides);
  });

  // Approval system — pending approvals map + IPC
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  let approvalCounter = 0;

  yoAgent.setApprovalCallback(async (toolName, input) => {
    const id = `approval-${++approvalCounter}`;
    const { TOOL_LABELS } = require("./action-gate");
    const toolLabel = TOOL_LABELS[toolName] || toolName;
    mainWindow?.webContents.send("approval-request", id, toolName, toolLabel, input);
    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(id, resolve);
      setTimeout(() => {
        if (pendingApprovals.has(id)) {
          pendingApprovals.delete(id);
          resolve(false);
        }
      }, 60000);
    });
  });

  ipcMain.on("approval-respond", (_e, id: string, approved: boolean) => {
    const resolve = pendingApprovals.get(id);
    if (resolve) {
      pendingApprovals.delete(id);
      resolve(approved);
    }
  });

  // IPC: Voice transcription (local Whisper)
  ipcMain.handle("transcribe-audio", async (_e, audioBuffer: ArrayBuffer) => {
    try {
      const float32 = new Float32Array(audioBuffer);
      const text = await transcriber.transcribe(float32);
      return { ok: true, text };
    } catch (err: any) {
      console.error("[transcribe]", err);
      return { ok: false, error: err.message || "Transcription failed" };
    }
  });

  // IPC: Yo chat history
  ipcMain.handle("yo-chats-list", () => yoAgent.listChats());
  ipcMain.handle("yo-chats-load", (_e, id: string) => yoAgent.loadChat(id));
  ipcMain.handle("yo-chats-delete", (_e, id: string) => yoAgent.deleteChat(id));
  ipcMain.handle("yo-chats-search", () => []);
  ipcMain.handle("yo-chat-new", () => { yoAgent.clear(); return true; });

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
  ipcMain.handle("skills-generate", (_e, name: string, description: string) =>
    skillEngine.generatePrompt(name, description),
  );

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

  // IPC: apps CRUD (panel apps)
  ipcMain.handle("apps-list", () => appConnector.list());
  ipcMain.handle("apps-add", (_e, id: string, name: string, url: string) => {
    const app = appConnector.add(id, name, url);
    panelManager.addPanel(id, url);
    return app;
  });
  ipcMain.handle("apps-remove", (_e, id: string) => appConnector.remove(id));
  ipcMain.handle("apps-update-id", (_e, oldId: string, newId: string) => appConnector.updateId(oldId, newId));
  ipcMain.handle("apps-update-name", (_e, id: string, name: string) => appConnector.updateName(id, name));
  ipcMain.handle("apps-update-url", (_e, id: string, url: string) => appConnector.updateUrl(id, url));
  ipcMain.handle("apps-update-force-web", (_e, id: string, forceWeb: boolean) => appConnector.updateForceWeb(id, forceWeb));
  ipcMain.handle("apps-update-do-not-record", (_e, id: string, doNotRecord: boolean) => appConnector.updateDoNotRecord(id, doNotRecord));
  ipcMain.handle("apps-set-connected-slug", () => false);

  // IPC: app command mapping (DOM picker)
  ipcMain.handle("apps-set-command", (_e, id: string, key: string, mapping: { selector: string; action: string; description: string }) => {
    return appConnector.setCommand(id, key, mapping as any);
  });
  ipcMain.handle("apps-remove-command", (_e, id: string, key: string) => {
    return appConnector.removeCommand(id, key);
  });
  ipcMain.handle("apps-test-command", async (_e, id: string, key: string, wcId?: number) => {
    const app = appConnector.get(id);
    if (!app) return "App not found";
    const mapping = app.commands[key];
    if (!mapping) return "Command not found";
    let wc: import("electron").WebContents | null = null;
    if (wcId) {
      const { webContents } = require("electron") as typeof import("electron");
      wc = webContents.fromId(wcId) ?? null;
    }
    if (!wc) wc = panelManager.getGuestOrWebContents(id);
    if (!wc || wc.isDestroyed()) return "Panel not open";
    const { executeCommand: execCmd } = await import("./dom-bridge");
    return execCmd(wc, mapping);
  });

  ipcMain.on("start-picker", (_e, wcId: number) => {
    const { webContents } = require("electron") as typeof import("electron");
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(PICKER_SCRIPT).catch(() => {});
    const onConsole = (_ev: Electron.Event, _level: number, message: string) => {
      if (!message.startsWith("__YO_PICK__:")) return;
      try {
        const result = JSON.parse(message.slice("__YO_PICK__:".length));
        mainWindow?.webContents.send("picker-result", result);
      } catch {}
      wc.off("console-message", onConsole);
    };
    wc.on("console-message", onConsole);
  });

  // IPC: command execution (used by Cmd+. overlay)
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

  // IPC: app version
  ipcMain.handle("get-app-version", () => app.getVersion());

  // IPC: auth
  ipcMain.handle("start-auth", async (_e, mode: "register" | "login") => startAuthFlow(mode));
  ipcMain.handle("is-authenticated", () => isAuthenticated());
  ipcMain.handle("get-account-info", () => getAccountInfo());
  ipcMain.handle("get-auth-status", () => getAuthStatus());
  ipcMain.handle("logout", () => { logout(); });
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
    // Skip validation if only model/provider changed (same key)
    const existing = loadLLMConfig();
    const keyChanged = config.apiKey !== existing.apiKey;
    if (keyChanged) {
      const result = await validateLLMConfig(config);
      if (!result.valid) return { ok: false, error: result.error };
    }
    saveLLMConfig(config);
    applyLLMConfig(config);
    return { ok: true };
  });

  // ── MCP Expose IPC handlers ────────────────────────────
  ipcMain.handle("mcp-expose-start", () => mcpExpose!.start());
  ipcMain.handle("mcp-expose-stop", () => { mcpExpose!.stop(); });
  ipcMain.handle("mcp-expose-status", () => ({
    running: mcpExpose!.isRunning,
    port: mcpExpose!.getPort(),
  }));
  ipcMain.handle("mcp-expose-get-tokens", () => mcpExpose!.getTokens());
  ipcMain.handle("mcp-expose-gen-token", (_e, label: string) => mcpExpose!.generateToken(label));
  ipcMain.handle("mcp-expose-revoke-token", (_e, token: string) => { mcpExpose!.revokeToken(token); });

  // ── Dashboard IPC handlers ─────────────────────────────

  ipcMain.handle("dashboard:today", () => usageTracker.getToday());
  ipcMain.handle("dashboard:history", (_e, days?: number) => usageTracker.getHistory(days || 30));
  ipcMain.handle("dashboard:all-time", () => usageTracker.getAllTime());

  ipcMain.handle("dashboard:apps", () => {
    const appsDir = path.join(os.homedir(), "yo", "apps");
    try {
      if (!fs.existsSync(appsDir)) return [];
      const entries = fs.readdirSync(appsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const indexPath = path.join(appsDir, e.name, "index.html");
          let modified = "";
          try {
            const stat = fs.statSync(indexPath);
            modified = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          } catch { /* no index.html */ }
          return { name: e.name, path: path.join(appsDir, e.name), modified };
        })
        .filter((a) => a.modified); // only show apps that have index.html
    } catch { return []; }
  });

  ipcMain.on("dashboard:open-app", (_e, name: string) => {
    const filePath = path.join(os.homedir(), "yo", "apps", name, "index.html");
    if (fs.existsSync(filePath) && mainWindow) {
      const fileUrl = `file://${filePath}`;
      panelManager.addPanel(`app-${name}`, fileUrl);
      panelManager.switchTo(`app-${name}`, mainWindow);
    }
  });

  ipcMain.handle("dashboard:delete-app", (_e, name: string) => {
    const appDir = path.join(os.homedir(), "yo", "apps", name);
    try {
      fs.rmSync(appDir, { recursive: true, force: true });
      return true;
    } catch { return false; }
  });

  ipcMain.handle("dashboard:reminders", () => {
    const result: Array<{ id: string; message: string; fireAt: number }> = [];
    for (const [id, r] of activeReminders) {
      result.push({ id, message: r.message, fireAt: r.fireAt });
    }
    return result;
  });

  ipcMain.handle("dashboard:cancel-reminder", (_e, id: string) => {
    const r = activeReminders.get(id);
    if (!r) return false;
    clearTimeout(r.timer);
    activeReminders.delete(id);
    return true;
  });

  ipcMain.handle("dashboard:llm-info", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
  }));

  // Billing/account managed via web dashboard — no client-side checkout needed

  // IPC: tabs
  ipcMain.handle("tab-list", () => {
    return buildTabState();
  });

  ipcMain.on("tab-switch", (_e, id: string) => {
    if (!mainWindow) return;
    if (id === "__layout__") {
      // Clicking the layout tab restores the grid
      layoutManager.restoreSplit(mainWindow);
      const gridInfo = layoutManager.getGridInfo();
      if (gridInfo) {
        setPreference("lastView", {
          type: "grid-full",
          grid: { name: "", version: 2, cols: gridInfo.cols, rows: gridInfo.rows, colWidths: gridInfo.colWidths, rowHeights: gridInfo.rowHeights, cells: gridInfo.cells },
        });
      }
    } else {
      // Switching to a non-layout tab exits the grid
      layoutManager.clearSplit();
      panelManager.switchTo(id, mainWindow);
      setPreference("lastView", { type: "panel", id });
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-close", (_e, id: string) => {
    if (!mainWindow) return;

    // Closing the layout tab closes all panels in the grid
    if (id === "__layout__") {
      const gridInfo = layoutManager.getGridInfo();
      if (gridInfo) {
        for (const panelId of gridInfo.panelIds) {
          const idx = openTabs.indexOf(panelId);
          if (idx >= 0) openTabs.splice(idx, 1);
          panelManager.closePanel(panelId, mainWindow);
        }
      }
      layoutManager.clearSplit();
      // Switch to first remaining tab
      if (openTabs.length > 0) {
        panelManager.switchTo(openTabs[0], mainWindow);
      }
      persistTabs();
      sendSplitState();
      sendTabState();
      return;
    }

    const idx = openTabs.indexOf(id);
    if (idx < 0) return;
    openTabs.splice(idx, 1);
    persistTabs();
    const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
    panelManager.closePanel(id, mainWindow, nextId);
    // Clean up saved browser URL
    if (id === "browser" || id.startsWith("browse-")) {
      const saved = getPreference<Record<string, string>>("browserTabUrls", {});
      delete saved[id];
      setPreference("browserTabUrls", saved);
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-new", () => {
    if (!mainWindow) return;
    tabBrowserCounter++;
    const id = `browse-${tabBrowserCounter}`;
    const homeUrl = resolveBrowserHome();
    panelManager.addPanel(id, browserHtmlUrl(homeUrl), undefined, undefined, true);
    panelManager.switchTo(id, mainWindow);
    ensureTab(id);
    sendSplitState();
    sendTabState();
  });

  // IPC: URL bar
  const URL_BAR_HEIGHT = 34;

  // Apply initial URL bar state
  if (getPreference<boolean>("showUrlBar", true)) {
    panelManager.setTopInset(URL_BAR_HEIGHT);
  }

  ipcMain.on("url-bar-navigate", (_e, url: string) => {
    if (!mainWindow) return;
    const id = panelManager.activePanelId;
    if (!id) return;

    // Normalize: add protocol if missing
    let target = url.trim();
    if (target && !/^https?:\/\//i.test(target)) {
      if (/^localhost(:\d+)?(\/|$)/i.test(target) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(target)) {
        target = "http://" + target;
      } else {
        target = "https://" + target;
      }
    }

    const isBrowser = id === "browser" || id.startsWith("browse-");
    if (isBrowser) {
      // Navigate the webview guest inside browser.html
      const wc = panelManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.executeJavaScript(`(function(){
          const wv = document.querySelector("webview");
          if (wv) { wv.loadURL(${JSON.stringify(target)}); }
          const bar = document.getElementById("url");
          if (bar) bar.value = ${JSON.stringify(target)};
        })()`).catch(() => {});
      }
    } else {
      // Navigate the BrowserView directly
      const wc = panelManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.loadURL(target).catch(() => {});
      }
    }
  });

  ipcMain.on("url-bar-back", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.goBack();
    }
  });

  ipcMain.on("url-bar-forward", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.goForward();
    }
  });

  ipcMain.on("url-bar-refresh", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.reload();
    }
  });

  // Per-panel nav (for cell URL bars in grid mode)
  ipcMain.on("panel-nav-back", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.goBack();
  });
  ipcMain.on("panel-nav-forward", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.goForward();
  });
  ipcMain.on("panel-nav-refresh", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.reload();
  });
  ipcMain.on("panel-nav-to", (_e, panelId: string, url: string) => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    const isBrowser = panelId === "browser" || panelId.startsWith("browse-");
    const nwc = panelNavWc[panelId];
    if (!nwc || nwc.isDestroyed()) return;
    if (isBrowser) {
      nwc.executeJavaScript(`(function(){
        const wv = document.querySelector("webview");
        if (wv) { wv.loadURL(${JSON.stringify(target)}); }
        const bar = document.getElementById("url");
        if (bar) bar.value = ${JSON.stringify(target)};
      })()`).catch(() => {});
    } else {
      nwc.loadURL(target).catch(() => {});
    }
  });

  ipcMain.on("url-bar-toggle", (_e, show: boolean) => {
    setPreference("showUrlBar", show);
    panelManager.setTopInset(show ? URL_BAR_HEIGHT : 0);
  });

  ipcMain.on("open-external", (_e, url: string) => {
    // Only allow http(s) and mailto URLs — block file://, javascript://, etc.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:") {
        shell.openExternal(url);
      } else {
        console.warn("[open-external] blocked unsafe protocol:", parsed.protocol, url.slice(0, 80));
      }
    } catch {
      console.warn("[open-external] blocked malformed URL:", url.slice(0, 80));
    }
  });

  // Account and billing managed via yosup.dev/dashboard

  // IPC: support ticket (uses authenticated server call)
  ipcMain.handle("submit-support-ticket", async (_e, ticket: { subject: string; description: string }) => {
    try {
      return await serverPostAuthed("/api/support/ticket", {
        ...ticket,
        appVersion: app.getVersion(),
        os: `${process.platform} ${process.arch}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
    // Live-apply remote mode toggle
    if (key === "remoteEnabled") {
      if (value) voiceRelay?.start();
      else voiceRelay?.stop();
    }
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
    // Hide panels immediately — the tutorial will show next and it's HTML
    // that gets painted under BrowserViews. panelsShow fires when tutorial closes.
    if (mainWindow) panelManager.hideActive(mainWindow);
    sendSplitState();
  });

  // Configure webviews embedded in the renderer (e.g. app-preview in help overlay)
  (mainWindow?.webContents as any)?.on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
    childWc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" },
        },
      };
    });
  });

  // Tell renderer to check auth gate
  mainWindow?.webContents.on("did-finish-load", () => {
    const hideWelcome = getPreference<boolean>("hideWelcome", false);
    const authStatus = getAuthStatus();
    // Recompute needsOnboarding dynamically (may have changed after logout/re-login)
    const currentNeedsOnboarding = !isAuthenticated() || !llmConfig.apiKey;
    mainWindow?.webContents.send("boot", {
      authenticated: authStatus.authenticated,
      status: authStatus.status,
      tier: authStatus.tier,
      daysRemaining: authStatus.daysRemaining,
      apiKey: llmConfig.apiKey ? true : false,
      needsOnboarding: currentNeedsOnboarding,
      hideWelcome,
    });
    if (!currentNeedsOnboarding && !panelsReady) {
      restorePanels();
      panelsReady = true;
      sendSplitState();
    } else if (!currentNeedsOnboarding) {
      sendSplitState();
    }
  });
}

app.whenReady().then(boot);

// Handle HTTP Basic Auth prompts (401 WWW-Authenticate) from any webContents
app.on("login", (event, _wc, _details, authInfo, callback) => {
  event.preventDefault();
  const authWin = new BrowserWindow({
    width: 360, height: 260,
    parent: mainWindow || undefined,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: "hidden",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const host = authInfo.host || "This site";
  const realm = authInfo.realm ? ` (${authInfo.realm})` : "";
  const html = `data:text/html,${encodeURIComponent(`<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#1a1a1a;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;padding:24px;display:flex;flex-direction:column;gap:12px}
    h3{font-size:14px;font-weight:600;color:#fff}
    p{font-size:12px;color:#888}
    input{width:100%;padding:8px 10px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none}
    input:focus{border-color:#25C75E}
    .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
    button{padding:6px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer}
    .cancel{background:#333;color:#ccc}
    .login{background:#25C75E;color:#000;font-weight:600}
  </style></head><body>
    <h3>Authentication Required</h3>
    <p>${host}${realm} requires credentials.</p>
    <input id="u" type="text" placeholder="Username" autofocus />
    <input id="p" type="password" placeholder="Password" />
    <div class="btns">
      <button class="cancel" onclick="window.close()">Cancel</button>
      <button class="login" id="go">Log In</button>
    </div>
    <script>
      document.getElementById('go').onclick=()=>{
        document.title='AUTH:'+encodeURIComponent(document.getElementById('u').value)+'|'+encodeURIComponent(document.getElementById('p').value);
      };
      document.getElementById('p').onkeydown=(e)=>{if(e.key==='Enter')document.getElementById('go').click()};
      document.getElementById('u').onkeydown=(e)=>{if(e.key==='Enter')document.getElementById('p').focus()};
    </script>
  </body></html>`)}`;
  authWin.loadURL(html);
  authWin.once("ready-to-show", () => authWin.show());
  let answered = false;
  authWin.webContents.on("page-title-updated", (_e, title) => {
    if (!title.startsWith("AUTH:")) return;
    answered = true;
    const parts = title.slice(5).split("|", 2);
    const username = decodeURIComponent(parts[0]);
    const password = decodeURIComponent(parts[1] || "");
    callback(username, password);
    authWin.close();
  });
  authWin.on("closed", () => {
    if (!answered) callback(); // cancel
  });
});

app.on("window-all-closed", () => {
  cleanupAll();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  cleanupAll();
});

let cleanedUp = false;
function cleanupAll() {
  if (cleanedUp) return;
  cleanedUp = true;
  globalShortcut.unregisterAll();
  cleanupAuthTimers();
  voiceRelay?.stop();
  cloudSyncInstance?.stop();
  cloudSyncInstance = null;
  configSync?.stop();
  configSync = null;
  terminalManager?.killAll();
  vscodeServer?.stop();
  mcpExpose?.stop();
  embedder?.cleanup();
  usageTracker.flush();
  // Hard exit if anything keeps the process alive
  setTimeout(() => process.exit(0), 5000).unref();
}
