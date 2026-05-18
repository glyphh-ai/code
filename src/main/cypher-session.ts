/**
 * cypher-session.ts — Cypher session activation and jammer spawning.
 *
 * Extracted from main.ts. Both functions take a deps object so the caller
 * can wire them to whichever managers / stores live in the main process.
 */

import fs from "fs";
import path from "path";
import type { WebContents } from "electron";
import type { AgentConfig as RunnerAgentConfig } from "./agent-runner";
import type { AgentRunner } from "./agent-runner";
import type { HierarchyEntry, McpExpose } from "./mcp-expose";
import { ghRequest } from "./mcp-expose";
import type { CypherBus } from "./cypher-bus";
import type { PanelManager } from "./panel-manager";
import type { WorkspaceManager } from "./workspace-manager";
import type { AgentConfig as AgentRegistryConfig } from "./stores/agent-store-db";
import type { SetupStep } from "./work-package-runner";
import type * as threadStoreNs from "./cypher-thread-store";

// ── Dependency interface ────────────────────────────────────

export interface CypherSessionDeps {
  /** Return the main BrowserWindow's webContents (or null if destroyed). */
  getMainWebContents: () => WebContents | null;

  panelManager: PanelManager;
  agentRunner: AgentRunner;
  workspaceManager: WorkspaceManager;
  mcpExpose: McpExpose | null;
  cypherBus: CypherBus;
  threadStore: typeof threadStoreNs;

  // Auth / API
  serverGetAuthed: <T>(path: string) => Promise<T>;
  serverPostAuthed: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
  // Agent registry
  listAgents: () => AgentRegistryConfig[];
  getAgent: (id: string) => AgentRegistryConfig | null;
}

// ── Factory ─────────────────────────────────────────────────

