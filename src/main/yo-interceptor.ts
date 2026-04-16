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
import type { YoResult } from "./command-parser";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string, sourcePanelId?: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private getVisiblePanelIds: (() => string[]) | null = null;
  private opId = 0; // incremented per operation; cancel bumps it to invalidate in-flight results
  private sessionNotifier: (() => void) | null = null;

  // Yo conversation callbacks
  private yoSearcher: ((query: string) => Promise<YoResult[]>) | null = null;
  private yoQuerier: ((query: string) => Promise<string>) | null = null;
  private yoRefiner: ((message: string) => Promise<string>) | null = null;
  private yoClearer: (() => void) | null = null;
  private panelOpener: ((query: string) => void) | null = null;
  private yoWidgetWc: WebContents | null = null; // track which wc has the widget open
  private yoActiveWc: WebContents | null = null; // wc the current .yo conversation is in
  private yoResults: YoResult[] = []; // current search results
  private yoSessionActive = false; // true when in a .yo conversation

  constructor(
    private appConnector: AppConnector,
    private skillEngine: SkillEngine,
    private session: SessionCache,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCommandHandler(handler: (input: string, sourcePanelId?: string) => Promise<string>): void { this.commandHandler = handler; }
  setVisiblePanelsGetter(getter: () => string[]): void { this.getVisiblePanelIds = getter; }
  setSessionNotifier(fn: () => void): void { this.sessionNotifier = fn; }
  setYoSearcher(fn: (query: string) => Promise<YoResult[]>): void { this.yoSearcher = fn; }
  setYoQuerier(fn: (query: string) => Promise<string>): void { this.yoQuerier = fn; }
  setYoRefiner(fn: (message: string) => Promise<string>): void { this.yoRefiner = fn; }
  setYoClearer(fn: () => void): void { this.yoClearer = fn; }
  setPanelOpener(fn: (query: string) => void): void { this.panelOpener = fn; }
  getActiveYoWc(): WebContents | null { return this.yoActiveWc; }

  /** Start watching a panel's webContents for commands. */
  activate(wc: WebContents, appId: string): void {
    this.deactivate(wc.id);

    const inject = () => this.inject(wc);
    const onConsole = (_e: any, _l: any, msg: string) => {
      if (typeof msg !== "string" || !msg.startsWith(PREFIX)) return;
      try {
        const data = JSON.parse(msg.slice(PREFIX.length));
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
    return `
(function(){
if(window.__yoActive)return;window.__yoActive=true;
var CMD_RE=/^\\.(yo|sup|dip|drip)(?:\\s+([\\s\\S]+))?$/i;
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
  console.log('${PREFIX}'+JSON.stringify({type:cmd,instruction:arg}));
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
      case "cancel":
        this.opId++; // invalidate any in-flight operation
        await this.clearNotify(wc);
        break;
      case "yo-use":
        await this.handleYoUse(wc, data as any);
        break;
      case "yo-refine":
        await this.handleYoRefine(wc, data as any);
        break;
      case "yo-dismiss":
        this.dismissYoWidget(wc);
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

      const skill = dotMatch[1]?.trim();
      if (!skill) {
        // Bare .sup . → just capture
        await this.commandHandler("sup", appId);
        await this.clearNotify(wc);
        this.notify(wc, "captured", "success");
        return;
      }

      // .sup . <skill/prompt> → capture + process
      try {
        const result = await this.commandHandler(`sup . ${skill}`, appId);
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "result");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // Check if chaining: .sup . .dip gmail — handled via command parser chaining
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

  /** Handle [use] click from widget — inject content into original text area. */
  private async handleYoUse(wc: WebContents, data: { index?: number; text?: string }): Promise<void> {
    let content = "";
    if (data.text) {
      content = data.text;
    } else if (typeof data.index === "number" && this.yoResults[data.index]) {
      content = this.yoResults[data.index].content;
    }
    if (content) {
      this.dismissYoWidget(wc);
      this.injectContent(wc, content);
    }
  }

  /** Handle refinement message from widget input. */
  private async handleYoRefine(wc: WebContents, data: { text?: string }): Promise<void> {
    const message = data.text?.trim();
    if (!message) return;

    // If no results yet (bare .yo), treat as a fresh search
    if (this.yoResults.length === 0 && this.yoSearcher) {
      await this.appendYoMessage(wc, "user", message);
      await this.setYoLoading(wc, true);
      try {
        const results = await this.yoSearcher(message);
        this.yoResults = results;
        await this.setYoLoading(wc, false);
        // Update header to show the query
        try {
          await wc.executeJavaScript(`(function(){var w=document.getElementById('__yo-widget');if(!w)return;var t=w.querySelector('span');if(t)t.textContent='.yo '+${JSON.stringify(message)};})()`);
        } catch {}
        if (results.length === 0) {
          await this.appendYoMessage(wc, "error", "No matching context found.");
        } else {
          await this.updateYoWidgetResults(wc, results);
        }
      } catch (err) {
        await this.setYoLoading(wc, false);
        await this.appendYoMessage(wc, "error", `Search failed: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (!this.yoRefiner) return;

    await this.appendYoMessage(wc, "user", message);
    await this.setYoLoading(wc, true);

    try {
      const result = await this.yoRefiner(message);
      await this.setYoLoading(wc, false);
      await this.appendYoMessage(wc, "assistant", result);
    } catch (err) {
      await this.setYoLoading(wc, false);
      await this.appendYoMessage(wc, "error", `Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Dismiss yo state — clears session, widget, and result Escape handler. */
  private dismissYoWidget(wc: WebContents): void {
    this.yoWidgetWc = null;
    this.yoActiveWc = null;
    this.yoResults = [];
    this.yoSessionActive = false;
    this.yoClearer?.();
    try {
      wc.executeJavaScript(`(function(){var s=document.getElementById('__yo-widget-thinking');if(s&&s.__tid)clearInterval(s.__tid);var h=document.getElementById('__yo-widget-host');if(h)h.remove();if(window.__yoWidgetEsc){document.removeEventListener('keydown',window.__yoWidgetEsc,true);window.__yoWidgetEsc=null;}if(window.__yoResultEsc){document.removeEventListener('keydown',window.__yoResultEsc,true);window.__yoResultEsc=null;}})()`);
    } catch {}
  }

  /** Add Escape handler to clear streamed result from input and end session. */
  private addYoEscapeHandler(wc: WebContents): void {
    try {
      wc.executeJavaScript(`(function(){
if(window.__yoResultEsc){document.removeEventListener('keydown',window.__yoResultEsc,true);window.__yoResultEsc=null;}
window.__yoResultEsc=function(e){
  if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation();
    var el=window.__yoLastEl;if(el){
      if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
        var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        var s=Object.getOwnPropertyDescriptor(p,'value');
        if(s&&s.set)s.set.call(el,'');else el.value='';
        el.dispatchEvent(new Event('input',{bubbles:true}));
      }else{el.innerText='';}
    }
    console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss'}));
    document.removeEventListener('keydown',window.__yoResultEsc,true);
    window.__yoResultEsc=null;
  }
};
document.addEventListener('keydown',window.__yoResultEsc,true);
})()`);
    } catch {}
  }

  // ── yo: search agent, retrieve, utilities ──────────────

  private static readonly COMMAND_KEYWORDS = new Set([".dip", ".drip"]);

  private async handleYo(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    if (!this.commandHandler) return;

    // Subcommands routed through command parser
    const sub = instruction?.split(/\s+/)[0]?.toLowerCase();
    if (sub === "help" || sub === "skill" || sub === "layout") {
      this.yoSessionActive = false;
      // command parser handles side effects (e.g. opening help overlay)
      await this.commandHandler(`yo ${instruction}`);
      return;
    }

    // Bare .yo → clear session, open help
    if (!instruction?.trim()) {
      this.yoSessionActive = false;
      this.yoClearer?.();
      // Open help overlay (same as .yo help)
      await this.commandHandler("yo help");
      return;
    }

    // .yo . <skill/prompt> → process last capture with skill
    const dotMatch = instruction.match(/^\.\s*(.+)$/);
    if (dotMatch) {
      this.yoSessionActive = false;
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      try {
        const result = await this.commandHandler(`yo ${instruction}`, appId);
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "result");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // .yo <query> . <processor> → search + process, direct inject
    const parts = instruction.split(/\s+/);
    const dotIdx = parts.indexOf(".");
    if (dotIdx > 0 && dotIdx < parts.length - 1) {
      this.yoSessionActive = false;
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      try {
        const result = await this.commandHandler(`yo ${instruction}`, appId);
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "result");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // ── Conversational .yo ─────────────────────────────────
    // Opens the slide-out agent panel. The panel handles the full
    // conversation loop — streaming, tool use, follow-ups, and "use" injection.

    const query = instruction.trim();
    this.yoActiveWc = wc;

    if (this.panelOpener) {
      this.panelOpener(query);
    } else {
      this.notify(wc, "Agent panel not available.", "error");
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
    } else {
      content = await wc.executeJavaScript("document.body.innerText.slice(0,10000)");
    }
    if (!content || content.startsWith("[Element not found")) return null;
    return content;
  }

  // ── Yo widget injection ────────────────────────────────

  private async injectYoWidget(wc: WebContents, query: string): Promise<void> {
    const escaped = JSON.stringify(query);
    try {
      await wc.executeJavaScript(`
(function(){
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
closeBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss'}));};
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
  console.log('${PREFIX}'+JSON.stringify({type:'yo-refine',text:msg}));
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
    console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss'}));
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
    console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss'}));
  }
};
document.addEventListener('keydown',window.__yoWidgetEsc,true);
})()`);
    } catch {}
  }

  /** Update widget body with search results or an error message. */
  private async updateYoWidgetResults(wc: WebContents, results: YoResult[], errorMsg?: string): Promise<void> {
    const data = JSON.stringify(results.map((r, i) => ({
      i,
      title: r.title,
      panelId: r.panelId,
      age: r.age,
      preview: r.preview,
      content: r.content,
    })));
    const err = errorMsg ? JSON.stringify(errorMsg) : "null";
    try {
      await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-widget-body');if(!body)return;
var spinner=document.getElementById('__yo-widget-thinking');if(spinner&&spinner.__tid)clearInterval(spinner.__tid);
body.innerHTML='';
var err=${err};
if(err){
  var msg=document.createElement('div');msg.style.cssText='color:#999;font-size:12px;padding:12px 0;text-align:center;';
  msg.textContent=err;body.appendChild(msg);return;
}
if(results.length===0){
  var empty=document.createElement('div');empty.style.cssText='color:#555;font-size:12px;padding:20px 0;text-align:center;';
  empty.textContent='search your memory';body.appendChild(empty);return;
}

// Lightweight markdown renderer
function renderMd(text){
  var lines=text.split('\\n');var html=[];var inCode=false;var inList=false;
  for(var i=0;i<lines.length;i++){
    var l=lines[i];
    if(l.match(/^\`\`\`/)){
      if(inCode){html.push('</pre>');inCode=false;}
      else{html.push('<pre style="background:#111;border-radius:4px;padding:8px 10px;overflow-x:auto;font-size:11px;color:#ccc;margin:6px 0;">');inCode=true;}
      continue;
    }
    if(inCode){html.push(l.replace(/</g,'&lt;')+'\\n');continue;}
    if(l.match(/^### /)){html.push('<div style="color:#e0e0e0;font-weight:600;font-size:12px;margin:8px 0 4px;">'+l.slice(4)+'</div>');continue;}
    if(l.match(/^## /)){html.push('<div style="color:#e0e0e0;font-weight:600;font-size:13px;margin:10px 0 4px;">'+l.slice(3)+'</div>');continue;}
    if(l.match(/^# /)){html.push('<div style="color:#fff;font-weight:700;font-size:14px;margin:10px 0 4px;">'+l.slice(2)+'</div>');continue;}
    if(l.match(/^[-*] /)){
      if(!inList){html.push('<div style="margin:4px 0;">');inList=true;}
      html.push('<div style="padding-left:12px;">\\u2022 '+l.slice(2)+'</div>');continue;
    }
    if(inList&&!l.trim()){inList=false;html.push('</div>');}
    if(l.match(/^---+$/)){html.push('<hr style="border:none;border-top:1px solid #333;margin:8px 0;">');continue;}
    var escaped=l.replace(/</g,'&lt;');
    escaped=escaped.replace(/\`([^\`]+)\`/g,'<code style="background:#111;padding:1px 4px;border-radius:3px;font-size:11px;">$1</code>');
    escaped=escaped.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong style="color:#e0e0e0;">$1</strong>');
    escaped=escaped.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    if(escaped.trim())html.push('<div style="margin:2px 0;">'+escaped+'</div>');
    else html.push('<div style="height:6px;"></div>');
  }
  if(inCode)html.push('</pre>');
  if(inList)html.push('</div>');
  return html.join('');
}

var results=${data};
results.forEach(function(r){
  var card=document.createElement('div');
  card.style.cssText='background:#222;border:1px solid #333;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:border-color 0.15s;';
  card.onmouseenter=function(){if(!card.__expanded)card.style.borderColor='#444';};
  card.onmouseleave=function(){if(!card.__expanded)card.style.borderColor='#333';};
  card.__expanded=false;

  var top=document.createElement('div');top.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
  var label=document.createElement('span');label.style.cssText='color:#25C75E;font-size:11px;font-weight:600;';
  label.textContent=r.title+' \\u00b7 '+r.age;
  var useBtn=document.createElement('div');useBtn.textContent='use';
  useBtn.style.cssText='color:#25C75E;font-size:11px;font-weight:600;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background 0.15s;';
  useBtn.onmouseenter=function(){useBtn.style.background='#25C75E22';};
  useBtn.onmouseleave=function(){useBtn.style.background='none';};
  useBtn.onclick=function(e){e.stopPropagation();console.log('${PREFIX}'+JSON.stringify({type:'yo-use',index:0}).replace('"index":0','"index":'+r.i));};
  top.appendChild(label);top.appendChild(useBtn);

  var preview=document.createElement('div');preview.style.cssText='color:#999;font-size:11px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;';
  preview.textContent=r.preview;

  var full=document.createElement('div');full.style.cssText='display:none;color:#bbb;font-size:12px;line-height:1.5;margin-top:8px;';
  full.innerHTML=renderMd(r.content);

  card.onclick=function(){
    if(card.__expanded){
      card.__expanded=false;
      card.style.borderColor='#333';card.style.cursor='pointer';
      preview.style.display='';full.style.display='none';
    }else{
      card.__expanded=true;
      card.style.borderColor='#25C75E44';card.style.cursor='default';
      preview.style.display='none';full.style.display='block';
    }
  };

  card.appendChild(top);card.appendChild(preview);card.appendChild(full);body.appendChild(card);
});
body.scrollTop=0;
})()`);
    } catch {}
  }

  /** Append a message to the widget conversation area. */
  private async appendYoMessage(wc: WebContents, role: "user" | "assistant" | "error", text: string): Promise<void> {
    const escaped = JSON.stringify(text);
    const isUser = role === "user";
    const isError = role === "error";
    try {
      if (isUser) {
        await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-widget-body');if(!body)return;
var wrap=document.createElement('div');
wrap.style.cssText='display:flex;justify-content:flex-end;margin-top:8px;';
var bubble=document.createElement('div');
bubble.style.cssText='background:#25C75E18;border:1px solid #25C75E33;border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:80%;font-size:12px;line-height:1.5;color:#ccc;white-space:pre-wrap;word-break:break-word;';
bubble.textContent=${escaped};
wrap.appendChild(bubble);body.appendChild(wrap);body.scrollTop=body.scrollHeight;
})()`);
      } else {
        await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-widget-body');if(!body)return;
${isError ? `
var msg=document.createElement('div');msg.style.cssText='margin-top:8px;padding:8px 12px;color:#ff5f57;font-size:12px;line-height:1.5;';
msg.textContent=${escaped};body.appendChild(msg);body.scrollTop=body.scrollHeight;
` : `
function renderMd(text){
  var lines=text.split('\\n');var html=[];var inCode=false;var inList=false;
  for(var i=0;i<lines.length;i++){
    var l=lines[i];
    if(l.match(/^\`\`\`/)){
      if(inCode){html.push('</pre>');inCode=false;}
      else{html.push('<pre style="background:#111;border-radius:4px;padding:8px 10px;overflow-x:auto;font-size:11px;color:#ccc;margin:6px 0;">');inCode=true;}
      continue;
    }
    if(inCode){html.push(l.replace(/</g,'&lt;')+'\\n');continue;}
    if(l.match(/^### /)){html.push('<div style="color:#e0e0e0;font-weight:600;font-size:12px;margin:8px 0 4px;">'+l.slice(4)+'</div>');continue;}
    if(l.match(/^## /)){html.push('<div style="color:#e0e0e0;font-weight:600;font-size:13px;margin:10px 0 4px;">'+l.slice(3)+'</div>');continue;}
    if(l.match(/^# /)){html.push('<div style="color:#fff;font-weight:700;font-size:14px;margin:10px 0 4px;">'+l.slice(2)+'</div>');continue;}
    if(l.match(/^[-*] /)){
      if(!inList){html.push('<div style="margin:4px 0;">');inList=true;}
      html.push('<div style="padding-left:12px;">\\u2022 '+l.slice(2)+'</div>');continue;
    }
    if(inList&&!l.trim()){inList=false;html.push('</div>');}
    if(l.match(/^---+$/)){html.push('<hr style="border:none;border-top:1px solid #333;margin:8px 0;">');continue;}
    var escaped=l.replace(/</g,'&lt;');
    escaped=escaped.replace(/\`([^\`]+)\`/g,'<code style="background:#111;padding:1px 4px;border-radius:3px;font-size:11px;">$1</code>');
    escaped=escaped.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong style="color:#e0e0e0;">$1</strong>');
    escaped=escaped.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    if(escaped.trim())html.push('<div style="margin:2px 0;">'+escaped+'</div>');
    else html.push('<div style="height:6px;"></div>');
  }
  if(inCode)html.push('</pre>');
  if(inList)html.push('</div>');
  return html.join('');
}
var card=document.createElement('div');
card.style.cssText='background:#222;border:1px solid #333;border-radius:8px;padding:10px 12px;margin-top:8px;cursor:pointer;transition:border-color 0.15s;';
card.onmouseenter=function(){if(!card.__expanded)card.style.borderColor='#444';};
card.onmouseleave=function(){if(!card.__expanded)card.style.borderColor='#333';};
card.__expanded=false;
var top=document.createElement('div');top.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
var label=document.createElement('span');label.style.cssText='color:#25C75E;font-size:11px;font-weight:600;';
label.textContent='yo result';
var useBtn=document.createElement('div');useBtn.textContent='use';
useBtn.style.cssText='color:#25C75E;font-size:11px;font-weight:600;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background 0.15s;';
useBtn.onmouseenter=function(){useBtn.style.background='#25C75E22';};
useBtn.onmouseleave=function(){useBtn.style.background='none';};
useBtn.onclick=function(e){e.stopPropagation();console.log('${PREFIX}'+JSON.stringify({type:'yo-use',text:${escaped}}));};
top.appendChild(label);top.appendChild(useBtn);
var text=${escaped};
var previewText=text.split('\\n').slice(0,3).join(' ').substring(0,150);
if(text.length>150)previewText+='...';
var preview=document.createElement('div');preview.style.cssText='color:#999;font-size:11px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;';
preview.textContent=previewText;
var full=document.createElement('div');full.style.cssText='display:none;color:#bbb;font-size:12px;line-height:1.5;margin-top:8px;';
full.innerHTML=renderMd(text);
card.onclick=function(){
  if(card.__expanded){
    card.__expanded=false;card.style.borderColor='#333';card.style.cursor='pointer';
    preview.style.display='';full.style.display='none';
  }else{
    card.__expanded=true;card.style.borderColor='#25C75E44';card.style.cursor='default';
    preview.style.display='none';full.style.display='block';
  }
};
card.appendChild(top);card.appendChild(preview);card.appendChild(full);body.appendChild(card);
body.scrollTop=body.scrollHeight;
`}
})()`);
      }
    } catch {}
  }

  /** Show/hide loading indicator in widget (braille spinner like standard notify). */
  private async setYoLoading(wc: WebContents, loading: boolean): Promise<void> {
    try {
      await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-widget-body');if(!body)return;
var existing=document.getElementById('__yo-widget-thinking');
if(${loading}){
  if(existing)return;
  var el=document.createElement('div');el.id='__yo-widget-thinking';
  el.style.cssText='color:#666;font-size:12px;padding:8px 0;';
  var frames=['\\u280B','\\u2819','\\u2839','\\u2838','\\u283C','\\u2834','\\u2826','\\u2827'];
  var words=['chilling...','vibing...','yozing...','cooking...','thinking...','brewing...','manifesting...','marinating...'];
  var fi=0;var curWord=words[Math.floor(Math.random()*words.length)];
  var nextWord='';var wipePos=-1;var lastSwap=Date.now();
  function pick(){var w=words[Math.floor(Math.random()*words.length)];while(w===curWord&&words.length>1)w=words[Math.floor(Math.random()*words.length)];return w;}
  el.textContent=frames[0]+' '+curWord;
  el.__iv=setInterval(function(){
    fi++;var now=Date.now();
    if(wipePos>=0){
      wipePos++;var display=curWord;
      if(wipePos<=display.length){
        display=nextWord.substring(0,wipePos)+display.substring(wipePos);
        if(wipePos>=curWord.length){curWord=nextWord;wipePos=-1;lastSwap=now;}
      }
      el.textContent=frames[fi%frames.length]+' '+display;
    }else{
      el.textContent=frames[fi%frames.length]+' '+curWord;
      if(now-lastSwap>3000){nextWord=pick();wipePos=0;}
    }
  },100);
  body.appendChild(el);body.scrollTop=body.scrollHeight;
}else{
  if(existing){if(existing.__iv)clearInterval(existing.__iv);existing.remove();}
}
})()`);
    } catch {}
  }

  // ── Injected UI helpers ───────────────────────────────

  private async injectContent(wc: WebContents, text: string): Promise<boolean> {
    try {
      return await wc.executeJavaScript(
        `(function(){ if(window.__yoInject){window.__yoInject(${JSON.stringify(text)});return true;} return false; })()`,
      );
    } catch {
      return false;
    }
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
    try {
      await wc.executeJavaScript(`
(function(){
if(window.__yoNoteIv){clearInterval(window.__yoNoteIv);window.__yoNoteIv=null;}
var el=window.__yoLastEl;if(!el)return;
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
  stopBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'cancel'}));};
  // Position next to input
  try{var rect=el.getBoundingClientRect();stopBtn.style.top=(rect.top+rect.height/2-12)+'px';stopBtn.style.right='12px';}catch(e){}
  var old=document.getElementById('__yo-stop');if(old)old.remove();
  document.body.appendChild(stopBtn);
  // Escape key also cancels
  window.__yoStopEsc=function(e){if(e.key==='Escape'){console.log('${PREFIX}'+JSON.stringify({type:'cancel'}));}};
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
      console.log('${PREFIX}'+JSON.stringify({type:'yo-dismiss'}));
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
var el=window.__yoLastEl;if(!el)return;
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
})();`);
    } catch {}
  }
}
