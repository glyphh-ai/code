import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ── Config ────────────────────────────────────────────
const GRID = 8;
const TINY = 0.03;
const GAP = 0.14;
const GH_R = 1.2;
const GH_N = 120;
const DIALOG_MS = 6000;
const LEADER_POSITIONS = new Set(["leader", "lieutenant", "sub-lead"]);
const LEADER_COLOR = new THREE.Color(0xa855f7);
const WORKER_COLOR = new THREE.Color(0x22c55e);

// Hierarchy orbit radii
const LEADER_ORBIT = 20;
const CHILD_ORBIT = 10;

// ── Types ─────────────────────────────────────────────
export interface VizJammer {
  id: string;
  name: string;
  position: string;
  status: string;
  parentId?: string | null;
}

interface JNode {
  id: string;
  name: string;
  worldPos: THREE.Vector3;
  mesh: THREE.InstancedMesh;
  status: string;
  color: THREE.Color;
  parentId: string | null;
  amplitude: number;
  targetAmplitude: number;
  heat: number;
}

interface DialogEntry {
  el: HTMLDivElement;
  timer: number;
}

// ── Helpers ───────────────────────────────────────────
function fibSphere(n: number, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const golden = (1 + Math.sqrt(5)) / 2;
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / golden;
    const phi = Math.acos(1 - 2 * (i + 0.5) / n);
    pts.push(
      new THREE.Vector3(
        r * Math.cos(theta) * Math.sin(phi),
        r * Math.sin(theta) * Math.sin(phi),
        r * Math.cos(phi),
      ),
    );
  }
  return pts;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── CypherViz ─────────────────────────────────────────
export class CypherViz {
  private container: HTMLElement | null = null;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();
  private animId = 0;
  private running = false;

  // Nodes
  private nodes = new Map<string, JNode>();
  private ghGroup = new THREE.Group();
  private ghMesh: THREE.InstancedMesh | null = null;

  // Edges: hierarchy (parent→child), hub (jammer→github), peer (jammer→jammer)
  private ghLines = new Map<string, THREE.Line>();
  private hierLines = new Map<string, THREE.Line>();
  private peerLines = new Map<string, THREE.Line>();

  // Which target each jammer is currently communicating with
  private activeTarget = new Map<string, string>();

  // Overlays (labels + dialogs)
  private overlayContainer: HTMLDivElement | null = null;
  private labels = new Map<string, HTMLDivElement>();
  private dialogs = new Map<string, DialogEntry>();

  // Reusable temporaries
  private _m4 = new THREE.Matrix4();
  private _v3 = new THREE.Vector3();
  private _v3b = new THREE.Vector3();
  private _q0 = new THREE.Quaternion();

  private lastIdKey = "";
  private resizeObs: ResizeObserver | null = null;

  // ── Public API ────────────────────────────────────────

