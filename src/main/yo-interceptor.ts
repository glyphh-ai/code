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
 *   wassup       → list skills
 *   wassup <name> <instructions> → LLM creates a skill
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
import { executeCommand } from "./dom-bridge";
import type { YoChat } from "./yo-chat";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private getVisiblePanelIds: (() => string[]) | null = null;
  private sessionNotifier: (() => void) | null = null;
  constructor(
    private appConnector: AppConnector,
    private library: Library,
    private skillEngine: SkillEngine,
    private session: SessionCache,
  ) {}

  setYoChat(chat: YoChat): void { this.yoChat = chat; }
  setCommandHandler(handler: (input: string) => Promise<string>): void { this.commandHandler = handler; }
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
var CMD_RE=/^\\.(yo|sup|dip|drip|wassup)(?:\\s+(.+))?$/i;
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
      case "drip":
        // Delegate to command parser which sends drip-effect to renderer
        if (this.commandHandler) {
          const cmd = data.instruction ? `drip ${data.instruction}` : "drip";
          await this.commandHandler(cmd);
        }
        break;
      case "sup-load-file": {
        const name = data.instruction;
        if (name) {
          const content = this.library.read(name);
          if (content) {
            this.session.capture("library", content, name + ".md", name);
            this.session.copyToClipboard();
            this.sessionNotifier?.();
            this.notify(wc, `Loaded: ${name}.md \u2014 copied to clipboard`, "success");
          } else {
            this.notify(wc, `Not found: ${name}`, "error");
          }
        }
        break;
      }
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

  private static readonly COMMAND_KEYWORDS = new Set(["yo", "sup", "dip", "drip", "wassup"]);

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

    // Check if realInstruction starts with a command keyword → chained command
    // e.g. "yo . dip gmail" → capture active panel, then run "dip gmail"
    const firstWord = realInstruction?.split(/\s+/)[0]?.toLowerCase();
    const isChainedCommand = firstWord && YoInterceptor.COMMAND_KEYWORDS.has(firstWord);

    // Grab content
    this.notify(wc, "", "loading");
    const content = await this.grabPanels(wc, appId, !currentOnly);
    if (!content) {
      this.notify(wc, "Could not grab content.", "error");
      return;
    }

    // If chained command, do bare capture then delegate rest to command handler
    if (isChainedCommand && this.commandHandler) {
      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
      this.session.capture(appId, content, `${ts}.md`, ts);
      this.library.write(ts, content);
      this.session.copyToClipboard();
      this.sessionNotifier?.();
      await this.clearNotify(wc);
      this.notify(wc, `yo${currentOnly ? " ." : ""} — captured`, "success");
      // Execute the chained command
      const chainResult = await this.commandHandler(realInstruction!);
      if (chainResult) this.notify(wc, chainResult, "success");
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

    // Auto-name: date-time for bare yo, skill label for yo <skill>
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
    const skillLabel = realInstruction?.split(/\s+/)[0] || undefined;
    const sessionLabel = skillLabel ? `${skillLabel}.md` : `${ts}.md`;
    this.session.capture(appId, finalContent, sessionLabel, skillLabel || ts);
    this.library.write(skillLabel || ts, finalContent);
    this.sessionNotifier?.();

    const label = realInstruction ? `yo ${realInstruction}` : "yo";
    await this.clearNotify(wc);

    this.session.copyToClipboard();
    this.notify(wc, `${label} \u2014 captured`, "success");
  }

  // ── sup: session → process → inject ───────────────────
  //
  //   sup <skill>   → session → skill → inject
  //   sup <text>    → session → LLM → inject
  //   sup           → inject raw session content (paste shortcut)

  private async handleSup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    // Bare "sup" → always show library browser
    if (!instruction) {
      this.showSupBrowser(wc);
      return;
    }

    // sup . → paste session content directly, no LLM
    if (instruction === ".") {
      if (!this.session.hasContent()) {
        this.notify(wc, "No context loaded. Use yo to capture first.", "error");
        return;
      }
      const content = this.session.get();
      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, content);
      if (!injected) {
        this.session.copyToClipboard();
        this.notify(wc, "Context copied to clipboard", "success");
      }
      return;
    }

    // No session content + instruction → try loading from library by name first
    if (!this.session.hasContent()) {
      const name = instruction.split(/\s+/)[0];
      const content = this.library.read(name);
      if (content) {
        this.session.capture("library", content, name + ".md", name);
        this.session.copyToClipboard();
        this.sessionNotifier?.();
        await this.clearNotify(wc);
        const injected = await this.injectContent(wc, content);
        if (!injected) {
          this.notify(wc, `Loaded: ${name}.md \u2014 copied to clipboard`, "success");
        }
        return;
      }
      this.showSupBrowser(wc);
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

  // ── wassup: skill creation ─────────────────────────────
  //
  //   wassup             → list skills
  //   wassup <name> <instructions> → LLM creates a skill

  private async handleWassup(wc: WebContents, _appId: string, instruction?: string): Promise<void> {
    // Bare "wassup" → list skills
    if (!instruction) {
      const skills = this.skillEngine.listSkills();
      if (skills.length === 0) {
        this.notify(wc, "No skills yet. Create one: wassup <name> <instructions>", "success");
      } else {
        this.notify(wc, `Skills: ${skills.join(", ")}`, "success");
      }
      return;
    }

    const parts = instruction.split(/\s+/);
    const name = parts[0];

    if (parts.length === 1) {
      // Single word → check if existing skill
      const prompt = this.skillEngine.readSkill(name);
      if (prompt !== null) {
        this.notify(wc, `Skill "${name}" exists. To recreate: wassup ${name} <instructions>`, "success");
      } else {
        this.notify(wc, `Create it: wassup ${name} <instructions>`, "success");
      }
      return;
    }

    // wassup <name> <instructions...> → LLM writes skill prompt
    if (!this.yoChat) {
      this.notify(wc, "No AI engine available.", "error");
      return;
    }

    const instructions = parts.slice(1).join(" ");
    this.notify(wc, "", "loading");

    try {
      const result = await this.yoChat.executeInline(
        "wassup",
        `Write a skill prompt (system prompt) for a skill called "${name}". The user's instructions for what this skill should do: ${instructions}\n\nRespond with ONLY the skill prompt text, nothing else. No markdown fencing, no explanation.`,
        _appId,
      );

      this.skillEngine.createSkill(name, result.trim());
      this.notify(wc, `Skill created: ${name}`, "success");
    } catch (err) {
      this.notify(wc, `wassup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── Sup browser (injected DOM) ─────────────────────────

  private async showSupBrowser(wc: WebContents): Promise<void> {
    const files = this.library.list();
    // Pre-read file contents so view works without round-trips
    const fileData = files.map((name) => ({
      name,
      content: this.library.read(name) || "",
    }));
    const data = JSON.stringify(fileData);
    try {
      await wc.executeJavaScript(`
(function(){
var m=document.getElementById('__yo_modal');if(m)m.remove();
var fileData=${data};
var names=fileData.map(function(f){return f.name;});
var PREFIX='${PREFIX}';
var ov=document.createElement('div');ov.id='__yo_modal';
ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.5);display:flex;align-items:flex-start;justify-content:center;padding-top:60px;opacity:0;transition:opacity 0.2s;backdrop-filter:blur(2px);';
var card=document.createElement('div');
card.style.cssText='background:#111;border:1px solid #222;border-radius:12px;padding:0;width:520px;max-height:70vh;box-shadow:0 16px 48px rgba(0,0,0,0.6);font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;transform:scale(0.96);transition:transform 0.2s;display:flex;flex-direction:column;overflow:hidden;';
var hdr=document.createElement('div');hdr.style.cssText='display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #1e1e1e;';
var si=document.createElement('input');si.type='text';si.placeholder='search library...';
si.style.cssText='flex:1;height:30px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;padding:0 12px;color:#e0e0e0;font-size:13px;font-family:monospace;outline:none;';
si.onfocus=function(){si.style.borderColor='#25C75E';};
si.onblur=function(){si.style.borderColor='#2a2a2a';};
hdr.appendChild(si);
var cb=document.createElement('button');cb.textContent='\\u00d7';
cb.style.cssText='background:none;border:none;color:#555;font-size:20px;cursor:pointer;padding:0 4px;line-height:1;';
cb.onclick=function(){ov.remove();};
hdr.appendChild(cb);
card.appendChild(hdr);
var body=document.createElement('div');body.style.cssText='flex:1;overflow-y:auto;min-height:0;';
card.appendChild(body);

function showList(filtered){
  body.innerHTML='';
  si.style.display='';
  var shown=filtered||names;
  if(shown.length===0){
    var em=document.createElement('div');
    em.textContent=names.length===0?'Library is empty. Use yo to capture content.':'No matches.';
    em.style.cssText='color:#555;text-align:center;padding:24px;font-size:13px;';
    body.appendChild(em);
    return;
  }
  shown.slice(0,20).forEach(function(name){
    var fd=fileData.find(function(f){return f.name===name;});
    var row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:8px;padding:10px 16px;cursor:pointer;border-bottom:1px solid #161616;transition:background 0.1s;';
    row.onmouseenter=function(){this.style.background='#1a1a1a';};
    row.onmouseleave=function(){this.style.background='';};
    var left=document.createElement('div');left.style.cssText='flex:1;min-width:0;';
    var n=document.createElement('div');n.textContent=name+'.md';
    n.style.cssText='font-size:13px;font-family:monospace;color:#ccc;';
    left.appendChild(n);
    if(fd&&fd.content){
      var snip=document.createElement('div');
      snip.textContent=fd.content.slice(0,80).replace(/\\n/g,' ')+(fd.content.length>80?'...':'');
      snip.style.cssText='font-size:11px;color:#555;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      left.appendChild(snip);
    }
    row.appendChild(left);
    var btns=document.createElement('div');btns.style.cssText='display:flex;gap:6px;flex-shrink:0;';
    var vb=document.createElement('button');vb.textContent='View';
    vb.style.cssText='background:#1a1a1a;border:1px solid #2a2a2a;color:#999;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;transition:all 0.1s;';
    vb.onmouseenter=function(){vb.style.color='#fff';vb.style.borderColor='#444';};
    vb.onmouseleave=function(){vb.style.color='#999';vb.style.borderColor='#2a2a2a';};
    vb.onclick=function(e){e.stopPropagation();showPreview(name);};
    btns.appendChild(vb);
    var lb=document.createElement('button');lb.textContent='Load';
    lb.style.cssText='background:#25C75E;border:1px solid #25C75E;color:#fff;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;transition:opacity 0.1s;';
    lb.onmouseenter=function(){lb.style.opacity='0.85';};
    lb.onmouseleave=function(){lb.style.opacity='1';};
    lb.onclick=function(e){e.stopPropagation();ov.remove();
      console.log(PREFIX+JSON.stringify({type:'sup-load-file',instruction:name}));};
    btns.appendChild(lb);
    row.appendChild(btns);
    body.appendChild(row);
  });
}

function showPreview(name){
  var fd=fileData.find(function(f){return f.name===name;});
  if(!fd)return;
  si.style.display='none';
  body.innerHTML='';
  var ph=document.createElement('div');ph.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #1e1e1e;';
  var pn=document.createElement('span');pn.textContent=name+'.md';
  pn.style.cssText='font-size:13px;font-weight:600;font-family:monospace;color:#fff;';
  ph.appendChild(pn);
  var pa=document.createElement('div');pa.style.cssText='display:flex;gap:6px;';
  var plb=document.createElement('button');plb.textContent='Load as Context';
  plb.style.cssText='background:#25C75E;border:1px solid #25C75E;color:#fff;font-size:11px;font-weight:500;padding:4px 12px;border-radius:4px;cursor:pointer;';
  plb.onclick=function(){ov.remove();
    console.log(PREFIX+JSON.stringify({type:'sup-load-file',instruction:name}));};
  pa.appendChild(plb);
  var bb=document.createElement('button');bb.textContent='Back';
  bb.style.cssText='background:#1a1a1a;border:1px solid #2a2a2a;color:#999;font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;';
  bb.onclick=function(){showList();si.style.display='';si.focus();};
  pa.appendChild(bb);
  ph.appendChild(pa);
  body.appendChild(ph);
  var pre=document.createElement('pre');
  pre.textContent=fd.content||'(empty)';
  pre.style.cssText='padding:16px;margin:0;font-size:12px;font-family:monospace;color:#bbb;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;background:#0a0a0a;max-height:400px;overflow-y:auto;';
  body.appendChild(pre);
}

si.oninput=function(){
  var q=si.value.trim().toLowerCase();
  if(!q){showList();return;}
  showList(names.filter(function(f){return f.toLowerCase().includes(q);}));
};
showList();
si.addEventListener('keydown',function(e){
  if(e.key==='Escape'){ov.remove();return;}
});
ov.onclick=function(e){if(e.target===ov)ov.remove();};
ov.appendChild(card);
document.body.appendChild(ov);
requestAnimationFrame(function(){ov.style.opacity='1';card.style.transform='scale(1)';si.focus();});
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
