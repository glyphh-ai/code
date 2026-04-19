/**
 * VibeRecorder — captures user interactions across live panels into a replayable vibe.
 *
 * User hits Cmd+Shift+. to start recording. All clicks, text input, and panel
 * switches are captured passively (without interfering with normal operation).
 * Hit the shortcut again to stop — raw events are refined into a Vibe definition.
 *
 * Recording script is injected into each panel's webContents via executeJavaScript.
 * Events flow back via console.log with a __YO_REC__ prefix + session nonce.
 */

import type { WebContents } from "electron";
import type { AppConnector } from "./app-connector";
import type { Vibe, VibeStep } from "./vibe-runner";
import crypto from "crypto";

// ── Types ───────────────────────────────────────────────

export interface RawRecordedEvent {
  type: "click" | "input" | "navigate" | "panel-switch";
  timestamp: number;
  panelId: string;
  selector?: string;
  text?: string;
  tag?: string;
  url?: string;
  isEditable?: boolean;
  isClickable?: boolean;
}

export interface RecordingSession {
  startedAt: number;
  events: RawRecordedEvent[];
  panelSequence: string[];
}

// ── VibeRecorder ────────────────────────────────────────

export class VibeRecorder {
  private recording = false;
  private events: RawRecordedEvent[] = [];
  private panelSequence: string[] = [];
  private currentPanel: string | null = null;
  private startTime = 0;
  private injectedPanels = new Set<string>();
  private readonly nonce = crypto.randomBytes(16).toString("hex");
  private cleanups = new Map<number, () => void>();

  // Callbacks (wired from main.ts)
  private wcGetter: ((id: string) => WebContents | null) | null = null;
  private panelIdsGetter: (() => string[]) | null = null;
  private activePanelGetter: (() => string | null) | null = null;
  private appConnector: AppConnector | null = null;
  private onStateChange: ((recording: boolean, stepCount: number) => void) | null = null;

  // ── Setters ─────────────────────────────────────────

  setWcGetter(fn: typeof this.wcGetter): void { this.wcGetter = fn; }
  setPanelIdsGetter(fn: typeof this.panelIdsGetter): void { this.panelIdsGetter = fn; }
  setActivePanelGetter(fn: typeof this.activePanelGetter): void { this.activePanelGetter = fn; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }
  setOnStateChange(fn: typeof this.onStateChange): void { this.onStateChange = fn; }

  get isRecording(): boolean { return this.recording; }

  get stepCount(): number {
    return this.events.filter((e) => e.type !== "panel-switch").length;
  }

  // ── Start / Stop ──────────────────────────────────────

  /** Start recording interactions across all loaded panels. */
  start(): void {
    if (this.recording) return;
    this.recording = true;
    this.events = [];
    this.panelSequence = [];
    this.startTime = Date.now();
    this.injectedPanels.clear();

    // Track current active panel
    this.currentPanel = this.activePanelGetter?.() ?? null;
    if (this.currentPanel) {
      this.panelSequence.push(this.currentPanel);
    }

    // Inject recording script into all loaded panels
    const panelIds = this.panelIdsGetter?.() ?? [];
    for (const id of panelIds) {
      this.injectRecorder(id);
    }

    this.onStateChange?.(true, 0);
  }

  /** Stop recording and return the raw session. */
  stop(): RecordingSession {
    this.recording = false;

    // Clean up console listeners
    for (const [, cleanup] of this.cleanups) {
      cleanup();
    }
    this.cleanups.clear();

    // Remove recording UI from all panels
    for (const id of this.injectedPanels) {
      this.removeRecorderUI(id);
    }
    this.injectedPanels.clear();

    this.onStateChange?.(false, 0);

    return {
      startedAt: this.startTime,
      events: [...this.events],
      panelSequence: [...new Set(this.panelSequence)],
    };
  }

  /** Called by main.ts when a panel receives focus. */
  onPanelFocus(panelId: string): void {
    if (!this.recording) return;

    if (this.currentPanel && this.currentPanel !== panelId) {
      this.events.push({
        type: "panel-switch",
        timestamp: Date.now() - this.startTime,
        panelId,
      });
      this.panelSequence.push(panelId);
      this.onStateChange?.(true, this.stepCount);
    }
    this.currentPanel = panelId;

    // Inject recorder into newly focused panel if needed
    if (!this.injectedPanels.has(panelId)) {
      this.injectRecorder(panelId);
    }
  }

  /** Called when a new panel is created while recording is active. */
  onPanelCreated(panelId: string): void {
    if (!this.recording) return;
    this.injectRecorder(panelId);
  }

  // ── Event handling ──────────────────────────────────

