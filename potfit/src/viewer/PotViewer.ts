// Two three.js views of the same fit: a perspective 3D view and an
// orthographic side-on section view that cuts the outer pot in half through
// the reference pot's axis. Both have a gizmo for moving and scaling the pot.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { ReferenceDims } from '../../shared/fit.ts';
import { cloneTransform, computeBounds, transformMatrix, type Bounds } from '../../shared/transform.ts';
import type { PotTransform } from '../../shared/types.ts';

export type GizmoMode = 'translate' | 'scale' | 'off';
export type ScaleLock = 'uniform' | 'round' | 'free';
export type DragPhase = 'start' | 'drag' | 'end';

export interface ViewerCallbacks {
  onTransform(t: PotTransform, phase: DragPhase): void;
}

const COLORS = {
  background: 0x1b1f24,
  sectionBackground: 0x14171b,
  pot: 0xc4724e,
  cut: 0xf1c27d,
  reference: 0x4ade80,
  envelope: 0xa3e635,
  axis: 0x60a5fa,
  grid: 0x3a4048,
  gridMajor: 0x555d68,
};

const SECTION_DISTANCE = 2000;

interface View {
  el: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  orbit: OrbitControls;
  gizmo: TransformControls;
  handle: THREE.Object3D;
  potGroup: THREE.Group;
  front: THREE.Mesh;
  back: THREE.Mesh;
}

function makeRenderer(el: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  el.appendChild(renderer.domElement);
  return renderer;
}

