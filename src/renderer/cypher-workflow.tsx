import React, { useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
// @ts-ignore — CSS import handled by esbuild
import "@xyflow/react/dist/style.css";
// @ts-ignore — no type declarations for dagre
import dagre from "dagre";

const LEADER_POSITIONS = new Set(["leader", "lieutenant", "sub-lead"]);
const PURPLE = "#a855f7";
const GREEN = "#22c55e";
const BLUE = "#5599ff";

export interface WorkflowJammer {
  id: string;
  name: string;
  position: string;
  status: string;
  parentId?: string | null;
}

// ── Theme CSS ─────────────────────────────────────────

const THEME_CSS = `
  .react-flow__controls button {
    background: rgba(14,14,28,0.95) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    fill: #888 !important;
  }
  .react-flow__controls button:hover {
    background: rgba(30,30,55,0.95) !important;
    fill: #bbb !important;
  }
  .react-flow__edge-path {
    stroke-linecap: round;
  }
  .react-flow__attribution {
    display: none !important;
  }
`;

// ── Custom Nodes ──────────────────────────────────────

const HANDLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  width: 1,
  height: 1,
};

function JammerNode({ data }: NodeProps) {
  const d = data as Record<string, any>;
  const accent = d.isLeader ? PURPLE : GREEN;
  const isRunning = d.status === "running" || d.status === "starting";
  const statusColor = isRunning ? GREEN : "#555";

  return (
    <>
      <Handle type="target" position={Position.Top} style={HANDLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE} />
      <div
        style={{
          background: "rgba(12, 12, 26, 0.96)",
          border: `2px solid ${d.active ? accent : accent + "55"}`,
          borderRadius: 14,
          padding: "14px 16px",
          minWidth: 180,
          backdropFilter: "blur(12px)",
          boxShadow: d.active
            ? `0 0 24px ${accent}35, 0 0 48px ${accent}10, inset 0 0 20px ${accent}08`
            : "0 2px 16px rgba(0,0,0,0.5)",
          transition: "border-color 0.4s, box-shadow 0.4s",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${accent}18, ${accent}44)`,
              border: `2px solid ${accent}77`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: 700,
              color: "#eee",
              letterSpacing: 1,
              flexShrink: 0,
            }}
          >
            {d.initials}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                color: "#eee",
                fontWeight: 600,
                fontSize: 13,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {d.name}
            </div>
            <div
              style={{
                color: accent,
                fontSize: 11,
                fontWeight: 500,
                textTransform: "capitalize",
                marginTop: 2,
                opacity: 0.85,
              }}
            >
              {d.position}
            </div>
          </div>
        </div>
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderTop: "1px solid rgba(255,255,255,0.05)",
            paddingTop: 8,
          }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: statusColor,
              boxShadow: isRunning ? `0 0 8px ${statusColor}` : "none",
              transition: "all 0.3s",
            }}
          />
          <span style={{ color: "#777", fontSize: 10, fontWeight: 500 }}>
            {d.status || "idle"}
          </span>
        </div>
      </div>
    </>
  );
}

function HubNode(_props: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Bottom} style={HANDLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE} />
      <div
        style={{
          background: "rgba(12, 16, 36, 0.96)",
          border: `2px solid ${BLUE}44`,
          borderRadius: 20,
          padding: "18px 28px",
          textAlign: "center",
          backdropFilter: "blur(12px)",
          boxShadow: `0 0 32px ${BLUE}0c, 0 2px 16px rgba(0,0,0,0.5)`,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.85 }}>⬡</div>
        <div
          style={{
            color: BLUE,
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 0.5,
          }}
        >
          GitHub
        </div>
      </div>
    </>
  );
}

const nodeTypes = { jammer: JammerNode, hub: HubNode };

// ── Dagre Layout ──────────────────────────────────────

const JAMMER_W = 210;
const JAMMER_H = 100;
const HUB_W = 140;
const HUB_H = 76;

function computeLayout(
  jammers: WorkflowJammer[],
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    ranksep: 100,
    nodesep: 50,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  g.setNode("gh-hub", { width: HUB_W, height: HUB_H });

  for (const j of jammers) {
    g.setNode(j.id, { width: JAMMER_W, height: JAMMER_H });
    if (j.parentId) {
      g.setEdge(j.parentId, j.id);
    } else {
      g.setEdge("gh-hub", j.id);
    }
  }

  dagre.layout(g);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const hp = g.node("gh-hub");
  if (hp) {
    nodes.push({
      id: "gh-hub",
      type: "hub",
      position: { x: hp.x - HUB_W / 2, y: hp.y - HUB_H / 2 },
      data: {},
      draggable: false,
    });
  }

  for (const j of jammers) {
    const p = g.node(j.id);
    if (!p) continue;
    const isLeader = LEADER_POSITIONS.has(j.position);
    const initials = (j.name || j.id)
      .split(/[\s\-_]+/)
      .map((w: string) => w[0] || "")
      .join("")
      .slice(0, 2)
      .toUpperCase();

    nodes.push({
      id: j.id,
      type: "jammer",
      position: { x: p.x - JAMMER_W / 2, y: p.y - JAMMER_H / 2 },
      data: {
        name: j.name || j.id,
        initials: initials || "??",
        position: j.position,
        status: j.status,
        isLeader,
        active: false,
      },
      draggable: false,
    });

    if (j.parentId) {
      edges.push({
        id: `hier-${j.parentId}-${j.id}`,
        source: j.parentId,
        target: j.id,
        type: "default",
        animated: true,
        style: { stroke: PURPLE, strokeWidth: 2, strokeDasharray: "8 4" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: PURPLE,
          width: 14,
          height: 14,
        },
      });
    } else {
      edges.push({
        id: `hub-${j.id}`,
        source: "gh-hub",
        target: j.id,
        type: "default",
        animated: true,
        style: {
          stroke: BLUE,
          strokeWidth: 1.5,
          strokeDasharray: "6 4",
          opacity: 0.3,
        },
      });
    }
  }

  return { nodes, edges };
}

// ── React Component ───────────────────────────────────

interface CommPair {
  from: string;
  to: string;
}

interface WorkflowProps {
  jammers: WorkflowJammer[];
  activeNodes: Set<string>;
  activePairs: CommPair[];
  activeHubNodes: Set<string>;
}

function WorkflowGraph({ jammers, activeNodes, activePairs, activeHubNodes }: WorkflowProps) {
  const structKey = JSON.stringify(
    jammers.map((j) => [j.id, j.parentId, j.position, j.status]),
  );

  const { nodes: layoutNodes, edges: structEdges } = useMemo(
    () => computeLayout(jammers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structKey],
  );

  const nodes = useMemo(
    () =>
      layoutNodes.map((n) => ({
        ...n,
        data: { ...n.data, active: activeNodes.has(n.id) },
      })),
    [layoutNodes, activeNodes],
  );

  const edges = useMemo(() => {
    const all: Edge[] = structEdges.map((e) => {
      if (e.id.startsWith("hub-")) {
        const jammerId = e.id.slice(4);
        const isActive = activeHubNodes.has(jammerId);
        return {
          ...e,
          style: {
            ...e.style,
            stroke: isActive ? BLUE : BLUE,
            strokeWidth: isActive ? 2.5 : 1.5,
            opacity: isActive ? 0.8 : 0.15,
          },
          animated: isActive,
        };
      }
      return e;
    });

    const seen = new Set<string>();
    for (const pair of activePairs) {
      const key = pair.from < pair.to ? `${pair.from}|${pair.to}` : `${pair.to}|${pair.from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        id: `comm-${key}`,
        source: pair.from,
        target: pair.to,
        type: "default",
        animated: true,
        style: {
          stroke: GREEN,
          strokeWidth: 2,
          strokeDasharray: "6 4",
          opacity: 0.7,
        },
      });
    }

    return all;
  }, [structEdges, activePairs, activeHubNodes]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <style>{THEME_CSS}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        style={{ background: "#0a0a14" }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="#1a1a2e"
          gap={24}
          size={1}
        />
        <Controls
          showInteractive={false}
          style={{
            background: "rgba(14,14,28,0.95)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 10,
            boxShadow: "0 2px 16px rgba(0,0,0,0.4)",
          }}
        />
        <MiniMap
          style={{
            background: "rgba(14,14,28,0.95)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 10,
          }}
          nodeColor={(node) => {
            if (node.type === "hub") return BLUE;
            return (node.data as any)?.isLeader ? PURPLE : GREEN;
          }}
          maskColor="rgba(0,0,0,0.7)"
        />
      </ReactFlow>
    </div>
  );
}

