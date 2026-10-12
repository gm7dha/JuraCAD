import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { PartMesh } from "../kernel/protocol";
import type { DatumName, PlaneName, SelectionItem } from "../model/store";
import type { SketchController, SketchPointer, SketchTransient } from "../sketch/controller";
import { planeFrame, type SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import { labelSprite } from "./labels";
import { SketchLayer, type ActiveSketch } from "./SketchLayer";
import { VIEW_DIRECTIONS, ViewCube, type StandardView } from "./ViewCube";

// PartSmith is Z-up, like Onshape.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const COLOURS = {
  part: "#a8b4c0",
  partHover: "#ffb15c",
  partSelected: "#5b9dff",
  edge: "#1d232a",
  edgeHover: "#ff8a00",
  edgeSelected: "#0b5cd5",
  plane: "#f2c36b",
  planeBorder: "#d9a03a",
  planeLabel: "#9a6a12",
  planeHover: "#ffb15c",
  planeHoverBorder: "#ff8a00",
  planeSelected: "#5b9dff",
  planeSelectedBorder: "#1f6fd1",
};

/** Which way to look at each default plane for "View normal to". */
const PLANE_VIEWS: Record<PlaneName, StandardView> = { Top: "top", Front: "front", Right: "right" };

/** Base frustum height in mm at zoom 1. Zoom changes what is actually visible. */
const FRUSTUM_HEIGHT = 200;
/** How close (in screen pixels) the pointer must be to an edge to pick it. */
const EDGE_PICK_PIXELS = 6;
/** Pointer movement (pixels) above which a click becomes a drag. */
const CLICK_SLOP = 4;

interface PartObjects {
  data: PartMesh;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.Material[]>;
}

/** What's under the pointer: a face/edge of a part, or one of the default planes. */
export type PickTarget = { kind: "part"; item: SelectionItem } | { kind: "plane"; plane: PlaneName };

export interface SceneCallbacks {
  /** Called when the user clicks in the viewport. `additive` is true with Shift/Ctrl/Cmd held. */
  onPick: (target: PickTarget | null, additive: boolean) => void;
}

interface PlaneObjects {
  group: THREE.Group;
  square: THREE.Mesh;
  fill: THREE.MeshBasicMaterial;
  border: THREE.LineBasicMaterial;
}

type Pick = SelectionItem;

const sameItem = (a: Pick | null, b: Pick | null) =>
  !!a && !!b && a.partId === b.partId && a.kind === b.kind && a.index === b.index;

/**
 * Owns the three.js scene: camera, Onshape-style mouse controls, parts,
 * default planes, origin, view cube, hover highlighting and picking.
 * React talks to it through a handful of methods.
 */
export class SceneManager {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly viewCube = new ViewCube();
  private readonly raycaster = new THREE.Raycaster();
  private readonly partsGroup = new THREE.Group();
  private readonly planesGroup = new THREE.Group();
  private readonly originGroup = new THREE.Group();
  private readonly planeLabels: THREE.Sprite[] = [];
  private readonly planes = new Map<PlaneName, PlaneObjects>();
  private readonly parts = new Map<string, PartObjects>();
  private readonly materials: { faces: THREE.Material[]; edges: THREE.Material[] };
  private readonly resizeObserver: ResizeObserver;
  private readonly callbacks: SceneCallbacks;
  private readonly sketchLayer = new SketchLayer();
  /** Set while a sketch is being edited: left-button input goes to the sketch tools. */
  private sketchController: SketchController | null = null;
  private readonly frameListeners = new Set<() => void>();