  private handleEvent(panelId: string, data: Record<string, unknown>): void {
    if (!this.recording) return;
    if (data._recNonce !== this.nonce) return;

    const event: RawRecordedEvent = {
      type: data.type as RawRecordedEvent["type"],
      timestamp: Date.now() - this.startTime,
      panelId,
      selector: data.selector as string | undefined,
      text: data.text as string | undefined,
      tag: data.tag as string | undefined,
      isEditable: data.isEditable as boolean | undefined,
      isClickable: data.isClickable as boolean | undefined,
    };

    this.events.push(event);
    this.onStateChange?.(true, this.stepCount);
  }

  // ── Injection ─────────────────────────────────────────

  /** Inject the recording script into a panel's webContents. */
  private injectRecorder(panelId: string): void {
    const wc = this.wcGetter?.(panelId);
    if (!wc || wc.isDestroyed()) return;
    // Skip background/internal panels
    if (panelId.startsWith("bgv-")) return;

    this.injectedPanels.add(panelId);

    // Inject the recording script
    wc.executeJavaScript(this.buildRecorderScript()).catch(() => {});

    // Listen for recording events via console.log
    const PREFIX = "__YO_REC__";
    const onConsole = (_e: unknown, _l: unknown, msg: string) => {
      if (typeof msg !== "string" || !msg.startsWith(PREFIX)) return;
      try {
        const data = JSON.parse(msg.slice(PREFIX.length));
        this.handleEvent(panelId, data);
      } catch { /* malformed JSON */ }
    };

    // Listen for navigation events
    const onNav = (_e: unknown, url: string) => {
      if (!this.recording) return;
      if (url.startsWith("data:")) return; // ignore data URLs
      this.events.push({
        type: "navigate",
        timestamp: Date.now() - this.startTime,
        panelId,
        url,
      });
      this.onStateChange?.(true, this.stepCount);
    };

    // Re-inject script after page reload
    const onLoad = () => {
      if (!this.recording) return;
      wc.executeJavaScript(this.buildRecorderScript()).catch(() => {});
    };

    (wc as any).on("console-message", onConsole);
    wc.on("did-navigate", onNav as any);
    wc.on("did-finish-load", onLoad);

    this.cleanups.set(wc.id, () => {
      (wc as any).removeListener("console-message", onConsole);
      wc.removeListener("did-navigate", onNav as any);
      wc.removeListener("did-finish-load", onLoad);
    });
  }

  /** Remove the recording UI overlay from a panel. */
  private removeRecorderUI(panelId: string): void {
    const wc = this.wcGetter?.(panelId);
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(`
      (function(){
        window.__yoRecActive=false;
        var el=document.getElementById('__yo-rec-indicator');
        if(el)el.remove();
        var st=document.getElementById('__yo-rec-style');
        if(st)st.remove();
      })()
    `).catch(() => {});
  }

  // ── Recording script ─────────────────────────────────

