/**
 * skill-flow.tsx — React Flow island for the "skill as a workflow" view.
 *
 * The renderer is otherwise vanilla TS; this is the one React surface. It is
 * esbuild-bundled separately (build:skill-flow) into skill-flow.js + a
 * sibling skill-flow.css, then lazy-loaded by the Skills explorer, which
 * computes the graph (flow-graph.ts) and calls window.SkillFlow.mount().
 */

import { createRoot, type Root } from "react-dom/client";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./skill-flow.css";

type Kind = "trigger" | "input" | "skill" | "tool" | "subskill" | "output";

const KIND: Record<Kind, { color: string; glyph: string; tag: string }> = {
  trigger:  { color: "#f59e0b", glyph: "▸", tag: "Trigger" },
  input:    { color: "#4a9eff", glyph: "›", tag: "Input" },
  skill:    { color: "#25c75e", glyph: "◆", tag: "Skill" },
  tool:     { color: "#a78bfa", glyph: "⚙", tag: "MCP tool" },
  subskill: { color: "#25c75e", glyph: "⊂", tag: "Sub-skill" },
  output:   { color: "#4a9eff", glyph: "⤷", tag: "Output" },
};

function FlowNode({ data }: NodeProps) {
  const d = data as { label: string; sub?: string; kind: Kind };
  const k = KIND[d.kind] ?? KIND.skill;
  return (
    <div
      className={`sf-node${d.kind === "skill" ? " sf-node-skill" : ""}`}
      style={{ ["--sf" as string]: k.color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="sf-handle" />
      <div className="sf-tag">{k.glyph}&nbsp;{k.tag}</div>
      <div className="sf-label">{d.label}</div>
      {d.sub ? <div className="sf-sub">{d.sub}</div> : null}
      <Handle type="source" position={Position.Right} className="sf-handle" />
    </div>
  );
}

const nodeTypes = { flow: FlowNode };

function SkillFlow({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "smoothstep", style: { stroke: "var(--sf-edge)", strokeWidth: 1.5 } }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--sf-dot)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

interface Graph { nodes: Node[]; edges: Edge[]; }

const api = {
  mount(container: HTMLElement, graph: Graph): void {
    let root = roots.get(container);
    if (!root) { root = createRoot(container); roots.set(container, root); }
    root.render(<SkillFlow nodes={graph.nodes} edges={graph.edges} />);
  },
  unmount(container: HTMLElement): void {
    const root = roots.get(container);
    if (root) { root.unmount(); roots.delete(container); }
  },
};

(window as unknown as { SkillFlow: typeof api }).SkillFlow = api;
