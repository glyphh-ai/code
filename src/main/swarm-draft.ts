/**
 * swarm-draft — compose a SwarmManifest from a goal + an agent roster.
 *
 * v1 draft: the first agent leads; the rest are workers reporting to it.
 * A future "draft skill" can replace this with an LLM-composed hierarchy
 * (sub-leads, areas, contracts) — `draftSwarm` is the seam it slots into.
 */

import { randomUUID } from "crypto";
import type { SwarmManifest, SwarmAssignment } from "./cypher-session";

export function draftSwarm(opts: {
  goal: string;
  workspace: string;
  agentIds: string[];
  title?: string;
}): SwarmManifest {
  const ids = opts.agentIds.filter(Boolean);
  const title = (opts.title || opts.goal || "Swarm").slice(0, 80);
  const base = { id: randomUUID(), title, goal: opts.goal, workspace: opts.workspace };

  if (ids.length === 0) return { ...base, agents: [] };

  const [leaderId, ...workerIds] = ids;
  const agents: SwarmAssignment[] = [
    { agentId: leaderId, position: "leader", parentAgentId: null, reports: workerIds },
    ...workerIds.map((id): SwarmAssignment => ({
      agentId: id, position: "worker", parentAgentId: leaderId, reports: [],
    })),
  ];
  return { ...base, agents };
}
