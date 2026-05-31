/**
 * AdalRepl — an in-process line-editing REPL driven over the xterm surface.
 *
 * The yo://adaL app reuses the regular terminal renderer (xterm) + preload, but
 * instead of a node-pty shell its keystrokes feed this REPL, which runs adaL
 * cognitive commands directly in the Electron main process. Running in-process
 * (rather than a spawned `node` subprocess) is deliberate: the substrate's
 * better-sqlite3 store is built for Electron's ABI and would fail to load under
 * a plain node child.
 *
 * Input arrives as raw xterm byte sequences via feed(); output is emitted via
 * the write callback (already wired to `terminal:data`).
 */

import { getAdal } from "./index";

const PROMPT = "\x1b[36madaL\x1b[0m \x1b[90m›\x1b[0m ";
const NL = "\r\n";

const HELP = [
  "adaL REPL — cognitive substrate commands",
  "",
  "  /think <text>      associative recall (grounded constellation)",
  "  /ask <question>    targeted retrieval (honest refusal if unsure)",
  "  /tell <text>       absorb a fact",
  "  /tell_raw <text>   absorb verbatim (no enrichment)",
  "  /history <key>     version chain for a keyed concept",
  "  /drift <key>       cosine drift across a concept's versions",
  "  /schema            substrate summary (count, avg strength)",
  "  /clear             clear the screen",
  "  /help              this message",
  "",
  "  bare text with no leading / is treated as /think.",
].join(NL);

export class AdalRepl {
  private line = "";
  private busy = false;

  constructor(private write: (data: string) => void) {}

  /** Print banner + first prompt. Call once after the renderer is ready. */
  start(): void {
    this.write(
      `\x1b[1madaL\x1b[0m substrate REPL — type \x1b[33m/help\x1b[0m for commands.${NL}${NL}`,
    );
    this.prompt();
  }

  private prompt(): void {
    this.write(PROMPT);
  }

  /** Feed raw xterm input (may contain several keystrokes per chunk). */
  feed(data: string): void {
    if (this.busy) return; // ignore input while a command is running
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        this.write(NL);
        this.run(this.line.trim());
        this.line = "";
      } else if (code === 0x7f || code === 0x08) {
        // Backspace / delete
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.write("\b \b");
        }
      } else if (ch === "\x03") {
        // Ctrl-C — abandon the current line
        this.write("^C" + NL);
        this.line = "";
        this.prompt();
      } else if (ch === "\x15") {
        // Ctrl-U — kill line
        while (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.write("\b \b");
        }
      } else if (code >= 0x20) {
        this.line += ch;
        this.write(ch); // local echo
      }
    }
  }

  private run(input: string): void {
    if (!input) {
      this.prompt();
      return;
    }
    this.busy = true;
    let out = "";
    try {
      out = this.dispatch(input);
    } catch (err: any) {
      out = `\x1b[31merror:\x1b[0m ${err?.message || String(err)}`;
    }
    if (out) this.write(out.replace(/\n/g, NL) + NL);
    this.busy = false;
    this.prompt();
  }

  private dispatch(input: string): string {
    const adal = getAdal();
    if (!input.startsWith("/")) {
      // Bare text → associative recall.
      const act = adal.think(input);
      return act.thoughts.length ? act.groundedContext : "(no activation)";
    }
    const sp = input.indexOf(" ");
    const cmd = (sp === -1 ? input : input.slice(0, sp)).toLowerCase();
    const arg = sp === -1 ? "" : input.slice(sp + 1).trim();

    switch (cmd) {
      case "/help":
        return HELP;
      case "/clear":
        this.write("\x1b[2J\x1b[H");
        return "";
      case "/think": {
        if (!arg) return "usage: /think <text>";
        const act = adal.think(arg);
        return act.thoughts.length ? act.groundedContext : "(no activation)";
      }
      case "/ask": {
        if (!arg) return "usage: /ask <question>";
        const a = adal.ask(arg);
        return a.refused
          ? `I don't know. (confidence ${a.confidence.toFixed(2)})`
          : `${a.answer}\n(confidence ${a.confidence.toFixed(2)})`;
      }
      case "/tell": {
        if (!arg) return "usage: /tell <text>";
        const id = adal.tell(arg, "incoming");
        return id ? `absorbed: ${id}` : "(duplicate — not absorbed)";
      }
      case "/tell_raw": {
        if (!arg) return "usage: /tell_raw <text>";
        const id = adal.tellRaw(arg);
        return id ? `absorbed (raw): ${id}` : "(duplicate — not absorbed)";
      }
      case "/history": {
        if (!arg) return "usage: /history <key>";
        const hist = adal.history(arg);
        return hist.length
          ? hist.map((h) => `v${h.version ?? "?"}: ${h.content}`).join("\n")
          : `(no history for "${arg}")`;
      }
      case "/drift": {
        if (!arg) return "usage: /drift <key>";
        const d = adal.drift(arg);
        if (d.driftRate === undefined) return `only ${d.versions} version(s) — drift needs ≥2`;
        return [
          `versions: ${d.versions}`,
          `consecutive sims: [${(d.consecutiveSimilarities ?? []).map((x) => x.toFixed(3)).join(", ")}]`,
          `first→last sim: ${d.firstToLastSimilarity?.toFixed(3)}`,
          `drift rate: ${d.driftRate?.toFixed(3)}`,
        ].join("\n");
      }
      case "/schema": {
        const s = adal.schema();
        return `thoughts: ${s.count}\navg strength: ${s.avgStrength.toFixed(3)}`;
      }
      default:
        return `unknown command: ${cmd} — try /help`;
    }
  }
}