  private buildRecorderScript(): string {
    const nonce = JSON.stringify(this.nonce);
    return `
(function(){
if(window.__yoRecActive)return;
window.__yoRecActive=true;
var _n=${nonce};
var PREFIX='__YO_REC__';

function buildSel(el){
  if(!el||el===document.body||el===document.documentElement)return 'body';
  if(el.id)return '#'+CSS.escape(el.id);
  var tid=el.getAttribute('data-testid');
  if(tid)return '[data-testid="'+tid+'"]';
  var aria=el.getAttribute('aria-label');
  if(aria){
    var s=el.tagName.toLowerCase()+'[aria-label="'+aria.replace(/"/g,'\\\\"')+'"]';
    try{if(document.querySelectorAll(s).length===1)return s;}catch(e){}
  }
  var ph=el.getAttribute('placeholder');
  if(ph)return el.tagName.toLowerCase()+'[placeholder="'+ph.replace(/"/g,'\\\\"')+'"]';
  var parts=[];var cur=el;
  while(cur&&cur!==document.body&&parts.length<5){
    var tag=cur.tagName.toLowerCase();
    if(cur.id){parts.unshift('#'+CSS.escape(cur.id));break;}
    var seg=tag;
    if(cur.parentElement){
      var sibs=Array.from(cur.parentElement.children).filter(function(s){return s.tagName===cur.tagName;});
      if(sibs.length>1)seg+=':nth-of-type('+(sibs.indexOf(cur)+1)+')';
    }
    parts.unshift(seg);
    cur=cur.parentElement;
  }
  return parts.join(' > ');
}

function emit(data){
  if(!window.__yoRecActive)return;
  data._recNonce=_n;
  console.log(PREFIX+JSON.stringify(data));
}

// ── Click capture ────────────────────────────
document.addEventListener('click',function(e){
  if(!window.__yoRecActive)return;
  var el=e.target;
  if(!el||!el.tagName)return;
  if(el.closest&&el.closest('#__yo-rec-indicator'))return;
  var tag=el.tagName.toLowerCase();
  // Skip clicks on editable elements — input events handle those
  if(tag==='input'||tag==='textarea')return;
  if(el.getAttribute('contenteditable')==='true')return;
  if(el.getAttribute('role')==='textbox')return;
  // Walk up to find the actual interactive element (button wrapping an icon, etc.)
  var target=el;
  for(var i=0;i<4&&target.parentElement;i++){
    var pt=target.parentElement;
    var ptag=pt.tagName.toLowerCase();
    if(ptag==='button'||ptag==='a'||pt.getAttribute('role')==='button'){
      target=pt;break;
    }
    if(ptag==='body'||ptag==='main')break;
    target=pt;
  }
  // Reset to original if we walked too far
  if(target.tagName.toLowerCase()==='body')target=el;
  emit({
    type:'click',
    selector:buildSel(target),
    text:(target.innerText||target.textContent||'').trim().slice(0,100),
    tag:target.tagName.toLowerCase(),
    isClickable:true,
  });
},true);

// ── Input capture ────────────────────────────
var lastInEl=null;
var lastInVal='';
var inTimer=null;

function recInput(el,val){
  if(!val)return;
  emit({
    type:'input',
    selector:buildSel(el),
    text:val,
    tag:el.tagName.toLowerCase(),
    isEditable:true,
  });
}

document.addEventListener('input',function(e){
  if(!window.__yoRecActive)return;
  var el=e.target;if(!el)return;
  var tag=el.tagName.toLowerCase();
  if(tag!=='input'&&tag!=='textarea'&&
     el.getAttribute('contenteditable')!=='true'&&
     el.getAttribute('role')!=='textbox')return;
  lastInEl=el;
  lastInVal=tag==='input'||tag==='textarea'?el.value:(el.innerText||el.textContent||'');
  if(inTimer)clearTimeout(inTimer);
  inTimer=setTimeout(function(){
    if(lastInEl===el&&lastInVal){
      recInput(el,lastInVal);
      lastInVal='';
    }
  },2000);
},true);

document.addEventListener('focusout',function(){
  if(!window.__yoRecActive)return;
  if(lastInEl&&lastInVal){
    recInput(lastInEl,lastInVal);
    lastInVal='';lastInEl=null;
    if(inTimer){clearTimeout(inTimer);inTimer=null;}
  }
},true);

document.addEventListener('keydown',function(e){
  if(!window.__yoRecActive)return;
  if(e.key==='Enter'&&!e.shiftKey&&lastInEl&&lastInVal){
    recInput(lastInEl,lastInVal);
    lastInVal='';lastInEl=null;
    if(inTimer){clearTimeout(inTimer);inTimer=null;}
  }
},true);

// ── Recording indicator ──────────────────────
var ind=document.createElement('div');
ind.id='__yo-rec-indicator';
ind.style.cssText='position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483647;'+
  'background:rgba(255,50,50,0.9);color:#fff;font:500 11px -apple-system,system-ui,sans-serif;'+
  'padding:3px 12px;border-radius:12px;display:flex;align-items:center;gap:5px;'+
  'box-shadow:0 2px 8px rgba(255,0,0,0.3);pointer-events:none;user-select:none;'+
  'animation:__yoRecPulse 1.5s infinite;letter-spacing:0.3px;';
var dot=document.createElement('div');
dot.style.cssText='width:6px;height:6px;border-radius:50%;background:#fff;';
ind.appendChild(dot);
var lbl=document.createElement('span');
lbl.textContent='REC';
ind.appendChild(lbl);
var st=document.createElement('style');
st.id='__yo-rec-style';
st.textContent='@keyframes __yoRecPulse{0%,100%{opacity:1}50%{opacity:0.5}}';
document.head.appendChild(st);
document.body.appendChild(ind);
})();`;
  }

  // ── Refinement ────────────────────────────────────────

  /**
   * Convert raw recorded events into a draft Vibe definition.
   * Matches events against known app commands where possible.
   */
  refine(session: RecordingSession, name: string, description?: string): Vibe {
    const steps: VibeStep[] = [];
    let currentApp = session.panelSequence[0] || "unknown";

    // Deduplicate and clean events
    const cleaned = this.cleanEvents(session.events);

    for (const event of cleaned) {
      switch (event.type) {
        case "panel-switch":
          currentApp = event.panelId;
          break;

        case "click": {
          const cmd = this.matchCommand(currentApp, event.selector || "", event.text || "");
          steps.push({
            app: currentApp,
            command: cmd || "click",
            find: cmd ? undefined : (event.text || event.selector || undefined),
            describe: `Click "${event.text?.slice(0, 40) || event.tag || "element"}" on ${currentApp}`,
          });
          break;
        }

        case "input": {
          const cmd = this.matchInputCommand(currentApp, event.selector || "");
          steps.push({
            app: currentApp,
            command: cmd || "input",
            value: event.text || "",
            find: cmd ? undefined : (event.selector || undefined),
            describe: `Type in ${cmd || "input"} on ${currentApp}`,
          });
          break;
        }

        case "navigate": {
          steps.push({
            app: currentApp,
            command: "navigate",
            value: event.url || "",
            describe: `Navigate to ${event.url?.slice(0, 60) || "page"} on ${currentApp}`,
          });
          break;
        }
      }
    }

    // Add inter-step pauses based on timestamps
    this.addWaits(cleaned, steps);

    return {
      name,
      description: description || `Recorded vibe with ${steps.length} steps`,
      steps,
    };
  }

