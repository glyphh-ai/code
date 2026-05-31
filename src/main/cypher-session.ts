/**
 * cypher-session.ts — local swarm spawning.
 *
 * `spawnSwarm` takes a local SwarmManifest and starts each agent on the
 * AgentRunner. No server: the manifest is produced locally (the draft skill /
 * create_swarm tool); the agents coordinate over the in-process bus.
 */

import type { WebContents } from "electron";
import type { AgentConfig as RunnerAgentConfig } from "./agent-runner";
import type { AgentRunner } from "./agent-runner";
import type { HierarchyEntry, McpExpose } from "./mcp-expose";
import type { CypherBus } from "./cypher-bus";
import type { WorkspaceManager } from "./workspace-manager";
import type { AgentConfig as AgentRegistryConfig } from "./stores/agent-store-db";
import { runByokStream } from "./provider-adapters/byok-client";
import type { LLMProvider } from "./provider-adapters/agent-adapter";

const BYOK_PROVIDERS = new Set<string>(["anthropic", "openai", "google", "xai", "perplexity"]);

// ── Swarm manifest (local — no server) ──────────────────────

export interface SwarmAssignment {
  /** Registry agent id. */
  agentId: string;
  /** "leader" | "worker". */
  position: string;
  area?: string;
  contract?: string;
  parentAgentId?: string | null;
  reports?: string[];
}

export interface SwarmManifest {
  id: string;
  title: string;
  goal: string;
  /** Workspace slug the swarm runs in. */
  workspace: string;
  agents: SwarmAssignment[];
}

export interface CypherSessionDeps {
  agentRunner: AgentRunner;
  workspaceManager: WorkspaceManager;
  mcpExpose: McpExpose | null;
  cypherBus: CypherBus;
  getAgent: (id: string) => AgentRegistryConfig | null;
}

// ── Factory ─────────────────────────────────────────────────

