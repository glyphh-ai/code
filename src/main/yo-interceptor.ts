/**
 * YoInterceptor — intercepts yo/dip/drip typed inside app panels.
 *
 *   yo             → grab all visible panels → session cache + clipboard
 *   yo .           → grab current panel only → session cache + clipboard
 *   yo . <skill>   → capture active + skill process
 *   yo <query>     → search context store → LLM answer (via command parser)
 *   yo help        → open help overlay
 *   dip <args>     → panel navigation (via command parser)
 *   drip <effect>  → visual effect
 *
 * All UI (notifications, tool picker) is injected directly into the
 * app's DOM via executeJavaScript. Session content is also copied to
 * the system clipboard so users can paste into terminal/code/etc.
 */

import { WebContents } from "electron";
import { AppConnector } from "./app-connector";
import { SkillEngine } from "./skill-engine";
import { SessionCache } from "./session-cache";
import { executeCommand } from "./dom-bridge";
import type { YoChat } from "./yo-chat";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string, sourcePanelId?: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private getVisiblePanelIds: (() => string[]) | null = null;
  private sessionNotifier: (() => void) | null = null;
  constructor(
    private appConnector: AppConnector,
    private skillEngine: SkillEngine,
    private session: SessionCache,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCommandHandler(handler: (input: string, sourcePanelId?: string) => Promise<string>): void { this.commandHandler = handler; }
  setVisiblePanelsGetter(getter: () => string[]): void { this.getVisiblePanelIds = getter; }
  setSessionNotifier(fn: () => void): void { this.sessionNotifier = fn; }

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
var CMD_RE=/^\\.(yo|dip|drip)(?:\\s+([\\s\\S]+))?$/i;
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

  // ── yo: capture, query, or browse ─────────────────────

  private static readonly COMMAND_KEYWORDS = new Set([".dip", ".drip"]);

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

    // Parse dot modifier vs plain query
    const rawFirstWord = instruction?.split(/\s+/)[0]?.toLowerCase();
    const isDirectChain = rawFirstWord && YoInterceptor.COMMAND_KEYWORDS.has(rawFirstWord);
    const dotMatch = !isDirectChain ? instruction?.match(/^\.\s*(.*)?$/) : null;
    const currentOnly = !!dotMatch;
    const realInstruction = isDirectChain
      ? instruction
      : currentOnly ? (dotMatch![1]?.trim() || undefined) : instruction;

    // Check if what follows is a chained command
    const chainWord = realInstruction?.split(/\s+/)[0]?.toLowerCase();
    const isChainedCommand = isDirectChain || !!(currentOnly && chainWord && YoInterceptor.COMMAND_KEYWORDS.has(chainWord));

    // ── Query path (no dot, no chain) — skip panel grab, search context store
    if (realInstruction && !currentOnly && !isChainedCommand) {
      if (this.commandHandler) {
        this.notify(wc, "", "loading");
        try {
          const result = await this.commandHandler(`yo ${realInstruction}`, appId);
          await this.clearNotify(wc);
          if (result) this.notify(wc, result, "result");
        } catch (err) {
          this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
        }
      }
      return;
    }

    // ── Capture path — grab panel content first
    this.notify(wc, "", "loading");
    const content = await this.grabPanels(wc, appId, !currentOnly);
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
      if (chainResult) this.notify(wc, chainResult, "success");
      return;
    }

    // Dot modifier with instruction: capture + skill/LLM process
    if (realInstruction && currentOnly && this.commandHandler) {
      try {
        const result = await this.commandHandler(`yo . ${realInstruction}`, appId);
        await this.clearNotify(wc);
        if (result) this.notify(wc, result, "success");
      } catch (err) {
        this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      return;
    }

    // Bare yo (no args) — capture all visible panels
    const ts = this.timestamp();
    this.session.capture(appId, content, `${ts}.md`, ts);
    this.sessionNotifier?.();
    await this.clearNotify(wc);
    this.session.copyToClipboard();
    this.notify(wc, "yo \u2014 captured", "success");
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
