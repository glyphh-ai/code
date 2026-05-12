import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ── Config ────────────────────────────────────────────
const GRID = 8;
const TINY = 0.03;
const GAP = 0.14;
const ORBIT_R = 16;
const GH_R = 2.8;
const GH_N = 280;
const PULSE_SPEED = 12;
const DIALOG_MS = 6000;
const LEADER_POSITIONS = new Set(["leader", "lieutenant", "sub-lead"]);
const LEADER_COLOR = new THREE.Color(0xa855f7);
const WORKER_COLOR = new THREE.Color(0x22c55e);

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

interface Pulse {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

interface DialogEntry {
  el: HTMLDivElement;
  timer: number;
}

// ── Helpers ───────────────────────────────────────────
function hashColor(s: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.7, 0.55);
}

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

  // Edges
  private pairEdges: THREE.LineSegments | null = null;
  private ghEdges: THREE.LineSegments | null = null;
  private hierMeshes: THREE.Mesh[] = [];
  private hierMaterial = new THREE.MeshBasicMaterial({
    color: 0x00ffaa,
    transparent: true,
    opacity: 0.45,
  });

  // Pulses
  private pulses: Pulse[] = [];
  private pulseGeo = new THREE.SphereGeometry(0.18, 8, 8);

  // Edge glows (temporary bright overlays on active edges)
  private edgeGlows: { line: THREE.Line; brightness: number }[] = [];

  // Overlays (labels + dialogs)
  private overlayContainer: HTMLDivElement | null = null;
  private labels = new Map<string, HTMLDivElement>();
  private dialogs = new Map<string, DialogEntry>();

  // Reusable temporaries
  private _m4 = new THREE.Matrix4();
  private _v3 = new THREE.Vector3();
  private _v3b = new THREE.Vector3();
  private _q0 = new THREE.Quaternion();

  // Track jammer set for edge rebuild
  private lastIdKey = "";

  // Resize observer
  private resizeObs: ResizeObserver | null = null;

  // ── Public API ────────────────────────────────────────

  init(container: HTMLElement): void {
    this.container = container;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 200);
    this.camera.position.set(0, 14, 30);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 60;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.target.set(0, 0, 0);

    // Lights
    this.scene.add(new THREE.AmbientLight(0x404060, 1.2));
    const point = new THREE.PointLight(0x6688ff, 3.0, 100);
    point.position.set(0, 0, 0);
    this.scene.add(point);
    this.scene.add(new THREE.HemisphereLight(0x5577dd, 0x001122, 0.7));

    // GitHub center sphere
    this.buildGitHub();
    this.scene.add(this.ghGroup);

    // Overlay container for labels + dialogs
    this.overlayContainer = document.createElement("div");
    this.overlayContainer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    container.style.position = "relative";
    container.appendChild(this.overlayContainer);

    // Auto-resize
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
  }

  setJammers(jammers: VizJammer[]): void {
    const incomingIds = new Set(jammers.map((j) => j.id));

    // Remove stale nodes
    for (const [id, node] of this.nodes) {
      if (!incomingIds.has(id)) {
        this.scene.remove(node.mesh);
        node.mesh.geometry.dispose();
        (node.mesh.material as THREE.Material).dispose();
        this.nodes.delete(id);
        this.removeLabel(id);
      }
    }

    // Compute layout positions for all jammers
    const count = jammers.length || 1;
    const positions = jammers.map((j, i) => {
      const isLeader = LEADER_POSITIONS.has(j.position);
      const r = isLeader ? ORBIT_R * 0.58 : ORBIT_R;
      const y = isLeader ? 3 : -0.5;
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      return new THREE.Vector3(
        Math.cos(angle) * r,
        y + Math.sin(i * 1.7) * 1.2,
        Math.sin(angle) * r,
      );
    });

    // Add or update nodes
    jammers.forEach((j, i) => {
      const existing = this.nodes.get(j.id);
      if (existing) {
        existing.status = j.status;
        existing.name = j.name;
        existing.targetAmplitude =
          j.status === "running" || j.status === "starting" ? 1 : 0;
        existing.worldPos.copy(positions[i]);
        existing.mesh.position.copy(positions[i]);
        this.updateLabel(j.id, j.name || j.id);
      } else {
        const color = LEADER_POSITIONS.has(j.position) ? LEADER_COLOR.clone() : WORKER_COLOR.clone();
        const mesh = this.buildJammerMesh(color);
        mesh.position.copy(positions[i]);
        this.scene.add(mesh);

        this.nodes.set(j.id, {
          id: j.id,
          name: j.name,
          worldPos: positions[i].clone(),
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
    });

    // Rebuild edges only when the set changes
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

    // Determine target: another jammer, or GitHub center
    const toNode = to ? this.nodes.get(to) : null;
    const targetPos = toNode ? toNode.worldPos : new THREE.Vector3(0, 0, 0);
    if (toNode) toNode.heat = Math.min(toNode.heat + 0.15, 1);

    // Light up the edge and send a pulse along it
    this.lightEdge(node.worldPos, targetPos, node.color);
    this.addPulse(node.worldPos, targetPos, node.color);

    // Show dialog near the jammer
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

    // Dispose nodes
    for (const node of this.nodes.values()) {
      node.mesh.geometry.dispose();
      (node.mesh.material as THREE.Material).dispose();
    }
    this.nodes.clear();

    // Dispose github
    if (this.ghMesh) {
      this.ghMesh.geometry.dispose();
      (this.ghMesh.material as THREE.Material).dispose();
    }

    // Dispose edges
    this.clearEdges();

    // Dispose pulses
    for (const p of this.pulses) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.pulses.length = 0;

    // Dispose edge glows
    for (const g of this.edgeGlows) {
      g.line.geometry.dispose();
      (g.line.material as THREE.Material).dispose();
    }
    this.edgeGlows.length = 0;

    // Dispose overlays
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

  private clearEdges(): void {
    if (this.pairEdges) {
      this.scene.remove(this.pairEdges);
      this.pairEdges.geometry.dispose();
      (this.pairEdges.material as THREE.Material).dispose();
      this.pairEdges = null;
    }
    if (this.ghEdges) {
      this.scene.remove(this.ghEdges);
      this.ghEdges.geometry.dispose();
      (this.ghEdges.material as THREE.Material).dispose();
      this.ghEdges = null;
    }
    for (const m of this.hierMeshes) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.hierMeshes = [];
  }

  private buildEdges(): void {
    this.clearEdges();

    const ids = [...this.nodes.keys()];
    const n = ids.length;
    if (n === 0) return;

    // All-pairs edges (very dim)
    const pairs: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.nodes.get(ids[i])!.worldPos;
        const b = this.nodes.get(ids[j])!.worldPos;
        pairs.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    if (pairs.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(pairs, 3),
      );
      this.pairEdges = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          color: 0x4466aa,
          transparent: true,
          opacity: 0.15,
        }),
      );
      this.scene.add(this.pairEdges);
    }

    // GitHub-to-jammer edges (slightly brighter)
    const ghPairs: number[] = [];
    for (const nd of this.nodes.values()) {
      ghPairs.push(0, 0, 0, nd.worldPos.x, nd.worldPos.y, nd.worldPos.z);
    }
    if (ghPairs.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(ghPairs, 3),
      );
      this.ghEdges = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({
          color: 0x5599ff,
          transparent: true,
          opacity: 0.25,
        }),
      );
      this.scene.add(this.ghEdges);
    }

    // Hierarchy edges (thicker cylinders)
    for (const nd of this.nodes.values()) {
      if (!nd.parentId) continue;
      const parent = this.nodes.get(nd.parentId);
      if (!parent) continue;

      const dir = this._v3.subVectors(parent.worldPos, nd.worldPos);
      const len = dir.length();
      if (len < 0.1) continue;

      const geo = new THREE.CylinderGeometry(0.045, 0.045, len, 4, 1);
      geo.translate(0, len / 2, 0);
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.hierMaterial);
      mesh.position.copy(nd.worldPos);
      mesh.lookAt(parent.worldPos);
      this.scene.add(mesh);
      this.hierMeshes.push(mesh);
    }
  }

  // ── Private: Pulses ───────────────────────────────────

  private addPulse(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: THREE.Color,
  ): void {
    const mat = new THREE.MeshBasicMaterial({
      color: color.clone().lerp(new THREE.Color(0xffffff), 0.3),
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.pulseGeo, mat);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.pulses.push({ mesh, from: from.clone(), to: to.clone(), t: 0 });
  }

  // ── Private: Edge glows ────────────────────────────────

  private lightEdge(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const mat = new THREE.LineBasicMaterial({
      color: color.clone().lerp(new THREE.Color(0xffffff), 0.25),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.edgeGlows.push({ line, brightness: 1 });
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
    setTimeout(() => {
      dlg.el.remove();
      this.dialogs.delete(jid);
    }, 350);
  }

  private updateOverlays(): void {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    // Labels (just below each jammer cluster)
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

    // Dialogs (above each jammer)
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
      // Decay heat over time
      node.heat = Math.max(node.heat - dt * 0.08, 0);

      // Drive emissive intensity + opacity from heat
      const mat = node.mesh.material as THREE.MeshPhongMaterial;
      mat.emissiveIntensity = 0.25 + node.heat * 0.75;
      mat.opacity = 0.5 + node.heat * 0.45;

      // Smooth amplitude transition
      node.amplitude += (node.targetAmplitude - node.amplitude) * 0.04;
      if (node.amplitude > 0.005) {
        this.animateWorking(node, t, node.amplitude);
      } else {
        // Subtle idle rotation
        node.mesh.rotation.y = Math.sin(t * 0.3 + hashVal(node.id)) * 0.03;
        node.mesh.rotation.x =
          Math.cos(t * 0.2 + hashVal(node.id) * 2) * 0.02;
      }
    }

    // Animate edge glows (fade out)
    for (let i = this.edgeGlows.length - 1; i >= 0; i--) {
      const glow = this.edgeGlows[i];
      glow.brightness -= dt * 0.4;
      if (glow.brightness <= 0) {
        this.scene.remove(glow.line);
        glow.line.geometry.dispose();
        (glow.line.material as THREE.Material).dispose();
        this.edgeGlows.splice(i, 1);
      } else {
        (glow.line.material as THREE.LineBasicMaterial).opacity = glow.brightness * 0.6;
      }
    }

    // Animate pulses
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      const dist = p.from.distanceTo(p.to);
      p.t += (dt * PULSE_SPEED) / Math.max(dist, 1);
      if (p.t >= 1) {
        this.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.pulses.splice(i, 1);
      } else {
        p.mesh.position.lerpVectors(p.from, p.to, p.t);
        const fade = p.t < 0.1 ? p.t / 0.1 : p.t > 0.8 ? (1 - p.t) / 0.2 : 1;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = fade * 0.85;
        const pScale = 0.6 + fade * 0.4;
        p.mesh.scale.setScalar(pScale);
      }
    }

    // Update overlay positions
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

          // Wave: cubes breathe outward
          const wave =
            Math.sin(t * 3 + idOffset - dist * 3.5) * 0.07 * amp;
          // Spiral layer twist
          const spiral =
            Math.sin(t * 1.8 + idOffset + cy * 5) * 0.025 * amp;

          const px = cx + nx * wave + spiral;
          const py = cy + ny * wave;
          const pz = cz + nz * wave - spiral;

          // Scale modulation
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

    // Whole-cluster rotation when working
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
