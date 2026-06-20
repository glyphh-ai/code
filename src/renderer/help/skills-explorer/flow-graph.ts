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

export type FlowKind = "start" | "trigger" | "input" | "skill" | "tool" | "subskill" | "app" | "output" | "end";

export interface FlowNode {
  id: string;
  type: "flow";
  position: { x: number; y: number };
  data: { label: string; sub?: string; kind: FlowKind; appId?: string; url?: string };
}

export interface FlowApp { id: string; name: string; url?: string }

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
const COL = { start: -300, trigger: 0, input: 280, skill: 600, fan: 940, output: 1280, end: 1640 };
const ROW = 104;
const CENTER = 0;

/** Vertical positions for `count` siblings, centered on CENTER. */
function stack(count: number): number[] {
  if (count <= 0) return [];
  const start = CENTER - ((count - 1) * ROW) / 2;
  return Array.from({ length: count }, (_, i) => start + i * ROW);
}

export function buildSkillGraph(name: string, data: SkillFlowInput | null, apps: FlowApp[] = []): FlowGraph {
  const m = data?.manifest || {};
  const inputs = Array.isArray(m.inputs) ? m.inputs : [];
  const outputs = Array.isArray(m.outputs) ? m.outputs : [];
  const allowedTools = Array.isArray(m["allowed-tools"]) ? m["allowed-tools"] : [];
  const subs = Array.isArray(m.requires) ? m.requires : [];
  const schedule = data?.runnerSchedule || m.schedule || null;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const edge = (source: string, target: string) =>
    edges.push({ id: `e-${source}-${target}`, source, target });

  // Start marker
  nodes.push({ id: "start", type: "flow", position: { x: COL.start, y: CENTER }, data: { kind: "start", label: "Start" } });
  edge("start", "trigger");

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

  // Fan-out. allowed-tools entries are "<app-id>.<tool>"; tools whose namespace
  // is a Glyphh app collapse into ONE clickable app tile (opens that app's
  // panel). Everything else is a generic tool node. Sub-skills come from
  // `requires`.
  const appMap = new Map(apps.map((a) => [a.id, a]));
  const connected = new Map<string, FlowApp>();
  const toolNodes: Array<{ ns: string; tool: string }> = [];
  for (const entry of allowedTools) {
    const dot = entry.indexOf(".");
    const ns = dot < 0 ? entry : entry.slice(0, dot);
    const tool = dot < 0 ? entry : entry.slice(dot + 1);
    if (ns !== "yo" && appMap.has(ns)) {
      if (!connected.has(ns)) connected.set(ns, appMap.get(ns)!);
    } else {
      toolNodes.push({ ns, tool });
    }
  }

  const items: Array<{ id: string; data: FlowNode["data"] }> = [
    ...Array.from(connected.values()).map((a) => ({
      id: `app-${a.id}`,
      data: { kind: "app" as const, label: a.name, sub: "Glyphh app", appId: a.id, url: a.url },
    })),
    ...toolNodes.map((t, i) => ({
      id: `tool-${i}`,
      data: { kind: "tool" as const, label: t.tool || t.ns, sub: "tool" },
    })),
    ...subs.map((s, i) => ({
      id: `sub-${i}`,
      data: { kind: "subskill" as const, label: s, sub: "sub-skill" },
    })),
  ];
  const fanY = stack(items.length);
  items.forEach((it, i) => {
    nodes.push({ id: it.id, type: "flow", position: { x: COL.fan, y: fanY[i] }, data: it.data });
    edge("skill", it.id);
  });

  // Declared outputs
  const outY = stack(outputs.length);
  outputs.forEach((o, i) => {
    const id = `out-${i}`;
    nodes.push({ id, type: "flow", position: { x: COL.output, y: outY[i] }, data: { kind: "output", label: o.name, sub: o.type } });
    edge("skill", id);
  });

  // End marker — the flow completes at the declared outputs, or at the skill
  // itself when none are declared.
  nodes.push({ id: "end", type: "flow", position: { x: COL.end, y: CENTER }, data: { kind: "end", label: "End" } });
  if (outputs.length) outputs.forEach((_, i) => edge(`out-${i}`, "end"));
  else edge("skill", "end");

  return { nodes, edges };
}
