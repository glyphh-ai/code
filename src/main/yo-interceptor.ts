/**
 * YoInterceptor — intercepts yo/sup/dip/drip typed inside app panels.
 *
 *   yo .           → capture active panel → context store + clipboard
 *   yo . <skill>   → capture + process with skill → inject result
 *   yo help        → open help overlay
 *   sup <query>    → search context store → inject results
 *   sup . <skill>  → process last capture with skill → inject
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
import type { SupResult } from "./command-parser";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string, sourcePanelId?: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private getVisiblePanelIds: (() => string[]) | null = null;
  private opId = 0; // incremented per operation; cancel bumps it to invalidate in-flight results
  private sessionNotifier: (() => void) | null = null;

  // Sup widget callbacks
  private supSearcher: ((query: string) => Promise<SupResult[]>) | null = null;
  private supRefiner: ((message: string) => Promise<string>) | null = null;
  private supClearer: (() => void) | null = null;
  private supWidgetWc: WebContents | null = null; // track which wc has the widget open
  private supResults: SupResult[] = []; // current search results

  constructor(
    private appConnector: AppConnector,
    private skillEngine: SkillEngine,
    private session: SessionCache,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCommandHandler(handler: (input: string, sourcePanelId?: string) => Promise<string>): void { this.commandHandler = handler; }
  setVisiblePanelsGetter(getter: () => string[]): void { this.getVisiblePanelIds = getter; }
  setSessionNotifier(fn: () => void): void { this.sessionNotifier = fn; }
  setSupSearcher(fn: (query: string) => Promise<SupResult[]>): void { this.supSearcher = fn; }
  setSupRefiner(fn: (message: string) => Promise<string>): void { this.supRefiner = fn; }
  setSupClearer(fn: () => void): void { this.supClearer = fn; }

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
      case "sup-use":
        await this.handleSupUse(wc, data as any);
        break;
      case "sup-refine":
        await this.handleSupRefine(wc, data as any);
        break;
      case "sup-dismiss":
        this.dismissSupWidget(wc);
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

  // ── sup: retrieve from memory ─────────────────────────

  private async handleSup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    if (!this.commandHandler) return;

    // Bare .sup → library browser
    if (!instruction?.trim()) {
      const result = await this.commandHandler("sup", appId);
      if (result === "__SUP_BROWSE__") {
        wc.executeJavaScript(`window.postMessage({type:'open-library'},'*')`).catch(() => {});
      }
      return;
    }

    // .sup . <skill/prompt> → direct inject from last capture (no widget)
    const dotMatch = instruction.match(/^\.\s*(.+)$/);
    if (dotMatch) {
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      try {
        const result = await this.commandHandler(`sup ${instruction}`, appId);
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "result");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // .sup <query> . <processor> → direct inject (user specified processor)
    const parts = instruction.split(/\s+/);
    const dotIdx = parts.indexOf(".");
    if (dotIdx > 0 && dotIdx < parts.length - 1) {
      const myOp = ++this.opId;
      this.notify(wc, "", "loading");
      try {
        const result = await this.commandHandler(`sup ${instruction}`, appId);
        if (this.opId !== myOp) return;
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "result");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // .sup <query> → open inline widget with search results
    if (!this.supSearcher) {
      this.notify(wc, "Search not available.", "error");
      return;
    }

    this.dismissSupWidget(wc);
    this.supClearer?.();

    const query = instruction.trim();
    await this.injectSupWidget(wc, query);
    this.supWidgetWc = wc;

    try {
      const results = await this.supSearcher(query);
      this.supResults = results;
      if (results.length === 0) {
        await this.updateSupWidgetResults(wc, [], "No matching context found.");
      } else {
        await this.updateSupWidgetResults(wc, results);
      }
    } catch (err) {
      await this.updateSupWidgetResults(wc, [], `Search failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Handle [use] click from widget — inject content into original text area. */
  private async handleSupUse(wc: WebContents, data: { index?: number; text?: string }): Promise<void> {
    let content = "";
    if (data.text) {
      content = data.text;
    } else if (typeof data.index === "number" && this.supResults[data.index]) {
      content = this.supResults[data.index].content;
    }
    if (content) {
      this.dismissSupWidget(wc);
      this.injectContent(wc, content);
    }
  }

  /** Handle refinement message from widget input. */
  private async handleSupRefine(wc: WebContents, data: { text?: string }): Promise<void> {
    const message = data.text?.trim();
    if (!message || !this.supRefiner) return;

    await this.appendSupMessage(wc, "user", message);
    await this.setSupLoading(wc, true);

    try {
      const result = await this.supRefiner(message);
      await this.setSupLoading(wc, false);
      await this.appendSupMessage(wc, "assistant", result);
    } catch (err) {
      await this.setSupLoading(wc, false);
      await this.appendSupMessage(wc, "error", `Failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Remove the sup widget from the page. */
  private dismissSupWidget(wc: WebContents): void {
    this.supWidgetWc = null;
    this.supResults = [];
    try {
      wc.executeJavaScript(`(function(){var w=document.getElementById('__yo-sup');if(w)w.remove();if(window.__yoSupEsc){document.removeEventListener('keydown',window.__yoSupEsc,true);window.__yoSupEsc=null;}})()`);
    } catch {}
  }

  // ── yo: capture or utilities ─────────────────────────

  private static readonly COMMAND_KEYWORDS = new Set([".sup", ".dip", ".drip"]);

  private async handleYo(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    // Subcommands routed through command parser
    const sub = instruction?.split(/\s+/)[0]?.toLowerCase();
    if (sub === "help" || sub === "skill" || sub === "layout") {
      if (this.commandHandler) {
        const result = await this.commandHandler(`yo ${instruction}`);
        if (result) this.notify(wc, result, "success");
      }
      return;
    }

    // Bare .yo (no instruction) — do nothing
    if (!instruction?.trim()) return;

    // Parse dot modifier: .yo . or .yo . <skill/prompt>
    const rawFirstWord = instruction?.split(/\s+/)[0]?.toLowerCase();
    const isDirectChain = rawFirstWord && YoInterceptor.COMMAND_KEYWORDS.has(rawFirstWord);
    const dotMatch = !isDirectChain ? instruction?.match(/^\.\s*(.*)?$/) : null;
    const currentOnly = !!dotMatch;
    const realInstruction = isDirectChain
      ? instruction
      : currentOnly ? (dotMatch![1]?.trim() || undefined) : undefined;

    // .yo without dot modifier and not a chain — not valid (queries moved to .sup)
    if (!currentOnly && !isDirectChain) return;

    // Check if what follows is a chained command
    const chainWord = realInstruction?.split(/\s+/)[0]?.toLowerCase();
    const isChainedCommand = isDirectChain || !!(currentOnly && chainWord && YoInterceptor.COMMAND_KEYWORDS.has(chainWord));

    // ── Capture path — grab panel content first
    const myOp = ++this.opId;
    this.notify(wc, "", "loading");
    const content = await this.grabPanels(wc, appId, !currentOnly);
    if (this.opId !== myOp) return; // cancelled
    if (!content) {
      this.notify(wc, "Could not grab content.", "error");
      return;
    }

    // Chained command: capture then run the chain
    if (isChainedCommand && this.commandHandler) {
      const ts = this.timestamp();
      this.session.capture(appId, content, `${ts}.md`, ts);
      this.session.copyToClipboard();
      this.sessionNotifier?.();
      await this.clearNotify(wc);
      this.notify(wc, `yo${currentOnly ? " ." : ""} \u2014 captured`, "success");
      const chainResult = await this.commandHandler(realInstruction!);
      if (this.opId !== myOp) return;
      if (chainResult) this.notify(wc, chainResult, "success");
      return;
    }

    // Dot modifier with instruction: capture + skill/LLM process → inject result into text area
    if (realInstruction && currentOnly && this.commandHandler) {
      try {
        const result = await this.commandHandler(`yo . ${realInstruction}`, appId);
        if (this.opId !== myOp) return; // cancelled
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "result");
      } catch (err) {
        if (this.opId !== myOp) return;
        this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // Bare .yo . — force capture into context store
    if (currentOnly && this.commandHandler) {
      await this.commandHandler("yo .", appId);
    }
    await this.clearNotify(wc);
    this.notify(wc, "captured", "success");
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

  // ── Sup widget injection ───────────────────────────────

  private async injectSupWidget(wc: WebContents, query: string): Promise<void> {
    const escaped = JSON.stringify(query);
    try {
      await wc.executeJavaScript(`
(function(){
var old=document.getElementById('__yo-sup');if(old)old.remove();
var w=document.createElement('div');w.id='__yo-sup';
w.style.cssText='position:fixed;z-index:999999;bottom:60px;right:16px;width:380px;max-height:480px;background:#1a1a1a;border:1px solid #333;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#ccc;overflow:hidden;';

// Header
var hdr=document.createElement('div');
hdr.style.cssText='padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
var title=document.createElement('span');title.style.cssText='color:#25C75E;font-weight:600;font-size:12px;';
title.textContent='.sup '+${escaped};
var closeBtn=document.createElement('div');closeBtn.textContent='\\u00d7';
closeBtn.style.cssText='width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#666;font-size:16px;border-radius:4px;';
closeBtn.onmouseenter=function(){closeBtn.style.color='#fff';closeBtn.style.background='#333';};
closeBtn.onmouseleave=function(){closeBtn.style.color='#666';closeBtn.style.background='none';};
closeBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'sup-dismiss'}));};
hdr.appendChild(title);hdr.appendChild(closeBtn);

// Body (results + messages)
var body=document.createElement('div');body.id='__yo-sup-body';
body.style.cssText='flex:1;overflow-y:auto;padding:8px 14px;min-height:60px;max-height:320px;';
// Loading indicator
var loading=document.createElement('div');loading.id='__yo-sup-loading';
loading.style.cssText='color:#666;font-size:12px;padding:12px 0;text-align:center;';
loading.textContent='searching...';
body.appendChild(loading);

// Input
var inputWrap=document.createElement('div');
inputWrap.style.cssText='padding:8px 10px;border-top:1px solid #333;flex-shrink:0;';
var input=document.createElement('input');input.id='__yo-sup-input';input.type='text';
input.placeholder='refine or ask about results...';
input.style.cssText='width:100%;background:#111;border:1px solid #333;border-radius:6px;padding:8px 10px;color:#ccc;font-size:12px;outline:none;box-sizing:border-box;';
input.onfocus=function(){input.style.borderColor='#25C75E';};
input.onblur=function(){input.style.borderColor='#333';};
input.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&input.value.trim()){
    e.preventDefault();e.stopPropagation();
    var msg=input.value.trim();input.value='';
    console.log('${PREFIX}'+JSON.stringify({type:'sup-refine',text:msg}));
  }
  if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation();
    console.log('${PREFIX}'+JSON.stringify({type:'sup-dismiss'}));
  }
},true);

