/**
 * YoInterceptor — intercepts yo/sup/dip/drip typed inside app panels.
 *
 *   yo <query>     → search context store → open inline widget
 *   yo . <skill>   → process last capture with skill → inject result
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

  constructor(
    private appConnector: AppConnector,
    private skillEngine: SkillEngine,
    private session: SessionCache,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCommandHandler(handler: (input: string, sourcePanelId?: string) => Promise<string>): void { this.commandHandler = handler; }
  setVisiblePanelsGetter(getter: () => string[]): void { this.getVisiblePanelIds = getter; }
  setSessionNotifier(fn: () => void): void { this.sessionNotifier = fn; }
  setYoClearer(fn: () => void): void { this.yoClearer = fn; }
  setPanelOpener(fn: (query: string, sourcePanelId?: string) => void): void { this.panelOpener = fn; }
  getActiveYoWc(): WebContents | null { return this.yoActiveWc; }

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
var _n=${JSON.stringify(nonce)};
var CMD_RE=/^\\.(yo|sup|dip|drip|waz|grp)(?:\\s+([\\s\\S]+))?$/i;
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
      case "waz":
        // Delegate to command parser for app command execution
        if (this.commandHandler) {
          const cmd = data.instruction ? `waz ${data.instruction}` : "waz";
          const result = await this.commandHandler(cmd, appId);
          if (result) this.notify(wc, result, "success");
        }
        break;
      case "grp":
        // Delegate to command parser for group chat
        if (this.commandHandler) {
          const cmd = data.instruction ? `grp ${data.instruction}` : "grp";
          await this.commandHandler(cmd);
        }
        break;
      case "cancel":
        this.opId++; // invalidate any in-flight operation
        await this.clearNotify(wc);
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

  private static readonly COMMAND_KEYWORDS = new Set([".dip", ".drip", ".waz"]);

  /**
   * Split off chained commands (.dip, .drip, .waz) from the end of an instruction.
   * Returns [ownArgs, chainedRemainder].
   * e.g. "summarize .dip grok .drip =" → ["summarize", ".dip grok .drip ="]
   */
  private static splitChain(instruction: string): [string, string] {
    const chainRe = /\s+(\.(dip|drip|waz)\b.*)$/i;
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
      await this.handleYoDot(wc, appId, prompt);
      await this.runChain(chain);
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



  private timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  }

  // ── Content grabbing ──────────────────────────────────

  /** Grab content from visible panels (all or current only). */
  private async grabPanels(wc: WebContents, appId: string, allPanels: boolean): Promise<string | null> {
    if (!allPanels) {
      const app = this.appConnector.get(appId);
      return this.grabContent(wc, app);
    }

    const panelIds = this.getVisiblePanelIds?.() ?? [appId];
    if (panelIds.length <= 1) {
      const app = this.appConnector.get(appId);
      return this.grabContent(wc, app);
    }

    const sections: string[] = [];
    for (const id of panelIds) {
      const app = this.appConnector.get(id);
      let content: string | null;
      if (id === appId) {
        content = await this.grabContent(wc, app);
      } else {
        const otherWc = this.getWebContentsForPanel(id);
        if (!otherWc) continue;
        content = await this.grabContent(otherWc, app);
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
          if (app && wc.getURL().includes(new URL(app.url).hostname)) {
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
  ): Promise<string | null> {
    let content = "";
    if (app?.commands.grab) {
      content = await executeCommand(wc, app.commands.grab);
    }
    // Fall back to body text if app-specific grab returned nothing useful
    if (!content || content.startsWith("[Element not found")) {
      content = await wc.executeJavaScript("document.body.innerText.slice(0,10000)");
    }
    if (!content) return null;
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
w.style.cssText='width:100%;max-height:700px;background:#1a1a1a;border:1px solid #333;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:13px;color:#ccc;overflow:hidden;line-height:normal;box-sizing:border-box;';

// Header
var hdr=document.createElement('div');
hdr.style.cssText='padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
var title=document.createElement('span');title.style.cssText='color:#25C75E;font-weight:600;font-size:12px;';
title.textContent=${escaped}?'.yo '+${escaped}:'.yo';
var closeBtn=document.createElement('div');closeBtn.textContent='\\u00d7';
closeBtn.style.cssText='width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#666;font-size:16px;border-radius:4px;';
closeBtn.onmouseenter=function(){closeBtn.style.color='#fff';closeBtn.style.background='#333';};
closeBtn.onmouseleave=function(){closeBtn.style.color='#666';closeBtn.style.background='none';};
closeBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss',_nonce:_n}));};
hdr.appendChild(title);hdr.appendChild(closeBtn);

// Body (results + messages)
var body=document.createElement('div');body.id='__yo-widget-body';
body.style.cssText='flex:1;overflow-y:auto;padding:8px 14px;min-height:120px;max-height:540px;';
// Show animated spinner when query provided, empty state otherwise
if(${escaped}){
  var loading=document.createElement('div');loading.id='__yo-widget-thinking';
  loading.style.cssText='color:#666;font-size:12px;padding:12px 0;';
  var frames=['\\u280B','\\u2819','\\u2839','\\u2838','\\u283C','\\u2834','\\u2826','\\u2827'];
  var words=['chilling...','vibing...','yozing...','cooking...','thinking...','brewing...','manifesting...','marinating...'];
  var fi=0;var curWord=words[Math.floor(Math.random()*words.length)];
  loading.textContent=frames[0]+' '+curWord;
  var tid=setInterval(function(){fi=(fi+1)%frames.length;loading.textContent=frames[fi]+' '+curWord;},120);
  loading.__tid=tid;
  body.appendChild(loading);
}else{
  var empty=document.createElement('div');empty.style.cssText='color:#555;font-size:12px;padding:20px 0;text-align:center;';
  empty.textContent='search your memory';body.appendChild(empty);
}

// Input area with textarea + send button
var inputWrap=document.createElement('div');
inputWrap.style.cssText='padding:8px 10px;border-top:1px solid #333;flex-shrink:0;';
var inputRow=document.createElement('div');
inputRow.style.cssText='display:flex;align-items:flex-end;gap:6px;background:#111;border:1px solid #333;border-radius:8px;padding:6px 8px;transition:border-color 0.15s;';
var input=document.createElement('textarea');input.id='__yo-widget-input';input.rows=1;
input.placeholder=${escaped}?'ask about results...':'search your memory...';
input.style.cssText='flex:1;background:none;border:none;color:#ccc;font-size:12px;outline:none;resize:none;font-family:inherit;line-height:1.4;max-height:72px;overflow-y:auto;padding:0;margin:0;';
var sendBtn=document.createElement('div');sendBtn.id='__yo-widget-send';
sendBtn.innerHTML='\\u2191';
sendBtn.style.cssText='width:22px;height:22px;border-radius:6px;background:#25C75E;color:#000;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:opacity 0.15s;opacity:0.4;';
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
input.onfocus=function(){inputRow.style.borderColor='#25C75E';};
input.onblur=function(){inputRow.style.borderColor='#333';};
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
    const autoRemove = type === "success" || type === "error";
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
function setText(val){
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
    var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var s=Object.getOwnPropertyDescriptor(p,'value');
    if(s&&s.set)s.set.call(el,val);else el.value=val;
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    el.innerText=val;
  }
}
if(isLoading){
  var frames=['\\u280B','\\u2819','\\u2839','\\u2838','\\u283C','\\u2834','\\u2826','\\u2827'];
  var words=['chilling...','vibing...','yozing...','cooking...','thinking...','brewing...','manifesting...','marinating...'];
  var fi=0;
  var curWord=text;
  var nextWord='';
  var wipePos=-1;
  var lastSwap=Date.now();
  function pickNext(){var w=words[Math.floor(Math.random()*words.length)];while(w===curWord&&words.length>1)w=words[Math.floor(Math.random()*words.length)];return w;}
  function cursorHome(){try{if(el.setSelectionRange)el.setSelectionRange(0,0);else{var s=window.getSelection();if(s){var r=document.createRange();r.setStart(el,0);r.collapse(true);s.removeAllRanges();s.addRange(r);}}}catch(e){}}
  setText(frames[0]+' '+curWord+'   ');
  cursorHome();
  // Stop button
  var stopBtn=document.createElement('div');
  stopBtn.id='__yo-stop';
  stopBtn.innerHTML='\\u25A0';
  stopBtn.title='Stop';
  stopBtn.style.cssText='position:fixed;z-index:999999;width:24px;height:24px;border-radius:6px;background:#333;color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background 0.15s;user-select:none;';
  stopBtn.onmouseenter=function(){stopBtn.style.background='#ff5f57';};
  stopBtn.onmouseleave=function(){stopBtn.style.background='#333';};
  stopBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'cancel',_nonce:_n}));};
  // Position next to input
  try{var rect=el.getBoundingClientRect();stopBtn.style.top=(rect.top+rect.height/2-12)+'px';stopBtn.style.right='12px';}catch(e){}
  var old=document.getElementById('__yo-stop');if(old)old.remove();
  document.body.appendChild(stopBtn);
  // Escape key also cancels
  window.__yoStopEsc=function(e){if(e.key==='Escape'){console.log('${PREFIX}'+JSON.stringify({type:'cancel',_nonce:_n}));}};
  document.addEventListener('keydown',window.__yoStopEsc,true);
  window.__yoNoteIv=setInterval(function(){
    fi++;
    var now=Date.now();
    if(wipePos>=0){
      wipePos++;
      var display=curWord;
      if(wipePos<=display.length){
        display=nextWord.substring(0,wipePos)+display.substring(wipePos);
        if(wipePos>=curWord.length){curWord=nextWord;wipePos=-1;lastSwap=now;}
      }
      setText(frames[fi%frames.length]+' '+display+'   ');
    }else{
      setText(frames[fi%frames.length]+' '+curWord+'   ');
      if(now-lastSwap>3000){nextWord=pickNext();wipePos=0;}
    }
    cursorHome();
  },100);
}else{
  setText(text);
  ${autoRemove ? "setTimeout(function(){try{setText('');}catch(e){}},2500);" : `
  // Escape clears result and ends yo session
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
var stop=document.getElementById('__yo-stop');if(stop)stop.remove();
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