// ── Imperative Wrapper ────────────────────────────────

export class CypherWorkflow {
  private root: Root | null = null;
  private jammers: WorkflowJammer[] = [];
  private activeNodes = new Set<string>();
  private activeTimers = new Map<string, number>();
  private activePairs = new Map<string, { from: string; to: string; timer: number }>();
  private activeHubNodes = new Set<string>();
  private hubTimers = new Map<string, number>();

  init(container: HTMLElement): void {
    this.root = createRoot(container);
    this.render();
  }

  setJammers(jammers: WorkflowJammer[]): void {
    this.jammers = jammers;
    this.render();
  }

  onFeedEvent(from: string, _kind: string, _body: string, to?: string): void {
    this.activate(from);
    if (to) {
      const isJammer = this.jammers.some((j) => j.id === to);
      if (isJammer) {
        this.activate(to);
        this.activatePair(from, to);
      }
    }
    if (!to || !this.jammers.some((j) => j.id === to)) {
      this.activateHub(from);
    }
    this.render();
  }

  updateStatus(id: string, status: string): void {
    const j = this.jammers.find((x) => x.id === id);
    if (j) {
      j.status = status;
      this.render();
    }
  }

  resize(): void {}

  dispose(): void {
    for (const t of this.activeTimers.values()) clearTimeout(t);
    this.activeTimers.clear();
    this.activeNodes.clear();
    for (const p of this.activePairs.values()) clearTimeout(p.timer);
    this.activePairs.clear();
    for (const t of this.hubTimers.values()) clearTimeout(t);
    this.hubTimers.clear();
    this.activeHubNodes.clear();
    this.root?.unmount();
    this.root = null;
  }

