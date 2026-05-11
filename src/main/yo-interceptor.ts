/**
 * YoInterceptor — intercepts yo/sup/dip/drip/council typed inside app panels.
 *
 *   yo <query>     → open agent panel
 *   yo . <skill>   → process last .sup capture with skill → inject result (requires capture)
 *   yo > <prompt>  → search capture history → process → inject result
 *   yo help        → open help overlay
 *   sup            → capture active panel → context store + clipboard
 *   sup . <skill>  → capture + process with skill → inject result
 *   dip <args>     → panel navigation (via command parser)
 *   drip <effect>  → visual effect
 *
 * All UI (notifications, tool picker) is injected directly into the
 * app's DOM via executeJavaScript.
 */

import { WebContents } from "electron";
import { AppConnector } from "./app-connector";
import { SkillEngine } from "./skill-engine";
import { SessionCache } from "./session-cache";
import { executeCommand } from "./dom-bridge";
import type { YoChat } from "./yo-chat";
import type { CaptureStore } from "./capture-store";

import crypto from "crypto";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  /** Per-session nonce — injected into pages and validated on receipt. */
  private readonly sessionNonce = crypto.randomBytes(16).toString("hex");
  private commandHandler: ((input: string, sourcePanelId?: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private getVisiblePanelIds: (() => string[]) | null = null;
  private opId = 0; // incremented per operation; cancel bumps it to invalidate in-flight results
  private sessionNotifier: (() => void) | null = null;

  // Yo conversation callbacks
  private yoClearer: (() => void) | null = null;
  private panelOpener: ((query: string, sourcePanelId?: string) => void) | null = null;
  private yoActiveWc: WebContents | null = null; // wc the current .yo conversation is in
  private modeColor = "#25C75E"; // current agent mode color (default=green, plan=blue, acceptEdits=orange)
  private agentMode = "default";
  private currentModel = "";
  private availableModels: string[] = [];
  private theme = "dark";
  private lastAgentResult: (() => string) | null = null;
  private captureStore: CaptureStore | null = null;
  private getFavicons: (() => Record<string, string>) | null = null;
  private getLayouts: (() => Array<{ name: string }>) | null = null;
  private getDripCustoms: (() => Array<{ name: string; recipe: string }>) | null = null;
  private modeChanger: ((mode: string) => void) | null = null;
  private modelChanger: ((model: string) => void) | null = null;
  private wazSpawner: ((prompt: string) => void) | null = null;

  constructor(
    private appConnector: AppConnector,
    private skillEngine: SkillEngine,
    private session: SessionCache,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  setCommandHandler(handler: (input: string, sourcePanelId?: string) => Promise<string>): void { this.commandHandler = handler; }
  setVisiblePanelsGetter(getter: () => string[]): void { this.getVisiblePanelIds = getter; }
  setSessionNotifier(fn: () => void): void { this.sessionNotifier = fn; }
  setYoClearer(fn: () => void): void { this.yoClearer = fn; }
  setPanelOpener(fn: (query: string, sourcePanelId?: string) => void): void { this.panelOpener = fn; }
  setFaviconsGetter(fn: () => Record<string, string>): void { this.getFavicons = fn; }
  setLayoutsGetter(fn: () => Array<{ name: string }>): void { this.getLayouts = fn; }
  setDripCustomsGetter(fn: () => Array<{ name: string; recipe: string }>): void { this.getDripCustoms = fn; }
  setLastAgentResult(fn: () => string): void { this.lastAgentResult = fn; }
  setModeChanger(fn: (mode: string) => void): void { this.modeChanger = fn; }
  setModelChanger(fn: (model: string) => void): void { this.modelChanger = fn; }
  setWazSpawner(fn: (prompt: string) => void): void { this.wazSpawner = fn; }
  setAvailableModels(models: string[]): void { this.availableModels = models; }
  setCurrentModel(model: string): void {
    this.currentModel = model;
    this.pushToAll(`if(window.__yoSetModel)window.__yoSetModel(${JSON.stringify(model)})`);
  }
  setModeColor(color: string): void { this.modeColor = color; }
  setAgentMode(mode: string): void {
    this.agentMode = mode;
    const colors: Record<string, string> = { default: "#25C75E", plan: "#4A9EFF", acceptEdits: "#FF8C00", bypassPermissions: "#FF2D55" };
    this.modeColor = colors[mode] || colors.default;
    this.pushToAll(`if(window.__yoSetMode)window.__yoSetMode(${JSON.stringify(mode)},${JSON.stringify(this.modeColor)})`);
  }
  private pushToAll(js: string): void {
    for (const [wcId] of this.active) {
      try {
        const { webContents } = require("electron");
        const wc = webContents.fromId(wcId);
        if (wc && !wc.isDestroyed()) wc.executeJavaScript(js).catch(() => {});
      } catch {}
    }
  }

  setTheme(theme: string): void {
    this.theme = theme;
    const escaped = JSON.stringify(theme);
    const js = `if(window.__yoSetTheme)window.__yoSetTheme(${escaped})`;
    for (const [wcId] of this.active) {
      try {
        const { webContents } = require("electron");
        const wc = webContents.fromId(wcId);
        if (wc && !wc.isDestroyed()) {
          wc.executeJavaScript(js).catch(() => {});
        }
      } catch {}
    }
  }
  getActiveYoWc(): WebContents | null { return this.yoActiveWc; }

  /** Inject only the command bar (tab + toggle + Cmd+Shift+.) into a panel
   *  that doesn't get the full interceptor (e.g. terminal panels). Also
   *  listens for console-message so bar commands get dispatched. */
  activateBarOnly(wc: WebContents, appId: string): void {
    const script = this.buildBarOnlyScript();
    const inject = () => {
      if (!wc.isDestroyed()) wc.executeJavaScript(script).catch(() => {});
    };
    const onConsole = (_e: any, _l: any, msg: string) => {
      if (typeof msg !== "string" || !msg.startsWith(PREFIX)) return;
      try {
        const data = JSON.parse(msg.slice(PREFIX.length));
        if (data._nonce !== this.sessionNonce) return;
        delete data._nonce;
        this.dispatch(wc, appId, data).catch((err) => {
          console.error("YoInterceptor bar-only dispatch error:", err);
        });
      } catch {}
    };
    wc.on("did-finish-load", inject);
    (wc as any).on("console-message", onConsole);
    if (!wc.isLoading()) inject();
    this.active.set(wc.id, () => {
      wc.removeListener("did-finish-load", inject);
      (wc as any).removeListener("console-message", onConsole);
    });
  }

  private buildBarOnlyScript(): string {
    const nonce = this.sessionNonce;
    return `(function(){
if(window.__yoBarActive)return;window.__yoBarActive=true;
var __yoThemes={dark:{'surface':'#111','surface2':'#1a1a1a','surface3':'#141414','border':'#1e1e1e','border2':'#2a2a2a','border3':'#333','text':'#e0e0e0','text-bright':'#fff','text2':'#ccc','text3':'#666','text-muted':'#555','text-faint':'#444','text-dim':'#333','accent':'#25C75E','accent-hover':'#2ed96a','hover':'#222','shadow':'rgba(0,0,0,0.7)','shadow-med':'rgba(0,0,0,0.5)','shadow-sm':'rgba(0,0,0,0.3)'},light:{'surface':'#fff','surface2':'#f5f5f5','surface3':'#f0f0f0','border':'#e5e5e5','border2':'#d4d4d4','border3':'#c4c4c4','text':'#374151','text-bright':'#111','text2':'#4b5563','text3':'#6b7280','text-muted':'#6b7280','text-faint':'#9ca3af','text-dim':'#b0b8c4','accent':'#25C75E','accent-hover':'#22b855','hover':'#e5e5e5','shadow':'rgba(0,0,0,0.18)','shadow-med':'rgba(0,0,0,0.12)','shadow-sm':'rgba(0,0,0,0.06)'}};
var __yoT=__yoThemes[${JSON.stringify(this.theme)}]||__yoThemes.dark;
(function(){var s=document.getElementById('__yo-theme-vars');if(!s){s=document.createElement('style');s.id='__yo-theme-vars';(document.head||document.documentElement).appendChild(s);}var css=':root{';for(var k in __yoT)css+='--yo-'+k+':'+__yoT[k]+';';css+='}';s.textContent=css;})();
window.__yoSetTheme=function(t){__yoT=__yoThemes[t]||__yoThemes.dark;var s=document.getElementById('__yo-theme-vars');if(s){var css=':root{';for(var k in __yoT)css+='--yo-'+k+':'+__yoT[k]+';';css+='}';s.textContent=css;}};
var _n=${JSON.stringify(nonce)};
var __yoTrust=null;
try{if(window.trustedTypes&&window.trustedTypes.createPolicy)__yoTrust=window.trustedTypes.createPolicy('yo-bar',{createHTML:function(s){return s;}});}catch(e){}
function safeInner(el,html){el.innerHTML=__yoTrust?__yoTrust.createHTML(html):html;}
var tab=null,bar=null,barInput=null,barMsg=null,barOpen=false,barWaiting=false,barErrorTimer=null;
function toggleBar(){createTab();if(barOpen){closeBar();}else{openBar();}}
function openBar(){createTab();if(!bar)createBar();barOpen=true;barWaiting=false;bar.style.borderColor='var(--yo-border2,rgba(255,255,255,0.12))';bar.style.transform='translateY(-50%) translateX(0)';bar.style.opacity='1';bar.style.pointerEvents='auto';barInput.value='';barInput.style.display='';barInput.disabled=false;barInput.style.opacity='1';if(barMsg)barMsg.style.display='none';if(barErrorTimer){clearTimeout(barErrorTimer);barErrorTimer=null;}setTimeout(function(){barInput.focus();},60);}
function closeBar(){barOpen=false;barWaiting=false;if(barErrorTimer){clearTimeout(barErrorTimer);barErrorTimer=null;}if(bar){bar.style.transform='translateY(-50%) translateX(100%)';bar.style.opacity='0';bar.style.pointerEvents='none';bar.style.borderColor='var(--yo-border2,rgba(255,255,255,0.12))';}if(barInput){barInput.value='';barInput.disabled=false;barInput.style.display='';barInput.style.opacity='1';}if(barMsg)barMsg.style.display='none';}
window.__yoBarResult=function(msg,isError){if(!barOpen)return;if(!isError){closeBar();return;}barWaiting=false;barInput.style.display='none';if(!barMsg){barMsg=document.createElement('span');barMsg.id='__yo-bar-msg';barMsg.style.cssText='flex:1;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';bar.appendChild(barMsg);}barMsg.textContent=msg;barMsg.style.display='';barMsg.style.color='#ff6b6b';bar.style.borderColor='#ff6b6b';barErrorTimer=setTimeout(function(){closeBar();},4000);};
function createBar(){if(bar)return;bar=document.createElement('div');bar.id='__yo-bar';bar.style.cssText='position:fixed;z-index:2147483647;right:0;top:50%;transform:translateY(-50%) translateX(100%);height:36px;width:280px;background:var(--yo-surface2,rgba(30,30,30,0.95));border:1px solid var(--yo-border2,rgba(255,255,255,0.12));border-right:none;border-radius:18px 0 0 18px;display:flex;align-items:center;padding:0 14px;box-shadow:-4px 0 20px var(--yo-shadow,rgba(0,0,0,0.4));backdrop-filter:blur(12px);opacity:0;pointer-events:none;transition:transform 0.2s ease,opacity 0.2s ease;';barInput=document.createElement('input');barInput.id='__yo-bar-input';barInput.type='text';barInput.placeholder='.dip .yo .drip';barInput.spellcheck=false;barInput.autocomplete='off';barInput.style.cssText='flex:1;background:transparent;border:none;outline:none;color:var(--yo-text,#e0e0e0);font-size:13px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';barInput.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();closeBar();return;}if(e.key==='Enter'){e.preventDefault();if(barWaiting)return;var cmd=barInput.value.trim();if(cmd){barWaiting=true;barInput.disabled=true;barInput.style.opacity='0.5';var instruction=cmd.replace(/^\\./, '');console.log('${PREFIX}'+JSON.stringify({type:'bar-command',instruction:instruction,_nonce:_n}));}return;}});barInput.addEventListener('blur',function(){setTimeout(function(){if(barOpen&&!barWaiting)closeBar();},150);});bar.appendChild(barInput);document.body.appendChild(bar);}
function createTab(){if(tab)return;tab=document.createElement('div');tab.id='__yo-tab';tab.style.cssText='position:fixed;z-index:2147483646;right:0;top:50%;transform:translateY(-50%);width:28px;height:56px;border-radius:28px 0 0 28px;background:var(--yo-surface2,rgba(30,30,30,0.9));border:1px solid var(--yo-border2,rgba(255,255,255,0.1));border-right:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s;box-shadow:-2px 0 12px var(--yo-shadow-sm,rgba(0,0,0,0.3));flex-direction:column;gap:1px;user-select:none;';safeInner(tab,'<span style="font-size:10px;font-weight:700;color:var(--yo-accent,#25C75E);font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1;">.Yo</span>');tab.addEventListener('mouseenter',function(){tab.style.background='var(--yo-hover,rgba(50,50,50,0.9))';tab.style.width='32px';});tab.addEventListener('mouseleave',function(){tab.style.background='var(--yo-surface2,rgba(30,30,30,0.9))';tab.style.width='28px';});tab.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();toggleBar();});document.body.appendChild(tab);}
document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key==='.'){e.preventDefault();e.stopPropagation();toggleBar();}},true);
})();`;
  }

  /** Start watching a panel's webContents for commands. */
  activate(wc: WebContents, appId: string): void {
    this.deactivate(wc.id);

    const inject = () => this.inject(wc);
    const onConsole = (_e: any, _l: any, msg: string) => {
      if (typeof msg !== "string" || !msg.startsWith(PREFIX)) return;
      try {
        const data = JSON.parse(msg.slice(PREFIX.length));
        // Validate session nonce — reject messages from page scripts that don't have it
        if (data._nonce !== this.sessionNonce) return;
        delete data._nonce; // strip before dispatch
        this.dispatch(wc, appId, data).catch((err) => {
          console.error("YoInterceptor dispatch error:", err);
          this.notify(wc, `Error: ${err instanceof Error ? err.message : err}`, "error").catch(() => {});
        });
      } catch { /* ignore malformed JSON */ }
    };
    const onFrameLoad = (_e: any, isMainFrame: boolean) => {
      if (isMainFrame) return;
      this.injectFrames(wc);
    };

    wc.on("did-finish-load", inject);
    wc.on("did-frame-finish-load", onFrameLoad);
    (wc as any).on("console-message", onConsole);
    if (!wc.isLoading()) inject();

    this.active.set(wc.id, () => {
      wc.removeListener("did-finish-load", inject);
      wc.removeListener("did-frame-finish-load", onFrameLoad);
      (wc as any).removeListener("console-message", onConsole);
    });
  }

  deactivate(wcId: number): void {
    this.active.get(wcId)?.();
    this.active.delete(wcId);
  }

  // ── Injection ──────────────────────────────────────────

  private async inject(wc: WebContents): Promise<void> {
    const script = this.buildScript();
    try { await wc.executeJavaScript(script); } catch {}
    this.injectFrames(wc);
  }

  private injectFrames(wc: WebContents): void {
    const script = this.buildScript();
    try {
      for (const frame of wc.mainFrame.framesInSubtree) {
        if (frame === wc.mainFrame) continue;
        frame.executeJavaScript(script).catch(() => {});
      }
    } catch {}
  }

  private buildScript(): string {
    const nonce = this.sessionNonce;
    return `
(function(){
if(window.__yoActive)return;window.__yoActive=true;
var __yoThemes={dark:{'surface':'#111','surface2':'#1a1a1a','surface3':'#141414','border':'#1e1e1e','border2':'#2a2a2a','border3':'#333','text':'#e0e0e0','text-bright':'#fff','text2':'#ccc','text3':'#666','text-muted':'#555','text-faint':'#444','text-dim':'#333','accent':'#25C75E','accent-hover':'#2ed96a','hover':'#222','shadow':'rgba(0,0,0,0.7)','shadow-med':'rgba(0,0,0,0.5)','shadow-sm':'rgba(0,0,0,0.3)'},light:{'surface':'#fff','surface2':'#f5f5f5','surface3':'#f0f0f0','border':'#e5e5e5','border2':'#d4d4d4','border3':'#c4c4c4','text':'#374151','text-bright':'#111','text2':'#4b5563','text3':'#6b7280','text-muted':'#6b7280','text-faint':'#9ca3af','text-dim':'#b0b8c4','accent':'#25C75E','accent-hover':'#22b855','hover':'#e5e5e5','shadow':'rgba(0,0,0,0.18)','shadow-med':'rgba(0,0,0,0.12)','shadow-sm':'rgba(0,0,0,0.06)'}};
var __yoT=__yoThemes[${JSON.stringify(this.theme)}]||__yoThemes.dark;
(function(){var s=document.getElementById('__yo-theme-vars');if(!s){s=document.createElement('style');s.id='__yo-theme-vars';(document.head||document.documentElement).appendChild(s);}var css=':root{';for(var k in __yoT)css+='--yo-'+k+':'+__yoT[k]+';';css+='}';s.textContent=css;})();
window.__yoSetTheme=function(t){__yoT=__yoThemes[t]||__yoThemes.dark;var s=document.getElementById('__yo-theme-vars');if(s){var css=':root{';for(var k in __yoT)css+='--yo-'+k+':'+__yoT[k]+';';css+='}';s.textContent=css;}};
var _n=${JSON.stringify(nonce)};
var CMD_RE=/^\\.(yo|sup|dip|drip|peace|council|waz)(?:\\s+([\\s\\S]+))?$/i;
var lastText='';
var handled=false;
var firing=false;

window.__yoLastEl=null;
window.__yoInject=function(text){
  var el=window.__yoLastEl;if(!el)return;
  el.focus();
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
    var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var s=Object.getOwnPropertyDescriptor(p,'value');
    if(s&&s.set)s.set.call(el,text);else el.value=text;
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    var sel=window.getSelection();var range=document.createRange();
    range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
    document.execCommand('insertText',false,text);
  }
};

function ed(){
  var a=document.activeElement;if(!a||a===document.body)a=null;
  while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;
  if(a&&a.id&&a.id.startsWith('__yo'))return null;
  if(a){
    if(a.tagName==='INPUT'||a.tagName==='TEXTAREA')return a;
    if(a.isContentEditable)return a;
    if(a.getAttribute&&a.getAttribute('role')==='textbox')return a;
    var c=a.closest&&a.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
    if(c)return c;
  }
  var fb=['[role="textbox"]','[contenteditable]:not([contenteditable="false"])'];
  for(var i=0;i<fb.length;i++){try{var els=document.querySelectorAll(fb[i]);
    for(var j=0;j<els.length;j++){var r=els[j].getBoundingClientRect();
      if(r.width>0&&r.height>0)return els[j];}}catch(e){}}
  return null;
}
function tx(el){
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA')return el.value||'';
  return el.innerText||el.textContent||'';
}
function fire(text,srcEl){
  if(handled||firing)return;handled=true;firing=true;
  var m=text.match(CMD_RE);if(!m){firing=false;return;}
  var cmd=m[1].toLowerCase();
  var arg=(m[2]||'').trim()||null;
  window.__yoLastEl=srcEl||ed();
  console.log('${PREFIX}'+JSON.stringify({type:cmd,instruction:arg,_nonce:_n}));
  setTimeout(function(){firing=false;},500);
}

document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||e.shiftKey||firing)return;
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  if(!CMD_RE.test(t))return;
  handled=false;
  e.preventDefault();e.stopImmediatePropagation();e.stopPropagation();
  var srcEl=el;
  // Clear input immediately so the app never sees the command text
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
    var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var s=Object.getOwnPropertyDescriptor(p,'value');
    if(s&&s.set)s.set.call(el,'');else el.value='';
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    el.focus();
    var sel=window.getSelection();var range=document.createRange();
    range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
    document.execCommand('delete',false);
  }
  // Fire after clearing — prevents any async app handlers from seeing the text
  setTimeout(function(){fire(t,srcEl);},0);
},true);

var lastEl=null;
document.addEventListener('input',function(){
  if(firing)return;
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  if(CMD_RE.test(t)){lastText=t;lastEl=el;handled=false;}
  else if(lastText&&t.length===0){
    var saved=lastText;var sEl=lastEl;lastText='';lastEl=null;
    fire(saved,sEl);
  }else if(!CMD_RE.test(t)){lastText='';lastEl=null;}
},true);

document.addEventListener('keyup',function(e){
  if(e.key!=='Enter'||firing)return;
  if(lastText&&!handled){var saved=lastText;var sEl=lastEl;lastText='';lastEl=null;fire(saved,sEl);}
},true);

// Block form submission when a command is being fired (fixes Google, etc.)
document.addEventListener('submit',function(e){
  if(!firing)return;
  e.preventDefault();e.stopImmediatePropagation();e.stopPropagation();
},true);
// Also block via beforeunload during firing — last resort for sites that navigate
window.addEventListener('beforeunload',function(e){
  if(!firing)return;
  e.preventDefault();
},true);

// ── .Yo tab + command bar (inline in panel) ────────────────────────
(function(){
var __yoTrust=null;
try{if(window.trustedTypes&&window.trustedTypes.createPolicy)__yoTrust=window.trustedTypes.createPolicy('yo-overlay',{createHTML:function(s){return s;}});}catch(e){}
function safeInner(el,html){el.innerHTML=__yoTrust?__yoTrust.createHTML(html):html;}
var tab=null;
var bar=null;
var barInput=null;
var barMsg=null;
var barOpen=false;
var barWaiting=false;
var barErrorTimer=null;
var currentEl=null;

window.__yoSetMode=function(){};
window.__yoSetModel=function(){};

function toggleBar(){
  createTab();
  if(barOpen){closeBar();}else{openBar();}
}
function openBar(){
  createTab();
  if(!bar)createBar();
  barOpen=true;
  barWaiting=false;
  bar.style.borderColor='var(--yo-border2,rgba(255,255,255,0.12))';
  bar.style.transform='translateY(-50%) translateX(0)';
  bar.style.opacity='1';
  bar.style.pointerEvents='auto';
  barInput.value='';
  barInput.style.display='';
  barInput.disabled=false;
  if(barMsg)barMsg.style.display='none';
  if(barErrorTimer){clearTimeout(barErrorTimer);barErrorTimer=null;}
  setTimeout(function(){barInput.focus();},60);
}
function closeBar(){
  barOpen=false;
  barWaiting=false;
  if(barErrorTimer){clearTimeout(barErrorTimer);barErrorTimer=null;}
  if(bar){bar.style.transform='translateY(-50%) translateX(100%)';bar.style.opacity='0';bar.style.pointerEvents='none';bar.style.borderColor='var(--yo-border2,rgba(255,255,255,0.12))';}
  if(barInput){barInput.value='';barInput.disabled=false;barInput.style.display='';}
  if(barMsg)barMsg.style.display='none';
}
window.__yoBarResult=function(msg,isError){
  if(!barOpen)return;
  if(!isError){closeBar();return;}
  barWaiting=false;
  barInput.style.display='none';
  if(!barMsg){barMsg=document.createElement('span');barMsg.id='__yo-bar-msg';barMsg.style.cssText='flex:1;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';bar.appendChild(barMsg);}
  barMsg.textContent=msg;
  barMsg.style.display='';
  barMsg.style.color='#ff6b6b';
  bar.style.borderColor='#ff6b6b';
  barErrorTimer=setTimeout(function(){closeBar();},4000);
};
function createBar(){
  if(bar)return;
  bar=document.createElement('div');
  bar.id='__yo-bar';
  bar.style.cssText='position:fixed;z-index:2147483647;right:0;top:50%;transform:translateY(-50%) translateX(100%);height:36px;width:280px;background:var(--yo-surface2,rgba(30,30,30,0.95));border:1px solid var(--yo-border2,rgba(255,255,255,0.12));border-right:none;border-radius:18px 0 0 18px;display:flex;align-items:center;padding:0 14px;box-shadow:-4px 0 20px var(--yo-shadow,rgba(0,0,0,0.4));backdrop-filter:blur(12px);opacity:0;pointer-events:none;transition:transform 0.2s ease,opacity 0.2s ease;';
  barInput=document.createElement('input');
  barInput.id='__yo-bar-input';
  barInput.type='text';
  barInput.placeholder='.dip .yo .drip';
  barInput.spellcheck=false;
  barInput.autocomplete='off';
  barInput.style.cssText='flex:1;background:transparent;border:none;outline:none;color:var(--yo-text,#e0e0e0);font-size:13px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
  barInput.addEventListener('keydown',function(e){
    if(e.key==='Escape'){e.stopPropagation();closeBar();return;}
    if(e.key==='Enter'){
      e.preventDefault();
      if(barWaiting)return;
      var cmd=barInput.value.trim();
      if(cmd){
        barWaiting=true;
        barInput.disabled=true;
        barInput.style.opacity='0.5';
        window.__yoLastEl=currentEl;
        var instruction=cmd.replace(/^\./,'');
        console.log('${PREFIX}'+JSON.stringify({type:'bar-command',instruction:instruction,_nonce:_n}));
      }
      return;
    }
  });
  barInput.addEventListener('blur',function(){setTimeout(function(){if(barOpen&&!barWaiting)closeBar();},150);});
  bar.appendChild(barInput);
  document.body.appendChild(bar);
}

// ── Half-moon tab on right edge ──
function createTab(){
  if(tab)return;
  tab=document.createElement('div');
  tab.id='__yo-tab';
  tab.style.cssText='position:fixed;z-index:2147483646;right:0;top:50%;transform:translateY(-50%);width:28px;height:56px;border-radius:28px 0 0 28px;background:var(--yo-surface2,rgba(30,30,30,0.9));border:1px solid var(--yo-border2,rgba(255,255,255,0.1));border-right:none;display:none;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s;box-shadow:-2px 0 12px var(--yo-shadow-sm,rgba(0,0,0,0.3));flex-direction:column;gap:1px;user-select:none;';
  safeInner(tab,'<span style="font-size:10px;font-weight:700;color:var(--yo-accent,#25C75E);font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1;">.Yo</span>');
  tab.addEventListener('mouseenter',function(){tab.style.background='var(--yo-hover,rgba(50,50,50,0.9))';tab.style.width='32px';});
  tab.addEventListener('mouseleave',function(){tab.style.background='var(--yo-surface2,rgba(30,30,30,0.9))';tab.style.width='28px';});
  tab.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();toggleBar();});
  document.body.appendChild(tab);
}

function showTab(){createTab();tab.style.display='flex';}
function hideTab(){if(tab)tab.style.display='none';if(barOpen)closeBar();}

// ── Track focused inputs → show tab ──
function isInputEl(el){
  if(!el||!el.getBoundingClientRect)return false;
  if(el.id&&el.id.startsWith('__yo'))return false;
  var tag=el.tagName;
  if(tag==='INPUT'){var t=el.type||'text';return['text','search','email','url',''].indexOf(t)!==-1;}
  if(tag==='TEXTAREA')return true;
  if(el.isContentEditable)return true;
  var role=el.getAttribute&&el.getAttribute('role');
  if(role==='textbox')return true;
  var ce=el.getAttribute&&el.getAttribute('contenteditable');
  if(ce&&ce!=='false')return true;
  return false;
}

var focusTimer=null;
document.addEventListener('focusin',function(e){
  if(isInputEl(e.target)){clearTimeout(focusTimer);currentEl=e.target;showTab();}
},true);
document.addEventListener('focusout',function(){
  clearTimeout(focusTimer);
  focusTimer=setTimeout(function(){
    var a=document.activeElement;
    if(a&&a.id&&a.id.startsWith('__yo'))return;
    if(tab&&tab.contains(a))return;
    if(bar&&bar.contains(a))return;
    hideTab();
    currentEl=null;
  },250);
},true);

// Initial focus check
setTimeout(function(){
  var a=document.activeElement;
  if(isInputEl(a)){currentEl=a;showTab();}
},500);

// Right-edge hover → show tab after 200ms
var hoverTimer=null;
document.addEventListener('mousemove',function(e){
  if(e.clientX>=window.innerWidth-8){
    if(!hoverTimer&&!barOpen){hoverTimer=setTimeout(function(){showTab();hoverTimer=null;},200);}
  }else{
    if(hoverTimer){clearTimeout(hoverTimer);hoverTimer=null;}
  }
});

// Click anywhere non-input → hide tab
document.addEventListener('mousedown',function(e){
  if(!tab||tab.style.display!=='flex')return;
  if(barOpen)return;
  if(isInputEl(e.target))return;
  if(tab.contains(e.target))return;
  if(bar&&bar.contains(e.target))return;
  hideTab();currentEl=null;
});

// Cmd+Shift+. — toggle command bar
document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key==='.'){
    e.preventDefault();e.stopPropagation();
    toggleBar();
  }
},true);
})();

})();`;
  }

  // ── Dispatch ───────────────────────────────────────────

  private async dispatch(
    wc: WebContents,
    appId: string,
    data: { type: string; instruction?: string | null },
  ): Promise<void> {
    switch (data.type) {
      case "yo":
        await this.handleYo(wc, appId, data.instruction ?? undefined);
        break;
      case "sup":
        await this.handleSup(wc, appId, data.instruction ?? undefined);
        break;
      case "dip":
        await this.handleDip(wc, appId, data.instruction ?? undefined);
        break;
      case "drip":
        // Delegate to command parser which sends drip-effect to renderer
        if (this.commandHandler) {
          const cmd = data.instruction ? `drip ${data.instruction}` : "drip";
          await this.commandHandler(cmd);
        }
        break;
      case "peace":
        if (this.commandHandler) {
          const cmd = data.instruction ? `peace ${data.instruction}` : "peace";
          await this.commandHandler(cmd);
        }
        break;
      case "waz":
        if (this.wazSpawner) {
          this.wazSpawner(data.instruction || "");
          this.notify(wc, ".waz spawned", "success");
        }
        break;
      case "yo-toggle-panel":
        if (this.panelOpener) this.panelOpener("", appId);
        break;
      case "bar-command":
        if (this.commandHandler && data.instruction) {
          console.log("[bar-command]", data.instruction);
          let barResult: string;
          let barIsError = false;
          try {
            barResult = await this.commandHandler(data.instruction);
            barIsError = /not running|not found|not available|failed|error|unknown command/i.test(barResult);
          } catch (err) {
            barResult = err instanceof Error ? err.message : String(err);
            barIsError = true;
          }
          console.log("[bar-command] result:", barResult, "isError:", barIsError);
          if (barResult) {
            const escaped = JSON.stringify(barResult);
            wc.executeJavaScript(`if(window.__yoBarResult)window.__yoBarResult(${escaped},${barIsError})`).catch(() => {});
          }
          if (this.sessionNotifier) this.sessionNotifier();
        }
        break;
      case "set-mode":
        if (data.instruction && this.modeChanger) this.modeChanger(data.instruction);
        break;
      case "set-model":
        if (data.instruction && this.modelChanger) this.modelChanger(data.instruction);
        break;
      case "cancel":
        this.opId++;
        await this.clearNotify(wc);
        this.notify(wc, "cancelled", "success");
        break;
    }
  }

  // ── dip ───────────────────────────────────────────────

  private async handleDip(wc: WebContents, sourcePanelId: string, args?: string): Promise<void> {
    const cmd = args ? `dip ${args}` : "dip back";
    if (this.commandHandler) {
      const result = await this.commandHandler(cmd, sourcePanelId);
      if (result) this.notify(wc, result, "success");
    }
  }

  // ── sup: capture screen ────────────────────────────────

  private async handleSup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    if (!this.commandHandler) return;

    // Bare .sup → just capture
    if (!instruction?.trim()) {
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      const content = await this.grabPanels(wc, appId, false);
      if (this.opId !== myOp) return;
      if (!content) {
        this.notify(wc, "Could not grab content.", "error");
        return;
      }
      await this.commandHandler("sup", appId);
      await this.clearNotify(wc);
      this.notify(wc, "captured", "success");
      return;
    }

    // .sup .. → capture last agent result
    if (instruction.trim() === "..") {
      const result = this.lastAgentResult?.();
      if (!result) {
        this.notify(wc, "No agent result yet. Use .yo first.", "error");
        return;
      }
      const ts = this.timestamp();
      this.session.capture("yo-agent", result, `agent ${ts}`, `agent-${ts}`);
      this.session.copyToClipboard();
      this.sessionNotifier?.();
      this.notify(wc, "agent result captured", "success");
      return;
    }

    // .sup . or .sup . <skill/prompt> → capture + optional process
    const dotMatch = instruction.match(/^\.\s*(.*)$/);
    if (dotMatch) {
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      const content = await this.grabPanels(wc, appId, false);
      if (this.opId !== myOp) return;
      if (!content) {
        this.notify(wc, "Could not grab content.", "error");
        return;
      }

      const [skill, chain] = YoInterceptor.splitChain(dotMatch[1]?.trim() || "");
      if (!skill) {
        // Bare .sup . → just capture
        await this.commandHandler("sup", appId);
        await this.clearNotify(wc);
        this.notify(wc, "captured", "success");
        await this.runChain(chain);
        return;
      }

      // .sup . <skill/prompt> → capture + process (result stored in session)
      try {
        await this.commandHandler(`sup . ${skill}`, appId);
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        this.notify(wc, "captured + processed", "success");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      await this.runChain(chain);
      return;
    }

    // Check if chaining: .sup .dip gmail — instruction starts with a command keyword
    const isChain = instruction.split(/\s+/)[0]?.toLowerCase();
    if (isChain && YoInterceptor.COMMAND_KEYWORDS.has(`.${isChain}`)) {
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      const content = await this.grabPanels(wc, appId, false);
      if (this.opId !== myOp) return;
      if (!content) {
        this.notify(wc, "Could not grab content.", "error");
        return;
      }
      // Capture first, then run the chained command
      await this.commandHandler("sup", appId);
      const ts = this.timestamp();
      this.session.capture(appId, content, `${ts}.md`, ts);
      this.session.copyToClipboard();
      this.sessionNotifier?.();
      await this.clearNotify(wc);
      this.notify(wc, "sup — captured", "success");
      const chainResult = await this.commandHandler(instruction);
      if (this.opId !== myOp) return;
      if (chainResult) this.notify(wc, chainResult, "success");
      return;
    }

    // Anything else: bare capture (ignore unrecognized args)
    const myOp = ++this.opId;
    this.notify(wc, "", "loading");
    await this.commandHandler("sup", appId);
    if (this.opId !== myOp) return;
    await this.clearNotify(wc);
    this.notify(wc, "captured", "success");
  }

  private static readonly COMMAND_KEYWORDS = new Set([".dip", ".drip"]);

  /**
   * Split off chained commands (.dip, .drip) from the end of an instruction.
   * Returns [ownArgs, chainedRemainder].
   * e.g. "summarize .dip grok .drip =" → ["summarize", ".dip grok .drip ="]
   */
  private static splitChain(instruction: string): [string, string] {
    const chainRe = /\s+(\.(dip|drip)\b.*)$/i;
    const m = instruction.match(chainRe);
    if (!m) return [instruction, ""];
    return [instruction.slice(0, m.index!).trim(), m[1].trim()];
  }

  /** Execute any chained commands via the command handler. */
  private async runChain(chain: string): Promise<void> {
    if (chain && this.commandHandler) {
      await this.commandHandler(chain);
    }
  }

  // ── yo ─────────────────────────────────────────────────

  private async handleYo(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    const raw = instruction?.trim() || "";

    // .yo . or .yo . <prompt> → inject/process last .sup capture
    const dotMatch = raw.match(/^\.\s*(.*)$/s);
    if (dotMatch !== null && raw.startsWith(".")) {
      const [prompt, chain] = YoInterceptor.splitChain(dotMatch[1]?.trim() || "");
      if (!prompt) {
        // Bare .yo . → inject last capture directly, no LLM
        const content = this.session.get();
        if (!content) {
          this.notify(wc, "Nothing captured. Use .sup first.", "error");
          return;
        }
        try {
          await wc.executeJavaScript(
            `(function(){if(window.__yoInject){window.__yoInject(${JSON.stringify(content)});}})()`,
          );
        } catch {}
        await this.runChain(chain);
        return;
      }
      if (!this.session.hasContent()) {
        this.notify(wc, "Nothing captured. Use .sup first.", "error");
        return;
      }
      await this.handleYoDot(wc, appId, prompt);
      await this.runChain(chain);
      return;
    }

    // .yo > <prompt> → search capture history, inject result into current panel
    const pullMatch = raw.match(/^>\s*(.+)$/s);
    if (pullMatch) {
      const prompt = pullMatch[1].trim();
      await this.handleYoPull(wc, appId, prompt);
      return;
    }

    // Regular .yo → open the agent side panel
    this.yoActiveWc = wc;
    if (this.panelOpener) {
      this.panelOpener(raw, appId);
    }
  }

  /**
   * .yo . <prompt> — lightweight inline processing.
   * Takes the last .sup capture from session, sends a single LLM call
   * with the user's prompt, and injects the result directly into the
   * current text area. No agent panel, no tools, no streaming.
   */
  private async handleYoDot(wc: WebContents, _appId: string, prompt: string): Promise<void> {
    if (!this.yoChat) {
      this.notify(wc, "Agent not ready.", "error");
      return;
    }

    const context = this.session.get();
    if (!context) {
      this.notify(wc, "Nothing captured. Use .sup first.", "error");
      return;
    }

    const myOp = ++this.opId;
    this.notify(wc, "", "loading");

    try {
      const result = await this.yoChat.executeProcess(prompt, context);
      if (this.opId !== myOp) return; // cancelled
      await this.clearNotify(wc);

      // Inject the result directly into the text area
      try {
        await wc.executeJavaScript(
          `(function(){if(window.__yoInject){window.__yoInject(${JSON.stringify(result)});}})()`,
        );
      } catch {}
    } catch (err) {
      if (this.opId !== myOp) return;
      await this.clearNotify(wc);
      this.notify(wc, `Failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  /**
   * .yo > <prompt> — search capture history + inject result.
   * Searches the capture store, passes results to LLM with the user's prompt,
   * injects the processed result into the current text area.
   */
  private async handleYoPull(wc: WebContents, _appId: string, prompt: string): Promise<void> {
    if (!this.captureStore) {
      this.notify(wc, "Capture store not available.", "error");
      return;
    }
    if (!this.yoChat) {
      this.notify(wc, "Agent not ready.", "error");
      return;
    }

    const myOp = ++this.opId;
    this.notify(wc, "", "loading");

    try {
      // Search captures for relevant content
      const results = await this.captureStore.search(prompt, 5);
      if (!results || results.length === 0) {
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        this.notify(wc, "No matching captures found.", "error");
        return;
      }

      // Build context from search results
      const context = results
        .map((r, i) =>
          `[${i + 1}] (score: ${r.score.toFixed(2)}, source: ${r.meta.source})\n${r.content}`)
        .join("\n\n---\n\n");

      // Check if prompt is a skill name
      const matchedSkill = /^\S+$/.test(prompt)
        ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === prompt.toLowerCase())
        : undefined;

      let finalResult: string;
      if (matchedSkill) {
        try {
          finalResult = await this.skillEngine.process(context, matchedSkill);
        } catch (err) {
          finalResult = `Skill error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        finalResult = await this.yoChat.executeProcess(prompt, context);
      }

      if (this.opId !== myOp) return;
      await this.clearNotify(wc);

      // Inject the result directly into the text area
      try {
        await wc.executeJavaScript(
          `(function(){if(window.__yoInject){window.__yoInject(${JSON.stringify(finalResult)});}})()`,
        );
      } catch {}
    } catch (err) {
      if (this.opId !== myOp) return;
      await this.clearNotify(wc);
      this.notify(wc, `Failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  private timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  }

  // ── Content grabbing ──────────────────────────────────

  /** Grab content from visible panels (all or current only). */
  private async grabPanels(wc: WebContents, appId: string, allPanels: boolean): Promise<string | null> {
    if (!allPanels) {
      const app = this.appConnector.get(appId);
      return this.grabContent(wc, app, appId);
    }

    const panelIds = this.getVisiblePanelIds?.() ?? [appId];
    if (panelIds.length <= 1) {
      const app = this.appConnector.get(appId);
      return this.grabContent(wc, app, appId);
    }

    const sections: string[] = [];
    for (const id of panelIds) {
      const app = this.appConnector.get(id);
      let content: string | null;
      if (id === appId) {
        content = await this.grabContent(wc, app, id);
      } else {
        const otherWc = this.getWebContentsForPanel(id);
        if (!otherWc) continue;
        content = await this.grabContent(otherWc, app, id);
      }
      if (content) {
        sections.push(`## ${app?.name || id}\n\n${content}`);
      }
    }

    return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
  }

  private getWebContentsForPanel(panelId: string): WebContents | null {
    for (const [wcId] of this.active) {
      try {
        const { webContents } = require("electron");
        const wc = webContents.fromId(wcId);
        if (wc && !wc.isDestroyed()) {
          const app = this.appConnector.get(panelId);
          if (app?.url && wc.getURL().includes(new URL(app.url).hostname)) {
            return wc;
          }
        }
      } catch {}
    }
    return null;
  }

  private async grabContent(
    wc: WebContents,
    app: ReturnType<AppConnector["get"]>,
    appId?: string,
  ): Promise<string | null> {
    let content = "";
    if (app?.commands.grab) {
      content = await executeCommand(wc, app.commands.grab);
    }
    // Fall back to body text if app-specific grab returned nothing useful
    if (!content || content.startsWith("[Element not found")) {
      content = await wc.executeJavaScript("document.body.innerText.slice(0, 200000)");
    }
    if (!content) return null;

    // Raw body text → capture store for search indexing
    if (appId) {
      try {
        const raw = await wc.executeJavaScript("document.body.innerText.slice(0, 200000)");
        if (raw) {
          const title = await wc.executeJavaScript("document.title");
          this.session.rawCapture(appId, `PAGE: ${title}\nURL: ${wc.getURL()}\n\n${raw}`);
        }
      } catch {}
    }

    return content;
  }

  // ── Yo widget injection ────────────────────────────────

  private async injectYoWidget(wc: WebContents, query: string): Promise<void> {
    const escaped = JSON.stringify(query);
    const nonceJs = JSON.stringify(this.sessionNonce);
    try {
      await wc.executeJavaScript(`
(function(){
var _n=${nonceJs};
// Shadow DOM host — isolates widget from site CSS
var oldHost=document.getElementById('__yo-widget-host');if(oldHost)oldHost.remove();
var host=document.createElement('div');host.id='__yo-widget-host';
host.style.cssText='position:fixed !important;z-index:2147483647 !important;bottom:60px !important;right:16px !important;width:380px !important;max-height:700px !important;pointer-events:auto !important;';
document.documentElement.appendChild(host);
var w=document.createElement('div');w.id='__yo-widget';
w.style.cssText='width:100%;max-height:700px;background:var(--yo-surface2);border:1px solid var(--yo-border3);border-radius:12px;box-shadow:0 8px 32px var(--yo-shadow-med);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:13px;color:var(--yo-text2);overflow:hidden;line-height:normal;box-sizing:border-box;';

// Header
var hdr=document.createElement('div');
hdr.style.cssText='padding:10px 14px;border-bottom:1px solid var(--yo-border3);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
var title=document.createElement('span');title.style.cssText='color:var(--yo-accent);font-weight:600;font-size:12px;';
title.textContent=${escaped}?'.yo '+${escaped}:'.yo';
var closeBtn=document.createElement('div');closeBtn.textContent='\\u00d7';
closeBtn.style.cssText='width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--yo-text3);font-size:16px;border-radius:4px;';
closeBtn.onmouseenter=function(){closeBtn.style.color='var(--yo-text-bright)';closeBtn.style.background='var(--yo-border3)';};
closeBtn.onmouseleave=function(){closeBtn.style.color='var(--yo-text3)';closeBtn.style.background='none';};
closeBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss',_nonce:_n}));};
hdr.appendChild(title);hdr.appendChild(closeBtn);

// Body (results + messages)
var body=document.createElement('div');body.id='__yo-widget-body';
body.style.cssText='flex:1;overflow-y:auto;padding:8px 14px;min-height:120px;max-height:540px;';
// Show animated spinner when query provided, empty state otherwise
if(${escaped}){
  var loading=document.createElement('div');loading.id='__yo-widget-thinking';
  loading.style.cssText='color:var(--yo-text3);font-size:12px;padding:12px 0;';
  var frames=['\\u280B','\\u2819','\\u2839','\\u2838','\\u283C','\\u2834','\\u2826','\\u2827'];
  var words=['chilling...','vibing...','yozing...','cooking...','thinking...','brewing...','manifesting...','marinating...'];
  var fi=0;var curWord=words[Math.floor(Math.random()*words.length)];
  loading.textContent=frames[0]+' '+curWord;
  var tid=setInterval(function(){fi=(fi+1)%frames.length;loading.textContent=frames[fi]+' '+curWord;},120);
  loading.__tid=tid;
  body.appendChild(loading);
}else{
  var empty=document.createElement('div');empty.style.cssText='color:var(--yo-text-muted);font-size:12px;padding:20px 0;text-align:center;';
  empty.textContent='search your memory';body.appendChild(empty);
}

// Input area with textarea + send button
var inputWrap=document.createElement('div');
inputWrap.style.cssText='padding:8px 10px;border-top:1px solid var(--yo-border3);flex-shrink:0;';
var inputRow=document.createElement('div');
inputRow.style.cssText='display:flex;align-items:flex-end;gap:6px;background:var(--yo-surface);border:1px solid var(--yo-border3);border-radius:8px;padding:6px 8px;transition:border-color 0.15s;';
var input=document.createElement('textarea');input.id='__yo-widget-input';input.rows=1;
input.placeholder=${escaped}?'ask about results...':'search your memory...';
input.style.cssText='flex:1;background:none;border:none;color:var(--yo-text2);font-size:12px;outline:none;resize:none;font-family:inherit;line-height:1.4;max-height:72px;overflow-y:auto;padding:0;margin:0;';
var sendBtn=document.createElement('div');sendBtn.id='__yo-widget-send';
sendBtn.textContent='\\u2191';
sendBtn.style.cssText='width:22px;height:22px;border-radius:6px;background:var(--yo-accent);color:#000;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:opacity 0.15s;opacity:0.4;';
function updateSend(){sendBtn.style.opacity=input.value.trim()?'1':'0.4';}
function doSend(){
  var msg=input.value.trim();if(!msg)return;
  input.value='';input.style.height='auto';updateSend();
  console.log('${PREFIX}'+JSON.stringify({type:'yo-refine',text:msg,_nonce:_n}));
}
sendBtn.onclick=function(e){e.preventDefault();doSend();input.focus();};
input.addEventListener('input',function(){
  input.style.height='auto';input.style.height=Math.min(input.scrollHeight,72)+'px';
  updateSend();
});
input.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey&&input.value.trim()){
    e.preventDefault();e.stopPropagation();doSend();
  }
  if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation();
    console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss',_nonce:_n}));
  }
},true);
input.onfocus=function(){inputRow.style.borderColor='var(--yo-accent)';};
input.onblur=function(){inputRow.style.borderColor='var(--yo-border3)';};
inputRow.appendChild(input);inputRow.appendChild(sendBtn);
inputWrap.appendChild(inputRow);
w.appendChild(hdr);w.appendChild(body);w.appendChild(inputWrap);
host.appendChild(w);

// Focus input after a tick
setTimeout(function(){input.focus();},50);

// Escape key listener (global — on document, not shadow)
window.__yoWidgetEsc=function(e){
  if(e.key==='Escape'&&document.getElementById('__yo-widget-host')){
    e.preventDefault();e.stopPropagation();
    console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss',_nonce:_n}));
  }
};
document.addEventListener('keydown',window.__yoWidgetEsc,true);
})()`);
    } catch {}
  }

  private async notify(
    wc: WebContents,
    msg: string,
    type: "loading" | "success" | "error" | "result" | "yo",
  ): Promise<void> {
    const loadingMessages = [
      "chilling...", "vibing...", "yozing...", "cooking...",
      "thinking...", "brewing...", "manifesting...", "marinating...",
    ];
    const displayMsg = type === "loading"
      ? loadingMessages[Math.floor(Math.random() * loadingMessages.length)]
      : msg;
    const isNegativeResult = (type === "result" || type === "yo") && /not found|nothing/i.test(msg);
    const icon = type === "success" ? "\u2713 " : type === "error" || isNegativeResult ? "\u2717 " : type === "result" ? "\u2713 " : "";
    const text = icon + displayMsg;
    const autoRemove = type === "success";
    const autoRemoveError = type === "error";
    const nonceJs = JSON.stringify(this.sessionNonce);
    try {
      await wc.executeJavaScript(`
(function(){
var _n=${nonceJs};
if(window.__yoNoteIv){clearInterval(window.__yoNoteIv);window.__yoNoteIv=null;}
var el=window.__yoLastEl;
if(!el||!el.isConnected){el=document.activeElement;if(!el||el===document.body)el=null;
if(!el){var fb=['[role="textbox"]','[contenteditable]:not([contenteditable="false"])','textarea','input[type="text"]'];
for(var i=0;!el&&i<fb.length;i++){try{var els=document.querySelectorAll(fb[i]);
for(var j=0;j<els.length;j++){var r=els[j].getBoundingClientRect();
if(r.width>0&&r.height>0){el=els[j];break;}}}catch(e){}}}
if(el)window.__yoLastEl=el;}
if(!el)return;
var isLoading=${type === "loading"};
var text=${JSON.stringify(text)};
var modeColor=${JSON.stringify(this.modeColor)};
function setText(val){
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
    var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var s=Object.getOwnPropertyDescriptor(p,'value');
    if(s&&s.set)s.set.call(el,val);else el.value=val;
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    el.innerText=val;
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }
}
function cursorHome(){try{if(el.setSelectionRange)el.setSelectionRange(0,0);else{var s=window.getSelection();if(s){var r=document.createRange();r.setStart(el,0);r.collapse(true);s.removeAllRanges();s.addRange(r);}}}catch(e){}}
if(isLoading){
  var frames=['\\u280B','\\u2819','\\u2839','\\u2838','\\u283C','\\u2834','\\u2826','\\u2827'];
  var words=['chilling...','vibing...','yozing...','cooking...','thinking...','brewing...','manifesting...','marinating...'];
  var fi=0;
  var curWord=text;
  var nextWord='';
  var wipePos=-1;
  var lastSwap=Date.now();
  function pickNext(){var w=words[Math.floor(Math.random()*words.length)];while(w===curWord&&words.length>1)w=words[Math.floor(Math.random()*words.length)];return w;}
  setText(' '+frames[0]+' '+curWord+'   ');
  cursorHome();
  window.__yoStopEsc=function(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();console.log('${PREFIX}'+JSON.stringify({type:'cancel',_nonce:_n}));}};
  document.addEventListener('keydown',window.__yoStopEsc,true);
  window.__yoNoteIv=setInterval(function(){
    fi++;
    var now=Date.now();
    var display;
    if(wipePos>=0){
      wipePos++;
      display=curWord;
      if(wipePos<=display.length){
        display=nextWord.substring(0,wipePos)+display.substring(wipePos);
        if(wipePos>=curWord.length){curWord=nextWord;wipePos=-1;lastSwap=now;}
      }
    }else{
      display=curWord;
      if(now-lastSwap>3000){nextWord=pickNext();wipePos=0;}
    }
    setText(' '+frames[fi%frames.length]+' '+display+'   ');
    cursorHome();
  },100);
}else{
  setText(text);
  ${autoRemove || autoRemoveError ? `setTimeout(function(){try{setText('');}catch(e){}},${autoRemoveError ? 6000 : 1500});` : `
  if(window.__yoResultEsc){document.removeEventListener('keydown',window.__yoResultEsc,true);window.__yoResultEsc=null;}
  window.__yoResultEsc=function(e){
    if(e.key==='Escape'){
      e.preventDefault();e.stopPropagation();
      try{setText('');}catch(ex){}
      console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss',_nonce:_n}));
      document.removeEventListener('keydown',window.__yoResultEsc,true);
      window.__yoResultEsc=null;
    }
  };
  document.addEventListener('keydown',window.__yoResultEsc,true);
  `}
}
})();`);
    } catch {}
  }

  private async clearNotify(wc: WebContents): Promise<void> {
    try {
      await wc.executeJavaScript(`
(function(){
if(window.__yoNoteIv){clearInterval(window.__yoNoteIv);window.__yoNoteIv=null;}
if(window.__yoStopEsc){document.removeEventListener('keydown',window.__yoStopEsc,true);window.__yoStopEsc=null;}
if(window.__yoResultEsc){document.removeEventListener('keydown',window.__yoResultEsc,true);window.__yoResultEsc=null;}
var el=window.__yoLastEl;
if(el&&el.isConnected){
if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
  var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  var s=Object.getOwnPropertyDescriptor(p,'value');
  if(s&&s.set)s.set.call(el,'');else el.value='';
  el.dispatchEvent(new Event('input',{bubbles:true}));
}else{
  el.focus();
  var sel=window.getSelection();var range=document.createRange();
  range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
  document.execCommand('delete',false);
}}
})();`);
    } catch {}
  }
}
