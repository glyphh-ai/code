/**
 * flow-graph.ts — derive a React Flow graph from a skill.
 *
 * A skill is, in effect, a workflow: a trigger feeds inputs into the skill
 * body (a prompt or a JS runner), which fans out to the MCP tools it may
 * call and the sub-skills it chains, and produces declared outputs. We map
 * the skill's manifest to a left→right layered graph that the React island
 * (skill-flow.tsx) renders. No JS parsing — purely manifest-driven, so it's
 * deterministic and cheap.
 */

export type FlowKind = "trigger" | "input" | "skill" | "tool" | "subskill" | "output";

export interface FlowNode {
  id: string;
  type: "flow";
  position: { x: number; y: number };
  data: { label: string; sub?: string; kind: FlowKind };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface SkillFlowInput {
  manifest?: {
    inputs?: Array<{ name: string; type?: string }>;
    outputs?: Array<{ name: string; type?: string }>;
    "allowed-tools"?: string[];
    requires?: string[];
    schedule?: string | null;
  } | null;
  hasRunner?: boolean;
  runnerSchedule?: string | null;
}

// Column x-positions (left → right) and vertical spacing between siblings.
const COL = { trigger: 0, input: 280, skill: 600, fan: 940, output: 1280 };
const ROW = 104;
const CENTER = 0;

/** Vertical positions for `count` siblings, centered on CENTER. */
function stack(count: number): number[] {
  if (count <= 0) return [];
  const start = CENTER - ((count - 1) * ROW) / 2;
  return Array.from({ length: count }, (_, i) => start + i * ROW);
}

export function buildSkillGraph(name: string, data: SkillFlowInput | null): FlowGraph {
  const m = data?.manifest || {};
  const inputs = Array.isArray(m.inputs) ? m.inputs : [];
  const outputs = Array.isArray(m.outputs) ? m.outputs : [];
  const tools = Array.isArray(m["allowed-tools"]) ? m["allowed-tools"] : [];
  const subs = Array.isArray(m.requires) ? m.requires : [];
  const schedule = data?.runnerSchedule || m.schedule || null;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const edge = (source: string, target: string) =>
    edges.push({ id: `e-${source}-${target}`, source, target });

  // Trigger
  nodes.push({
    id: "trigger", type: "flow", position: { x: COL.trigger, y: CENTER },
    data: { kind: "trigger", label: schedule ? "Scheduled" : "Manual / Agent", sub: schedule || "Run on demand" },
  });

  // Inputs (between trigger and skill)
  const inY = stack(inputs.length);
  inputs.forEach((inp, i) => {
    const id = `in-${i}`;
    nodes.push({ id, type: "flow", position: { x: COL.input, y: inY[i] }, data: { kind: "input", label: inp.name, sub: inp.type } });
    edge("trigger", id);
  });

  // Core skill node
  nodes.push({
    id: "skill", type: "flow", position: { x: COL.skill, y: CENTER },
    data: { kind: "skill", label: name, sub: data?.hasRunner ? "JavaScript runner" : "Prompt skill" },
  });
  if (inputs.length) inputs.forEach((_, i) => edge(`in-${i}`, "skill"));
  else edge("trigger", "skill");

  // Fan-out: MCP tools the skill may call + sub-skills it chains
  const fan = [
    ...tools.map((t, i) => ({ id: `tool-${i}`, kind: "tool" as const, label: t, sub: "MCP tool" })),
    ...subs.map((s, i) => ({ id: `sub-${i}`, kind: "subskill" as const, label: s, sub: "sub-skill" })),
  ];
  const fanY = stack(fan.length);
  fan.forEach((f, i) => {
    nodes.push({ id: f.id, type: "flow", position: { x: COL.fan, y: fanY[i] }, data: { kind: f.kind, label: f.label, sub: f.sub } });
    edge("skill", f.id);
  });

  // Declared outputs
  const outY = stack(outputs.length);
  outputs.forEach((o, i) => {
    const id = `out-${i}`;
    nodes.push({ id, type: "flow", position: { x: COL.output, y: outY[i] }, data: { kind: "output", label: o.name, sub: o.type } });
    edge("skill", id);
  });

  return { nodes, edges };
}