export function createCypherSession(deps: CypherSessionDeps) {
  const {
    getMainWebContents,
    panelManager,
    agentRunner,
    workspaceManager,
    mcpExpose,
    cypherBus,
    threadStore,
    serverGetAuthed,
    serverPostAuthed,
    listAgents,
    getAgent,
  } = deps;

  // ── helpers ──────────────────────────────────────────────

  /** Send a token (streaming text) to the yo panel in the main window. */
  function sendYoToken(text: string): void {
    const wc = getMainWebContents();
    if (wc && !wc.isDestroyed()) wc.send("yo-panel-token", text);
  }

  /** Send a "done" event to the yo panel in the main window. */
  function sendYoDone(text: string): void {
    const wc = getMainWebContents();
    if (wc && !wc.isDestroyed()) wc.send("yo-panel-done", text);
  }

  // ── activateCypherSession ────────────────────────────────

  async function activateCypherSession(cypId: string): Promise<void> {
    const stageWc = panelManager.getView("cypher")?.webContents;

    // Re-bind orphaned agents to current panel webContents (panel may have been recreated)
    if (stageWc && !stageWc.isDestroyed()) {
      agentRunner.rebindWebContents(stageWc);
    }

    // 1. Fetch cypher data + jammers from server
    const [cData, jData] = await Promise.all([
      serverGetAuthed<{ cypher?: { title?: string; goal?: string; status?: string; owner_login?: string } }>(`/api/cyphers/${encodeURIComponent(cypId)}`),
      serverGetAuthed<{ jammers?: Array<{ agent_local_id: string; user_id: string; position?: string; left_at?: string | null }> }>(`/api/cyphers/${encodeURIComponent(cypId)}/jammers`),
    ]);
    const cy = cData?.cypher;
    const activeJammers = (jData?.jammers || []).filter((j: any) => !j.left_at);

    // Skip full setup for wrapped cyphers — no spawning, no notification
    if (cy?.status === "wrapped") {
      console.log("[cypher-session] cypher is wrapped, skipping activation");
      return;
    }

    // 2. Ensure draft assignments exist — run draft if missing
    if (activeJammers.length > 0) {
      try {
        const manifestR = await serverGetAuthed<{ ok?: boolean; manifest?: { assignments: unknown[] } }>(
          `/api/cyphers/${encodeURIComponent(cypId)}/manifest`,
        );
        if (!manifestR?.manifest?.assignments?.length) {
          console.log("[cypher-session] No assignments found, triggering redraft for", activeJammers.length, "jammers");
          const draftResult = await serverPostAuthed<{ ok?: boolean; error?: string; assignments?: unknown[] }>(
            `/api/cyphers/${encodeURIComponent(cypId)}/redraft`, {},
          );
          console.log("[cypher-session] Redraft result:", JSON.stringify(draftResult));
        } else {
          console.log("[cypher-session] Assignments already exist:", manifestR.manifest.assignments.length);
        }
      } catch (err) {
        console.error("[cypher-session] Draft/manifest check failed:", err instanceof Error ? err.message : err);
      }
    }

    // 4. Spawn local jammer agents — AFTER all GitHub setup is complete
    let spawned = 0;
    if (stageWc && !stageWc.isDestroyed()) {
      const spawnResult = await spawnCypherJammers(cypId, stageWc);
      spawned = spawnResult.spawned ?? 0;
      if (spawned === 0 && activeJammers.length > 0) {
        console.warn("[cypher-session] 0 jammers spawned despite", activeJammers.length, "active.", spawnResult);
      }
    }

    // 6. Send status summary to yo panel — only on first activation (when jammers are newly spawned)
    if (spawned > 0) {
      const statusLines = [
        `⚡ Cypher: ${cy?.title || "Untitled"} [${cy?.status || "unknown"}]`,
        cy?.goal ? `Goal: ${cy.goal}` : "",
        `Jammers: ${activeJammers.length > 0 ? activeJammers.map((j: any) => j.agent_local_id).join(", ") : "none"}`,
      ].filter(Boolean).join("\n");
      sendYoToken(statusLines + "\n\n");
      sendYoDone(statusLines);
      threadStore.appendStage(cypId, { ts: Date.now(), kind: "text", content: statusLines });
      threadStore.appendStage(cypId, { ts: Date.now(), kind: "done", content: "" });
    }
  }

  // ── spawnCypherJammers ───────────────────────────────────

  async function spawnCypherJammers(cypId: string, wc: WebContents): Promise<{ ok: boolean; spawned?: number; skipped?: string[]; error?: string }> {
    if (!cypId) return { ok: false, error: "cypherId required" };

    const manifestR = await serverGetAuthed<{
      ok?: boolean;
      manifest?: {
        cypher_id: string;
        slug: string;
        title: string;
        goal: string | null;
        type: string;
        status: string;
        assignments: Array<{ id: string; agent_local_id: string; user_id: string; position: string; area: string | null; contract: string | null; parent_agent_id: string | null; reports: string[] }>;
        setup: Array<Record<string, unknown>>;
        generated_at: string;
      };
    }>(`/api/cyphers/${encodeURIComponent(cypId)}/manifest`);
    const manifest = manifestR?.manifest;
    if (!manifest) { console.warn("[spawn-jammers] manifest unavailable"); return { ok: false, error: "manifest unavailable" }; }
    const assignments = manifest.assignments ?? [];
    if (assignments.length === 0) { console.warn("[spawn-jammers] manifest has 0 assignments"); return { ok: true, spawned: 0 }; }

    const localAgents = listAgents();
    const localIds = new Set(localAgents.map((a) => a.id));
    console.log("[spawn-jammers] assignments:", assignments.map((a) => a.agent_local_id), "local:", [...localIds]);
    const mine = assignments.filter((a) => localIds.has(a.agent_local_id));
    if (mine.length === 0) { console.warn("[spawn-jammers] no assignments match local agents"); return { ok: true, spawned: 0 }; }

    const wsSlug = workspaceManager.getActive().slug;
    const wpModule = await import("./work-package-runner");
    const { runWorkPackage, jammerSandboxPath } = wpModule;
    const setupSteps = manifest.setup as unknown as SetupStep[];

    // Build hierarchy context from manifest assignments and inject into McpExpose
    const hierarchyMap = new Map<string, HierarchyEntry>();
    for (const a of assignments) {
      hierarchyMap.set(a.agent_local_id, {
        agentId: a.agent_local_id,
        position: a.position,
        parentAgentId: a.parent_agent_id,
        reports: a.reports ?? [],
        area: a.area,
        contract: a.contract,
      });
    }
    mcpExpose?.setHierarchyContext(hierarchyMap);
    cypherBus.setHierarchyContext(hierarchyMap);

    // Wire project board context — project with a linked repo is required
    let projSlug: string | null = null;
    let linkedRepos: string[] = [];
    try {
      const projR = await serverGetAuthed<{ project?: { slug: string }; linked_repos?: string[] }>(`/api/projects/by-cypher/${encodeURIComponent(cypId)}`);
      projSlug = projR?.project?.slug ?? null;
      linkedRepos = projR?.linked_repos ?? [];
    } catch {
      // 404 means no project linked
    }
    if (!projSlug || linkedRepos.length === 0) {
      console.error("[spawn-jammers] BLOCKED: no repo linked for cypher", cypId, "slug:", projSlug, "repos:", linkedRepos.length);
      return { ok: false, error: "No GitHub repo linked to this cypher. A repo must be attached during cypher creation." };
    }
    let ghToken: string | null = null;
    try {
      const ghTokR = await serverGetAuthed<{ token: string }>("/api/me/gh-token");
      ghToken = ghTokR?.token ?? null;
    } catch {
      console.warn("[spawn-jammers] could not fetch GitHub token — gh_* tools will be unavailable");
    }
    if (mcpExpose) {
      mcpExpose.setProjectContext({
        projectRef: projSlug,
        serverGet: serverGetAuthed,
        serverPost: serverPostAuthed,
        ...(ghToken && linkedRepos.length > 0 ? { ghToken, repoFullName: linkedRepos[0] } : {}),
      });
    }
    console.log(`[spawn-jammers] project board wired: ${projSlug}`, ghToken ? `gh: ${linkedRepos[0]}` : "no gh token");

    const mcpUrl = mcpExpose?.isRunning ? `http://127.0.0.1:${mcpExpose.getPort()}/mcp` : null;
    let mcpToken: string | undefined;
    if (mcpUrl && mcpExpose) {
      const mcpTokens = mcpExpose.getTokens();
      mcpToken = mcpTokens.length > 0 ? mcpTokens[0].token : mcpExpose.generateToken("jammer").token;
    }

    let spawned = 0;
    const skipped: string[] = [];

    // Build jammer config for an assignment
    const mf = manifest!;
    async function buildJammerConfig(
      a: typeof mine[0],
      briefingOverride?: string,
    ): Promise<{ config: RunnerAgentConfig; sandbox: string } | null> {
      const reg = getAgent(a.agent_local_id);
      if (!reg) { skipped.push(`${a.agent_local_id} (not in registry)`); return null; }
      const sandbox = jammerSandboxPath(cypId, a.agent_local_id);
      try { fs.mkdirSync(sandbox, { recursive: true }); } catch { /* ignore */ }

      try {
        fs.writeFileSync(path.join(sandbox, "cypher.json"), JSON.stringify(mf, null, 2));
      } catch (writeErr) {
        console.warn(`[spawn-jammers] failed writing cypher.json for ${reg.id}:`, writeErr instanceof Error ? writeErr.message : writeErr);
      }

      const readmePath = path.join(sandbox, "README.md");
      if (!fs.existsSync(readmePath)) {
        try {
          const roster = assignments.map(a2 => `- **${a2.agent_local_id}** — ${a2.position}${a2.area ? ` (${a2.area})` : ""}`).join("\n");
          fs.writeFileSync(readmePath, [
            `# ${mf.title}`,
            ``,
            `> ${mf.goal || ""}`,
            ``,
            `## Status`,
            ``,
            `In progress.`,
            ``,
            `## Team`,
            ``,
            roster,
            ``,
            `## Output`,
            ``,
            `_This section will be updated by the leader when the cypher wraps._`,
            ``,
          ].join("\n"));
        } catch { /* best-effort */ }
      }

      let promptAddition = "";
      if (setupSteps.length > 0) {
        const result = await runWorkPackage(setupSteps, sandbox);
        promptAddition = result.prompt_addition;
      }

      const priorThread = threadStore.loadAgent(cypId, reg.id);
      const isResume = priorThread.length > 0;
      let stateContext = "";
      if (isResume) {
        const stateLines: string[] = [`\n--- CURRENT PROJECT STATE ---`];

        // Fetch live board (GitHub issues) so leader knows what exists
        if (ghToken && linkedRepos.length > 0) {
          try {
            const [owner, repo] = linkedRepos[0].split("/");
            const res = await ghRequest("GET", `/repos/${owner}/${repo}/issues?state=all&per_page=50`, ghToken, "application/vnd.github+json");
            if (res.status >= 200 && res.status < 300) {
              const issues = JSON.parse(res.data) as { number: number; title: string; state: string; labels: { name: string }[]; assignees: { login: string }[] }[];
              if (issues.length > 0) {
                stateLines.push(`\n## Board Issues`);
                for (const iss of issues) {
                  const statusLabel = iss.labels.find(l => l.name.startsWith("status:"))?.name.replace("status:", "") || iss.state;
                  const assignee = iss.assignees.map(a => a.login).join(", ") || "unassigned";
                  stateLines.push(`  #${iss.number} [${statusLabel}] "${iss.title}" — ${assignee}`);
                }
              }
            }
          } catch { /* gh fetch failed, continue without */ }
        }

        // Recent feed activity
        const feed = threadStore.loadFeed(cypId, 30);
        if (feed.length > 0) {
          stateLines.push(`\n## Recent Activity`);
          for (const f of feed.slice(-20)) {
            const body = f.body.length > 120 ? f.body.slice(0, 117) + "..." : f.body;
            stateLines.push(`  [${f.from}] ${f.kind}: ${body}`);
          }
        }

        stateLines.push(
          `\n## Instructions`,
          `You were previously active. The session was interrupted (client restart).`,
          `Assess the activity above. Pick up where things left off — continue coding, assign remaining work, or wrap up if done.`,
          `--- END STATE ---\n`,
        );
        stateContext = stateLines.join("\n");
      }

      const role = reg.role || a.position;
      const g = reg.guardrails || {};
      const guardrailLines: string[] = [];
      if (g.max_turns) guardrailLines.push(`- Max turns: ${g.max_turns}`);
      if (g.max_tokens_per_session) guardrailLines.push(`- Max tokens budget: ${g.max_tokens_per_session}`);
      if (g.rate_limit_rpm) guardrailLines.push(`- Rate limit: ${g.rate_limit_rpm} requests/minute`);
      if (g.auto_stop_idle_seconds) guardrailLines.push(`- Auto-stop if idle for ${g.auto_stop_idle_seconds}s`);

      const isLeader = a.position === "leader" || a.position === "lieutenant" || a.position === "sub-lead";
      const hier = hierarchyMap.get(a.agent_local_id);
      const reportsStr = hier?.reports?.length ? hier.reports.join(", ") : "none";
      const parentStr = hier?.parentAgentId ?? "nobody (you are top of chain)";

      const systemPrompt = [
        `# JAMMER AGENT: ${reg.id}`,
        `Role: ${role}`,
        `Cypher: ${mf.title} (${cypId})`,
        `Sandbox: ${sandbox}`,
        ``,
        `## CONSTRAINTS`,
        `- Work in your sandbox: ${sandbox}`,
        `- Git clone/push/pull to the linked GitHub repo is permitted`,
        `- If something fails 3 times, stop and report it`,
        ``,
        `## EFFICIENCY`,
        `- You have a LIMITED budget. Ship working code fast — do NOT over-iterate or polish.`,
        `- Write a file ONCE. Do not rewrite the same file more than 2-3 times total.`,
        `- If something works, MOVE ON. Perfect is the enemy of done.`,
        `- Aim to complete your task in under 15 tool calls. If you've used 20+, wrap up immediately.`,
        `- When you finish, call complete_task right away. Do not review, refactor, or beautify.`,
        guardrailLines.length > 0 ? `\n## RESOURCE LIMITS\n${guardrailLines.join("\n")}` : "",
        ``,
        `## HIERARCHY`,
        `Position: ${a.position}`,
        `Reports to: ${parentStr}`,
        `Direct reports: ${reportsStr}`,
        ``,
        `## METHODOLOGY`,
        isLeader
          ? [
              `As ${a.position}:`,
              `1. Read ./cypher.json for the goal and roster.`,
              `2. IMMEDIATELY decompose the goal and assign a concrete task to EACH of`,
              `   your reports: ${reportsStr} — use assign_task, describe each task clearly.`,
              `   Do this FIRST. Your workers are waiting on you for direction.`,
              `3. If GitHub is set up, clone the repo (gh_repo_info → git clone) and write a`,
              `   README.md project plan. If git is NOT available, SKIP this — it does not`,
              `   block you, and it does not block assigning tasks.`,
              `4. Monitor progress — review what workers report; reassign or unblock as needed.`,
              `5. When the work is done, summarize the result (README or show_output).`,
              ``,
              `Your #1 job is to KEEP THE SWARM MOVING. Assign work fast; never stall on`,
              `tooling (git, auth). Workers come online shortly after the cypher starts —`,
              `give them tasks. Don't create GitHub issues or a task board — assign directly.`,
            ].join("\n")
          : [
              `As a worker:`,
              `1. Accept your task (accept_task). If you haven't been assigned one yet,`,
              `   read ./cypher.json and wait briefly — your leader will assign via the bus.`,
              `2. If GitHub is set up, clone the repo (gh_repo_info → git clone).`,
              `3. Do the work, commit often with clear messages.`,
              `4. If you can push: \`git pull && git push\`. If you CANNOT push (no git/auth),`,
              `   call submit_work when done — the maestro integrates your changes.`,
              `5. Use complete_task when finished.`,
              ``,
              `If push fails due to conflicts, pull and resolve, then push again.`,
              `Stay focused on your assigned task. Ship code, not tickets.`,
            ].join("\n"),
        ``,
        `## COMMUNICATION`,
        `- Use assign_task / accept_task / complete_task for work coordination`,
        `- Use post_to to message other agents directly`,
        `- Use report_status to update your leader on progress or blockers`,
        `- Read ./cypher.json for the cypher goal, roster, and context`,
        reg.systemPrompt ? `\n## CUSTOM INSTRUCTIONS\n${reg.systemPrompt}` : "",
      ].filter(Boolean).join("\n");

      const briefing = briefingOverride || [
        `You are jammer "${reg.id}" in cypher ${cypId}.`,
        `Position: ${a.position}.${a.area ? ` Area: ${a.area}` : ""}`,
        a.contract ? `Contract: ${a.contract}` : "",
        stateContext,
        isResume
          ? isLeader
            ? `Review the project state above. Clone the repo and pull latest. Check what's done vs in-progress. Continue from where things left off.`
            : `You were previously working on a task. Clone the repo, pull latest, and continue from where you left off.`
          : isLeader
            ? `Read ./cypher.json for context, then decompose the goal and assign tasks to your reports using assign_task.`
            : `You have been assigned a task. Use accept_task, then execute it.`,
        promptAddition,
      ].filter(Boolean).join("\n");

      const config: RunnerAgentConfig = {
        name: reg.id,
        role,
        cwd: sandbox,
        prompt: systemPrompt,
        startPrompt: briefing,
        workspace: wsSlug,
        cypherId: cypId,
        model: reg.model_name,
        modelProvider: reg.model_provider,
        guardrails: reg.guardrails,
        ...(mcpUrl && mcpToken ? {
          mcpServers: {
            "yo-workspace": {
              type: "http",
              url: mcpUrl,
              headers: {
                "X-Yo-Agent": reg.id,
                "X-Yo-Workspace": wsSlug,
                "Authorization": `Bearer ${mcpToken}`,
              },
            },
          },
        } : {}),
      };
      return { config, sandbox };
    }

    // Split into leaders (start immediately) and workers (start on assign_task)
    const leaders: typeof mine = [];
    const workers: typeof mine = [];
    for (const a of mine) {
      if (a.position === "leader" || a.position === "lieutenant" || a.position === "sub-lead") {
        leaders.push(a);
      } else {
        workers.push(a);
      }
    }

    // Phase A: Start leaders immediately
    for (const a of leaders) {
      const built = await buildJammerConfig(a);
      if (!built) continue;
      console.log(`[spawn-jammers] starting leader "${a.agent_local_id}" (position=${a.position})`);
      agentRunner.startAgent(wc, built.config).catch((startErr) => {
        console.error(`[spawn-jammers] start failed for ${a.agent_local_id}:`, startErr instanceof Error ? startErr.message : startErr);
      });
      spawned++;
    }

    // Phase B: Register workers for deferred activation on assign_task
    const pendingWorkers = new Map<string, typeof mine[0]>();
    for (const a of workers) {
      const reg = getAgent(a.agent_local_id);
      if (!reg) { skipped.push(`${a.agent_local_id} (not in registry)`); continue; }
      pendingWorkers.set(a.agent_local_id, a);
    }

    if (pendingWorkers.size > 0) {
      console.log(`[spawn-jammers] ${pendingWorkers.size} workers pending activation: ${[...pendingWorkers.keys()].join(", ")}`);

      const activateWorker = (a: typeof mine[0], briefing: string): void => {
        if (!pendingWorkers.has(a.agent_local_id)) return; // already activated
        pendingWorkers.delete(a.agent_local_id);
        spawned++;
        void buildJammerConfig(a, briefing).then((built) => {
          if (!built) return;
          agentRunner.startAgent(wc, built.config).catch((startErr) => {
            console.error(`[spawn-jammers] start failed for ${a.agent_local_id}:`, startErr instanceof Error ? startErr.message : startErr);
          });
        });
      };

      // A worker assigned a task before the auto-start timer fires gets the
      // task in its opening briefing.
      const unsub = cypherBus.onPost((_ws, event) => {
        if (event.kind !== "assign_task" || !event.to) return;
        const pending = pendingWorkers.get(event.to);
        if (!pending) return;
        console.log(`[spawn-jammers] activating worker "${event.to}" on assign_task from ${event.from}`);
        activateWorker(pending, [
          `You are jammer "${event.to}" in cypher ${cypId}.`,
          `Position: ${pending.position}.${pending.area ? ` Area: ${pending.area}` : ""}`,
          `You have been assigned a task by ${event.from}: ${event.body}`,
          `Use accept_task to acknowledge, then execute the task in your sandbox.`,
        ].join(" "));
        if (pendingWorkers.size === 0) unsub();
      });

      // Auto-start any still-idle workers after a short grace period — they
      // must not wait forever for a leader's assign_task (a stalled leader
      // would otherwise leave the whole swarm dark). They come up, register
      // on the bus, and pick up their assignment live when it arrives.
      setTimeout(() => {
        if (pendingWorkers.size === 0) return;
        console.log(`[spawn-jammers] auto-starting ${pendingWorkers.size} idle worker(s): ${[...pendingWorkers.keys()].join(", ")}`);
        for (const a of [...pendingWorkers.values()]) {
          activateWorker(a, [
            `You are jammer "${a.agent_local_id}" in cypher ${cypId}.`,
            `Position: ${a.position}.${a.area ? ` Area: ${a.area}` : ""}`,
            `Read ./cypher.json for the goal and roster. Your leader will assign you a`,
            `task via the bus — when it arrives, accept_task and execute it. If you`,
            `already see clear work in your area, start on it now.`,
          ].join(" "));
        }
        unsub();
      }, 25_000);
    }

    return { ok: true, spawned, skipped };
  }

  return {
    activateCypherSession,
    spawnCypherJammers,
  };
}