  private activate(id: string): void {
    this.activeNodes.add(id);
    const prev = this.activeTimers.get(id);
    if (prev) clearTimeout(prev);
    this.activeTimers.set(
      id,
      window.setTimeout(() => {
        this.activeNodes.delete(id);
        this.activeTimers.delete(id);
        this.render();
      }, 3000),
    );
  }

  private activatePair(from: string, to: string): void {
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    const prev = this.activePairs.get(key);
    if (prev) clearTimeout(prev.timer);
    this.activePairs.set(key, {
      from,
      to,
      timer: window.setTimeout(() => {
        this.activePairs.delete(key);
        this.render();
      }, 4000),
    });
  }

  private activateHub(from: string): void {
    this.activeHubNodes.add(from);
    const prev = this.hubTimers.get(from);
    if (prev) clearTimeout(prev);
    this.hubTimers.set(
      from,
      window.setTimeout(() => {
        this.activeHubNodes.delete(from);
        this.hubTimers.delete(from);
        this.render();
      }, 4000),
    );
  }

  private render(): void {
    if (!this.root) return;
    const pairs: CommPair[] = [];
    for (const p of this.activePairs.values()) {
      pairs.push({ from: p.from, to: p.to });
    }
    this.root.render(
      <WorkflowGraph
        jammers={this.jammers}
        activeNodes={new Set(this.activeNodes)}
        activePairs={pairs}
        activeHubNodes={new Set(this.activeHubNodes)}
      />,
    );
  }
}
