/**
 * YoInterceptor — intercepts yo/sup/dip/wassup typed inside app panels.
 *
 * Simple session model:
 *   yo           → grab all visible panels → session cache + clipboard
 *   yo .         → grab current panel only → session cache + clipboard
 *   yo <skill>   → grab all → skill process → session cache + clipboard
 *   yo . <skill> → grab current → skill process → session cache + clipboard
 *   yo help      → open help overlay
 *   sup <skill>  → session cache → skill process → inject result
 *   sup <text>   → session cache → LLM process → inject result
 *   sup          → session manager UI (future)
 *   dip <args>   → panel navigation (via command parser)
 *   wassup       → tool picker
 *   wassup <id>  → run tool with session context
 *
 * All UI (notifications, tool picker) is injected directly into the
 * app's DOM via executeJavaScript. Session content is also copied to
 * the system clipboard so users can paste into terminal/code/etc.
 */

import { WebContents } from "electron";
import { AppConnector } from "./app-connector";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { SessionCache } from "./session-cache";
import { ToolManager } from "./tool-manager";
import { executeCommand } from "./dom-bridge";
import type { YoChat } from "./yo-chat";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private getVisiblePanelIds: (() => string[]) | null = null;

  constructor(
    private appConnector: AppConnector,
    private library: Library,
    private skillEngine: SkillEngine,
    private session: SessionCache,
    private toolManager: ToolManager,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCommandHandler(handler: (input: string) => Promise<string>): void { this.commandHandler = handler; }
  setVisiblePanelsGetter(getter: () => string[]): void { this.getVisiblePanelIds = getter; }

  /** Start watching a panel's webContents for commands. */
  activate(wc: WebContents, appId: string): void {
    this.deactivate(wc.id);

    const inject = () => this.inject(wc);
    const onConsole = (_e: any, _l: any, msg: string) => {
      if (typeof msg !== "string" || !msg.startsWith(PREFIX)) return;
      try {
        this.dispatch(wc, appId, JSON.parse(msg.slice(PREFIX.length)));
      } catch { /* ignore malformed */ }
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
var CMD_RE=/^(yo|sup|dip|wassup)(?:\\s+(.+))?$/i;
var lastText='';
var handled=false;

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
  if(handled)return;handled=true;
  var m=text.match(CMD_RE);if(!m)return;
  var cmd=m[1].toLowerCase();
  var arg=(m[2]||'').trim()||null;
  window.__yoLastEl=srcEl||ed();
  console.log('${PREFIX}'+JSON.stringify({type:cmd,instruction:arg}));
}

document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||e.shiftKey)return;
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  if(!CMD_RE.test(t))return;
  handled=false;
  e.preventDefault();e.stopImmediatePropagation();
  var srcEl=el;
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
  fire(t,srcEl);
},true);

var lastEl=null;
document.addEventListener('input',function(){
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  if(CMD_RE.test(t)){lastText=t;lastEl=el;handled=false;}
  else if(lastText&&t.length===0){
    var saved=lastText;var sEl=lastEl;lastText='';lastEl=null;
    fire(saved,sEl);
  }else if(!CMD_RE.test(t)){lastText='';lastEl=null;}
},true);

