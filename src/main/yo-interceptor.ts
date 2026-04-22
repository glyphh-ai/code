/**
 * YoInterceptor — intercepts yo/sup/dip/drip/waz/council typed inside app panels.
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
  private modeColor = "#25C75E"; // current agent mode color (ask=green, plan=blue, auto=orange)
  private lastAgentResult: (() => string) | null = null;
  private captureStore: CaptureStore | null = null;

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
  setLastAgentResult(fn: () => string): void { this.lastAgentResult = fn; }
  setModeColor(color: string): void { this.modeColor = color; }
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
var CMD_RE=/^\\.(yo|sup|dip|drip|waz|council)(?:\\s+([\\s\\S]+))?$/i;
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

// ── Command overlay for business users ──────────────────
(function(){
var dot=null,pop=null,promptRow=null,promptInput=null,activeCmd=null;
var currentEl=null;

function createDot(){
  if(dot)return;
  dot=document.createElement('div');
  dot.id='__yo-cmd-dot';
  dot.innerHTML='.';
  dot.style.cssText='position:absolute;z-index:2147483646;width:22px;height:22px;border-radius:50%;background:rgba(37,199,94,0.12);color:rgba(37,199,94,0.45);font-size:16px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:none;align-items:center;justify-content:center;cursor:pointer;transition:opacity 0.15s,background 0.15s;pointer-events:auto;line-height:22px;text-align:center;user-select:none;';
  dot.addEventListener('mouseenter',function(){dot.style.background='rgba(37,199,94,0.25)';dot.style.color='rgba(37,199,94,0.8)';});
  dot.addEventListener('mouseleave',function(){dot.style.background='rgba(37,199,94,0.12)';dot.style.color='rgba(37,199,94,0.45)';});
  dot.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();togglePop();});
  document.body.appendChild(dot);
}

function positionDot(el){
  if(!dot||!el)return;
  var r=el.getBoundingClientRect();
  if(r.width===0&&r.height===0){dot.style.display='none';return;}
  dot.style.display='flex';
  dot.style.top=(window.scrollY+r.top+Math.min(r.height/2-11,r.height-26))+'px';
  dot.style.left=(window.scrollX+r.right-28)+'px';
}

function createPop(){
  if(pop)return;
  pop=document.createElement('div');
  pop.id='__yo-cmd-pop';
  pop.style.cssText='position:absolute;z-index:2147483647;display:none;background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:6px;min-width:180px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

  // Natural language input at top
  var nlRow=document.createElement('div');
  nlRow.style.cssText='padding:4px 4px 6px;border-bottom:1px solid #2a2a2a;margin-bottom:4px;';
  var nlInput=document.createElement('input');
  nlInput.id='__yo-nl-input';
  nlInput.type='text';
  nlInput.placeholder='Ask anything...';
  nlInput.style.cssText='width:100%;box-sizing:border-box;background:#111;border:1px solid #333;border-radius:6px;padding:8px 10px;color:#e0e0e0;font-size:12px;font-family:inherit;outline:none;';
  nlInput.addEventListener('focus',function(){nlInput.style.borderColor='#25C75E';});
  nlInput.addEventListener('blur',function(){nlInput.style.borderColor='#333';});
  nlInput.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&nlInput.value.trim()){
      e.preventDefault();e.stopPropagation();
      // Send to yo agent with > (search + inject)
      fireCmd('yo','> '+nlInput.value.trim());
      closePop();
    }
    if(e.key==='Escape'){closePop();}
  });
  nlRow.appendChild(nlInput);
  pop.appendChild(nlRow);

  var cmds=[
    {icon:'\\u{1F50D}',label:'Pull',desc:'Search your history',cmd:'yo',args:'>'},
    {icon:'\\u{1F4CB}',label:'Capture',desc:'Grab this screen',cmd:'sup',args:null},
    {icon:'\\u{2728}',label:'Process',desc:'Transform with a skill',cmd:'sup',args:'.'},
    {icon:'\\u{1F4C2}',label:'Navigate',desc:'Switch panels',cmd:'dip',args:null},
  ];

  cmds.forEach(function(c){
    var row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;transition:background 0.1s;';
    row.innerHTML='<span style="font-size:16px;width:24px;text-align:center;">'+c.icon+'</span><div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:500;color:#e0e0e0;">'+c.label+'</div><div style="font-size:10px;color:#666;margin-top:1px;">'+c.desc+'</div></div>';
    row.addEventListener('mouseenter',function(){row.style.background='#252525';});
    row.addEventListener('mouseleave',function(){row.style.background='none';});
    row.addEventListener('mousedown',function(e){
      e.preventDefault();e.stopPropagation();
      handleCmd(c);
    });
    pop.appendChild(row);
  });

  // Divider + utility row
  var utilDiv=document.createElement('div');
  utilDiv.style.cssText='display:flex;gap:4px;padding:6px 4px 2px;border-top:1px solid #2a2a2a;margin-top:4px;';
  var utils=[
    {label:'\\u{2728} Ask Yo',action:function(){fireCmd('yo','');closePop();}},
    {label:'\\u{2753} Help',action:function(){fireCmd('yo','help');closePop();}},
    {label:'\\u{1F4CA} Dashboard',action:function(){
      console.log('${PREFIX}'+JSON.stringify({type:'__open_dashboard',_nonce:_n}));
      closePop();
    }},
  ];
  utils.forEach(function(u){
    var btn=document.createElement('div');
    btn.style.cssText='flex:1;text-align:center;padding:7px 4px;border-radius:6px;cursor:pointer;font-size:11px;color:#999;transition:background 0.1s,color 0.1s;';
    btn.textContent=u.label;
    btn.addEventListener('mouseenter',function(){btn.style.background='#252525';btn.style.color='#e0e0e0';});
    btn.addEventListener('mouseleave',function(){btn.style.background='none';btn.style.color='#999';});
    btn.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();u.action();});
    utilDiv.appendChild(btn);
  });
  pop.appendChild(utilDiv);

  // Prompt input row for Pull/Process (hidden by default)
  promptRow=document.createElement('div');
  promptRow.style.cssText='display:none;padding:6px 4px 2px;border-top:1px solid #2a2a2a;margin-top:4px;';
  promptRow.innerHTML='<div id="__yo-prompt-label" style="font-size:10px;color:#666;margin-bottom:4px;padding:0 6px;"></div>';
  promptInput=document.createElement('input');
  promptInput.type='text';
  promptInput.placeholder='Type here...';
  promptInput.style.cssText='width:100%;box-sizing:border-box;background:#111;border:1px solid #333;border-radius:6px;padding:7px 10px;color:#e0e0e0;font-size:12px;font-family:inherit;outline:none;';
  promptInput.addEventListener('focus',function(){promptInput.style.borderColor='#25C75E';});
  promptInput.addEventListener('blur',function(){promptInput.style.borderColor='#333';});
  promptInput.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&promptInput.value.trim()){
      e.preventDefault();e.stopPropagation();
      submitPrompt();
    }
    if(e.key==='Escape'){closePop();}
  });
  promptRow.appendChild(promptInput);
  pop.appendChild(promptRow);

  document.body.appendChild(pop);
}

function handleCmd(c){
  if(c.args==='>'||c.args==='.'){
    // Needs a prompt — show input
    activeCmd=c;
    var label=pop.querySelector('#__yo-prompt-label');
    if(c.args==='>')label.textContent='Search your captures:';
    else if(c.args==='.')label.textContent='Skill or instruction:';
    promptRow.style.display='block';
    promptInput.value='';
    setTimeout(function(){promptInput.focus();},50);
    return;
  }
  if(c.cmd==='dip'){
    // Show panel list or just fire dip back
    fireCmd('yo','');
    closePop();
    return;
  }
  // Direct execution
  fireCmd(c.cmd,c.args||'');
  closePop();
}

function submitPrompt(){
  if(!activeCmd)return;
  var val=promptInput.value.trim();
  if(!val)return;
  var fullArg=activeCmd.args+' '+val;
  fireCmd(activeCmd.cmd,fullArg);
  closePop();
}

function fireCmd(cmd,args){
  window.__yoLastEl=currentEl;
  var instruction=args||null;
  console.log('${PREFIX}'+JSON.stringify({type:cmd,instruction:instruction,_nonce:_n}));
}

function togglePop(){
  createPop();
  if(pop.style.display!=='none'){closePop();return;}
  // Reset state
  activeCmd=null;
  if(promptRow)promptRow.style.display='none';
  // Position below the dot
  var dr=dot.getBoundingClientRect();
  pop.style.display='block';
  pop.style.top=(window.scrollY+dr.bottom+6)+'px';
  pop.style.left=(window.scrollX+dr.right-pop.offsetWidth)+'px';
  // Clamp to viewport
  var pr=pop.getBoundingClientRect();
  if(pr.right>window.innerWidth)pop.style.left=(window.scrollX+window.innerWidth-pr.width-8)+'px';
  if(pr.bottom>window.innerHeight)pop.style.top=(window.scrollY+dr.top-pr.height-6)+'px';
}

function closePop(){
  if(pop)pop.style.display='none';
  activeCmd=null;
}

// Track focused inputs and show the dot
var focusTimer=null;
function onFocus(e){
  var el=e.target;
  if(!el||!el.getBoundingClientRect)return;
  if(el.id&&el.id.startsWith('__yo'))return;
  var tag=el.tagName;
  var isInput=tag==='INPUT'||tag==='TEXTAREA'||el.isContentEditable||
    (el.getAttribute&&el.getAttribute('role')==='textbox')||
    (el.getAttribute&&el.getAttribute('contenteditable')&&el.getAttribute('contenteditable')!=='false');
  if(!isInput)return;
  if(tag==='INPUT'&&el.type&&!['text','search','email','url',''].includes(el.type))return;
  currentEl=el;
  createDot();
  positionDot(el);
}
function onBlur(){
  clearTimeout(focusTimer);
  focusTimer=setTimeout(function(){
    // Don't hide if focus moved to the popover
    var a=document.activeElement;
    if(a&&a.id&&a.id.startsWith('__yo'))return;
    if(dot)dot.style.display='none';
    closePop();
    currentEl=null;
  },200);
}

document.addEventListener('focusin',onFocus,true);
document.addEventListener('focusout',onBlur,true);

// Reposition on scroll/resize
var reposTimer=null;
function reposition(){
  clearTimeout(reposTimer);
  reposTimer=setTimeout(function(){
    if(currentEl&&dot&&dot.style.display!=='none')positionDot(currentEl);
  },50);
}
window.addEventListener('scroll',reposition,true);
window.addEventListener('resize',reposition,true);

// Close popover on outside click
document.addEventListener('mousedown',function(e){
  if(!pop||pop.style.display==='none')return;
  if(pop.contains(e.target)||dot.contains(e.target))return;
  closePop();
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
      case "waz":
        // Delegate to command parser for app command execution
        if (this.commandHandler) {
          const cmd = data.instruction ? `waz ${data.instruction}` : "waz";
          const result = await this.commandHandler(cmd, appId);
          if (result) this.notify(wc, result, "success");
        }
        break;
      case "council":
        // Delegate to command parser for council
        if (this.commandHandler) {
          const cmd = data.instruction ? `council ${data.instruction}` : "council";
          await this.commandHandler(cmd);
        }
        break;
      case "__open_dashboard":
        // Open help/dashboard overlay from the command overlay
        if (this.commandHandler) {
          await this.commandHandler("yo help");
        }
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
        finalResult = await this.skillEngine.process(context, matchedSkill);
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
    appId?: string,
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

    // Raw body text → capture store for search indexing
    if (appId) {
      try {
        const raw = await wc.executeJavaScript("document.body.innerText.slice(0, 30000)");
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
