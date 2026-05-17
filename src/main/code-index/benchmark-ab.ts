/**
 * code-index/benchmark-ab — real agent A/B. Validates the static proxy.
 *
 * For each task the actual Claude agent runs twice against this repo:
 *   - baseline:    Grep + Glob + Read   (the normal find-then-read loop)
 *   - code_search: Read + code_search   (Grep/Glob/Bash withheld)
 * and we record the SDK's real token usage + cost for each.
 *
 * Spends API tokens (≈20 agent runs). Run with: npm run bench:code-index-ab
 */

import { z } from "zod/v4";
import { ensureSDK, asarSafeQueryOptions } from "../sdk-llm";
import { getShellPath } from "../shell-path";
import { searchCode } from "./search";

const REPO = process.cwd();
const MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 24;

const TASKS: Array<{ task: string; answerFile: string }> = [
  { task: "Find where the prompt-injection firewall scans untrusted input.", answerFile: "firewall.ts" },
  { task: "Find how the app's working directory folder is persisted.", answerFile: "working-directory.ts" },
  { task: "Find where BrowserView panel bounds are computed with the left-rail inset.", answerFile: "panel-manager.ts" },
  { task: "Find the file-open router that picks which app opens a file by its extension.", answerFile: "main.ts" },
  { task: "Find where the path-gate enforces the trust boundary on tool calls.", answerFile: "path-gate.ts" },
  { task: "Find how the app opens a file in VS Code without reloading the editor.", answerFile: "vscode-bridge.ts" },
  { task: "Find where the Claude agent SDK's cwd is set to the working directory.", answerFile: "yo-agent.ts" },
  { task: "Find how the run_command tool restricts shell commands to an allowlist.", answerFile: "tools.ts" },
  { task: "Find where the VS Code server is spawned with serve-web.", answerFile: "vscode-server.ts" },
  { task: "Find how creating a new file or folder works over IPC.", answerFile: "files-ipc.ts" },
];

function codeSearchMcp(sdk: any): any {
  return sdk.createSdkMcpServer({
    name: "bench",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [{
      name: "code_search",
      description:
        "Lexical search over the codebase — returns the most relevant code " +
        "chunks (file:line ranges + snippets). Use this to find where something " +
        "is implemented instead of grep/glob.",
      inputSchema: { query: z.string(), limit: z.number().optional() },
      handler: async (args: Record<string, unknown>) => {
        const limit = typeof args.limit === "number" ? args.limit : 8;
        const res = searchCode(String(args.query), REPO, limit);
        const body = res.hits
          .map((h) => `${h.file}:${h.startLine}-${h.endLine}\n${h.text}`)
          .join("\n\n---\n\n");
        return {
          content: [{
            type: "text" as const,
            text: res.hits.length ? `${res.hits.length} matches:\n\n${body}` : "No matches.",
          }],
        };
      },
    }],
  });
}

interface RunResult { inputTokens: number; cost: number; text: string; turns: number; }

async function runAgent(sdk: any, task: string, useCodeSearch: boolean): Promise<RunResult> {
  const options: Record<string, any> = {
    ...asarSafeQueryOptions(REPO),
    model: MODEL,
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, PATH: getShellPath() },
  };
  if (useCodeSearch) {
    options.allowedTools = ["Read", "mcp__bench__code_search"];
    options.disallowedTools = ["Grep", "Glob", "Bash"];
    options.mcpServers = { bench: codeSearchMcp(sdk) };
  } else {
    options.allowedTools = ["Grep", "Glob", "Read"];
    options.disallowedTools = ["Bash"];
  }

  const prompt =
    `In this repository: ${task}\n\n` +
    `Once you've located and understood the relevant code, reply with a one-line ` +
    `answer that names the key source file.`;

  let inputTokens = 0;
  let cost = 0;
  let text = "";
  let turns = 0;
  const gen = sdk.query({ prompt, options });
  for await (const msg of gen) {
    if (msg.type === "assistant") {
      turns++;
      for (const b of msg.message?.content || []) {
        if (b.type === "text" && b.text) text = b.text;
      }
    } else if (msg.type === "result") {
      const u = msg.usage || {};
      inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      cost = msg.total_cost_usd || 0;
      if (msg.result) text = String(msg.result);
    }
  }
  return { inputTokens, cost, text, turns };
}

async function main(): Promise<void> {
  console.log(`[ab] real agent A/B — ${TASKS.length} tasks × 2, model ${MODEL}\n`);
  const sdk = await ensureSDK();

  const rows: Array<{
    answerFile: string; baseTok: number; csTok: number;
    baseCost: number; csCost: number; baseHit: boolean; csHit: boolean;
  }> = [];

  for (let i = 0; i < TASKS.length; i++) {
    const { task, answerFile } = TASKS[i];
    console.log(`[${i + 1}/${TASKS.length}] ${task}`);
    try {
      const base = await runAgent(sdk, task, false);
      const baseHit = base.text.includes(answerFile);
      console.log(`   baseline     ${String(base.inputTokens).padStart(8)} in-tok  $${base.cost.toFixed(4)}  ${base.turns}t  ${baseHit ? "✓" : "✗"}`);
      const cs = await runAgent(sdk, task, true);
      const csHit = cs.text.includes(answerFile);
      console.log(`   code_search  ${String(cs.inputTokens).padStart(8)} in-tok  $${cs.cost.toFixed(4)}  ${cs.turns}t  ${csHit ? "✓" : "✗"}`);
      rows.push({
        answerFile,
        baseTok: base.inputTokens, csTok: cs.inputTokens,
        baseCost: base.cost, csCost: cs.cost,
        baseHit, csHit,
      });
    } catch (err) {
      console.log(`   ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (rows.length === 0) { console.log("\n[ab] no runs completed."); return; }
  const sum = (f: (r: typeof rows[0]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const baseTok = sum((r) => r.baseTok);
  const csTok = sum((r) => r.csTok);
  const baseCost = sum((r) => r.baseCost);
  const csCost = sum((r) => r.csCost);
  console.log(`\n── A/B results (${rows.length} tasks) ─────────────────────────────`);
  console.log(`  baseline correct:     ${rows.filter((r) => r.baseHit).length}/${rows.length}`);
  console.log(`  code_search correct:  ${rows.filter((r) => r.csHit).length}/${rows.length}`);
  console.log(`  avg input tokens — baseline: ${Math.round(baseTok / rows.length)}  code_search: ${Math.round(csTok / rows.length)}`);
  console.log(`  total cost — baseline: $${baseCost.toFixed(2)}  code_search: $${csCost.toFixed(2)}`);
  console.log(`  token savings:  ${((1 - csTok / baseTok) * 100).toFixed(1)}%`);
  console.log(`  cost savings:   ${((1 - csCost / baseCost) * 100).toFixed(1)}%\n`);
}

main().catch((err) => { console.error("[ab] failed:", err); process.exit(1); });