  private width = 1;
  private height = 1;
  private hover: Pick | null = null;
  private selection: Pick[] = [];
  private hidden = new Set<string>();
  private hiddenDatums = new Set<DatumName>();
  private selectedPlane: PlaneName | null = null;
  /** Plane highlighted because the pointer is over its row in the feature list. */
  private listHoverPlane: PlaneName | null = null;
  /** Plane under the pointer in the viewport. */
  private hoverPlane: PlaneName | null = null;
  private planeSize = 100;
  private frame = 0;
  private pointerDown: { x: number; y: number; button: number } | null = null;
  private pendingMove: { x: number; y: number } | null = null;
  private animation: {
    start: number;
    duration: number;
    fromDir: THREE.Vector3;
    toDir: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromZoom: number;
    toZoom: number;
  } | null = null;

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;
    this.renderer.domElement.className = "viewport-canvas";
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(VIEW_DIRECTIONS.iso).multiplyScalar(5000);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);

    // Lighting: soft ambient plus a "headlight" that follows the camera.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a3, 1.1));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    headlight.position.set(0.4, 0.7, 1);
    headlight.target.position.set(0, 0, -1);
    this.camera.add(headlight, headlight.target);

    const faceMat = (color: string) =>
      new THREE.MeshPhongMaterial({
        color,
        specular: 0x222222,
        shininess: 20,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    this.materials = {
      faces: [faceMat(COLOURS.part), faceMat(COLOURS.partHover), faceMat(COLOURS.partSelected)],
      edges: [
        new THREE.LineBasicMaterial({ color: COLOURS.edge }),
        new THREE.LineBasicMaterial({ color: COLOURS.edgeHover }),
        new THREE.LineBasicMaterial({ color: COLOURS.edgeSelected }),
      ],
    };

    this.scene.add(this.partsGroup, this.planesGroup, this.originGroup, this.sketchLayer.group);
    this.buildPlanes();
    this.buildOrigin();

    // Our pointer handlers must run before OrbitControls' so Ctrl + right-drag can pan.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    // Onshape mouse: right-drag orbits, middle-drag pans, wheel zooms towards the cursor.
    this.controls = new OrbitControls(this.camera, el);
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.2;
    this.controls.minZoom = 0.002;
    this.controls.maxZoom = 2000;
    this.controls.addEventListener("start", () => (this.animation = null));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.fit(false);
    this.loop();
  }

  // -------------------------------------------------------------------------
  // Public API

  setParts(parts: PartMesh[]): void {
    const firstParts = this.parts.size === 0 && parts.length > 0;
    for (const p of this.parts.values()) {
      p.mesh.geometry.dispose();
      p.lines.geometry.dispose();
      this.partsGroup.remove(p.mesh, p.lines);
    }
    this.parts.clear();

    for (const data of parts) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3));
      if (data.normals.length === data.vertices.length) {
        geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      } else {
        geometry.computeVertexNormals();
      }
      geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));
      data.faceGroups.forEach((g) => geometry.addGroup(g.start, g.count, 0));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, this.materials.faces);
      mesh.userData.partId = data.id;

      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.BufferAttribute(data.lines, 3));
      data.edgeGroups.forEach((g) => lineGeometry.addGroup(g.start, g.count, 0));
      lineGeometry.computeBoundingSphere();
      const lines = new THREE.LineSegments(lineGeometry, this.materials.edges);
      lines.userData.partId = data.id;

      mesh.visible = lines.visible = !this.hidden.has(data.id);
      this.partsGroup.add(mesh, lines);
      this.parts.set(data.id, { data, mesh, lines });
    }

    if (this.hover && !this.parts.has(this.hover.partId)) this.hover = null;
    this.updatePlaneSize();
    this.applyHighlights();
    if (firstParts) this.fit(true);
  }

  setSelection(items: SelectionItem[]): void {
    this.selection = items;
    this.applyHighlights();
  }

  setHidden(ids: string[]): void {
    this.hidden = new Set(ids);
    for (const [id, p] of this.parts) p.mesh.visible = p.lines.visible = !this.hidden.has(id);
  }

  /** Zoom and centre so everything visible fits on screen. */
  fit(animate = true): void {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) if (p.mesh.visible) box.expandByObject(p.mesh);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(this.planeSize, this.planeSize, this.planeSize));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const aspect = this.width / this.height;
    const visible = Math.min(FRUSTUM_HEIGHT, FRUSTUM_HEIGHT * aspect);
    const zoom = visible / (radius * 2.5);
    this.animateTo({ target: sphere.center, zoom }, animate);
  }

  setView(view: StandardView, animate = true): void {
    this.animateTo({ dir: VIEW_DIRECTIONS[view] }, animate);
  }

  /** Selection, list-hover and visibility of the default planes and origin. */
  setDatums(state: { selected: PlaneName | null; listHover: PlaneName | null; hidden: DatumName[] }): void {
    this.selectedPlane = state.selected;
    this.listHoverPlane = state.listHover;
    this.hiddenDatums = new Set(state.hidden);
    for (const [name, p] of this.planes) p.group.visible = !this.hiddenDatums.has(name);
    this.originGroup.visible = !this.hiddenDatums.has("Origin");
    if (this.hoverPlane && this.hiddenDatums.has(this.hoverPlane)) this.hoverPlane = null;
    this.applyPlaneHighlights();
  }

  viewNormalToPlane(plane: PlaneName): void {
    this.setView(PLANE_VIEWS[plane]);
  }

  /** Look straight at the selected plane or face (Onshape's "View normal to"). Returns false if nothing suitable is selected. */
  viewNormalToSelection(): boolean {
    if (this.selectedPlane) {
      this.viewNormalToPlane(this.selectedPlane);
      return true;
    }
    const face = [...this.selection].reverse().find((s) => s.kind === "face");
    if (!face) return false;
    const p = this.parts.get(face.partId);
    const group = p?.data.faceGroups[face.index];
    if (!p || !group) return false;
    const normal = new THREE.Vector3();
    const centre = new THREE.Vector3();
    const n = p.data.normals;
    const v = p.data.vertices;
    const t = p.data.triangles;
    for (let i = group.start; i < group.start + group.count; i++) {
      const vi = t[i];
      normal.x += n[3 * vi];
      normal.y += n[3 * vi + 1];
      normal.z += n[3 * vi + 2];
      centre.x += v[3 * vi];
      centre.y += v[3 * vi + 1];
      centre.z += v[3 * vi + 2];
    }
    if (normal.lengthSq() < 1e-12) return false;
    centre.divideScalar(group.count);
    const dir = normal.normalize();
    // Avoid a direction exactly along Z, where "up" on screen is undefined.
    if (Math.abs(dir.z) > 0.9999) dir.set(0, -1e-4 * Math.sign(dir.z || 1), Math.sign(dir.z)).normalize();
    this.animateTo({ dir, target: centre }, true);
    return true;
  }

  // -------------------------------------------------------------------------
  // Sketching

  /** Finished sketches to show faintly, and the sketch being edited (if any). */
  setSketchScene(others: { plane: SketchPlane; data: SketchData }[], active: ActiveSketch | null): void {
    this.sketchLayer.setOthers(others);
    this.sketchLayer.setActive(active);
  }

  setSketchTransient(t: SketchTransient | null): void {
    this.sketchLayer.setTransient(t);
  }

  /** Route left-button input to sketch tools (or back to normal picking with null). */
  setSketchController(controller: SketchController | null): void {
    this.sketchController = controller;
    if (controller && this.hover) {
      this.hover = null;
      this.applyHighlights();
    }
  }

  /** Look straight at a sketch plane. */
  viewNormalToSketch(plane: SketchPlane): void {
    const f = planeFrame(plane);
    const dir = new THREE.Vector3(...f.n);
    if (Math.abs(dir.z) > 0.9999) dir.set(0, -1e-4 * Math.sign(dir.z), Math.sign(dir.z)).normalize();
    this.animateTo({ dir }, true);
  }

  /** Screen position (CSS px within the viewport) of a point on the active sketch, or null. */
  projectSketchPoint(x: number, y: number): { x: number; y: number } | null {
    const f = this.sketchLayer.frame;
    if (!f) return null;
    const v = new THREE.Vector3(
      f.origin[0] + x * f.u[0] + y * f.v[0],
      f.origin[1] + x * f.u[1] + y * f.v[1],
      f.origin[2] + x * f.u[2] + y * f.v[2],
    ).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Sketch coordinates under a screen point (CSS px within the viewport), or null. */
  unprojectToSketch(px: number, py: number): { x: number; y: number } | null {
    const f = this.sketchLayer.frame;
    if (!f) return null;
    const ndc = new THREE.Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const n = new THREE.Vector3(...f.n);
    const o = new THREE.Vector3(...f.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    hit.sub(o);
    return { x: hit.dot(new THREE.Vector3(...f.u)), y: hit.dot(new THREE.Vector3(...f.v)) };
  }

  /** Millimetres per screen pixel at the current zoom. */
  mmPerPixel(): number {
    return this.worldPerPixel();
  }

  /** Called after every frame is drawn (used to keep HTML labels in place). */
  addFrameListener(fn: () => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /**
   * If a face is flat, its outward normal and a point on it (for sketching on
   * the face). Returns null for curved faces.
   */
  flatFace(item: SelectionItem): { normal: [number, number, number]; point: [number, number, number] } | null {
    if (item.kind !== "face") return null;
    const p = this.parts.get(item.partId);
    const g = p?.data.faceGroups[item.index];
    if (!p || !g) return null;
    const { normals: n, vertices: v, triangles: t } = p.data;
    const avg = new THREE.Vector3();
    for (let i = g.start; i < g.start + g.count; i++) avg.add(new THREE.Vector3(n[3 * t[i]], n[3 * t[i] + 1], n[3 * t[i] + 2]));
    if (avg.lengthSq() < 1e-12) return null;
    avg.normalize();
    for (let i = g.start; i < g.start + g.count; i++) {
      const vn = new THREE.Vector3(n[3 * t[i]], n[3 * t[i] + 1], n[3 * t[i] + 2]).normalize();
      if (vn.dot(avg) < 0.9999) return null; // curved
    }
    const vi = t[g.start];
    return { normal: [avg.x, avg.y, avg.z], point: [v[3 * vi], v[3 * vi + 1], v[3 * vi + 2]] };
  }

  private sketchPointer(e: PointerEvent): SketchPointer | null {
    const { x, y } = this.localPoint(e);
    const p = this.unprojectToSketch(x, y);
    if (!p) return null;
    return { x: p.x, y: p.y, mmPerPx: this.worldPerPixel(), shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.sketchLayer.dispose();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    for (const p of this.parts.values()) {
      p.mesh.geometry.dispose();
      p.lines.geometry.dispose();
    }
    this.materials.faces.forEach((m) => m.dispose());
    this.materials.edges.forEach((m) => m.dispose());
    this.viewCube.dispose();
    this.renderer.dispose();
    el.remove();
  }

  // -------------------------------------------------------------------------
  // Scene furniture

  private buildPlanes(): void {
    const makePlane = (name: PlaneName, rotation: THREE.Euler) => {
      // Each plane has its own materials so it can be highlighted on its own.
      const fill = new THREE.MeshBasicMaterial({
        color: COLOURS.plane,
        transparent: true,
        opacity: 0.09,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const border = new THREE.LineBasicMaterial({ color: COLOURS.planeBorder, transparent: true, opacity: 0.55 });
      const group = new THREE.Group();
      group.name = name;
      const square = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fill);
      square.renderOrder = -1;
      square.userData.plane = name;
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.5, -0.5, 0),
          new THREE.Vector3(0.5, -0.5, 0),
          new THREE.Vector3(0.5, 0.5, 0),
          new THREE.Vector3(-0.5, 0.5, 0),
        ]),
        border,
      );
      const inner = new THREE.Group();
      inner.add(square, outline);
      inner.rotation.copy(rotation);
      group.add(inner);

      const label = labelSprite(name, COLOURS.planeLabel);
      // Label sits at the plane's corner (in plane coordinates (-0.5, 0.5)).
      label.position.copy(new THREE.Vector3(-0.5, 0.5, 0).applyEuler(rotation));
      label.userData.planeCorner = label.position.clone();
      this.planeLabels.push(label);
      group.add(label);
      this.planesGroup.add(group);
      this.planes.set(name, { group, square, fill, border });
    };

    makePlane("Top", new THREE.Euler(0, 0, 0)); // XY
    makePlane("Front", new THREE.Euler(Math.PI / 2, 0, 0)); // XZ
    makePlane("Right", new THREE.Euler(0, Math.PI / 2, Math.PI / 2)); // YZ
    this.updatePlaneSize();
  }

  private applyPlaneHighlights(): void {
    for (const [name, p] of this.planes) {
      const selected = this.selectedPlane === name;
      const hovered = this.hoverPlane === name || this.listHoverPlane === name;
      p.fill.color.set(selected ? COLOURS.planeSelected : hovered ? COLOURS.planeHover : COLOURS.plane);
      p.fill.opacity = selected ? 0.2 : hovered ? 0.18 : 0.09;
      p.border.color.set(selected ? COLOURS.planeSelectedBorder : hovered ? COLOURS.planeHoverBorder : COLOURS.planeBorder);
      p.border.opacity = selected || hovered ? 0.95 : 0.55;
    }
  }

  private updatePlaneSize(): void {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) box.expandByObject(p.mesh);
    const extent = box.isEmpty() ? 0 : Math.max(...box.getSize(new THREE.Vector3()).toArray(), 0);
    // Like Onshape, planes roughly cover the model (100 mm when empty).
    this.planeSize = extent > 0 ? Math.max(10, Math.ceil((extent * 1.1) / 5) * 5) : 100;
    for (const group of this.planesGroup.children) {
      const inner = group.children[0];
      inner.scale.setScalar(this.planeSize);
    }
    for (const label of this.planeLabels) {
      label.position.copy(label.userData.planeCorner as THREE.Vector3).multiplyScalar(this.planeSize);
    }
  }

  private buildOrigin(): void {
    const axis = (dir: THREE.Vector3, colour: string) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
      line.renderOrder = 4;
      return line;
    };
    this.originGroup.add(
      axis(new THREE.Vector3(1, 0, 0), "#d43c3c"),
      axis(new THREE.Vector3(0, 1, 0), "#2f9e44"),
      axis(new THREE.Vector3(0, 0, 1), "#2f6fd1"),
    );
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 12, 8),
      new THREE.MeshBasicMaterial({ color: "#3c4652", depthTest: false }),
    );
    dot.renderOrder = 4;
    this.originGroup.add(dot);
  }

  // -------------------------------------------------------------------------
  // Camera

  /** World units (mm) covered by one screen pixel at the current zoom. */
  private worldPerPixel(): number {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / this.height;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = `${this.width}px`;
    this.renderer.domElement.style.height = `${this.height}px`;
    const aspect = this.width / this.height;
    this.camera.left = (-FRUSTUM_HEIGHT * aspect) / 2;
    this.camera.right = (FRUSTUM_HEIGHT * aspect) / 2;
    this.camera.top = FRUSTUM_HEIGHT / 2;
    this.camera.bottom = -FRUSTUM_HEIGHT / 2;
    this.camera.updateProjectionMatrix();
    this.sketchLayer.setResolution(this.width, this.height);
  }

  private animateTo(goal: { dir?: THREE.Vector3; target?: THREE.Vector3; zoom?: number }, animate: boolean): void {
    const fromDir = this.camera.position.clone().sub(this.controls.target).normalize();
    const toDir = (goal.dir ?? fromDir).clone().normalize();
    const toTarget = (goal.target ?? this.controls.target).clone();
    const toZoom = goal.zoom ?? this.camera.zoom;
    if (!animate) {
      this.applyCamera(toDir, toTarget, toZoom);
      return;
    }
    this.animation = {
      start: performance.now(),
      duration: 280,
      fromDir,
      toDir,
      fromTarget: this.controls.target.clone(),
      toTarget,
      fromZoom: this.camera.zoom,
      toZoom,
    };
  }

  private applyCamera(dir: THREE.Vector3, target: THREE.Vector3, zoom: number): void {
    const distance = Math.max(5000, this.planeSize * 20);
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    this.controls.update();
  }

  private stepAnimation(now: number): void {
    const a = this.animation;
    if (!a) return;
    const t = Math.min(1, (now - a.start) / a.duration);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
    // Spherical interpolation of the view direction.
    const q = new THREE.Quaternion().setFromUnitVectors(a.fromDir, a.toDir);
    const dir = a.fromDir.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
    if (a.fromDir.dot(a.toDir) < -0.999) {
      // Opposite directions: swing round via a sideways axis.
      const side = Math.abs(a.fromDir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      dir.copy(a.fromDir).applyAxisAngle(side, Math.PI * e);
    }
    const target = a.fromTarget.clone().lerp(a.toTarget, e);
    const zoom = a.fromZoom * Math.pow(a.toZoom / a.fromZoom, e);
    this.applyCamera(dir.normalize(), target, zoom);
    if (t >= 1) this.animation = null;
  }

  // -------------------------------------------------------------------------
  // Picking and highlighting

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pickAt(x: number, y: number): PickTarget | null {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const threshold = EDGE_PICK_PIXELS * this.worldPerPixel();
    this.raycaster.params.Line = { threshold };

    const meshes: THREE.Object3D[] = [];
    const lines: THREE.Object3D[] = [];
    for (const p of this.parts.values()) {
      if (!p.mesh.visible) continue;
      meshes.push(p.mesh);
      lines.push(p.lines);
    }
    const faceHit = this.raycaster.intersectObjects(meshes, false)[0];
    const edgeHit = this.raycaster.intersectObjects(lines, false)[0];

    // Prefer an edge when it's not hidden behind the face we hit.
    if (edgeHit && (!faceHit || edgeHit.distance <= faceHit.distance + threshold * 2)) {
      const partId = edgeHit.object.userData.partId as string;
      const groups = this.parts.get(partId)?.data.edgeGroups ?? [];
      const vertex = edgeHit.index ?? -1;
      const index = groups.findIndex((g) => vertex >= g.start && vertex < g.start + g.count);
      if (index >= 0) return { kind: "part", item: { partId, kind: "edge", index } };
    }
    if (faceHit && faceHit.faceIndex !== undefined && faceHit.faceIndex !== null) {
      const partId = faceHit.object.userData.partId as string;
      const groups = this.parts.get(partId)?.data.faceGroups ?? [];
      const triIndex = faceHit.faceIndex * 3;
      const index = groups.findIndex((g) => triIndex >= g.start && triIndex < g.start + g.count);
      if (index >= 0) return { kind: "part", item: { partId, kind: "face", index } };
    }

    // Nothing on a part: try the default planes (nearest first).
    const squares: THREE.Object3D[] = [];
    for (const [name, p] of this.planes) if (!this.hiddenDatums.has(name)) squares.push(p.square);
    const planeHit = this.raycaster.intersectObjects(squares, false)[0];
    if (planeHit) return { kind: "plane", plane: planeHit.object.userData.plane as PlaneName };
    return null;
  }

  private applyHighlights(): void {
    for (const [id, p] of this.parts) {
      const state = (kind: "face" | "edge", index: number) => {
        if (this.selection.some((s) => s.partId === id && s.kind === kind && s.index === index)) return 2;
        if (this.hover && this.hover.partId === id && this.hover.kind === kind && this.hover.index === index) return 1;
        return 0;
      };
      p.mesh.geometry.groups.forEach((g, i) => (g.materialIndex = state("face", i)));
      p.lines.geometry.groups.forEach((g, i) => (g.materialIndex = state("edge", i)));
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    const { x, y } = this.localPoint(e);
    this.pointerDown = { x, y, button: e.button };
    if (this.sketchController && e.button === 0 && !this.viewCube.contains(x, y, this.width)) {
      const ptr = this.sketchPointer(e);
      if (ptr) {
        this.renderer.domElement.setPointerCapture(e.pointerId);
        this.sketchController.pointerDown(ptr);
      }
    }
    if (e.button === 2) {
      // Ctrl + right-drag pans, as in Onshape.
      this.controls.mouseButtons.RIGHT = e.ctrlKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.sketchController) {
      const ptr = this.sketchPointer(e);
      const leftDown = (e.buttons & 1) === 1;
      if (ptr && (leftDown || e.buttons === 0)) this.sketchController.pointerMove(ptr, leftDown);
      if (e.buttons === 0) this.pendingMove = this.localPoint(e); // view cube hover
      return;
    }
    if (e.buttons !== 0) return; // dragging: no hover updates
    this.pendingMove = this.localPoint(e);
  };

  private onPointerLeave = () => {
    this.pendingMove = null;
    this.sketchController?.pointerLeave();
    this.viewCube.setHover(null, null, this.width);
    if (this.hover) {
      this.hover = null;
      this.applyHighlights();
    }
    if (this.hoverPlane) {
      this.hoverPlane = null;
      this.applyPlaneHighlights();
    }
    this.renderer.domElement.style.cursor = "";
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || down.button !== 0 || e.button !== 0) return;
    const { x, y } = this.localPoint(e);
    const overCube = this.viewCube.contains(down.x, down.y, this.width);
    if (this.sketchController && !overCube) {
      if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      this.sketchController.pointerUp();
      return;
    }
    if (Math.hypot(x - down.x, y - down.y) > CLICK_SLOP) return;

    if (this.viewCube.contains(x, y, this.width)) {
      const view = this.viewCube.pick(x, y, this.width);
      if (view) this.setView(view);
      return;
    }
    this.callbacks.onPick(this.pickAt(x, y), e.shiftKey || e.ctrlKey || e.metaKey);
  };

  private processHover(): void {
    const move = this.pendingMove;
    if (!move) return;
    this.pendingMove = null;
    const overCube = this.viewCube.contains(move.x, move.y, this.width);
    this.viewCube.setHover(overCube ? move.x : null, overCube ? move.y : null, this.width);
    // While sketching, the sketch tools handle hover themselves.
    const hit = overCube || this.sketchController ? null : this.pickAt(move.x, move.y);
    this.renderer.domElement.style.cursor = overCube && this.viewCube.pick(move.x, move.y, this.width) ? "pointer" : "";
    const partHit = hit?.kind === "part" ? hit.item : null;
    const planeHit = hit?.kind === "plane" ? hit.plane : null;
    if (!sameItem(partHit, this.hover) && (partHit || this.hover)) {
      this.hover = partHit;
      this.applyHighlights();
    }
    if (planeHit !== this.hoverPlane) {
      this.hoverPlane = planeHit;
      this.applyPlaneHighlights();
    }
  }

  // -------------------------------------------------------------------------
  // Render loop

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    this.stepAnimation(performance.now());
    this.processHover();

    // Keep labels and the origin triad a constant size on screen.
    const wpp = this.worldPerPixel();
    for (const label of this.planeLabels) {
      const h = 18 * wpp;
      label.scale.set(h * (label.userData.aspect as number), h, 1);
    }
    this.originGroup.scale.setScalar(36 * wpp);
    this.sketchLayer.frameUpdate(wpp);

    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.render(this.scene, this.camera);
    this.viewCube.render(this.renderer, this.camera, this.width, this.height);
    for (const fn of this.frameListeners) fn();
  };
}