document.addEventListener('keyup',function(e){
  if(e.key!=='Enter')return;
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
        await this.handleDip(wc, data.instruction ?? undefined);
        break;
      case "wassup":
        await this.handleWassup(wc, appId, data.instruction ?? undefined);
        break;
    }
  }

  // ── dip ───────────────────────────────────────────────

  private async handleDip(wc: WebContents, args?: string): Promise<void> {
    const cmd = args ? `dip ${args}` : "dip back";
    if (this.commandHandler) {
      const result = await this.commandHandler(cmd);
      if (result) this.notify(wc, result, "success");
    }
  }

  // ── yo: capture → session + clipboard ─────────────────
  //
  //   yo           → grab all panels → session + clipboard
  //   yo .         → grab current panel → session + clipboard
  //   yo <skill>   → grab all → skill → session + clipboard
  //   yo . <skill> → grab current → skill → session + clipboard
  //   yo help      → open help overlay

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

    // Parse dot modifier: "yo ." or "yo . <skill>"
    const dotMatch = instruction?.match(/^\.\s*(.*)?$/);
    const currentOnly = !!dotMatch;
    const realInstruction = currentOnly ? (dotMatch![1]?.trim() || undefined) : instruction;

    // Grab content
    this.notify(wc, "", "loading");
    const content = await this.grabPanels(wc, appId, !currentOnly);
    if (!content) {
      this.notify(wc, "Could not grab content.", "error");
      return;
    }

    // Process with skill/LLM if instruction given
    let finalContent = content;
    if (realInstruction) {
      try {
        // Check for known skill
        const knownSkill = /^\S+$/.test(realInstruction)
          ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === realInstruction.toLowerCase())
          : undefined;

        if (knownSkill) {
          finalContent = await this.skillEngine.process(content, knownSkill);
        } else if (this.yoChat) {
          finalContent = await this.yoChat.executeInline("yo", realInstruction, appId, content);
        }
      } catch (err) {
        this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
        return;
      }
    }

    // Store in session + copy to clipboard
    if (currentOnly) {
      this.session.capture(appId, finalContent);
    } else {
      // For multi-panel grab, store each panel separately was complex.
      // Just store the combined result under the source panel.
      this.session.capture(appId, finalContent);
    }
    this.session.copyToClipboard();

    const label = realInstruction ? `yo ${realInstruction}` : "yo";
    this.notify(wc, `${label} \u2014 captured + copied`, "success");
  }

  // ── sup: session → process → inject ───────────────────
  //
  //   sup <skill>   → session → skill → inject
  //   sup <text>    → session → LLM → inject
  //   sup           → inject raw session content (paste shortcut)

  private async handleSup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    if (!this.session.hasContent()) {
      this.notify(wc, "Nothing captured yet. Use yo first.", "error");
      return;
    }

    // Bare "sup" → inject raw session content (like paste but smarter)
    if (!instruction) {
      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, this.session.get());
      if (!injected) {
        this.notify(wc, "Session content copied to clipboard. Paste with Cmd+V.", "success");
        this.session.copyToClipboard();
      }
      return;
    }

    // Process session content with skill or LLM
    this.notify(wc, "", "loading");
    const sessionContent = this.session.get();

    try {
      // Check for known skill
      const knownSkill = /^\S+$/.test(instruction)
        ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === instruction.toLowerCase())
        : undefined;

      let result: string;
      if (knownSkill) {
        result = await this.skillEngine.process(sessionContent, knownSkill);
      } else if (this.yoChat) {
        result = await this.yoChat.executeInline("sup", instruction, appId, sessionContent);
      } else {
        this.notify(wc, "No AI engine available.", "error");
        return;
      }

      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, result);
      if (!injected) {
        this.notify(wc, result, "success");
      }
    } catch (err) {
      this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── wassup: tools ─────────────────────────────────────
  //
  //   wassup        → show tool picker
  //   wassup <id>   → run matching tool with session context
  //   wassup <text> → LLM improvises with session context

  private async handleWassup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    // Bare "wassup" → show tool picker
    if (!instruction) {
      this.showToolPicker(wc);
      return;
    }

    // Search for matching tool
    const tool = this.toolManager.search(instruction);

    this.notify(wc, "", "loading");
    try {
      let result: string;
      if (tool && this.yoChat) {
        // Run tool prompt with session context
        const context = this.session.hasContent() ? this.session.get() : undefined;
        result = await this.yoChat.executeInline("wassup", tool.prompt, appId, context);
      } else if (this.yoChat) {
        // No matching tool → LLM improvises
        const context = this.session.hasContent() ? this.session.get() : undefined;
        result = await this.yoChat.executeInline("wassup", instruction, appId, context);
      } else {
        this.notify(wc, "No AI engine available.", "error");
        return;
      }

      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, result);
      if (!injected) {
        this.notify(wc, result, "success");
      }
    } catch (err) {
      this.notify(wc, `wassup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── Tool picker (injected DOM) ────────────────────────

  private async showToolPicker(wc: WebContents): Promise<void> {
    const tools = this.toolManager.list().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }));
    const data = JSON.stringify(tools);
    try {
      await wc.executeJavaScript(`
(function(){
var m=document.getElementById('__yo_modal');if(m)m.remove();
var tools=${data};
var ov=document.createElement('div');ov.id='__yo_modal';
ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;backdrop-filter:blur(2px);';
var card=document.createElement('div');
card.style.cssText='background:#151515;border:1px solid #2a2a2a;border-radius:10px;padding:24px;max-width:480px;width:90%;max-height:60vh;box-shadow:0 16px 48px rgba(0,0,0,0.6);font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;transform:scale(0.96);transition:transform 0.2s;display:flex;flex-direction:column;';
var hdr=document.createElement('div');hdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
var t=document.createElement('div');t.textContent='wassup';
t.style.cssText='font-size:15px;font-weight:600;color:#e0e0e0;';
hdr.appendChild(t);
var closeBtn=document.createElement('button');closeBtn.textContent='\\u00d7';
closeBtn.style.cssText='background:none;border:none;color:#555;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;';
closeBtn.onclick=function(){ov.remove();};
hdr.appendChild(closeBtn);
card.appendChild(hdr);
var pi=document.createElement('input');pi.type='text';
pi.placeholder='run a tool or describe what you need...';
pi.style.cssText='width:100%;box-sizing:border-box;background:#1e1e1e;border:1px solid #333;color:#e8e8e8;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:12px;outline:none;';
pi.onfocus=function(){pi.style.borderColor='#555';};
pi.onblur=function(){pi.style.borderColor='#333';};
card.appendChild(pi);
pi.addEventListener('keydown',function(e){
  if(e.key==='Escape'){ov.remove();return;}
  if(e.key==='Enter'&&pi.value.trim()){
    ov.remove();
    console.log('${PREFIX}'+JSON.stringify({type:'wassup',instruction:pi.value.trim()}));
  }
});
var list=document.createElement('div');list.style.cssText='flex:1;overflow-y:auto;min-height:0;';
card.appendChild(list);
function render(){
  list.innerHTML='';
  var q=pi.value.toLowerCase();
  var filtered=tools.filter(function(t){return !q||t.name.toLowerCase().includes(q)||t.description.toLowerCase().includes(q);});
  if(filtered.length===0){
    var em=document.createElement('div');
    em.textContent=tools.length===0?'No tools yet. Create one in Settings > Tools.':'No matches. Press Enter to let AI handle it.';
    em.style.cssText='color:#555;text-align:center;padding:20px;font-size:13px;';
    list.appendChild(em);
    return;
  }
  filtered.forEach(function(tool){
    var item=document.createElement('div');
    item.style.cssText='display:flex;flex-direction:column;gap:2px;padding:8px 12px;cursor:pointer;border-radius:6px;margin-bottom:1px;transition:background 0.1s;';
    item.onmouseenter=function(){this.style.background='#1e1e1e';};
    item.onmouseleave=function(){this.style.background='transparent';};
    var n=document.createElement('div');n.textContent=tool.name;
    n.style.cssText='font-size:13px;font-weight:500;color:#ccc;';
    item.appendChild(n);
    if(tool.description){
      var d=document.createElement('div');d.textContent=tool.description;
      d.style.cssText='font-size:11px;color:#555;';
      item.appendChild(d);
    }
    item.onclick=function(){ov.remove();
      console.log('${PREFIX}'+JSON.stringify({type:'wassup',instruction:tool.id}));};
    list.appendChild(item);
  });
}
pi.oninput=function(){render();};
render();
ov.onclick=function(e){if(e.target===ov)ov.remove();};
ov.appendChild(card);
document.body.appendChild(ov);
requestAnimationFrame(function(){ov.style.opacity='1';card.style.transform='scale(1)';pi.focus();});
})();`);
    } catch {}
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
    type: "loading" | "success" | "error",
  ): Promise<void> {
    const loadingMessages = [
      "chilling...", "vibing...", "supping...", "cooking...",
      "thinking...", "brewing...", "manifesting...", "marinating...",
    ];
    const displayMsg = type === "loading"
      ? loadingMessages[Math.floor(Math.random() * loadingMessages.length)]
      : msg;
    const icon = type === "success" ? "\u2713 " : type === "error" ? "\u2717 " : "";
    const text = icon + displayMsg;
    const autoRemove = type !== "loading";
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
  var fi=0;
  setText(frames[0]+' '+text+'   ');
  try{if(el.setSelectionRange)el.setSelectionRange(0,0);
  else{var s=window.getSelection();if(s){var r=document.createRange();r.setStart(el,0);r.collapse(true);s.removeAllRanges();s.addRange(r);}}}catch(e){}
  window.__yoNoteIv=setInterval(function(){
    fi++;setText(frames[fi%frames.length]+' '+text+'   ');
    try{if(el.setSelectionRange)el.setSelectionRange(0,0);
    else{var s=window.getSelection();if(s){var r=document.createRange();r.setStart(el,0);r.collapse(true);s.removeAllRanges();s.addRange(r);}}}catch(e){}
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
