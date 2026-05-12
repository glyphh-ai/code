import cytoscape from "cytoscape";
// @ts-ignore — no types for cytoscape-dagre
import dagre from "cytoscape-dagre";

cytoscape.use(dagre as any);

const LEADER_POSITIONS = new Set(["leader", "lieutenant", "sub-lead"]);
const PURPLE = "#a855f7";
const GREEN = "#22c55e";
const BLUE = "#5599ff";
const DIM = "#334";
const SURFACE = "#1a1a2e";

export interface WorkflowJammer {
  id: string;
  name: string;
  position: string;
  status: string;
  parentId?: string | null;
}

export interface WorkflowIssue {
  id: string;
  title: string;
  status: string;
  assignee?: string;
}

export class CypherWorkflow {
  private cy: cytoscape.Core | null = null;
  private container: HTMLElement | null = null;
  private animFrame = 0;
  private heatMap = new Map<string, number>();
  private lastJammerKey = "";

  init(container: HTMLElement): void {
    this.container = container;

    this.cy = cytoscape({
      container,
      elements: [],
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      style: [
        {
          selector: "node.jammer",
          style: {
            label: "data(label)",
            width: 60,
            height: 60,
            shape: "round-rectangle",
            "background-color": "data(color)",
            "background-opacity": 0.15,
            "border-width": 2,
            "border-color": "data(color)",
            "border-opacity": 0.8,
            color: "#eee",
            "font-size": "11px",
            "font-weight": "600",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "text-wrap": "ellipsis",
            "text-max-width": "80px",
          } as any,
        },
        {
          selector: "node.jammer.running",
          style: {
            "background-opacity": 0.35,
            "border-width": 3,
            "border-opacity": 1,
            "shadow-blur": 20,
            "shadow-color": "data(color)",
            "shadow-opacity": 0.6,
          } as any,
        },
        {
          selector: "node.hub",
          style: {
            label: "GitHub",
            width: 50,
            height: 50,
            shape: "ellipse",
            "background-color": BLUE,
            "background-opacity": 0.2,
            "border-width": 2,
            "border-color": BLUE,
            "border-opacity": 0.6,
            color: BLUE,
            "font-size": "10px",
            "font-weight": "700",
            "text-valign": "bottom",
            "text-margin-y": 8,
          } as any,
        },
        {
          selector: "node.issue",
          style: {
            label: "data(label)",
            width: "label",
            height: 24,
            shape: "round-rectangle",
            "background-color": "data(color)",
            "background-opacity": 0.12,
            "border-width": 1,
            "border-color": "data(color)",
            "border-opacity": 0.5,
            color: "data(color)",
            "font-size": "9px",
            "font-weight": "500",
            padding: "6px",
            "text-valign": "center",
            "text-halign": "center",
          } as any,
        },
        {
          selector: "edge.hierarchy",
          style: {
            width: 2,
            "line-color": PURPLE,
            "line-opacity": 0.3,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": PURPLE,
            "arrow-scale": 0.8,
          } as any,
        },
        {
          selector: "edge.hub-link",
          style: {
            width: 1,
            "line-color": BLUE,
            "line-opacity": 0.12,
            "line-style": "dashed",
            "curve-style": "bezier",
          } as any,
        },
        {
          selector: "edge.active",
          style: {
            "line-opacity": 0.7,
            width: 3,
          } as any,
        },
        {
          selector: "edge.issue-edge",
          style: {
            width: 1,
            "line-color": DIM,
            "line-opacity": 0.2,
            "curve-style": "bezier",
            "line-style": "dotted",
          } as any,
        },
      ],
    });
  }