  /** Remove noise from recorded events. */
  private cleanEvents(events: RawRecordedEvent[]): RawRecordedEvent[] {
    const cleaned: RawRecordedEvent[] = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Skip panel-switch events that don't have subsequent actions on the new panel
      if (event.type === "panel-switch") {
        const hasFollowup = events.slice(i + 1).some((e) =>
          e.panelId === event.panelId && e.type !== "panel-switch",
        );
        if (!hasFollowup) continue;
      }

      // Skip duplicate input events on the same element (keep the last one)
      if (event.type === "input") {
        const nextSame = events.slice(i + 1).findIndex((e) =>
          e.type === "input" && e.selector === event.selector && e.panelId === event.panelId,
        );
        if (nextSame >= 0) continue; // a later input event on same element exists
      }

      // Skip click events immediately followed by input on the same selector
      // (click was just to focus the input)
      if (event.type === "click" && i + 1 < events.length) {
        const next = events[i + 1];
        if (next.type === "input" && next.panelId === event.panelId) {
          continue;
        }
      }

      cleaned.push(event);
    }

    return cleaned;
  }

  /** Add waitMs to steps where the user paused (>2s gap between events). */
  private addWaits(events: RawRecordedEvent[], steps: VibeStep[]): void {
    // Map cleaned events to steps (1:1 for non-panel-switch events)
    let stepIdx = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === "panel-switch") continue;
      if (stepIdx >= steps.length) break;

      // Check gap to next action event
      const nextActionIdx = events.slice(i + 1).findIndex((e) => e.type !== "panel-switch");
      if (nextActionIdx >= 0) {
        const gap = events[i + 1 + nextActionIdx].timestamp - events[i].timestamp;
        if (gap > 2000) {
          steps[stepIdx].waitMs = Math.min(gap, 10000);
        }
      }
      stepIdx++;
    }
  }

  /** Match a recorded click against known app commands by selector. */
  private matchCommand(appId: string, selector: string, text: string): string | null {
    if (!this.appConnector) return null;
    const app = this.appConnector.get(appId);
    if (!app) return null;

    // Exact selector match
    for (const [key, cmd] of Object.entries(app.commands)) {
      if (cmd.selector && selector && cmd.selector === selector) return key;
    }

    // Fuzzy selector match
    for (const [key, cmd] of Object.entries(app.commands)) {
      if (cmd.selector && selector && (
        selector.includes(cmd.selector) || cmd.selector.includes(selector)
      )) return key;
    }

    // Text-based matching for common actions
    const textLower = (text || "").toLowerCase();
    const textMatches: [RegExp, string[]][] = [
      [/send|submit/i, ["submit", "send"]],
      [/search|find/i, ["search"]],
      [/compose|new|create/i, ["new", "compose", "new-chat", "create-item"]],
      [/reply/i, ["reply"]],
      [/stop|cancel/i, ["stop"]],
    ];
    for (const [pattern, cmdKeys] of textMatches) {
      if (!pattern.test(textLower)) continue;
      for (const key of cmdKeys) {
        if (app.commands[key]) return key;
      }
    }

    return null;
  }

  /** Match a recorded input against known app input commands. */
  private matchInputCommand(appId: string, selector: string): string | null {
    if (!this.appConnector) return null;
    const app = this.appConnector.get(appId);
    if (!app) return null;

    // Check input-type commands
    const inputKeys = ["input", "search", "to-field", "subject-field", "body-field", "title-field"];
    for (const key of inputKeys) {
      const cmd = app.commands[key];
      if (!cmd) continue;
      if (cmd.selector && selector && (
        cmd.selector === selector || selector.includes(cmd.selector) || cmd.selector.includes(selector)
      )) return key;
    }

    // Check all setValue commands
    for (const [key, cmd] of Object.entries(app.commands)) {
      if (cmd.action !== "setValue") continue;
      if (cmd.selector && selector && (
        cmd.selector === selector || selector.includes(cmd.selector)
      )) return key;
    }

    return null;
  }
}
