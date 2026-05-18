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

    function buildConfig(a: SwarmAssignment, briefing: string): RunnerAgentConfig | null {
      const reg = getAgent(a.agentId);
      if (!reg) { skipped.push(`${a.agentId} (not in registry)`); return null; }
      const hier = hierarchyMap.get(a.agentId)!;
      const isLeader = a.position === "leader";
      const reportsStr = hier.reports.length ? hier.reports.join(", ") : "none";
      const parentStr = hier.parentAgentId ?? "nobody (you are top of chain)";

      const systemPrompt = [
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
        isLeader
          ? `Decompose the goal and assign a concrete task to each report (${reportsStr}) with assign_task. Monitor progress, unblock workers, and keep the swarm moving. When the work is done, summarize the result.`
          : `Accept your task with accept_task, do the work, update your leader with report_status, and call complete_task when finished.`,
        ``,
        `## COMMUNICATION`,
        `- assign_task / accept_task / complete_task coordinate work`,
        `- post_to messages another agent directly; report_status updates your leader`,
        reg.systemPrompt ? `\n## CUSTOM INSTRUCTIONS\n${reg.systemPrompt}` : "",
      ].filter(Boolean).join("\n");

      return {
        name: reg.id,
        role: reg.role || a.position,
        cwd,
        prompt: systemPrompt,
        startPrompt: briefing,
        workspace: wsSlug,
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

    let spawned = 0;
    const leaders = assignments.filter((a) => a.position === "leader");
    const workers = assignments.filter((a) => a.position !== "leader");

    // Leaders start immediately.
    for (const a of leaders) {
      const cfg = buildConfig(a, [
        `You are "${a.agentId}", leading the swarm "${manifest.title}".`,
        `Goal: ${manifest.goal}`,
        `Decompose the goal and assign a task to each report via assign_task.`,
      ].join(" "));
      if (!cfg) continue;
      console.log(`[spawn-swarm] starting leader "${a.agentId}"`);
      agentRunner.startAgent(wc, cfg).catch((e) =>
        console.error(`[spawn-swarm] ${a.agentId} start failed:`, e instanceof Error ? e.message : e));
      spawned++;
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
        spawned++;
        const cfg = buildConfig(a, briefing);
        if (cfg) {
          agentRunner.startAgent(wc, cfg).catch((e) =>
            console.error(`[spawn-swarm] ${a.agentId} start failed:`, e instanceof Error ? e.message : e));
        }
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
          `${event.from} assigned you a task: ${event.body}`,
          `Use accept_task to acknowledge, then execute it.`,
        ].join(" "));
        if (pending.size === 0) unsub();
      });

      // A stalled leader must not leave the swarm dark — bring idle workers
      // up after a grace period; they register on the bus and pick up their
      // assignment live when it arrives.
      setTimeout(() => {
        if (pending.size === 0) return;
        console.log(`[spawn-swarm] auto-starting ${pending.size} idle worker(s)`);
        for (const a of [...pending.values()]) {
          activate(a, [
            `You are "${a.agentId}" in swarm "${manifest.title}".`,
            `Goal: ${manifest.goal}.${a.area ? ` Your area: ${a.area}.` : ""}`,
            `Your leader will assign a task via the bus — accept_task when it arrives.`,
            `If you already see clear work in your area, start on it now.`,
          ].join(" "));
        }
        unsub();
      }, 25_000);
    }

    return { ok: true, spawned, skipped };
  }

  return { spawnSwarm };
}