inputWrap.appendChild(input);
w.appendChild(hdr);w.appendChild(body);w.appendChild(inputWrap);
document.body.appendChild(w);

// Focus input after a tick
setTimeout(function(){input.focus();},50);

// Escape key listener (global)
window.__yoSupEsc=function(e){
  if(e.key==='Escape'&&document.getElementById('__yo-sup')){
    e.preventDefault();e.stopPropagation();
    console.log('${PREFIX}'+JSON.stringify({type:'sup-dismiss'}));
  }
};
document.addEventListener('keydown',window.__yoSupEsc,true);
})()`);
    } catch {}
  }

  /** Update widget body with search results or an error message. */
  private async updateSupWidgetResults(wc: WebContents, results: SupResult[], errorMsg?: string): Promise<void> {
    const data = JSON.stringify(results.map((r, i) => ({
      i,
      title: r.title,
      panelId: r.panelId,
      age: r.age,
      preview: r.preview,
    })));
    const err = errorMsg ? JSON.stringify(errorMsg) : "null";
    try {
      await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-sup-body');if(!body)return;
body.innerHTML='';
var err=${err};
if(err){
  var msg=document.createElement('div');msg.style.cssText='color:#999;font-size:12px;padding:12px 0;text-align:center;';
  msg.textContent=err;body.appendChild(msg);return;
}
var results=${data};
results.forEach(function(r){
  var card=document.createElement('div');
  card.style.cssText='background:#222;border:1px solid #333;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:default;transition:border-color 0.15s;';
  card.onmouseenter=function(){card.style.borderColor='#444';};
  card.onmouseleave=function(){card.style.borderColor='#333';};

  var top=document.createElement('div');top.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
  var label=document.createElement('span');label.style.cssText='color:#25C75E;font-size:11px;font-weight:600;';
  label.textContent=r.title+' \\u00b7 '+r.age;
  var useBtn=document.createElement('div');useBtn.textContent='use';
  useBtn.style.cssText='color:#25C75E;font-size:11px;font-weight:600;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background 0.15s;';
  useBtn.onmouseenter=function(){useBtn.style.background='#25C75E22';};
  useBtn.onmouseleave=function(){useBtn.style.background='none';};
  useBtn.onclick=function(e){e.stopPropagation();console.log('${PREFIX}'+JSON.stringify({type:'sup-use',index:0}).replace('"index":0','"index":'+r.i));};
  top.appendChild(label);top.appendChild(useBtn);

  var preview=document.createElement('div');preview.style.cssText='color:#999;font-size:11px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;';
  preview.textContent=r.preview;

  card.appendChild(top);card.appendChild(preview);body.appendChild(card);
});
body.scrollTop=0;
})()`);
    } catch {}
  }

  /** Append a message to the widget conversation area. */
  private async appendSupMessage(wc: WebContents, role: "user" | "assistant" | "error", text: string): Promise<void> {
    const escaped = JSON.stringify(text);
    const isUser = role === "user";
    const isError = role === "error";
    try {
      await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-sup-body');if(!body)return;
var msg=document.createElement('div');
msg.style.cssText='padding:8px 0;border-top:1px solid #2a2a2a;margin-top:4px;';
var row=document.createElement('div');row.style.cssText='display:flex;justify-content:space-between;align-items:flex-start;';
var txt=document.createElement('div');
txt.style.cssText='font-size:12px;line-height:1.5;color:${isUser ? "#ccc" : isError ? "#ff5f57" : "#e0e0e0"};white-space:pre-wrap;word-break:break-word;flex:1;';
txt.textContent=${escaped};
row.appendChild(txt);
${!isUser && !isError ? `
var useBtn=document.createElement('div');useBtn.textContent='use';
useBtn.style.cssText='color:#25C75E;font-size:11px;font-weight:600;cursor:pointer;padding:2px 8px;border-radius:4px;margin-left:8px;flex-shrink:0;white-space:nowrap;transition:background 0.15s;';
useBtn.onmouseenter=function(){useBtn.style.background='#25C75E22';};
useBtn.onmouseleave=function(){useBtn.style.background='none';};
useBtn.onclick=function(){console.log('${PREFIX}'+JSON.stringify({type:'sup-use',text:${escaped}}));};
row.appendChild(useBtn);
` : ""}
msg.appendChild(row);
${isUser ? `
var label=document.createElement('div');label.style.cssText='color:#666;font-size:10px;margin-bottom:2px;';
label.textContent='you';msg.insertBefore(label,row);
` : ""}
body.appendChild(msg);body.scrollTop=body.scrollHeight;
})()`);
    } catch {}
  }

  /** Show/hide loading indicator in widget. */
  private async setSupLoading(wc: WebContents, loading: boolean): Promise<void> {
    try {
      await wc.executeJavaScript(`
(function(){
var body=document.getElementById('__yo-sup-body');if(!body)return;
var existing=document.getElementById('__yo-sup-thinking');
if(${loading}){
  if(existing)return;
  var el=document.createElement('div');el.id='__yo-sup-thinking';
  el.style.cssText='color:#666;font-size:11px;padding:6px 0;';el.textContent='thinking...';
  body.appendChild(el);body.scrollTop=body.scrollHeight;
}else{
  if(existing)existing.remove();
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
    type: "loading" | "success" | "error" | "result",
  ): Promise<void> {
    const loadingMessages = [
      "chilling...", "vibing...", "supping...", "cooking...",
      "thinking...", "brewing...", "manifesting...", "marinating...",
    ];
    const displayMsg = type === "loading"
      ? loadingMessages[Math.floor(Math.random() * loadingMessages.length)]
      : msg;
    const icon = type === "success" ? "\u2713 " : type === "error" ? "\u2717 " : type === "result" ? "\u2713 " : "";
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
  var words=['chilling...','vibing...','supping...','cooking...','thinking...','brewing...','manifesting...','marinating...'];
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
  ${autoRemove ? "setTimeout(function(){try{setText('');}catch(e){}},2500);" : ""}
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
