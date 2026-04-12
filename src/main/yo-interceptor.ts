/**
 * YoInterceptor — intercepts "yo" and "sup" typed inside connected app panels.
 *
 * When a connected app's BrowserView loads, injects a script that watches
 * for yo/sup patterns in editable inputs:
 *   "yo <skill>" → grab content → LLM summarize → save to ~/yo/library/
 *   "sup <search>" → search library → push content into app (or show picker)
 *
 * All UI (notifications, result modals, file picker) is injected directly
 * into the app's DOM via executeJavaScript — zero renderer changes needed.
 */

import { WebContents } from "electron";
import { AppConnector } from "./app-connector";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { executeCommand } from "./dom-bridge";
import type { YoChat } from "./yo-chat";

const PREFIX = "__YO__";

export class YoInterceptor {
  private active = new Map<number, () => void>();
  private commandHandler: ((input: string) => Promise<string>) | null = null;
  private yoChat: YoChat | null = null;

  constructor(
    private appConnector: AppConnector,
    private library: Library,
    private skillEngine: SkillEngine,
  ) {}

  /** Set the YoChat instance for inline LLM execution. */
  setYoChat(chat: YoChat): void {
    this.yoChat = chat;
  }

  /** Set handler for dip commands (routed through command parser). */
  setCommandHandler(handler: (input: string) => Promise<string>): void {
    this.commandHandler = handler;
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

  // ── Injection ──────────────────────────────────────────

  private async inject(wc: WebContents, appId: string): Promise<void> {
    const app = this.appConnector.get(appId);
    const pushSel = app?.commands.push?.selector ?? null;
    try {
      await wc.executeJavaScript(this.buildScript(pushSel));
    } catch { /* page may have navigated away */ }
  }

  /**
   * Build the monitoring script to inject into the app page.
   *
   * Watches the push-command's input (if mapped) or any focused editable
   * element. On Enter, if text matches "yo <skill>" or "sup <search>",
   * intercepts and signals back via console.log with our PREFIX.
   */
  private buildScript(pushSelector: string | null): string {
    const sel = pushSelector ? JSON.stringify(pushSelector) : "null";
    // The template uses single-letter vars and no newlines for compactness.
    // PREFIX is baked in as a literal so we don't need to escape it.
    return `
(function(){
if(window.__yoActive)return;window.__yoActive=true;
var S=${sel};
function ed(){
  if(S){var el=document.querySelector(S);
    if(el&&(el.contains(document.activeElement)||el===document.activeElement))return el;}
  var a=document.activeElement;if(!a)return null;
  if(a.tagName==='INPUT'||a.tagName==='TEXTAREA')return a;
  if(a.getAttribute('contenteditable')==='true')return a;
  var c=a.closest('[contenteditable="true"]');return c||null;
}
function tx(el){return(el.tagName==='INPUT'||el.tagName==='TEXTAREA')?el.value||'':el.innerText||el.textContent||'';}
function cl(el){
  if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
    var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var s=Object.getOwnPropertyDescriptor(p,'value');
    if(s&&s.set)s.set.call(el,'');else el.value='';
  }else{el.innerHTML='';}
  el.dispatchEvent(new Event('input',{bubbles:true}));
}
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||e.shiftKey)return;
  var el=ed();if(!el)return;
  var t=tx(el).trim();
  var ym=t.match(/^yo(?:\\s+(.+))?$/i);
  var sm=t.match(/^sup(?:\\s+(.+))?$/i);
  if(ym){e.preventDefault();e.stopImmediatePropagation();cl(el);
    console.log('${PREFIX}'+JSON.stringify({type:'yo',instruction:(ym[1]||'').trim()||null}));return false;}
  if(sm){e.preventDefault();e.stopImmediatePropagation();cl(el);
    console.log('${PREFIX}'+JSON.stringify({type:'sup',instruction:(sm[1]||'').trim()||null}));return false;}
  var dm=t.match(/^dip(?:\\s+(.+))?$/i);
  if(dm){e.preventDefault();e.stopImmediatePropagation();cl(el);
    console.log('${PREFIX}'+JSON.stringify({type:'dip',args:(dm[1]||'').trim()||null}));return false;}
},true);
})();`;
  }

  // ── Dispatch ───────────────────────────────────────────

  private async dispatch(
    wc: WebContents,
    appId: string,
    data: { type: string; instruction?: string | null; fileName?: string; args?: string | null },
  ): Promise<void> {
    if (data.type === "yo") {
      await this.handleYo(wc, appId, data.instruction ?? undefined);
    } else if (data.type === "sup") {
      await this.handleSup(wc, appId, data.instruction ?? undefined);
    } else if (data.type === "sup-select") {
      await this.pushFile(wc, appId, data.fileName!);
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

  // ── yo flow: creating ────────────────────────────────────
  //
  // Smart routing:
  //   bare "yo"           → grab + default skill → save
  //   "yo <known-skill>"  → grab + skill → save  (fast path)
  //   "yo <natural lang>" → grab + LLM inline execution

  private async handleYo(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    const app = this.appConnector.get(appId);
    if (!app) return;

    // Decide: fast path (no instruction or single known skill) vs LLM
    const isSingleWord = instruction && /^\S+$/.test(instruction);
    const knownSkill = isSingleWord ? this.skillEngine.listSkills().find(
      (s) => s.toLowerCase() === instruction!.toLowerCase(),
    ) : undefined;
    const needsLLM = instruction && !knownSkill;

    if (needsLLM) {
      await this.handleYoInline(wc, appId, instruction!);
      return;
    }

    this.notify(wc, "Saving...", "loading");

    try {
      const content = await this.grabContent(wc, app);
      if (!content) {
        this.notify(wc, "Could not grab content from this page.", "error");
        return;
      }

      const processed = await this.skillEngine.process(content, knownSkill);

      const date = new Date().toISOString().slice(0, 10);
      const base = knownSkill || appId;
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

  /** LLM-powered yo: grab content, send instruction + content to LLM. */
  private async handleYoInline(wc: WebContents, appId: string, instruction: string): Promise<void> {
    if (!this.yoChat) {
      this.notify(wc, "Chat engine not available.", "error");
      return;
    }
    const app = this.appConnector.get(appId);
    if (!app) return;

    this.notify(wc, "Thinking...", "loading");

    try {
      const content = await this.grabContent(wc, app);
      const result = await this.yoChat.executeInline("yo", instruction, appId, content || undefined);
      this.notify(wc, result, "success");
    } catch (err) {
      this.notify(wc, `yo failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── sup flow: reading ───────────────────────────────────
  //
  // Smart routing:
  //   bare "sup"                → show all library files
  //   "sup <single-word>"       → search library (fast path)
  //   "sup <natural lang>"      → LLM inline execution

  private async handleSup(wc: WebContents, appId: string, instruction?: string): Promise<void> {
    // No instruction → show full library
    if (!instruction) {
      const files = this.library.list();
      if (files.length === 0) {
        this.notify(wc, "Library is empty.", "error");
        return;
      }
      const items = files.slice(0, 50).map((f) => ({
        name: f,
        preview: (this.library.read(f) || "").slice(0, 120).replace(/\n/g, " "),
      }));
      this.showSupPicker(wc, items);
      return;
    }

    // Single word → direct library search (fast path)
    const isSingleWord = /^\S+$/.test(instruction);
    if (isSingleWord) {
      const files = this.library.search(instruction);
      if (files.length === 0) {
        this.notify(wc, `No files matching "${instruction}"`, "error");
        return;
      }
      if (files.length === 1) {
        await this.pushFile(wc, appId, files[0]);
        return;
      }
      const items = files.slice(0, 50).map((f) => ({
        name: f,
        preview: (this.library.read(f) || "").slice(0, 120).replace(/\n/g, " "),
      }));
      this.showSupPicker(wc, items);
      return;
    }

    // Multi-word → LLM inline
    await this.handleSupInline(wc, appId, instruction);
  }

  /** LLM-powered sup: natural language library retrieval + push. */
  private async handleSupInline(wc: WebContents, appId: string, instruction: string): Promise<void> {
    if (!this.yoChat) {
      this.notify(wc, "Chat engine not available.", "error");
      return;
    }

    this.notify(wc, "Searching...", "loading");

    try {
      const result = await this.yoChat.executeInline("sup", instruction, appId);
      this.notify(wc, result, "success");
    } catch (err) {
      this.notify(wc, `sup failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  private async grabContent(
    wc: WebContents,
    app: ReturnType<AppConnector["get"]>,
  ): Promise<string | null> {
    let content = "";
    if (app?.commands.grab) {
      content = await executeCommand(wc, app.commands.grab);
    } else if (app?.commands.read) {
      content = await executeCommand(wc, app.commands.read);
    } else {
      content = await wc.executeJavaScript("document.body.innerText.slice(0,10000)");
    }
    if (!content || content.startsWith("[Element not found")) return null;
    return content;
  }

  private async pushFile(wc: WebContents, appId: string, fileName: string): Promise<void> {
    const content = this.library.read(fileName);
    if (!content) {
      this.notify(wc, `"${fileName}" not found.`, "error");
      return;
    }
    const app = this.appConnector.get(appId);
    if (app?.commands.push) {
      await executeCommand(wc, app.commands.push, content);
      this.notify(wc, `Loaded: ${fileName}.md`, "success");
    } else {
      // No push mapping — show content for manual copy
      this.showSupContent(wc, fileName, content);
    }
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
    const colors: Record<string, [string, string]> = {
      loading: ["#1a1a2e", "#a855f7"],
      success: ["#1a2e1a", "#22c55e"],
      error: ["#2e1a1a", "#ef4444"],
    };
    const [bg, border] = colors[type];
    const icon = type === "success" ? "\u2713 " : type === "error" ? "\u2717 " : "";
    const msgData = JSON.stringify(icon + msg);
    const autoRemove = type !== "loading";
    try {
      await wc.executeJavaScript(`
(function(){
var o=document.getElementById('__yo_note');if(o)o.remove();
var n=document.createElement('div');n.id='__yo_note';
n.textContent=${msgData};
n.style.cssText='position:fixed;top:16px;right:16px;z-index:999999;background:${bg};border:1px solid ${border};color:#e0e0e0;padding:12px 20px;border-radius:8px;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:400px;opacity:0;transform:translateY(-8px);transition:all 0.2s ease;pointer-events:none;';
document.body.appendChild(n);
requestAnimationFrame(function(){n.style.opacity='1';n.style.transform='none';});
${autoRemove ? "setTimeout(function(){n.style.opacity='0';n.style.transform='translateY(-8px)';setTimeout(function(){if(n.parentNode)n.remove();},300);},3500);" : ""}
})();`);
    } catch { /* page navigated */ }
  }

  private async showYoResult(wc: WebContents, fileName: string, content: string): Promise<void> {
    const data = JSON.stringify({ fileName, preview: content.slice(0, 500) });
    try {
      await wc.executeJavaScript(`
(function(){
var o=document.getElementById('__yo_note');if(o)o.remove();
var m=document.getElementById('__yo_modal');if(m)m.remove();
var d=${data};
var ov=document.createElement('div');ov.id='__yo_modal';
ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;';
var card=document.createElement('div');
card.style.cssText='background:#1a1a2e;border:1px solid #a855f7;border-radius:12px;padding:24px;max-width:500px;width:90%;max-height:60vh;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;transform:scale(0.95);transition:transform 0.2s;';
var t=document.createElement('div');t.textContent='\\u2713 Saved: '+d.fileName+'.md';
t.style.cssText='font-size:16px;font-weight:600;margin-bottom:12px;color:#a855f7;';
card.appendChild(t);
var pre=document.createElement('pre');pre.textContent=d.preview;
pre.style.cssText='font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0 0 16px;padding:12px;background:#0d0d1a;border-radius:6px;max-height:300px;overflow:auto;color:#ccc;';
card.appendChild(pre);
var btn=document.createElement('button');btn.textContent='Got it';
btn.style.cssText='background:#a855f7;color:white;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;transition:background 0.15s;';
btn.onmouseenter=function(){btn.style.background='#9333ea';};
btn.onmouseleave=function(){btn.style.background='#a855f7';};
btn.onclick=function(){ov.remove();};
card.appendChild(btn);
ov.appendChild(card);
ov.onclick=function(e){if(e.target===ov)ov.remove();};
document.body.appendChild(ov);
requestAnimationFrame(function(){ov.style.opacity='1';card.style.transform='scale(1)';});
setTimeout(function(){var el=document.getElementById('__yo_modal');if(el)el.remove();},15000);
})();`);
    } catch {}
  }

  private async showSupPicker(
    wc: WebContents,
    files: Array<{ name: string; preview: string }>,
  ): Promise<void> {
    const data = JSON.stringify(files);
    try {
      await wc.executeJavaScript(`
(function(){
var o=document.getElementById('__yo_note');if(o)o.remove();
var m=document.getElementById('__yo_modal');if(m)m.remove();
var files=${data};
var ov=document.createElement('div');ov.id='__yo_modal';
ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;';
var card=document.createElement('div');
card.style.cssText='background:#1a1a2e;border:1px solid #a855f7;border-radius:12px;padding:24px;max-width:500px;width:90%;max-height:70vh;box-shadow:0 16px 48px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;transform:scale(0.95);transition:transform 0.2s;display:flex;flex-direction:column;';
var t=document.createElement('div');t.textContent='Load context';
t.style.cssText='font-size:16px;font-weight:600;margin-bottom:12px;color:#a855f7;';
card.appendChild(t);
var si=document.createElement('input');si.type='text';si.placeholder='Search files...';
si.style.cssText='width:100%;box-sizing:border-box;background:#0d0d1a;border:1px solid #333;color:#e0e0e0;padding:8px 12px;border-radius:6px;font-size:14px;margin-bottom:12px;outline:none;transition:border-color 0.15s;';
si.onfocus=function(){si.style.borderColor='#a855f7';};
si.onblur=function(){si.style.borderColor='#333';};
card.appendChild(si);
var list=document.createElement('div');list.style.cssText='flex:1;overflow-y:auto;min-height:0;';
card.appendChild(list);
function render(arr){
  list.innerHTML='';
  arr.forEach(function(f){
    var item=document.createElement('div');
    item.style.cssText='padding:10px 12px;cursor:pointer;border-radius:6px;margin-bottom:2px;transition:background 0.1s;';
    item.onmouseenter=function(){item.style.background='#252540';};
    item.onmouseleave=function(){item.style.background='transparent';};
    var n=document.createElement('div');n.textContent=f.name+'.md';
    n.style.cssText='font-size:14px;font-weight:500;';item.appendChild(n);
    if(f.preview){var p=document.createElement('div');p.textContent=f.preview;
    p.style.cssText='font-size:12px;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    item.appendChild(p);}
    item.onclick=function(){ov.remove();
      console.log('${PREFIX}'+JSON.stringify({type:'sup-select',fileName:f.name}));};
    list.appendChild(item);
  });
  if(arr.length===0){var em=document.createElement('div');em.textContent='No matches';
  em.style.cssText='color:#666;text-align:center;padding:20px;font-size:14px;';list.appendChild(em);}
}
render(files);
si.oninput=function(){var q=si.value.toLowerCase();
  render(files.filter(function(f){return f.name.toLowerCase().includes(q)||f.preview.toLowerCase().includes(q);}));};
ov.onclick=function(e){if(e.target===ov)ov.remove();};
ov.appendChild(card);
document.body.appendChild(ov);
requestAnimationFrame(function(){ov.style.opacity='1';card.style.transform='scale(1)';si.focus();});
})();`);
    } catch {}
  }

  private async showSupContent(
    wc: WebContents,
    fileName: string,
    content: string,
  ): Promise<void> {
    const data = JSON.stringify({ fileName, content: content.slice(0, 2000) });
    try {
      await wc.executeJavaScript(`
(function(){
var o=document.getElementById('__yo_note');if(o)o.remove();
var m=document.getElementById('__yo_modal');if(m)m.remove();
var d=${data};
var ov=document.createElement('div');ov.id='__yo_modal';
ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;';
var card=document.createElement('div');
card.style.cssText='background:#1a1a2e;border:1px solid #a855f7;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:70vh;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;transform:scale(0.95);transition:transform 0.2s;';
var t=document.createElement('div');t.textContent=d.fileName+'.md';
t.style.cssText='font-size:16px;font-weight:600;margin-bottom:12px;color:#a855f7;';
card.appendChild(t);
var pre=document.createElement('pre');pre.textContent=d.content;
pre.style.cssText='font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0 0 16px;padding:12px;background:#0d0d1a;border-radius:6px;max-height:400px;overflow:auto;color:#ccc;user-select:all;';
card.appendChild(pre);
var row=document.createElement('div');row.style.cssText='display:flex;gap:8px;';
var cp=document.createElement('button');cp.textContent='Copy';
cp.style.cssText='background:#333;color:#e0e0e0;border:1px solid #555;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;transition:all 0.15s;';
cp.onmouseenter=function(){cp.style.background='#444';};
cp.onmouseleave=function(){cp.style.background='#333';};
cp.onclick=function(){navigator.clipboard.writeText(d.content);cp.textContent='Copied!';setTimeout(function(){cp.textContent='Copy';},2000);};
row.appendChild(cp);
var cl=document.createElement('button');cl.textContent='Close';
cl.style.cssText='background:#a855f7;color:white;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;transition:background 0.15s;';
cl.onmouseenter=function(){cl.style.background='#9333ea';};
cl.onmouseleave=function(){cl.style.background='#a855f7';};
cl.onclick=function(){ov.remove();};
row.appendChild(cl);
card.appendChild(row);
ov.appendChild(card);
ov.onclick=function(e){if(e.target===ov)ov.remove();};
document.body.appendChild(ov);
requestAnimationFrame(function(){ov.style.opacity='1';card.style.transform='scale(1)';});
})();`);
    } catch {}
  }
}