/** A screen-space thick line through 2D points in its local XY plane, drawn on top. */
function polyline(points: [number, number][], color: number, opts: { width?: number; dashed?: boolean } = {}): Line2 {
  const geometry = new LineGeometry().setPositions(points.flatMap(([x, y]) => [x, y, 0]));
  const material = new LineMaterial({
    color,
    linewidth: opts.width ?? 2,
    dashed: !!opts.dashed,
    dashSize: 2,
    gapSize: 1.5,
    depthTest: false,
    transparent: true,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = 10;
  return line;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export class PotViewer {
  private cb: ViewerCallbacks;
  private main: View;
  private section: View;
  private geometry = new THREE.BufferGeometry();
  private raw: Bounds | null = null;
  private transform: PotTransform | null = null;
  private dragStart: PotTransform | null = null;
  private ref: ReferenceDims | null = null;
  private radialClear = 0;
  private sectionAngle = 0;
  private cutaway = false;
  private lock: ScaleLock = 'uniform';
  private mode: GizmoMode = 'translate';
  private editable = true;
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private refMain = new THREE.Group();
  private refSection = new THREE.Group();
  private grid = new THREE.Group();
  private sectionGrid = new THREE.Group();
  private needsRender = true;
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private sectionHalfHeight = 60;

  constructor(mainEl: HTMLElement, sectionEl: HTMLElement, cb: ViewerCallbacks) {
    this.cb = cb;
    this.main = this.makeMainView(mainEl);
    this.section = this.makeSectionView(sectionEl);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mainEl);
    this.resizeObserver.observe(sectionEl);
    this.resize();
    this.applyCutaway();
    this.updateSectionPlane();
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      if (this.needsRender) {
        this.needsRender = false;
        this.renderAll();
      }
    };
    loop();
  }

  // ------------------------------------------------------------ set-up

  private potMeshes(clipped: boolean): { group: THREE.Group; front: THREE.Mesh; back: THREE.Mesh } {
    const planes = clipped ? [this.clipPlane] : [];
    const front = new THREE.Mesh(
      this.geometry,
      new THREE.MeshStandardMaterial({ color: COLORS.pot, roughness: 0.75, metalness: 0.05, side: THREE.FrontSide, clippingPlanes: planes }),
    );
    // Back faces seen through the cut are the inside of the solid: draw them
    // flat so the cut reads as a filled section.
    const back = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: COLORS.cut, side: THREE.BackSide, clippingPlanes: planes }));
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.add(front, back);
    return { group, front, back };
  }

  private addGizmo(view: Omit<View, 'gizmo' | 'handle'>): Pick<View, 'gizmo' | 'handle'> {
    const handle = new THREE.Object3D();
    view.scene.add(handle);
    const gizmo = new TransformControls(view.camera, view.renderer.domElement);
    gizmo.setSpace('world');
    gizmo.setSize(0.8);
    gizmo.attach(handle);
    view.scene.add(gizmo.getHelper());
    gizmo.addEventListener('dragging-changed', (e) => {
      view.orbit.enabled = !e.value;
    });
    gizmo.addEventListener('change', () => this.invalidate());
    gizmo.addEventListener('mouseDown', () => {
      this.dragStart = this.transform ? cloneTransform(this.transform) : null;
      if (this.transform) this.cb.onTransform(this.transform, 'start');
    });
    gizmo.addEventListener('objectChange', () => this.onGizmoChange(handle));
    gizmo.addEventListener('mouseUp', () => {
      if (this.transform && this.dragStart) this.cb.onTransform(this.transform, 'end');
      this.dragStart = null;
    });
    return { gizmo, handle };
  }

  private makeMainView(el: HTMLElement): View {
    const renderer = makeRenderer(el);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.background);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    camera.position.set(140, 110, 180);
    scene.add(camera);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3530, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(0.6, 1, 0.8);
    camera.add(key);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 30, 0);
    orbit.enableDamping = false;
    orbit.addEventListener('change', () => this.invalidate());
    const { group, front, back } = this.potMeshes(true);
    scene.add(group, this.refMain, this.grid);
    const partial = { el, renderer, scene, camera, orbit, potGroup: group, front, back };
    return { ...partial, ...this.addGizmo(partial) };
  }

  private makeSectionView(el: HTMLElement): View {
    const renderer = makeRenderer(el);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.sectionBackground);
    const camera = new THREE.OrthographicCamera(-60, 60, 60, -60, 1, SECTION_DISTANCE * 4);
    scene.add(camera);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.3, 0.6, 1);
    camera.add(key);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableRotate = false;
    orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    orbit.target.set(0, 30, 0);
    orbit.addEventListener('change', () => this.invalidate());
    const { group, front, back } = this.potMeshes(true);
    scene.add(group, this.refSection, this.sectionGrid);
    const partial = { el, renderer, scene, camera, orbit, potGroup: group, front, back };
    return { ...partial, ...this.addGizmo(partial) };
  }

  // ------------------------------------------------------------ public API

  invalidate() {
    this.needsRender = true;
  }

  setMesh(positions: Float32Array | null) {
    this.geometry.dispose();
    const g = new THREE.BufferGeometry();
    if (positions && positions.length) {
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      this.raw = computeBounds(positions);
    } else {
      this.raw = null;
    }
    this.geometry = g;
    for (const v of [this.main, this.section]) {
      v.front.geometry = g;
      v.back.geometry = g;
      v.potGroup.visible = !!positions;
    }
    this.syncTransform();
  }

  setTransform(t: PotTransform | null) {
    this.transform = t ? cloneTransform(t) : null;
    this.syncTransform();
  }

  setReference(ref: ReferenceDims | null, clearance: number) {
    this.ref = ref;
    this.radialClear = clearance / 2;
    this.buildReference();
    this.invalidate();
  }

  setGizmoMode(mode: GizmoMode) {
    this.mode = mode;
    this.applyGizmoState();
  }

  setScaleLock(lock: ScaleLock) {
    this.lock = lock;
  }

  setEditable(editable: boolean) {
    this.editable = editable;
    this.applyGizmoState();
  }

  setSectionAngle(deg: number) {
    this.sectionAngle = deg;
    this.updateSectionPlane();
  }

  setCutaway(on: boolean) {
    this.cutaway = on;
    this.applyCutaway();
  }

  /** Point both cameras at the pot and the reference pot. */
  frameAll() {
    const box = this.sceneBox();
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 10);

    const cam = this.main.camera as THREE.PerspectiveCamera;
    const dir = cam.position.clone().sub(this.main.orbit.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(0.55, 0.45, 0.7).normalize();
    // Fit the bounding sphere in whichever of the vertical and horizontal fields of view is narrower.
    const vHalf = THREE.MathUtils.degToRad(cam.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * this.aspect(this.main));
    const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
    this.main.orbit.target.copy(center);
    cam.position.copy(center).addScaledVector(dir, dist);
    cam.near = dist / 100;
    cam.far = dist * 20;
    cam.updateProjectionMatrix();
    this.main.orbit.update();

    const across = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    const aspect = this.aspect(this.section);
    this.sectionHalfHeight = Math.max(size.y / 2, across / aspect) * 1.12 + 2;
    this.section.orbit.target.set(0, center.y, 0);
    (this.section.camera as THREE.OrthographicCamera).zoom = 1;
    this.updateSectionPlane();
    this.resize();
  }

  /** PNG snapshots of both views (gizmos hidden) for Codex. */
  capture(): { section: string; view: string } {
    const shots = { section: '', view: '' };
    for (const [key, v] of [['section', this.section], ['view', this.main]] as const) {
      const helper = v.gizmo.getHelper();
      const visible = helper.visible;
      helper.visible = false;
      v.renderer.render(v.scene, v.camera);
      shots[key] = v.renderer.domElement.toDataURL('image/png');
      helper.visible = visible;
    }
    this.invalidate();
    return shots;
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    for (const v of [this.main, this.section]) {
      v.gizmo.detach();
      v.gizmo.dispose();
      v.orbit.dispose();
      v.renderer.dispose();
      v.renderer.domElement.remove();
    }
    disposeTree(this.refMain);
    disposeTree(this.refSection);
    disposeTree(this.grid);
    disposeTree(this.sectionGrid);
    this.geometry.dispose();
  }

  // ------------------------------------------------------------ internals

  private aspect(v: View) {
    const w = v.el.clientWidth || 1, h = v.el.clientHeight || 1;
    return w / h;
  }

  private resize() {
    for (const v of [this.main, this.section]) {
      const w = Math.max(1, v.el.clientWidth), h = Math.max(1, v.el.clientHeight);
      v.renderer.setSize(w, h);
      if (v.camera instanceof THREE.PerspectiveCamera) {
        v.camera.aspect = w / h;
      } else {
        const hh = this.sectionHalfHeight;
        v.camera.left = -hh * (w / h);
        v.camera.right = hh * (w / h);
        v.camera.top = hh;
        v.camera.bottom = -hh;
      }
      v.camera.updateProjectionMatrix();
      v.scene.traverse((o) => {
        const mat = (o as Line2).material;
        if (mat instanceof LineMaterial) mat.resolution.set(w, h);
      });
    }
    this.invalidate();
  }

  private sceneBox(): THREE.Box3 {
    const box = new THREE.Box3();
    if (this.raw && this.transform) {
      this.main.potGroup.updateMatrixWorld(true);
      const g = this.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      box.union(g.boundingBox!.clone().applyMatrix4(this.main.potGroup.matrixWorld));
    }
    if (this.ref) {
      const r = Math.max(this.ref.topOD, this.ref.bottomOD) / 2;
      box.union(new THREE.Box3(new THREE.Vector3(-r, 0, -r), new THREE.Vector3(r, this.ref.height, r)));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 80, 50));
    return box;
  }

  private syncTransform() {
    const has = !!(this.raw && this.transform);
    for (const v of [this.main, this.section]) {
      v.potGroup.visible = has;
      if (!has) continue;
      const m = transformMatrix(this.transform!, this.raw!);
      v.potGroup.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
      v.potGroup.matrixWorldNeedsUpdate = true;
      v.handle.position.set(this.transform!.position.x, this.transform!.position.y, this.transform!.position.z);
      v.handle.scale.set(this.transform!.scale.x, this.transform!.scale.y, this.transform!.scale.z);
      v.handle.updateMatrixWorld(true);
    }
    this.applyGizmoState();
    this.updateGrid();
    this.invalidate();
  }

  private applyGizmoState() {
    const active = this.editable && this.mode !== 'off' && !!this.transform && !!this.raw;
    for (const v of [this.main, this.section]) {
      v.gizmo.enabled = active;
      v.gizmo.getHelper().visible = active;
      if (this.mode !== 'off') v.gizmo.setMode(this.mode);
    }
    this.invalidate();
  }

  private onGizmoChange(handle: THREE.Object3D) {
    if (!this.transform) return;
    const prev = this.transform.scale;
    const s = { x: Math.max(handle.scale.x, 0.01), y: Math.max(handle.scale.y, 0.01), z: Math.max(handle.scale.z, 0.01) };
    if (this.mode === 'scale') {
      const ratios = { x: s.x / prev.x, y: s.y / prev.y, z: s.z / prev.z };
      const changed = (['x', 'y', 'z'] as const).reduce((a, b) => (Math.abs(Math.log(ratios[b])) > Math.abs(Math.log(ratios[a])) ? b : a));
      if (this.lock === 'uniform') {
        const k = ratios[changed];
        s.x = prev.x * k;
        s.y = prev.y * k;
        s.z = prev.z * k;
      } else if (this.lock === 'round' && changed !== 'y') {
        s.x = s.z = changed === 'x' ? s.x : s.z;
      }
    }
    const next: PotTransform = {
      ...this.transform,
      position: { x: handle.position.x, y: handle.position.y, z: handle.position.z },
      scale: s,
    };
    this.transform = next;
    this.syncTransform();
    this.cb.onTransform(cloneTransform(next), 'drag');
  }

  private applyCutaway() {
    // The section view is always cut; the 3D view only when cutaway is on.
    const planes = this.cutaway ? [this.clipPlane] : [];
    (this.main.front.material as THREE.Material).clippingPlanes = planes;
    (this.main.back.material as THREE.Material).clippingPlanes = planes;
    // Without a cut, show the inside of open meshes as normal surface.
    (this.main.front.material as THREE.Material).side = this.cutaway ? THREE.FrontSide : THREE.DoubleSide;
    this.main.back.visible = this.cutaway;
    (this.main.front.material as THREE.Material).needsUpdate = true;
    this.invalidate();
  }

  private updateSectionPlane() {
    const th = THREE.MathUtils.degToRad(this.sectionAngle);
    const toViewer = new THREE.Vector3(Math.sin(th), 0, Math.cos(th));
    // Keep the half of the model away from the viewer: n . p >= 0 survives.
    this.clipPlane.set(toViewer.clone().negate(), 0);
    const cam = this.section.camera;
    const target = this.section.orbit.target;
    // Pan along the section plane only.
    const u = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th));
    const along = target.dot(u);
    target.set(u.x * along, target.y, u.z * along);
    cam.position.copy(target).addScaledVector(toViewer, SECTION_DISTANCE);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    this.section.orbit.update();
    this.refSection.rotation.y = th;
    this.sectionGrid.rotation.y = th;
    this.invalidate();
  }

  private buildReference() {
    for (const g of [this.refMain, this.refSection]) {
      disposeTree(g);
      g.clear();
    }
    if (!this.ref) return;
    const rb = this.ref.bottomOD / 2, rt = this.ref.topOD / 2, h = this.ref.height;

    // 3D: translucent frustum with solid rim and base rings.
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(rt, rb, h, 96, 1, true),
      new THREE.MeshBasicMaterial({ color: COLORS.reference, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    shell.position.y = h / 2;
    shell.renderOrder = 5;
    this.refMain.add(shell);
    for (const [r, y] of [[rb, 0], [rt, h]] as const) {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      const ring = polyline(pts, COLORS.reference, { width: 1.5 });
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.refMain.add(ring);
    }

    // Section: outline, required clearance envelope and axis.
    this.refSection.add(polyline([[-rb, 0], [rb, 0], [rt, h], [-rt, h], [-rb, 0]], COLORS.reference, { width: 2.5 }));
    const c = this.radialClear;
    if (c > 0) {
      this.refSection.add(polyline([[-rb - c, 0], [-rt - c, h]], COLORS.envelope, { dashed: true, width: 1.5 }));
      this.refSection.add(polyline([[rb + c, 0], [rt + c, h]], COLORS.envelope, { dashed: true, width: 1.5 }));
    }
    this.refSection.add(polyline([[0, -h * 0.08], [0, h * 1.08]], COLORS.axis, { dashed: true, width: 1 }));
    this.resize();
  }

  private updateGrid() {
    const box = this.sceneBox();
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y);
    const size = Math.max(200, Math.ceil((span * 3) / 100) * 100);
    const key = `${size}`;
    const floor = Math.min(0, box.min.y) - 0.05;
    if (this.grid.userData.key !== key) {
      for (const g of [this.grid, this.sectionGrid]) {
        disposeTree(g);
        g.clear();
      }
      const ground = new THREE.GridHelper(size, size / 10, COLORS.gridMajor, COLORS.grid);
      this.grid.add(ground);
      const wall = new THREE.GridHelper(size, size / 10, COLORS.gridMajor, COLORS.grid);
      wall.rotation.x = Math.PI / 2;
      // Behind everything in the section view.
      wall.position.z = -size;
      this.sectionGrid.add(wall);
      this.grid.userData.key = key;
    }
    this.grid.position.y = floor;
  }

  private renderAll() {
    for (const v of [this.main, this.section]) v.renderer.render(v.scene, v.camera);
  }
}