export function createCypherSession(deps: CypherSessionDeps) {
  const { agentRunner, workspaceManager, mcpExpose, cypherBus, getAgent } = deps;

  /**
   * Spawn a local swarm: build a RunnerAgentConfig for each agent in the
   * manifest and start it on the AgentRunner. Leaders start immediately;
   * workers start when their leader assigns them a task (or after a short
   * grace period, so a stalled leader can't leave the swarm dark).
   */
  async function spawnSwarm(
    manifest: SwarmManifest,
    wc: WebContents,
  ): Promise<{ ok: boolean; spawned?: number; skipped?: string[]; error?: string }> {
    const assignments = manifest.agents ?? [];
    if (assignments.length === 0) return { ok: true, spawned: 0 };

    const active = workspaceManager.getActive();
    const wsSlug = manifest.workspace || active.slug;
    const cwd = active.rootDir; // the swarm shares the .yo working directory

    // Hierarchy context → McpExpose + bus (drives assign_task / get_hierarchy).
    const hierarchyMap = new Map<string, HierarchyEntry>();
    for (const a of assignments) {
      hierarchyMap.set(a.agentId, {
        agentId: a.agentId,
        position: a.position,
        parentAgentId: a.parentAgentId ?? null,
        reports: a.reports ?? [],
        area: a.area ?? null,
        contract: a.contract ?? null,
      });
    }
    mcpExpose?.setHierarchyContext(hierarchyMap);
    cypherBus.setHierarchyContext(hierarchyMap);

    // Local yo-workspace MCP wiring — the coordination toolkit.
    const mcpUrl = mcpExpose?.isRunning ? `http://127.0.0.1:${mcpExpose.getPort()}/mcp` : null;
    let mcpToken: string | undefined;
    if (mcpUrl && mcpExpose) {
      const toks = mcpExpose.getTokens();
      mcpToken = toks.length > 0 ? toks[0].token : mcpExpose.generateToken("swarm").token;
    }

    const skipped: string[] = [];

    /** A read-only agent runs a one-shot model turn, no tools. */
    function isReadonly(reg: AgentRegistryConfig): boolean {
      return reg.mode === "readonly"
        && !!reg.model_provider
        && BYOK_PROVIDERS.has(reg.model_provider);
    }

    function buildSystemPrompt(a: SwarmAssignment, reg: AgentRegistryConfig, readonly: boolean): string {
      const hier = hierarchyMap.get(a.agentId)!;
      const isLeader = a.position === "leader";
      const reportsStr = hier.reports.length ? hier.reports.join(", ") : "none";
      const parentStr = hier.parentAgentId ?? "nobody (you are top of chain)";
      return [
        `# SWARM AGENT: ${reg.id}`,
        `Role: ${reg.role || a.position}`,
        `Swarm: ${manifest.title}`,
        `Goal: ${manifest.goal}`,
        a.area ? `Your area: ${a.area}` : "",
        ``,
        `## HIERARCHY`,
        `Position: ${a.position}`,
        `Reports to: ${parentStr}`,
        `Direct reports: ${reportsStr}`,
        ``,
        `## METHODOLOGY`,
        readonly
          ? `You are a READ-ONLY agent: you have no tools and run a single turn. Think hard about the goal and your area, then give your analysis / position / recommendation in one clear, well-reasoned response.`
          : isLeader
            ? `Decompose the goal and assign a concrete task to each report (${reportsStr}) with assign_task. Monitor progress, unblock workers, and keep the swarm moving. When the work is done, summarize the result.`
            : `Wait for your leader's assign_task — do NOT guess your task. When it arrives, accept it with accept_task, do EXACTLY what it says, update your leader with report_status, and call complete_task when finished.`,
        readonly ? `` : `\n## COMMUNICATION\n- assign_task / accept_task / complete_task coordinate work\n- post_to messages another agent directly; report_status updates your leader`,
        readonly || isLeader ? `` : `\n## YOUR LEADER IS AUTHORITATIVE\nA message tagged [ASSIGNMENT from ...] is your real task and overrides anything you assumed earlier. If your leader corrects you or re-assigns mid-task, STOP what you're doing and follow the new instruction exactly — do not defend or continue your earlier interpretation.`,
        reg.systemPrompt ? `\n## CUSTOM INSTRUCTIONS\n${reg.systemPrompt}` : "",
      ].filter(Boolean).join("\n");
    }

    function buildConfig(a: SwarmAssignment, reg: AgentRegistryConfig, briefing: string): RunnerAgentConfig {
      return {
        name: reg.id,
        role: reg.role || a.position,
        cwd,
        prompt: buildSystemPrompt(a, reg, false),
        startPrompt: briefing,
        workspace: wsSlug,
        swarm: true,
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
    }

    /** Run a read-only agent: one BYOK turn, streamed onto the bus as feed. */
    async function runReadonly(a: SwarmAssignment, reg: AgentRegistryConfig, briefing: string): Promise<void> {
      if (!wc.isDestroyed()) wc.send("cw:agent:status", a.agentId, "running");
      void cypherBus.post(wsSlug, { from: a.agentId, kind: "agent_thinking", body: "Thinking…" });
      try {
        let acc = "";
        await runByokStream(
          reg.model_provider as LLMProvider,
          {
            model: reg.model_name || "",
            messages: [
              { role: "system", content: buildSystemPrompt(a, reg, true) },
              { role: "user", content: briefing },
            ],
          },
          { onText: (d) => { acc += d; } },
        );
        void cypherBus.post(wsSlug, {
          from: a.agentId, kind: "agent_result",
          body: acc.trim() || "(no response)",
        });
      } catch (e) {
        void cypherBus.post(wsSlug, {
          from: a.agentId, kind: "agent_error",
          body: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!wc.isDestroyed()) wc.send("cw:agent:status", a.agentId, "done");
      }
    }

    /** Dispatch one agent to its runtime — read-only turn or full agent loop. */
    function startOne(a: SwarmAssignment, briefing: string): boolean {
      const reg = getAgent(a.agentId);
      if (!reg) { skipped.push(`${a.agentId} (not in registry)`); return false; }
      if (isReadonly(reg)) {
        console.log(`[spawn-swarm] running read-only agent "${a.agentId}"`);
        void runReadonly(a, reg, briefing);
        return true;
      }
      console.log(`[spawn-swarm] starting agent "${a.agentId}"`);
      agentRunner.startAgent(wc, buildConfig(a, reg, briefing)).catch((e) =>
        console.error(`[spawn-swarm] ${a.agentId} start failed:`, e instanceof Error ? e.message : e));
      return true;
    }

    let spawned = 0;
    const leaders = assignments.filter((a) => a.position === "leader");
    const workers = assignments.filter((a) => a.position !== "leader");

    // Leaders start immediately.
    for (const a of leaders) {
      const ok = startOne(a, [
        `You are "${a.agentId}", leading the swarm "${manifest.title}".`,
        `Goal: ${manifest.goal}`,
        `Decompose the goal and assign a task to each report via assign_task.`,
      ].join(" "));
      if (ok) spawned++;
    }

    // Workers start on assign_task, or auto-start after a grace period.
    const pending = new Map<string, SwarmAssignment>();
    for (const a of workers) {
      if (!getAgent(a.agentId)) { skipped.push(`${a.agentId} (not in registry)`); continue; }
      pending.set(a.agentId, a);
    }

    if (pending.size > 0) {
      const activate = (a: SwarmAssignment, briefing: string): void => {
        if (!pending.has(a.agentId)) return; // already activated
        pending.delete(a.agentId);
        if (startOne(a, briefing)) spawned++;
      };

      // A worker assigned a task before the grace timer fires gets the task
      // in its opening briefing.
      const unsub = cypherBus.onPost((_ws, event) => {
        if (event.kind !== "assign_task" || !event.to) return;
        const a = pending.get(event.to);
        if (!a) return;
        console.log(`[spawn-swarm] activating worker "${event.to}" on assign_task`);
        activate(a, [
          `You are "${event.to}" in swarm "${manifest.title}".`,
          `${event.from} assigned you this task:`,
          `\n${event.body}\n`,
          `Acknowledge with accept_task, then execute it EXACTLY as written.`,
          `Do not re-scope or reinterpret it. If anything is unclear, ask your`,
          `leader with post_to before starting. If the leader later corrects or`,
          `re-assigns you, that new instruction overrides this one.`,
        ].join(" "));
        if (pending.size === 0) unsub();
      });

      // A stalled leader must not leave the swarm dark — bring idle workers
      // up after a grace period. They do NOT guess: they stand by, and their
      // real task is pushed into their loop as a follow-up when the leader's
      // assign_task lands on the bus.
      setTimeout(() => {
        if (pending.size === 0) return;
        console.log(`[spawn-swarm] auto-starting ${pending.size} idle worker(s) — standby`);
        for (const a of [...pending.values()]) {
          activate(a, [
            `You are "${a.agentId}" in swarm "${manifest.title}".`,
            `Goal: ${manifest.goal}`,
            `Your leader is still planning and has NOT assigned your task yet.`,
            `Do NOT guess your task or start any work. Reply with one short line`,
            `that you are standing by, then stop. Your assignment will arrive as`,
            `a follow-up message tagged [ASSIGNMENT from ...] — when it does,`,
            `accept_task and execute it exactly as written.`,
          ].join(" "));
        }
        unsub();
      }, 45_000);
    }

    return { ok: true, spawned, skipped };
  }

  /**
   * Spawn ONE detached ephemeral agent (not from the registry) on the
   * AgentRunner. Same machinery as a one-member swarm, but the agent is
   * ad-hoc: a generic background helper given a single task. It runs the full
   * agent loop (tools + workspace MCP), streams its activity onto the bus
   * (so it shows in the Sub-Agents panel), and posts agent_result on finish.
   * Returns as soon as it's launched — the caller does not block on it.
   */
  async function spawnEphemeral(
    wc: WebContents,
    opts: { id: string; role?: string; prompt: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const prompt = (opts.prompt || "").trim();
    if (!prompt) return { ok: false, error: "A prompt is required." };

    const active = workspaceManager.getActive();
    const wsSlug = active.slug;
    const cwd = active.rootDir;

    // Local yo-workspace MCP wiring so the helper has the coordination toolkit.
    const mcpUrl = mcpExpose?.isRunning ? `http://127.0.0.1:${mcpExpose.getPort()}/mcp` : null;
    let mcpToken: string | undefined;
    if (mcpUrl && mcpExpose) {
      const toks = mcpExpose.getTokens();
      mcpToken = toks.length > 0 ? toks[0].token : mcpExpose.generateToken("bg").token;
    }

    const system = [
      `# BACKGROUND AGENT: ${opts.id}`,
      opts.role ? `Role: ${opts.role}` : "",
      ``,
      `You are an autonomous background helper spawned by the user's main assistant to handle ONE task without blocking the user.`,
      `Do exactly the task you are given, using your tools as needed. When you finish, end your final message with a concise, self-contained summary of what you found or did — that summary is handed back to the main assistant, so it must stand on its own.`,
    ].filter(Boolean).join("\n");

    const config: RunnerAgentConfig = {
      name: opts.id,
      role: opts.role || "background",
      cwd,
      prompt: system,
      startPrompt: prompt,
      workspace: wsSlug,
      swarm: true,
      ...(mcpUrl && mcpToken ? {
        mcpServers: {
          "yo-workspace": {
            type: "http",
            url: mcpUrl,
            headers: {
              "X-Yo-Agent": opts.id,
              "X-Yo-Workspace": wsSlug,
              "Authorization": `Bearer ${mcpToken}`,
            },
          },
        },
      } : {}),
    };

    try {
      // Fire-and-forget: start the loop, return immediately. Failures surface
      // on the bus as agent_error (and to the console here).
      agentRunner.startAgent(wc, config).catch((e) =>
        console.error(`[spawn-ephemeral] ${opts.id} start failed:`, e instanceof Error ? e.message : e));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { spawnSwarm, spawnEphemeral };
}