  setJammers(jammers: WorkflowJammer[]): void {
    if (!this.cy) return;

    const key = jammers.map(j => `${j.id}:${j.status}`).join(",");
    if (key === this.lastJammerKey) return;
    this.lastJammerKey = key;

    const cy = this.cy;
    cy.elements().remove();

    // Hub node
    cy.add({ data: { id: "gh-hub" }, classes: "hub" });

    // Jammer nodes
    for (const j of jammers) {
      const isLeader = LEADER_POSITIONS.has(j.position);
      const color = isLeader ? PURPLE : GREEN;
      const classes = ["jammer"];
      if (j.status === "running" || j.status === "starting") classes.push("running");

      cy.add({
        data: {
          id: j.id,
          label: j.name || j.id,
          color,
          role: j.position,
        },
        classes: classes.join(" "),
      });

      // Hub links
      cy.add({
        data: { id: `hub-${j.id}`, source: j.id, target: "gh-hub" },
        classes: "hub-link",
      });

      // Hierarchy edges
      if (j.parentId) {
        cy.add({
          data: {
            id: `hier-${j.parentId}-${j.id}`,
            source: j.parentId,
            target: j.id,
          },
          classes: "hierarchy",
        });
      }
    }

    this.runLayout();
  }

  setIssues(issues: WorkflowIssue[]): void {
    if (!this.cy) return;

    // Remove old issue nodes and edges
    this.cy.elements("node.issue, edge.issue-edge").remove();

    const statusColor: Record<string, string> = {
      Backlog: "#888",
      Lobby: "#888",
      InProgress: "#fbca04",
      Review: "#f9d0c4",
      Done: GREEN,
    };

    for (const issue of issues) {
      const color = statusColor[issue.status] || "#888";
      const truncTitle = issue.title.length > 25
        ? issue.title.slice(0, 24) + "…"
        : issue.title;

      this.cy.add({
        data: {
          id: `issue-${issue.id}`,
          label: `#${issue.id} ${truncTitle}`,
          color,
        },
        classes: "issue",
      });

      // Connect issue to assignee or hub
      const target = issue.assignee && this.cy.getElementById(issue.assignee).length
        ? issue.assignee
        : "gh-hub";
      this.cy.add({
        data: {
          id: `ie-${issue.id}`,
          source: `issue-${issue.id}`,
          target,
        },
        classes: "issue-edge",
      });
    }

    this.runLayout();
  }

  onFeedEvent(from: string, _kind: string, _body: string, to?: string): void {
    if (!this.cy) return;

    this.heatMap.set(from, 1);

    // Flash the source node
    const node = this.cy.getElementById(from);
    if (node.length) {
      node.addClass("running");
      setTimeout(() => {
        if (!this.heatMap.get(from)) node.removeClass("running");
      }, 3000);
    }

    // Flash the edge
    const targetId = to || "gh-hub";
    const edgeId = `hub-${from}`;
    const edge = this.cy.getElementById(edgeId);
    if (edge.length) {
      edge.addClass("active");
      setTimeout(() => edge.removeClass("active"), 2000);
    }

    // If directed to another jammer, flash that hierarchy edge
    if (to) {
      const hierEdge = this.cy.edges(`[source="${from}"][target="${to}"], [source="${to}"][target="${from}"]`);
      if (hierEdge.length) {
        hierEdge.addClass("active");
        setTimeout(() => hierEdge.removeClass("active"), 2000);
      }
    }
  }

  updateStatus(id: string, status: string): void {
    if (!this.cy) return;
    const node = this.cy.getElementById(id);
    if (!node.length) return;
    if (status === "running" || status === "starting") {
      node.addClass("running");
    } else {
      node.removeClass("running");
    }
  }

  resize(): void {
    this.cy?.resize();
    this.cy?.fit(undefined, 40);
  }

  dispose(): void {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    this.cy?.destroy();
    this.cy = null;
    this.container = null;
    this.heatMap.clear();
    this.lastJammerKey = "";
  }

  private runLayout(): void {
    if (!this.cy) return;
    this.cy.layout({
      name: "dagre",
      rankDir: "TB",
      spacingFactor: 1.4,
      nodeSep: 40,
      rankSep: 80,
      animate: true,
      animationDuration: 400,
      fit: true,
      padding: 40,
    } as any).run();
  }
}
