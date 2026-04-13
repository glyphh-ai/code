/**
 * YoInterceptor — intercepts "yo" and "sup" typed inside connected app panels.
 *
 * When a connected app's BrowserView loads, injects a script that watches
 * for yo/sup patterns in editable inputs:
 *   "yo"               → grab ALL visible panels → open modal
 *   "yo ."             → grab current panel only → open modal
 *   "yo <skill>"       → grab all panels → skill → save (silent)
 *   "yo . <skill>"     → grab current panel → skill → save (silent)
 *   "sup <query>"      → LLM searches memory+library → push result
 *   "sup"              → open modal with library browse
 *
 * All UI (notifications, result modals, file picker) is injected directly
 * into the app's DOM via executeJavaScript — zero renderer changes needed.
 */

import { WebContents } from "electron";
import { AppConnector } from "./app-connector";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { MemoryStore } from "./memory-store";
import { executeCommand } from "./dom-bridge";
import type { YoChat } from "./yo-chat";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;
  private memoryStore: MemoryStore;
  private getVisiblePanelIds: (() => string[]) | null = null;
  private getPreviousPanelId: (() => string | null) | null = null;

  constructor(
    private appConnector: AppConnector,
    private library: Library,
    private skillEngine: SkillEngine,
    memoryStore: MemoryStore,
  ) {
    this.memoryStore = memoryStore;
  }

  /** Set the YoChat instance for inline LLM execution. */
  setYoChat(chat: YoChat): void {
    this.yoChat = chat;
  }

  /** Set handler for dip commands (routed through command parser). */
  setCommandHandler(handler: (input: string) => Promise<string>): void {
    this.commandHandler = handler;
  }

  /** Set getter for visible panel IDs (from layout manager). */
  setVisiblePanelsGetter(getter: () => string[]): void {
    this.getVisiblePanelIds = getter;
  }

  /** Set getter for previous panel ID (from panel manager). */
  setPreviousPanelGetter(getter: () => string | null): void {
    this.getPreviousPanelId = getter;
  }

  /** Start watching a panel's webContents for yo/sup commands. */
  activate(wc: WebContents, appId: string): void {
    this.deactivate(wc.id);

    const inject = () => this.inject(wc, appId);
    const onConsole = (_e: any, _l: any, msg: string) => {
      if (typeof msg !== "string" || !msg.startsWith(PREFIX)) return;
      try {
        this.dispatch(wc, appId, JSON.parse(msg.slice(PREFIX.length)));
      } catch { /* ignore malformed */ }
    };

    wc.on("did-finish-load", inject);
    (wc as any).on("console-message", onConsole);
    if (!wc.isLoading()) inject();

    this.active.set(wc.id, () => {
      wc.removeListener("did-finish-load", inject);
      (wc as any).removeListener("console-message", onConsole);
    });
  }

  /** Stop watching a panel. */
  deactivate(wcId: number): void {
    this.active.get(wcId)?.();
    this.active.delete(wcId);
  }

  /** Auto-capture: grab content from a panel and store in memory. */
  async autoCapture(wc: WebContents, appId: string): Promise<boolean> {
    try {
      const app = this.appConnector.get(appId);
      const content = await this.grabContent(wc, app);
      if (!content) return false;
      return this.memoryStore.capture(appId, content);
    } catch {
      return false;
    }
  }

  // ── Injection ──────────────────────────────────────────

  private async inject(wc: WebContents, appId: string): Promise<void> {
    try {
      await wc.executeJavaScript(this.buildScript());
    } catch { /* page may have navigated away */ }
  }

  /**
   * Build the monitoring script to inject into the app page.
   *
   * Watches any focused editable element. On Enter, if text matches
   * "yo <skill>" or "sup <search>", intercepts and signals back via
   * console.log with our PREFIX.
   */
  private buildScript(): string {
    return `
(function(){
if(window.__yoActive)return;window.__yoActive=true;
var CMD_RE=/^(yo|sup|dip)(?:\\s+(.+))?$/i;
var lastText='';
var handled=false;

// Remember the element the command was typed in so sup can inject back
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
    document.execCommand('insertText',false,text);
  }
};

function ed(){
  var a=document.activeElement;if(!a||a===document.body)a=null;
  // Walk into shadow roots to find the real active element (nested shadows, e.g. Gemini)
  while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;
  if(a){
    if(a.tagName==='INPUT'||a.tagName==='TEXTAREA')return a;
    if(a.isContentEditable)return a;
    if(a.getAttribute&&a.getAttribute('role')==='textbox')return a;
    // Walk up to find editable ancestor
    var c=a.closest&&a.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
    if(c)return c;
  }
  // Fallback: find any visible editable on page
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
  if(cmd==='yo')console.log('${PREFIX}'+JSON.stringify({type:'yo',instruction:arg}));
  else if(cmd==='sup')console.log('${PREFIX}'+JSON.stringify({type:'sup',instruction:arg}));
  else if(cmd==='dip')console.log('${PREFIX}'+JSON.stringify({type:'dip',args:arg}));
}

// Primary: capture-phase keydown (works for most apps)
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||e.shiftKey)return;
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  if(!CMD_RE.test(t))return;
  handled=false;
  e.preventDefault();e.stopImmediatePropagation();
  // Capture element ref before clearing
  var srcEl=el;
  // Clear using select-all + delete (framework-friendly)
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

// Fallback: track text on every input, detect submit via text disappearing.
// Catches apps where keydown capture is blocked (Angular, etc.)
var lastEl=null;
document.addEventListener('input',function(){
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  if(CMD_RE.test(t)){lastText=t;lastEl=el;handled=false;}
  else if(lastText&&t.length===0){
    // Text was a command and just got cleared = user submitted
    var saved=lastText;var sEl=lastEl;lastText='';lastEl=null;
    fire(saved,sEl);
  }else if(!CMD_RE.test(t)){lastText='';lastEl=null;}
},true);

// Safety net: keyup Enter checks tracked text
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
    data: { type: string; instruction?: string | null; fileName?: string; skill?: string; prompt?: string; args?: string | null },
  ): Promise<void> {
    if (data.type === "yo") {
      await this.handleYo(wc, appId, data.instruction ?? undefined);
    } else if (data.type === "yo-select") {
      await this.handleYoSelect(wc, appId, data.skill, data.fileName, data.prompt);
    } else if (data.type === "sup") {
      await this.handleSup(wc, appId, data.instruction ?? undefined);
    } else if (data.type === "sup-select") {
      await this.handleSupSelect(wc, appId, data.skill, data.fileName, data.prompt);
    } else if (data.type === "dip") {
      await this.handleDip(wc, data.args ?? undefined);
    }
  }

  // ── dip flow: route through command parser ────────────

  private async handleDip(wc: WebContents, args?: string): Promise<void> {
    const cmd = args ? `dip ${args}` : "dip back";
    if (this.commandHandler) {
      const result = await this.commandHandler(cmd);
      if (result) this.notify(wc, result, "success");
    }
  }

  // ── yo flow: capture ──────────────────────────────────────
  //
  //   bare "yo"           → grab ALL panels → show modal
  //   "yo ."              → grab current panel → show modal
  //   "yo help"           → open help overlay
  //   "yo <known-skill>"  → grab ALL panels + skill → save (fast path)
  //   "yo . <skill>"      → grab current panel + skill → save
  //   "yo <instruction>"  → grab ALL panels + LLM → save
  //   "yo . <instruction>"→ grab current panel + LLM → save

  private async handleYo(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    // Route subcommands through command parser
    const sub = instruction?.split(/\s+/)[0]?.toLowerCase();
    if (sub === "help" || sub === "skill" || sub === "layout") {
      if (this.commandHandler) {
        const result = await this.commandHandler(`yo ${instruction}`);
        if (result) this.notify(wc, result, "success");
      }
      return;
    }

    // Parse the dot modifier: "yo ." or "yo . <instruction>"
    const dotMatch = instruction?.match(/^\.\s*(.*)?$/);
    const currentOnly = !!dotMatch;
    const realInstruction = currentOnly ? (dotMatch![1]?.trim() || undefined) : instruction;

    // Bare "yo" or "yo ." → show modal
    if (!realInstruction) {
      this.showCommandModal(wc, "yo");
      return;
    }

    // Single known skill → fast path
    const isSingleWord = /^\S+$/.test(realInstruction);
    const knownSkill = isSingleWord ? this.skillEngine.listSkills().find(
      (s) => s.toLowerCase() === realInstruction!.toLowerCase(),
    ) : undefined;

    if (knownSkill) {
      await this.yoSave(wc, appId, currentOnly, knownSkill);
      return;
    }

    // Natural language → LLM processes and saves
    await this.yoSave(wc, appId, currentOnly, undefined, realInstruction);
  }

  /** Handle modal selection for yo (skill or library file picked). */
  private async handleYoSelect(
    wc: WebContents,
    appId: string,
    skill?: string,
    fileName?: string,
    prompt?: string,
  ): Promise<void> {
    if (fileName) {
      // Append current page content to existing library file
      const content = await this.grabAllPanels(wc, appId, false);
      if (!content) {
        this.notify(wc, "Could not grab content from this page.", "error");
        return;
      }
      const existing = this.library.read(fileName) || "";
      const timestamp = new Date().toLocaleString();
      const appended = existing + `\n\n---\n*Appended ${timestamp}*\n\n` + content;
      this.library.write(fileName, appended);
      this.notify(wc, `Appended to ${fileName}.md`, "success");
    } else {
      // Process with skill/prompt and save (default: all panels)
      await this.yoSave(wc, appId, false, skill, prompt);
    }
  }

  /** Grab content, process with skill/LLM, save to library. */
  private async yoSave(
    wc: WebContents,
    appId: string,
    currentOnly: boolean,
    skill?: string,
    instruction?: string,
  ): Promise<void> {
    this.notify(wc, "", "loading");
    try {
      const content = await this.grabAllPanels(wc, appId, !currentOnly);
      if (!content) {
        this.notify(wc, "Could not grab content.", "error");
        return;
      }

      let processed: string;
      if (instruction && this.yoChat) {
        processed = await this.yoChat.executeInline("yo", instruction, appId, content);
      } else {
        processed = await this.skillEngine.process(content, skill);
      }

      const date = new Date().toISOString().slice(0, 10);
      const base = skill || appId;
      let name = `${base}-${date}`;
      const existing = this.library.list();
      if (existing.includes(name)) {
        let i = 2;
        while (existing.includes(`${name}-${i}`)) i++;
        name = `${name}-${i}`;
      }

      this.library.write(name, processed);
      this.showYoResult(wc, name, processed);
    } catch (err) {
      this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── sup flow: recall + use ─────────────────────────────────
  //
  //   bare "sup"              → show modal (browse library + memory)
  //   "sup <query>"           → LLM searches memory+library → inject result
  //   "sup . <skill/prompt>"  → snapshot current panel → process → inject
  //   "sup * <skill/prompt>"  → use previous panel's last capture → process → inject

  private async handleSup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    // Bare "sup" → show modal
    if (!instruction) {
      this.showCommandModal(wc, "sup");
      return;
    }

    // Parse dot/star modifiers: "sup ." or "sup . <instruction>" / "sup *" or "sup * <instruction>"
    const dotMatch = instruction.match(/^\.\s*(.*)?$/);
    const starMatch = instruction.match(/^\*\s*(.*)?$/);

    if (dotMatch) {
      const prompt = dotMatch[1]?.trim();
      if (!prompt) {
        this.notify(wc, "sup . needs a skill or instruction", "error");
        return;
      }
      await this.supProcess(wc, appId, prompt, "current");
      return;
    }

    if (starMatch) {
      const prompt = starMatch[1]?.trim();
      if (!prompt) {
        this.notify(wc, "sup * needs a skill or instruction", "error");
        return;
      }
      await this.supProcess(wc, appId, prompt, "previous");
      return;
    }

    // Subcommands via command parser
    const sub = instruction.split(/\s+/)[0]?.toLowerCase();
    if (sub === "list" || sub === "search" || sub === "forget") {
      if (this.commandHandler) {
        const result = await this.commandHandler(`sup ${instruction}`);
        if (result) this.notify(wc, result, "success");
      }
      return;
    }

    // Single word → try library search first (fast path)
    const isSingleWord = /^\S+$/.test(instruction);
    if (isSingleWord) {
      const files = this.library.search(instruction);
      if (files.length === 1) {
        const content = this.library.read(files[0]);
        if (content) {
          await this.injectContent(wc, content);
          return;
        }
      }
    }

    // LLM-powered search across memory + library
    await this.supSearch(wc, appId, instruction);
  }

  /** Process context with a skill/prompt and inject the result.
   *  source: "current" = live snapshot, "previous" = last memory capture from previous panel */
  private async supProcess(
    wc: WebContents,
    appId: string,
    prompt: string,
    source: "current" | "previous",
  ): Promise<void> {
    this.notify(wc, "", "loading");

    let content: string | null = null;

    if (source === "current") {
      const app = this.appConnector.get(appId);
      content = await this.grabContent(wc, app);
    } else {
      // Previous panel's last captured content from memory store
      const prevId = this.getPreviousPanelId?.();
      if (!prevId) {
        this.notify(wc, "No previous panel.", "error");
        return;
      }
      content = this.memoryStore.getLatest(prevId);
    }

    if (!content) {
      this.notify(wc, source === "current" ? "Could not grab content." : "No captured content from previous panel.", "error");
      return;
    }

    // Check if prompt is a known skill
    const isSingleWord = /^\S+$/.test(prompt);
    const knownSkill = isSingleWord ? this.skillEngine.listSkills().find(
      (s) => s.toLowerCase() === prompt.toLowerCase(),
    ) : undefined;

    try {
      let result: string;
      if (knownSkill) {
        result = await this.skillEngine.process(content, knownSkill);
      } else if (this.yoChat) {
        result = await this.yoChat.executeInline("sup", prompt, appId, content);
      } else {
        this.notify(wc, "Chat engine not available.", "error");
        return;
      }

      // Clear spinner, then inject result into the input
      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, result);
      if (!injected) {
        this.notify(wc, result, "success");
      }
    } catch (err) {
      this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  /** LLM-powered recall: search memory + library, return best match. */
  private async supSearch(wc: WebContents, appId: string, query: string): Promise<void> {
    if (!this.yoChat) {
      this.notify(wc, "Chat engine not available.", "error");
      return;
    }

    this.notify(wc, "", "loading");
    try {
      // Build search context from memory store + library
      const memoryContext = this.memoryStore.buildSearchContext(100);
      const libraryFiles = this.library.list();
      const libraryContext = libraryFiles.length > 0
        ? "Library files: " + libraryFiles.slice(0, 50).join(", ")
        : "Library is empty.";

      const searchPrompt = `The user is searching for content. Their query: "${query}"

Available content sources:

## Auto-captured memory
${memoryContext}

## Library (curated saves)
${libraryContext}

Find the best matching content. If you find a match in auto-captured memory, use the memory_read tool with the entry ID. If it's in the library, use sup_load with the file name. Return the content to the user. Be concise — just return the relevant content, no commentary.`;

      const result = await this.yoChat.executeInline("sup", searchPrompt, appId);
      // Clear spinner, then inject result into the input
      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, result);
      if (!injected) {
        this.notify(wc, result, "success");
      }
    } catch (err) {
      this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  /** Handle modal selection for sup (skill or library file picked). */
  private async handleSupSelect(
    wc: WebContents,
    appId: string,
    skill?: string,
    fileName?: string,
    prompt?: string,
  ): Promise<void> {
    if (fileName && !skill) {
      // Library file → inject into input
      const content = this.library.read(fileName);
      if (content) {
        await this.injectContent(wc, content);
      }
      return;
    }

    // Skill selected → process with LLM
    const ctx = fileName ? this.library.read(fileName) || "" : "";

    if (!this.yoChat) {
      this.notify(wc, "Chat engine not available.", "error");
      return;
    }

    const instruction = prompt
      ? `Process using skill "${skill}": ${prompt}`
      : `Process using skill "${skill}"`;

    this.notify(wc, "", "loading");
    try {
      const skillPrompt = skill ? this.skillEngine.readSkill(skill) : null;
      const fullInstruction = skillPrompt
        ? `${skillPrompt}\n\nAdditional instruction: ${prompt || "process this content"}`
        : instruction;
      const result = await this.yoChat.executeInline("sup", fullInstruction, appId, ctx);
      // Clear spinner, then inject result into the input
      await this.clearNotify(wc);
      const injected = await this.injectContent(wc, result);
      if (!injected) {
        this.notify(wc, result, "success");
      }
    } catch (err) {
      this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── Multi-panel grab ──────────────────────────────────

  /** Grab content from all visible panels (or just current). */
  private async grabAllPanels(wc: WebContents, appId: string, allPanels: boolean): Promise<string | null> {
    if (!allPanels) {
      // Current panel only
      const app = this.appConnector.get(appId);
      return this.grabContent(wc, app);
    }

    // All visible panels
    const panelIds = this.getVisiblePanelIds?.() ?? [appId];

    // If only one panel visible, just grab it
    if (panelIds.length <= 1) {
      const app = this.appConnector.get(appId);
      return this.grabContent(wc, app);
    }

    // Grab from all visible panels, label each section
    const sections: string[] = [];
    for (const id of panelIds) {
      const app = this.appConnector.get(id);
      // For the source panel, use the wc we already have
      let content: string | null;
      if (id === appId) {
        content = await this.grabContent(wc, app);
      } else {
        // Get webContents for other panels
        const otherWc = this.getWebContentsForPanel(id);
        if (!otherWc) continue;
        content = await this.grabContent(otherWc, app);
      }
      if (content) {
        sections.push(`## ${app?.name || id}\n\n${content}`);
      }
    }

    if (sections.length === 0) return null;
    return sections.join("\n\n---\n\n");
  }

  /** Get webContents for a panel by ID (via the active map). */
  private getWebContentsForPanel(panelId: string): WebContents | null {
    // The PanelManager.getWebContents is not directly available here,
    // but we can look through our active watchers
    for (const [wcId] of this.active) {
      try {
        const { webContents } = require("electron");
        const wc = webContents.fromId(wcId);
        if (wc && !wc.isDestroyed()) {
          // Check if this wc belongs to the requested panel
          // We use the URL as a heuristic — match against app config
          const app = this.appConnector.get(panelId);
          if (app && wc.getURL().includes(new URL(app.url).hostname)) {
            return wc;
          }
        }
      } catch { /* skip */ }
    }
    return null;
  }

  // ── Helpers ─────────────────────────────────────────────

  /** Inject text into the element where the user typed the command. */
  private async injectContent(wc: WebContents, text: string): Promise<boolean> {
    try {
      return await wc.executeJavaScript(
        `(function(){ if(window.__yoInject){window.__yoInject(${JSON.stringify(text)});return true;} return false; })()`,
      );
    } catch {
      return false;
    }
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

  // ── Injected UI ────────────────────────────────────────
  //
  // All UI is injected directly into the app's BrowserView DOM.
  // This avoids the BrowserView-overlays-renderer-HTML problem
  // and keeps the UX seamless (modals appear right in the app).

  private async notify(
    wc: WebContents,
    msg: string,
    type: "loading" | "success" | "error",
  ): Promise<void> {
    const loadingMessages = [
      "chilling...", "vibing...", "supping...", "cooking...",
      "thinking...", "brewing...", "manifesting...", "marinating...",
      "pondering...", "scheming...", "simmering...", "noodling...",
      "conjuring...", "percolating...", "riffing...", "hatching...",
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
// Clear any previous spinner interval
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
  setText(frames[0]+' '+text);
  window.__yoNoteIv=setInterval(function(){
    fi++;setText(frames[fi%frames.length]+' '+text);
  },100);
}else{
  setText(text);
  ${autoRemove ? "setTimeout(function(){try{setText('');}catch(e){}},2500);" : ""}
}
})();`);
    } catch { /* page navigated */ }
  }

  private async showYoResult(wc: WebContents, fileName: string, _content: string): Promise<void> {
    // Show save confirmation in the input line, then clear
    await this.notify(wc, `Saved: ${fileName}.md`, "success");
  }

  /** Unified modal for yo (capture) and sup (recall). Shows prompt + skills + library. */
  private async showCommandModal(wc: WebContents, mode: "yo" | "sup"): Promise<void> {
    const skills = this.skillEngine.listSkills();
    const meta = this.library.listWithMeta();
    const files = meta.map((f) => ({
      name: f.name,
      modified: f.modified,
      preview: (this.library.read(f.name) || "").slice(0, 120).replace(/\n/g, " "),
    }));
    const data = JSON.stringify({ mode, skills, files });
    try {
      await wc.executeJavaScript(`
(function(){
if(window.__yoNoteIv){clearInterval(window.__yoNoteIv);window.__yoNoteIv=null;}
var m=document.getElementById('__yo_modal');if(m)m.remove();
var D=${data};
var mode=D.mode,skills=D.skills,files=D.files;
var PAGE=15,page=0,filtered=files;
var ov=document.createElement('div');ov.id='__yo_modal';
ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;backdrop-filter:blur(2px);';
var card=document.createElement('div');
card.style.cssText='background:#151515;border:1px solid #2a2a2a;border-radius:10px;padding:24px;max-width:580px;width:90%;max-height:80vh;box-shadow:0 16px 48px rgba(0,0,0,0.6);font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;transform:scale(0.96);transition:transform 0.2s;display:flex;flex-direction:column;';
var title=mode==='yo'?'Yo':'Sup';
var hdr=document.createElement('div');hdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
var t=document.createElement('div');t.textContent=title;
t.style.cssText='font-size:15px;font-weight:600;color:#e0e0e0;';
hdr.appendChild(t);
var closeBtn=document.createElement('button');closeBtn.textContent='\\u00d7';
closeBtn.style.cssText='background:none;border:none;color:#555;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;transition:color 0.15s;';
closeBtn.onmouseenter=function(){closeBtn.style.color='#fff';};
closeBtn.onmouseleave=function(){closeBtn.style.color='#555';};
closeBtn.onclick=function(){ov.remove();};
hdr.appendChild(closeBtn);
card.appendChild(hdr);
var pi=document.createElement('input');pi.type='text';
pi.placeholder=mode==='yo'?'what do you want to save?':'what are you looking for?';
pi.style.cssText='width:100%;box-sizing:border-box;background:#1e1e1e;border:1px solid #333;color:#e8e8e8;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:12px;outline:none;transition:border-color 0.15s;';
pi.onfocus=function(){pi.style.borderColor='#555';};
pi.onblur=function(){pi.style.borderColor='#333';};
card.appendChild(pi);
pi.addEventListener('keydown',function(e){
  if(e.key==='Escape'){ov.remove();return;}
  if(e.key==='Enter'&&pi.value.trim()){
    ov.remove();
    console.log('${PREFIX}'+JSON.stringify({type:mode+'-select',prompt:pi.value.trim()}));
  }
});
var list=document.createElement('div');list.style.cssText='flex:1;overflow-y:auto;min-height:0;';
card.appendChild(list);
var pager=document.createElement('div');pager.style.cssText='display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid #1e1e1e;margin-top:6px;';
var prevBtn=document.createElement('button');prevBtn.textContent='\\u2190';
prevBtn.style.cssText='background:none;border:1px solid #2a2a2a;color:#666;padding:3px 10px;border-radius:5px;font-size:12px;cursor:pointer;transition:all 0.15s;';
prevBtn.onmouseenter=function(){prevBtn.style.borderColor='#555';prevBtn.style.color='#fff';};
prevBtn.onmouseleave=function(){prevBtn.style.borderColor='#2a2a2a';prevBtn.style.color='#666';};
var pageInfo=document.createElement('span');pageInfo.style.cssText='font-size:11px;color:#444;';
var nextBtn=document.createElement('button');nextBtn.textContent='\\u2192';
nextBtn.style.cssText='background:none;border:1px solid #2a2a2a;color:#666;padding:3px 10px;border-radius:5px;font-size:12px;cursor:pointer;transition:all 0.15s;';
nextBtn.onmouseenter=function(){nextBtn.style.borderColor='#555';nextBtn.style.color='#fff';};
nextBtn.onmouseleave=function(){nextBtn.style.borderColor='#2a2a2a';nextBtn.style.color='#666';};
pager.appendChild(prevBtn);pager.appendChild(pageInfo);pager.appendChild(nextBtn);
card.appendChild(pager);
function ago(ms){
  var s=Math.floor((Date.now()-ms)/1000);
  if(s<60)return 'just now';
  var m=Math.floor(s/60);if(m<60)return m+'m ago';
  var h=Math.floor(m/60);if(h<24)return h+'h ago';
  var d=Math.floor(h/24);if(d<30)return d+'d ago';
  return new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
function render(){
  list.innerHTML='';
  var q=pi.value.toLowerCase();
  var fSkills=skills.filter(function(s){return !q||s.toLowerCase().includes(q);});
  var fFiles=q?files.filter(function(f){return f.name.toLowerCase().includes(q)||f.preview.toLowerCase().includes(q);}):files;
  filtered=fFiles;
  if(fSkills.length>0){
    var sh=document.createElement('div');sh.textContent='Skills';
    sh.style.cssText='font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#444;padding:4px 12px 6px;';
    list.appendChild(sh);
    fSkills.forEach(function(sk){
      var item=document.createElement('div');
      item.style.cssText='display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;border-radius:6px;margin-bottom:1px;transition:background 0.1s;';
      item.onmouseenter=function(){this.style.background='#1e1e1e';};
      item.onmouseleave=function(){this.style.background='transparent';};
      var dot=document.createElement('span');dot.textContent='\\u25CF';
      dot.style.cssText='color:#7c3aed;font-size:6px;';
      item.appendChild(dot);
      var n=document.createElement('span');n.textContent=sk;
      n.style.cssText='font-size:13px;font-weight:500;color:#ccc;';
      item.appendChild(n);
      item.onclick=function(){ov.remove();
        console.log('${PREFIX}'+JSON.stringify({type:mode+'-select',skill:sk,prompt:pi.value.trim()||null}));};
      list.appendChild(item);
    });
  }
  if(fFiles.length>0){
    var fh=document.createElement('div');fh.textContent='Library';
    fh.style.cssText='font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#444;padding:8px 12px 6px;';
    list.appendChild(fh);
    var total=fFiles.length;
    var pages=Math.max(1,Math.ceil(total/PAGE));
    if(page>=pages)page=pages-1;
    var start=page*PAGE,end=Math.min(start+PAGE,total);
    pageInfo.textContent=(page+1)+'/'+pages;
    prevBtn.style.visibility=page>0?'visible':'hidden';
    nextBtn.style.visibility=page<pages-1?'visible':'hidden';
    pager.style.display=total>PAGE?'flex':'none';
    for(var i=start;i<end;i++){
      var f=fFiles[i];
      var item=document.createElement('div');
      item.style.cssText='display:flex;align-items:center;gap:12px;padding:7px 12px;cursor:pointer;border-radius:6px;margin-bottom:1px;transition:background 0.1s;';
      item.onmouseenter=function(){this.style.background='#1e1e1e';};
      item.onmouseleave=function(){this.style.background='transparent';};
      var left=document.createElement('div');left.style.cssText='flex:1;min-width:0;';
      var n=document.createElement('div');n.textContent=f.name+'.md';
      n.style.cssText='font-size:13px;font-weight:500;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      left.appendChild(n);
      if(f.preview){var p=document.createElement('div');p.textContent=f.preview;
      p.style.cssText='font-size:11px;color:#555;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      left.appendChild(p);}
      item.appendChild(left);
      var ts=document.createElement('div');ts.textContent=ago(f.modified);
      ts.style.cssText='font-size:11px;color:#444;white-space:nowrap;flex-shrink:0;';
      item.appendChild(ts);
      (function(name){item.onclick=function(){ov.remove();
        console.log('${PREFIX}'+JSON.stringify({type:mode+'-select',fileName:name,prompt:pi.value.trim()||null}));};})(f.name);
      list.appendChild(item);
    }
  } else {
    pager.style.display='none';
  }
  if(fSkills.length===0&&fFiles.length===0){
    var em=document.createElement('div');em.textContent='No matches';
    em.style.cssText='color:#555;text-align:center;padding:20px;font-size:13px;';list.appendChild(em);
    pager.style.display='none';
  }
}
prevBtn.onclick=function(){if(page>0){page--;render();}};
nextBtn.onclick=function(){page++;render();};
pi.oninput=function(){page=0;render();};
render();
ov.onclick=function(e){if(e.target===ov)ov.remove();};
ov.appendChild(card);
document.body.appendChild(ov);
requestAnimationFrame(function(){ov.style.opacity='1';card.style.transform='scale(1)';pi.focus();});
})();`);
    } catch {}
  }
}