  init(container: HTMLElement): void {
    this.container = container;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 200);
    this.camera.position.set(0, 14, 30);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 60;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0x404060, 1.2));
    const point = new THREE.PointLight(0x6688ff, 3.0, 100);
    point.position.set(0, 0, 0);
    this.scene.add(point);
    this.scene.add(new THREE.HemisphereLight(0x5577dd, 0x001122, 0.7));

    this.buildGitHub();
    this.scene.add(this.ghGroup);

    this.overlayContainer = document.createElement("div");
    this.overlayContainer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    container.style.position = "relative";
    container.appendChild(this.overlayContainer);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
  }

  setJammers(jammers: VizJammer[]): void {
    const incomingIds = new Set(jammers.map((j) => j.id));

    for (const [id, node] of this.nodes) {
      if (!incomingIds.has(id)) {
        this.scene.remove(node.mesh);
        node.mesh.geometry.dispose();
        (node.mesh.material as THREE.Material).dispose();
        this.nodes.delete(id);
        this.removeLabel(id);
      }
    }

    // Build hierarchy: parentId → children
    const childMap = new Map<string, VizJammer[]>();
    const roots: VizJammer[] = [];
    for (const j of jammers) {
      if (j.parentId && jammers.some((p) => p.id === j.parentId)) {
        const siblings = childMap.get(j.parentId) || [];
        siblings.push(j);
        childMap.set(j.parentId, siblings);
      } else {
        roots.push(j);
      }
    }

    // Recursive orbital positioning: children orbit their parent
    const positions = new Map<string, THREE.Vector3>();
    const placeCluster = (
      id: string,
      center: THREE.Vector3,
      radius: number,
      angleOffset: number,
      count: number,
      index: number,
    ) => {
      const angle = count === 1
        ? angleOffset
        : angleOffset + (index / count) * Math.PI * 2;
      const pos = new THREE.Vector3(
        center.x + Math.cos(angle) * radius,
        0,
        center.z + Math.sin(angle) * radius,
      );
      positions.set(id, pos);

      const children = childMap.get(id) || [];
      for (let i = 0; i < children.length; i++) {
        placeCluster(children[i].id, pos, CHILD_ORBIT, angle, children.length, i);
      }
    };

    const hub = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < roots.length; i++) {
      placeCluster(roots[i].id, hub, LEADER_ORBIT, 0, roots.length, i);
    }

    // Add or update nodes
    for (const j of jammers) {
      const pos = positions.get(j.id) || new THREE.Vector3(0, 0, 0);
      const existing = this.nodes.get(j.id);
      if (existing) {
        existing.status = j.status;
        existing.name = j.name;
        existing.parentId = j.parentId || null;
        existing.targetAmplitude =
          j.status === "running" || j.status === "starting" ? 1 : 0;
        existing.worldPos.copy(pos);
        existing.mesh.position.copy(pos);
        this.updateLabel(j.id, j.name || j.id);
      } else {
        const color = LEADER_POSITIONS.has(j.position) ? LEADER_COLOR.clone() : WORKER_COLOR.clone();
        const mesh = this.buildJammerMesh(color);
        mesh.position.copy(pos);
        this.scene.add(mesh);

        this.nodes.set(j.id, {
          id: j.id,
          name: j.name,
          worldPos: pos.clone(),
          mesh,
          status: j.status,
          color,
          parentId: j.parentId || null,
          amplitude: 0,
          targetAmplitude:
            j.status === "running" || j.status === "starting" ? 1 : 0,
          heat: 0,
        });

        this.createLabel(j.id, j.name || j.id);
      }
    }

    const idKey = [...incomingIds].sort().join(",");
    if (idKey !== this.lastIdKey) {
      this.lastIdKey = idKey;
      this.buildEdges();
    }
  }

  updateStatus(id: string, status: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.status = status;
    node.targetAmplitude =
      status === "running" || status === "starting" ? 1 : 0;
  }

  onFeedEvent(from: string, kind: string, body: string, to?: string): void {
    const node = this.nodes.get(from);
    if (!node) return;

    node.heat = Math.min(node.heat + 0.35, 1);

    const toNode = to ? this.nodes.get(to) : null;
    const targetId = toNode ? to! : "hub";
    if (toNode) {
      toNode.heat = Math.min(toNode.heat + 0.15, 1);
      this.ensurePeerLine(from, to!);
    }

    this.activeTarget.set(from, targetId);
    this.showDialog(from, node.name || from, kind, body);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.animate();
  }

  stop(): void {
    this.running = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = 0;
    }
  }

  resize(): void {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose(): void {
    this.stop();
    this.resizeObs?.disconnect();
    this.resizeObs = null;

    for (const node of this.nodes.values()) {
      node.mesh.geometry.dispose();
      (node.mesh.material as THREE.Material).dispose();
    }
    this.nodes.clear();

    if (this.ghMesh) {
      this.ghMesh.geometry.dispose();
      (this.ghMesh.material as THREE.Material).dispose();
    }

    this.clearEdges();
    this.activeTarget.clear();
    this.peerLines.clear();

    for (const dlg of this.dialogs.values()) {
      clearTimeout(dlg.timer);
      dlg.el.remove();
    }
    this.dialogs.clear();
    for (const lbl of this.labels.values()) lbl.remove();
    this.labels.clear();

    this.overlayContainer?.remove();
    this.overlayContainer = null;

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.container = null;
  }

  // ── Private: Scene building ───────────────────────────

  private buildGitHub(): void {
    const geo = new THREE.BoxGeometry(TINY * 1.6, TINY * 1.6, TINY * 1.6);
    const mat = new THREE.MeshPhongMaterial({
      color: 0xddeeff,
      emissive: 0x6699ff,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.9,
    });
    this.ghMesh = new THREE.InstancedMesh(geo, mat, GH_N);
    const pts = fibSphere(GH_N, GH_R);
    for (let i = 0; i < GH_N; i++) {
      this._m4.makeTranslation(pts[i].x, pts[i].y, pts[i].z);
      this.ghMesh.setMatrixAt(i, this._m4);
    }
    this.ghMesh.instanceMatrix.needsUpdate = true;
    this.ghGroup.add(this.ghMesh);
  }

  private buildJammerMesh(color: THREE.Color): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(TINY, TINY, TINY);
    const mat = new THREE.MeshPhongMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.92,
    });
    const n = GRID ** 3;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const half = (GRID - 1) / 2;
    let idx = 0;
    for (let x = 0; x < GRID; x++) {
      for (let y = 0; y < GRID; y++) {
        for (let z = 0; z < GRID; z++) {
          this._m4.makeTranslation(
            (x - half) * GAP,
            (y - half) * GAP,
            (z - half) * GAP,
          );
          mesh.setMatrixAt(idx++, this._m4);
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  // ── Private: Edge management ──────────────────────────

  private clearEdges(): void {
    for (const line of this.ghLines.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.ghLines.clear();

    for (const line of this.hierLines.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.hierLines.clear();

    for (const line of this.peerLines.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.peerLines.clear();
  }

  private buildEdges(): void {
    this.clearEdges();
    if (this.nodes.size === 0) return;

    // Hub lines (jammer → github center)
    for (const nd of this.nodes.values()) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), nd.worldPos.clone(),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: 0x5599ff,
          transparent: true,
          opacity: 0.08,
        }),
      );
      this.scene.add(line);
      this.ghLines.set(nd.id, line);
    }

    // Hierarchy lines (child → parent)
    for (const nd of this.nodes.values()) {
      if (!nd.parentId) continue;
      const parent = this.nodes.get(nd.parentId);
      if (!parent) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([
        nd.worldPos.clone(), parent.worldPos.clone(),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: 0xa855f7,
          transparent: true,
          opacity: 0.2,
        }),
      );
      this.scene.add(line);
      this.hierLines.set(`${nd.id}:${nd.parentId}`, line);
    }
  }

  private peerKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  private ensurePeerLine(a: string, b: string): void {
    const key = this.peerKey(a, b);
    if (this.peerLines.has(key)) return;
    const nA = this.nodes.get(a);
    const nB = this.nodes.get(b);
    if (!nA || !nB) return;

    const geo = new THREE.BufferGeometry().setFromPoints([
      nA.worldPos.clone(), nB.worldPos.clone(),
    ]);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: 0x22c55e,
        transparent: true,
        opacity: 0,
      }),
    );
    this.scene.add(line);
    this.peerLines.set(key, line);
  }

  private updateEdgeVisuals(): void {
    // Hub lines: bright when jammer is targeting hub, invisible otherwise
    for (const [id, line] of this.ghLines) {
      const isActive = this.activeTarget.get(id) === "hub";
      (line.material as THREE.LineBasicMaterial).opacity = isActive ? 0.5 : 0.03;
    }

    // Hierarchy lines: bright when either end is targeting the other
    for (const [key, line] of this.hierLines) {
      const sep = key.indexOf(":");
      const childId = key.slice(0, sep);
      const parentId = key.slice(sep + 1);
      const cActive = this.activeTarget.get(childId);
      const pActive = this.activeTarget.get(parentId);
      const isActive = cActive === parentId || pActive === childId;
      (line.material as THREE.LineBasicMaterial).opacity = isActive ? 0.7 : 0.12;
    }

    // Peer lines: green, only visible during active communication
    for (const [key, line] of this.peerLines) {
      const sep = key.indexOf("|");
      const idA = key.slice(0, sep);
      const idB = key.slice(sep + 1);
      const aTarget = this.activeTarget.get(idA);
      const bTarget = this.activeTarget.get(idB);
      const isActive = aTarget === idB || bTarget === idA;
      const mat = line.material as THREE.LineBasicMaterial;
      mat.opacity = isActive ? 0.6 : Math.max(mat.opacity - 0.02, 0);

      // Update geometry in case nodes moved
      const nA = this.nodes.get(idA);
      const nB = this.nodes.get(idB);
      if (nA && nB) {
        const pos = line.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, nA.worldPos.x, nA.worldPos.y, nA.worldPos.z);
        pos.setXYZ(1, nB.worldPos.x, nB.worldPos.y, nB.worldPos.z);
        pos.needsUpdate = true;
      }
    }
  }

  // ── Private: Overlays (labels + dialogs) ─────────────

  private createLabel(id: string, name: string): void {
    if (!this.overlayContainer) return;
    const el = document.createElement("div");
    el.className = "cviz-label";
    el.textContent = name;
    this.overlayContainer.appendChild(el);
    this.labels.set(id, el);
  }

  private updateLabel(id: string, name: string): void {
    const el = this.labels.get(id);
    if (el) el.textContent = name;
  }

  private removeLabel(id: string): void {
    const el = this.labels.get(id);
    if (el) {
      el.remove();
      this.labels.delete(id);
    }
  }

  private showDialog(
    jid: string,
    name: string,
    kind: string,
    body: string,
  ): void {
    if (!this.overlayContainer) return;

    const existing = this.dialogs.get(jid);
    if (existing) {
      clearTimeout(existing.timer);
      const bodyEl = existing.el.querySelector(".cviz-dlg-body");
      if (bodyEl) bodyEl.textContent = body.slice(0, 200);
      const kindEl = existing.el.querySelector(".cviz-dlg-kind");
      if (kindEl) {
        kindEl.textContent = kindLabel(kind);
        kindEl.className = `cviz-dlg-kind ${kindClass(kind)}`;
      }
      existing.el.style.transform = "scale(1)";
      existing.el.style.opacity = "1";
      existing.timer = window.setTimeout(
        () => this.hideDialog(jid),
        DIALOG_MS,
      );
      return;
    }

    const el = document.createElement("div");
    el.className = "cviz-dialog";
    el.innerHTML = `
      <div class="cviz-dlg-header">
        <span class="cviz-dlg-name">${escHtml(name)}</span>
        <span class="cviz-dlg-kind ${kindClass(kind)}">${escHtml(kindLabel(kind))}</span>
      </div>
      <div class="cviz-dlg-body">${escHtml(body.slice(0, 200))}</div>`;
    this.overlayContainer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = "scale(1)";
      el.style.opacity = "1";
    });

    const timer = window.setTimeout(() => this.hideDialog(jid), DIALOG_MS);
    this.dialogs.set(jid, { el, timer });
  }

  private hideDialog(jid: string): void {
    const dlg = this.dialogs.get(jid);
    if (!dlg) return;
    dlg.el.style.transform = "scale(0)";
    dlg.el.style.opacity = "0";
    this.activeTarget.delete(jid);
    setTimeout(() => {
      dlg.el.remove();
      this.dialogs.delete(jid);
    }, 350);
  }

  private updateOverlays(): void {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    for (const [id, el] of this.labels) {
      const node = this.nodes.get(id);
      if (!node) continue;
      this._v3.copy(node.worldPos);
      this._v3.y -= 0.75;
      this._v3.project(this.camera);
      if (this._v3.z > 1) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      el.style.left = `${(this._v3.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-this._v3.y * 0.5 + 0.5) * h}px`;
    }

    for (const [jid, dlg] of this.dialogs) {
      const node = this.nodes.get(jid);
      if (!node) continue;
      this._v3.copy(node.worldPos);
      this._v3.y += 2.2;
      this._v3.project(this.camera);
      if (this._v3.z > 1) {
        dlg.el.style.display = "none";
        continue;
      }
      dlg.el.style.display = "";
      dlg.el.style.left = `${(this._v3.x * 0.5 + 0.5) * w}px`;
      dlg.el.style.top = `${(-this._v3.y * 0.5 + 0.5) * h}px`;
    }
  }

  // ── Private: Animation ────────────────────────────────

  private animate = (): void => {
    if (!this.running) return;
    this.animId = requestAnimationFrame(this.animate);

    const t = this.clock.getElapsedTime();
    const dt = Math.min(this.clock.getDelta(), 0.05);

    this.controls.update();

    // Rotate + pulse GitHub sphere
    this.ghGroup.rotation.y = t * 0.08;
    this.ghGroup.rotation.x = Math.sin(t * 0.12) * 0.04;
    const ghScale = 1 + Math.sin(t * 0.8) * 0.02;
    this.ghGroup.scale.setScalar(ghScale);

    // Animate jammer cubes
    for (const node of this.nodes.values()) {
      node.heat = Math.max(node.heat - dt * 0.08, 0);

      const mat = node.mesh.material as THREE.MeshPhongMaterial;
      mat.emissiveIntensity = 0.25 + node.heat * 0.75;
      mat.opacity = 0.5 + node.heat * 0.45;

      node.amplitude += (node.targetAmplitude - node.amplitude) * 0.04;
      if (node.amplitude > 0.005) {
        this.animateWorking(node, t, node.amplitude);
      } else {
        node.mesh.rotation.y = Math.sin(t * 0.3 + hashVal(node.id)) * 0.03;
        node.mesh.rotation.x =
          Math.cos(t * 0.2 + hashVal(node.id) * 2) * 0.02;
      }
    }

    this.updateEdgeVisuals();
    this.updateOverlays();

    this.renderer.render(this.scene, this.camera);
  };

  private animateWorking(node: JNode, t: number, amp: number): void {
    const half = (GRID - 1) / 2;
    const idOffset = hashVal(node.id) * 10;
    let idx = 0;
    for (let x = 0; x < GRID; x++) {
      for (let y = 0; y < GRID; y++) {
        for (let z = 0; z < GRID; z++) {
          const cx = (x - half) * GAP;
          const cy = (y - half) * GAP;
          const cz = (z - half) * GAP;

          const dist = Math.sqrt(cx * cx + cy * cy + cz * cz);
          const norm = dist > 0.001 ? 1 / dist : 0;
          const nx = cx * norm;
          const ny = cy * norm;
          const nz = cz * norm;

          const wave =
            Math.sin(t * 3 + idOffset - dist * 3.5) * 0.07 * amp;
          const spiral =
            Math.sin(t * 1.8 + idOffset + cy * 5) * 0.025 * amp;

          const px = cx + nx * wave + spiral;
          const py = cy + ny * wave;
          const pz = cz + nz * wave - spiral;

          const s =
            1 + Math.sin(t * 4 + idOffset + x * 0.6 + y * 0.8 + z * 0.4) * 0.18 * amp;

          this._m4.compose(
            this._v3b.set(px, py, pz),
            this._q0,
            this._v3.set(s, s, s),
          );
          node.mesh.setMatrixAt(idx++, this._m4);
        }
      }
    }
    node.mesh.instanceMatrix.needsUpdate = true;

    node.mesh.rotation.y += 0.003 * amp;
  }
}

// ── Static helpers ──────────────────────────────────────

function hashVal(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "agent_thinking":
      return "thinking";
    case "agent_tool_use":
      return "tool";
    case "agent_result":
      return "done";
    case "agent_error":
      return "error";
    default:
      return kind;
  }
}

function kindClass(kind: string): string {
  switch (kind) {
    case "agent_thinking":
      return "kthink";
    case "agent_tool_use":
      return "ktool";
    case "agent_result":
      return "kresult";
    case "agent_error":
      return "kerror";
    default:
      return "";
  }
}
