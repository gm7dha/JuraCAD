import { rectOf, shapeInBox, type Rect } from "./boxSelect";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { PartMesh } from "../kernel/protocol";
import type { DatumName, PlaneName, SelectionItem } from "../model/store";
import type { SketchController, SketchPointer, SketchTransient } from "../sketch/controller";
import { planeFrame, type SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import type { PickableLine, ReferenceShape } from "../model/patternRefs";
import { labelSprite } from "./labels";
import { SketchLayer, type ActiveSketch } from "./SketchLayer";
import { VIEW_DIRECTIONS, ViewCube, type StandardView } from "./ViewCube";

// JuraCAD is Z-up, like Onshape.
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
  /** Inside of a part when it's cut open by a section view. */
  sectionCut: "#d9774f",
};

/** A section view: everything on the far side of this plane is hidden (n·p + c < 0 is cut away). */
export interface SectionPlane {
  normal: [number, number, number];
  constant: number;
}

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
  /** The part's inside surface, shown flat-coloured where a section cuts it open. */
  cut: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.Material[]>;
}

/** What's under the pointer: a face/edge of a part, or one of the default planes. */
export type PickTarget =
  | { kind: "part"; item: SelectionItem; point?: [number, number, number]; /** The same point in the part's own coordinates (before it's placed in an assembly). */ local?: [number, number, number] }
  | { kind: "plane"; plane: PlaneName }
  /** A Plane feature (by its feature id). */
  | { kind: "customPlane"; id: string }
  /** A straight line in a finished sketch (`id` is the sketch feature's id), clickable while a mirror or pattern wants one. */
  | { kind: "sketchLine"; id: string; line: string };

/** A Plane feature to draw: where it is, its name, and whether it's highlighted. */
export interface CustomPlane {
  id: string;
  origin: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  label: string;
  highlight: boolean;
}

/** A line from the eye through a point on the screen (world coordinates). */
export interface ScreenRay {
  origin: [number, number, number];
  dir: [number, number, number];
}

export interface SceneCallbacks {
  /** Called when the user clicks in the viewport. `additive` is true with Shift/Ctrl/Cmd held. */
  onPick: (target: PickTarget | null, additive: boolean) => void;
  /** Left-drag that began on a part (only while dragging is switched on). Return false to ignore it. */
  onDragStart?: (target: PickTarget & { kind: "part" }, ray: ScreenRay, shift: boolean) => boolean;
  onDragMove?: (ray: ScreenRay) => void;
  onDragEnd?: () => void;
  /** A selection box dragged on empty space: the parts it chose (`additive` with Shift/Ctrl/Cmd held). */
  onBoxSelect?: (partIds: string[], additive: boolean) => void;
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
  /** Mate connector markers (small X/Y/Z arrows), kept a constant size on screen. */
  private readonly markersGroup = new THREE.Group();
  private readonly planeLabels: THREE.Sprite[] = [];
  private readonly planes = new Map<PlaneName, PlaneObjects>();
  private readonly parts = new Map<string, PartObjects>();
  private readonly materials: { faces: THREE.Material[]; edges: THREE.Material[]; cut: THREE.Material };
  private section: THREE.Plane | null = null;
  /** Part colours by part id, and one face material per colour (made as needed). */
  private colours: Record<string, string> = {};
  /** Assembly positions by part id (4×4, column by column); parts not listed stay where they are. */
  private placements: Record<string, number[]> = {};
  private readonly colourMaterials = new Map<string, THREE.MeshPhongMaterial>();
  private readonly makeFaceMaterial: (color: string) => THREE.MeshPhongMaterial;
  private readonly resizeObserver: ResizeObserver;
  private readonly callbacks: SceneCallbacks;
  private readonly sketchLayer = new SketchLayer();
  /** Set while a sketch is being edited: left-button input goes to the sketch tools. */
  private sketchControllerRaw: SketchController | null = null;
  /** While sketching, clicks pick part edges instead (the sketch's "Use" tool). */
  private sketchPicksParts = false;
  private get sketchController(): SketchController | null {
    return this.sketchPicksParts ? null : this.sketchControllerRaw;
  }
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
  /** Dragging parts with the left button (assemblies). */
  private dragEnabled = false;
  /** Left-drag on empty space draws a selection box (Part Studio). */
  private boxEnabled = false;
  private box: { x: number; y: number; cx: number; cy: number; shown: boolean; additive: boolean } | null = null;
  private readonly boxEl: HTMLDivElement;
  private drag: { target: PickTarget & { kind: "part" }; started: boolean; refused: boolean } | null = null;
  /** What the last left-press in drag mode found (for the smoke test's error messages). */
  lastDragDebug = "";
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
    fromUp: THREE.Vector3;
    toUp: THREE.Vector3;
  } | null = null;
  /** A right-drag (or one-finger drag) turning the view, with the last pointer position. */
  private orbit: { id: number; x: number; y: number } | null = null;
  /** Fingers on the screen (one turns the view; two pinch and pan). */
  private readonly touches = new Set<number>();

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;
    this.renderer.domElement.className = "viewport-canvas";
    container.appendChild(this.renderer.domElement);
    this.boxEl = document.createElement("div");
    this.boxEl.className = "box-select";
    this.boxEl.hidden = true;
    container.appendChild(this.boxEl);

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
    this.makeFaceMaterial = faceMat;
    this.materials = {
      faces: [faceMat(COLOURS.part), faceMat(COLOURS.partHover), faceMat(COLOURS.partSelected)],
      edges: [
        new THREE.LineBasicMaterial({ color: COLOURS.edge }),
        new THREE.LineBasicMaterial({ color: COLOURS.edgeHover }),
        new THREE.LineBasicMaterial({ color: COLOURS.edgeSelected }),
      ],
      cut: new THREE.MeshBasicMaterial({ color: COLOURS.sectionCut, side: THREE.BackSide }),
    };
    this.renderer.localClippingEnabled = true;

    this.scene.add(this.partsGroup, this.planesGroup, this.customPlanesGroup, this.originGroup, this.markersGroup, this.sketchLayer.group);
    this.buildPlanes();
    this.buildOrigin();

    // Our pointer handlers must run before OrbitControls' so Ctrl + right-drag can pan.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("pointercancel", this.onPointerCancel);
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    // Onshape mouse: right-drag orbits, middle-drag pans, wheel zooms towards the cursor.
    this.controls = new OrbitControls(this.camera, el);
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    // Turning the view is ours (see orbitBy): OrbitControls stops at straight up and down.
    this.controls.enableRotate = false;
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
      this.partsGroup.remove(p.mesh, p.lines, p.cut);
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
      const mesh = new THREE.Mesh(geometry, this.faceMaterialsFor(data.id));
      mesh.userData.partId = data.id;

      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.BufferAttribute(data.lines, 3));
      data.edgeGroups.forEach((g) => lineGeometry.addGroup(g.start, g.count, 0));
      lineGeometry.computeBoundingSphere();
      const lines = new THREE.LineSegments(lineGeometry, this.materials.edges);
      lines.userData.partId = data.id;

      const cut = new THREE.Mesh(geometry, this.materials.cut);
      cut.visible = this.section !== null;

      mesh.visible = lines.visible = !this.hidden.has(data.id);
      if (this.hidden.has(data.id)) cut.visible = false;
      this.partsGroup.add(mesh, lines, cut);
      this.parts.set(data.id, { data, mesh, lines, cut });
    }
    this.applyPlacements();

    if (this.hover && !this.parts.has(this.hover.partId)) this.hover = null;
    this.updatePlaneSize();
    this.applyHighlights();
    if (firstParts) this.fit(true);
  }

  /** Place parts (assembly instances): id → 4×4 matrix. Cheap — the meshes are kept. */
  setPlacements(placements: Record<string, number[]>): void {
    this.placements = placements;
    this.applyPlacements();
    this.updatePlaneSize();
  }

  private applyPlacements(): void {
    for (const [id, p] of this.parts) {
      const m = this.placements[id];
      for (const o of [p.mesh, p.lines, p.cut]) {
        o.matrixAutoUpdate = false;
        if (m) o.matrix.fromArray(m);
        else o.matrix.identity();
        o.matrixWorldNeedsUpdate = true;
        o.updateMatrixWorld(true);
      }
    }
  }

  /**
   * Screen position (CSS px within the viewport) of a point on a face — the
   * middle of its first triangle. Used by the browser smoke test to click faces.
   */
  screenPointOnFace(partId: string, faceIndex: number): { x: number; y: number } | null {
    const p = this.parts.get(partId);
    const g = p?.data.faceGroups[faceIndex];
    if (!p || !g) return null;
    const t = p.data.triangles;
    const v = p.data.vertices;
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(v[3 * t[g.start + k]], v[3 * t[g.start + k] + 1], v[3 * t[g.start + k] + 2]));
    c.divideScalar(3).applyMatrix4(p.mesh.matrixWorld).project(this.camera);
    return { x: ((c.x + 1) / 2) * this.width, y: ((1 - c.y) / 2) * this.height };
  }

  /** Screen position (CSS px within the viewport) of the middle of one of a part's edges, or null. */
  screenPointOnEdge(partId: string, edgeIndex: number): { x: number; y: number } | null {
    const p = this.parts.get(partId);
    const g = p?.data.edgeGroups[edgeIndex];
    if (!p || !g) return null;
    const l = p.data.lines;
    // Halfway along: the middle of the middle segment (the points come in pairs, one segment each).
    const seg = g.start + 2 * Math.floor(g.count / 4);
    const c = new THREE.Vector3((l[3 * seg] + l[3 * seg + 3]) / 2, (l[3 * seg + 1] + l[3 * seg + 4]) / 2, (l[3 * seg + 2] + l[3 * seg + 5]) / 2)
      .applyMatrix4(p.mesh.matrixWorld)
      .project(this.camera);
    return { x: ((c.x + 1) / 2) * this.width, y: ((1 - c.y) / 2) * this.height };
  }

  /** Ids of the parts (or assembly instances) on show, and what their faces look like. */
  shownParts(): { id: string; faceRefs: PartMesh["faceRefs"] }[] {
    return [...this.parts.values()].map((p) => ({ id: p.data.id, faceRefs: p.data.faceRefs }));
  }

  /** While a tool only takes faces (Thread, Draft…): clicks and hovering go to the face, never an edge on it. */
  setFacesOnly(on: boolean): void {
    this.facesOnly = on;
  }
  private facesOnly = false;

  /** Let left-drags on empty space draw a selection box. */
  setBoxSelectEnabled(on: boolean): void {
    this.boxEnabled = on;
    if (!on) this.endBox();
  }

  private endBox(): void {
    this.box = null;
    this.boxEl.hidden = true;
  }

  /** Parts chosen by a box on screen (px): wholly inside, or (crossing) any part of them. */
  partsInBox(r: Rect, crossing: boolean): string[] {
    const out: string[] = [];
    const v = new THREE.Vector3();
    const toScreen = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, m: THREE.Matrix4): Float32Array => {
      const pts = new Float32Array(attr.count * 2);
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(m).project(this.camera);
        pts[2 * i] = ((v.x + 1) / 2) * this.width;
        pts[2 * i + 1] = ((1 - v.y) / 2) * this.height;
      }
      return pts;
    };
    for (const p of this.parts.values()) {
      if (!p.mesh.visible) continue;
      p.mesh.updateMatrixWorld();
      const points = toScreen(p.mesh.geometry.getAttribute("position"), p.mesh.matrixWorld);
      const segments = toScreen(p.lines.geometry.getAttribute("position"), p.lines.matrixWorld);
      if (shapeInBox(r, points, segments, crossing)) out.push(p.data.id);
    }
    return out;
  }

  /** Let left-drags on parts move them (assemblies). */
  setDragEnabled(on: boolean): void {
    this.dragEnabled = on;
    if (!on) this.drag = null;
  }

  private rayAt(x: number, y: number): ScreenRay {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const r = this.raycaster.ray;
    return { origin: r.origin.toArray() as [number, number, number], dir: r.direction.clone().normalize().toArray() as [number, number, number] };
  }

  /** Show mate connectors: each an origin with X and Z directions (world coordinates). */
  setMarkers(markers: { origin: [number, number, number]; x: [number, number, number]; z: [number, number, number] }[]): void {
    for (const child of [...this.markersGroup.children]) {
      this.markersGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Line || o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    for (const m of markers) {
      const z = new THREE.Vector3(...m.z).normalize();
      const x = new THREE.Vector3(...m.x).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      const g = new THREE.Group();
      const arm = (dir: THREE.Vector3, colour: string, len: number) => {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(len)]),
          new THREE.LineBasicMaterial({ color: colour, depthTest: false, linewidth: 2 }),
        );
        line.renderOrder = 6;
        return line;
      };
      g.add(arm(x, "#d43c3c", 0.7), arm(y, "#2f9e44", 0.7), arm(z, "#2f6fd1", 1));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: "#1d232a", depthTest: false }));
      dot.renderOrder = 6;
      g.add(dot);
      g.position.set(...m.origin);
      this.markersGroup.add(g);
    }
  }

  /** Turn the section view on (cut along this plane) or off (null). */
  setSection(section: SectionPlane | null): void {
    this.section = section ? new THREE.Plane(new THREE.Vector3(...section.normal), section.constant) : null;
    const planes = this.section ? [this.section] : [];
    const faces = [...this.materials.faces, ...this.colourMaterials.values()];
    for (const m of [...faces, ...this.materials.edges, this.materials.cut]) m.clippingPlanes = planes;
    // While cut open, outer faces are drawn front-side only and the inside shows in the cut colour.
    for (const m of faces) {
      m.side = this.section ? THREE.FrontSide : THREE.DoubleSide;
      m.needsUpdate = true;
    }
    for (const p of this.parts.values()) p.cut.visible = this.section !== null && p.mesh.visible;
  }

  /** Colour parts (part id → "#rrggbb"); parts not listed are the default grey. */
  setPartColours(colours: Record<string, string>): void {
    this.colours = colours;
    for (const [id, p] of this.parts) p.mesh.material = this.faceMaterialsFor(id);
  }

  /** Parts drawn see-through, so you can see inside or behind them. */
  setTransparent(ids: string[]): void {
    this.transparent = new Set(ids);
    for (const [id, p] of this.parts) p.mesh.material = this.faceMaterialsFor(id);
  }
  private transparent = new Set<string>();

  /** Normal, hover and selected materials for a part: its own colour, then the shared highlights. */
  private faceMaterialsFor(partId: string): THREE.Material[] {
    const see = this.transparent.has(partId);
    const colour = this.colours[partId] ?? (see ? COLOURS.part : undefined);
    if (!colour) return this.materials.faces;
    const key = see ? `${colour}|see` : colour;
    let m = this.colourMaterials.get(key);
    if (!m) {
      m = this.makeFaceMaterial(colour);
      if (see) {
        m.transparent = true;
        m.opacity = 0.3;
        m.depthWrite = false;
      }
      m.clippingPlanes = this.section ? [this.section] : [];
      m.side = this.section ? THREE.FrontSide : THREE.DoubleSide;
      this.colourMaterials.set(key, m);
    }
    return see ? [m, m, this.materials.faces[2]] : [m, this.materials.faces[1], this.materials.faces[2]];
  }

  /** The model's extent along a direction (for the section slider). */
  extentAlong(dir: [number, number, number]): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of this.parts.values()) {
      if (!p.mesh.visible) continue;
      const v = p.data.vertices;
      // Measure along the direction as seen inside the part (it may be placed in an assembly).
      const m = p.mesh.matrixWorld;
      const e = m.elements;
      const ld = new THREE.Vector3(...dir).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m).transpose());
      const offset = e[12] * dir[0] + e[13] * dir[1] + e[14] * dir[2];
      for (let i = 0; i < v.length; i += 3) {
        const d = v[i] * ld.x + v[i + 1] * ld.y + v[i + 2] * ld.z + offset;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  }

  setSelection(items: SelectionItem[]): void {
    this.selection = items;
    this.applyHighlights();
  }

  /** Whole parts picked in the Parts list: drawn in the selection colour. */
  setSelectedParts(ids: string[]): void {
    this.selectedParts = new Set(ids);
    this.applyHighlights();
  }
  private selectedParts = new Set<string>();

  setHidden(ids: string[]): void {
    this.hidden = new Set(ids);
    for (const [id, p] of this.parts) {
      p.mesh.visible = p.lines.visible = !this.hidden.has(id);
      p.cut.visible = p.mesh.visible && this.section !== null;
    }
    this.updatePrintBed();
  }

  /** The box round everything shown (world mm), or null when nothing is. */
  visibleBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) if (p.mesh.visible) box.expandByObject(p.mesh);
    return box.isEmpty() ? null : { min: box.min.toArray() as [number, number, number], max: box.max.toArray() as [number, number, number] };
  }

  /**
   * Show a printer's bed (X × Y, with a 10 mm grid) under the parts shown,
   * centred beneath them, and its build volume as an outline — red where the
   * parts don't fit. Null hides it.
   */
  setPrintBed(size: [number, number, number] | null): void {
    this.printBedSize = size;
    this.updatePrintBed();
  }

  private printBedSize: [number, number, number] | null = null;
  private readonly printBedGroup = new THREE.Group();

  private updatePrintBed(): void {
    const g = this.printBedGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      const o = child as THREE.Mesh | THREE.LineSegments;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    const size = this.printBedSize;
    if (!size) return;
    if (!g.parent) this.scene.add(g);
    const b = this.visibleBounds();
    const centre = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : [0, 0];
    const z0 = b ? b.min[2] : 0;
    const fits = !b || [0, 1, 2].every((i) => b.max[i] - b.min[i] <= size[i] + 1e-6);
    const [w, d, h] = size;
    const x0 = centre[0] - w / 2;
    const y0 = centre[1] - d / 2;
    // The plate, just under the parts.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: fits ? 0x2f6fb0 : 0xc0392b, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    plate.position.set(centre[0], centre[1], z0 - 0.05);
    plate.raycast = () => {};
    // A 10 mm grid, and the build volume's edges.
    const grid: number[] = [];
    for (let x = 0; x <= w + 1e-6; x += 10) grid.push(x0 + x, y0, z0, x0 + x, y0 + d, z0);
    for (let y = 0; y <= d + 1e-6; y += 10) grid.push(x0, y0 + y, z0, x0 + w, y0 + y, z0);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
    const gridLines = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x6b7c8f, transparent: true, opacity: 0.35 }));
    gridLines.raycast = () => {};
    const volume = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, d, h)),
      new THREE.LineBasicMaterial({ color: fits ? 0x2f6fb0 : 0xc0392b, transparent: true, opacity: 0.7 }),
    );
    volume.position.set(centre[0], centre[1], z0 + h / 2);
    volume.raycast = () => {};
    g.add(plate, gridLines, volume);
  }

  /** Zoom and centre so everything visible fits on screen. */
  fit(animate = true): void {
    this.animateTo(this.fitGoal(), animate);
  }

  /** Where the camera looks and how far it's zoomed for everything visible to fit. */
  private fitGoal(): { target: THREE.Vector3; zoom: number } {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) if (p.mesh.visible) box.expandByObject(p.mesh);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(this.planeSize, this.planeSize, this.planeSize));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const aspect = this.width / this.height;
    const visible = Math.min(FRUSTUM_HEIGHT, FRUSTUM_HEIGHT * aspect);
    return { target: sphere.center, zoom: visible / (radius * 2.5) };
  }

  /** The current view (to come back to later). */
  saveView(): { dir: THREE.Vector3; target: THREE.Vector3; zoom: number; up: THREE.Vector3 } {
    const a = this.animation;
    if (a) return { dir: a.toDir.clone(), target: a.toTarget.clone(), zoom: a.toZoom, up: a.toUp.clone() };
    return { dir: this.camera.position.clone().sub(this.controls.target).normalize(), target: this.controls.target.clone(), zoom: this.camera.zoom, up: this.camera.up.clone() };
  }

  /** Which way is up on screen (for the smoke test). */
  cameraUp(): [number, number, number] {
    return this.camera.up.toArray() as [number, number, number];
  }

  restoreView(v: { dir: THREE.Vector3; target: THREE.Vector3; zoom: number; up?: THREE.Vector3 }): void {
    this.animateTo(v, true);
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
  /** While sketching, let clicks pick part edges (true) or go to the sketch tools (false). */
  setSketchPicksParts(on: boolean): void {
    this.sketchPicksParts = on;
  }

  setSketchController(controller: SketchController | null): void {
    this.sketchControllerRaw = controller;
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
    // With the whole model in view, so a sketch on a face shows all of it.
    const hasParts = [...this.parts.values()].some((p) => p.mesh.visible);
    this.animateTo(hasParts ? { dir, ...this.fitGoal() } : { dir }, true);
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
    return { x: p.x, y: p.y, mmPerPx: this.worldPerPixel(), shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, screenX: x };
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
    el.removeEventListener("pointercancel", this.onPointerCancel);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    for (const p of this.parts.values()) {
      p.mesh.geometry.dispose();
      p.lines.geometry.dispose();
    }
    this.materials.faces.forEach((m) => m.dispose());
    this.colourMaterials.forEach((m) => m.dispose());
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

  /** Draw the Plane features (replacing any drawn before). */
  setCustomPlanes(planes: CustomPlane[]): void {
    for (const g of [...this.customPlanesGroup.children]) {
      this.customPlanesGroup.remove(g);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    this.customPlaneData = planes;
    for (const p of planes) {
      const lit = p.highlight || this.hoverCustomPlane === p.id;
      const fill = new THREE.MeshBasicMaterial({ color: lit ? COLOURS.planeSelected : COLOURS.plane, transparent: true, opacity: lit ? 0.2 : 0.1, side: THREE.DoubleSide, depthWrite: false });
      const border = new THREE.LineBasicMaterial({ color: lit ? COLOURS.planeSelectedBorder : COLOURS.planeBorder, transparent: true, opacity: lit ? 0.95 : 0.7 });
      const s = this.planeSize * 0.8;
      const o = new THREE.Vector3(...p.origin);
      const u = new THREE.Vector3(...p.u).multiplyScalar(s / 2);
      const v = new THREE.Vector3(...p.v).multiplyScalar(s / 2);
      const corners = [o.clone().sub(u).sub(v), o.clone().add(u).sub(v), o.clone().add(u).add(v), o.clone().sub(u).add(v)];
      const geo = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      const square = new THREE.Mesh(geo, fill);
      square.renderOrder = -1;
      square.userData.customPlane = p.id;
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), border);
      const label = labelSprite(p.label, COLOURS.planeLabel);
      label.position.copy(corners[3]);
      const group = new THREE.Group();
      group.add(square, outline, label);
      this.customPlanesGroup.add(group);
    }
  }
  private readonly customPlanesGroup = new THREE.Group();
  private customPlaneData: CustomPlane[] = [];
  private hoverCustomPlane: string | null = null;

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
    this.updatePrintBed();
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

  /**
   * Turn the view by a mouse movement of (dx, dy) pixels, about the screen's
   * up and sideways directions — with no stop at straight up or down, so the
   * model can be turned right over (as in Onshape).
   */
  private orbitBy(dx: number, dy: number): void {
    const k = (2 * Math.PI * this.controls.rotateSpeed) / this.height;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const back = offset.clone().normalize();
    const up = this.camera.up.clone();
    up.addScaledVector(back, -up.dot(back));
    if (up.lengthSq() < 1e-12) up.copy(uprightFor(back));
    up.normalize();
    const right = up.clone().cross(back).normalize();
    const turn = new THREE.Quaternion()
      .setFromAxisAngle(up, -dx * k)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * k));
    offset.applyQuaternion(turn);
    up.applyQuaternion(turn);
    this.camera.position.copy(target).add(offset);
    this.camera.up.copy(up);
    this.camera.lookAt(target);
  }

  private animateTo(goal: { dir?: THREE.Vector3; target?: THREE.Vector3; zoom?: number; up?: THREE.Vector3 }, animate: boolean): void {
    const fromDir = this.camera.position.clone().sub(this.controls.target).normalize();
    // If the camera is already moving (e.g. F pressed straight after Shift+7), keep heading where it
    // was going for anything this move doesn't change, rather than cancelling the turn.
    const running = this.animation;
    const toDir = (goal.dir ?? running?.toDir ?? fromDir).clone().normalize();
    const toTarget = (goal.target ?? running?.toTarget ?? this.controls.target).clone();
    const toZoom = goal.zoom ?? running?.toZoom ?? this.camera.zoom;
    // A new direction stands the view upright again (Z up, or Y up looking straight down).
    const toUp = (goal.up ?? (goal.dir ? uprightFor(toDir) : (running?.toUp ?? this.camera.up))).clone();
    if (!animate) {
      this.applyCamera(toDir, toTarget, toZoom, toUp);
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
      fromUp: this.camera.up.clone(),
      toUp,
    };
  }

  private applyCamera(dir: THREE.Vector3, target: THREE.Vector3, zoom: number, up: THREE.Vector3): void {
    const distance = Math.max(5000, this.planeSize * 20);
    const u = up.clone().addScaledVector(dir, -up.dot(dir));
    this.camera.up.copy(u.lengthSq() > 1e-12 ? u.normalize() : uprightFor(dir));
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
    const up = a.fromUp.clone().lerp(a.toUp, e);
    this.applyCamera(dir.normalize(), target, zoom, up.lengthSq() > 1e-12 ? up : a.toUp);
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
    // With a section on, ignore anything in the part that's cut away.
    const kept = (h: THREE.Intersection) => !this.section || this.section.distanceToPoint(h.point) >= -1e-6;
    const faceHit = this.raycaster.intersectObjects(meshes, false).find(kept);
    const edgeHit = this.raycaster.intersectObjects(lines, false).find(kept);

    // A sketch line (while a mirror or pattern wants one), unless it's hidden behind a face.
    const line = this.nearestPickLine(threshold);
    if (line && (!faceHit || line.distance <= faceHit.distance + threshold * 2)) return { kind: "sketchLine", id: line.line.sketch, line: line.line.line };

    // Prefer an edge when it's not hidden behind the face we hit (unless only faces are wanted).
    if (edgeHit && !this.facesOnly && (!faceHit || edgeHit.distance <= faceHit.distance + threshold * 2)) {
      const partId = edgeHit.object.userData.partId as string;
      const groups = this.parts.get(partId)?.data.edgeGroups ?? [];
      const vertex = edgeHit.index ?? -1;
      const index = groups.findIndex((g) => vertex >= g.start && vertex < g.start + g.count);
      if (index >= 0) return { kind: "part", item: { partId, kind: "edge", index }, point: edgeHit.point.toArray() as [number, number, number], local: edgeHit.object.worldToLocal(edgeHit.point.clone()).toArray() as [number, number, number] };
    }
    if (faceHit && faceHit.faceIndex !== undefined && faceHit.faceIndex !== null) {
      const partId = faceHit.object.userData.partId as string;
      const groups = this.parts.get(partId)?.data.faceGroups ?? [];
      const triIndex = faceHit.faceIndex * 3;
      const index = groups.findIndex((g) => triIndex >= g.start && triIndex < g.start + g.count);
      if (index >= 0) return { kind: "part", item: { partId, kind: "face", index }, point: faceHit.point.toArray() as [number, number, number], local: faceHit.object.worldToLocal(faceHit.point.clone()).toArray() as [number, number, number] };
    }

    // Nothing on a part: try the planes (nearest first) — Plane features, then the default planes.
    const custom = this.raycaster.intersectObjects(this.customPlanesGroup.children.map((g) => g.children[0]), false)[0];
    if (custom) return { kind: "customPlane", id: custom.object.userData.customPlane as string };
    const squares: THREE.Object3D[] = [];
    for (const [name, p] of this.planes) if (!this.hiddenDatums.has(name)) squares.push(p.square);
    const planeHit = this.raycaster.intersectObjects(squares, false)[0];
    if (planeHit) return { kind: "plane", plane: planeHit.object.userData.plane as PlaneName };
    return null;
  }

  // -------------------------------------------------------------------------
  // References for Mirror and patterns: clickable sketch lines, and the chosen plane or axis drawn in the view.

  private pickLines: PickableLine[] = [];
  private hoverLine: PickableLine | null = null;
  private reference: ReferenceShape | null = null;
  private readonly referenceGroup = new THREE.Group();

  /** Sketch lines that can be clicked (empty: none). */
  setPickLines(lines: PickableLine[]): void {
    this.pickLines = lines;
    if (this.hoverLine && !lines.some((l) => l.sketch === this.hoverLine!.sketch && l.line === this.hoverLine!.line)) this.hoverLine = null;
    this.drawReference();
  }

  /** Show the plane or axis a mirror or pattern uses (null: nothing). */
  setReference(shape: ReferenceShape | null): void {
    this.reference = shape;
    this.drawReference();
  }

  private nearestPickLine(threshold: number): { line: PickableLine; distance: number } | null {
    if (!this.pickLines.length) return null;
    const ray = this.raycaster.ray;
    let best: { line: PickableLine; distance: number } | null = null;
    const onRay = new THREE.Vector3();
    for (const l of this.pickLines) {
      const d2 = ray.distanceSqToSegment(new THREE.Vector3(...l.a), new THREE.Vector3(...l.b), onRay);
      if (d2 > threshold * threshold) continue;
      const distance = onRay.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { line: l, distance };
    }
    return best;
  }

  private drawReference(): void {
    const g = this.referenceGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      const o = child as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    if (!g.parent) this.scene.add(g);
    const v = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);
    const segment = (a: THREE.Vector3, b: THREE.Vector3, colour: string, dashed = false) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color: colour, dashSize: this.planeSize / 25, gapSize: this.planeSize / 50, depthTest: false, transparent: true })
        : new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true });
      const line = new THREE.Line(geo, mat);
      if (dashed) line.computeLineDistances();
      line.renderOrder = 10;
      g.add(line);
    };
    const square = (o: THREE.Vector3, u: THREE.Vector3, w: THREE.Vector3) => {
      const s = this.planeSize * 0.8;
      const hu = u.clone().normalize().multiplyScalar(s / 2);
      const hv = w.clone().normalize().multiplyScalar(s / 2);
      const c = [o.clone().sub(hu).sub(hv), o.clone().add(hu).sub(hv), o.clone().add(hu).add(hv), o.clone().sub(hu).add(hv)];
      const fill = new THREE.Mesh(
        new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]),
        new THREE.MeshBasicMaterial({ color: COLOURS.planeSelected, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.renderOrder = -1;
      g.add(fill);
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), new THREE.LineBasicMaterial({ color: COLOURS.planeSelectedBorder, transparent: true, opacity: 0.95 }));
      g.add(outline);
    };
    const r = this.reference;
    if (r?.kind === "plane") square(v(r.origin), v(r.u), v(r.v));
    if (r?.kind === "axis") {
      const d = v(r.dir).normalize().multiplyScalar(this.planeSize * 0.75);
      segment(v(r.through).sub(d), v(r.through).add(d), COLOURS.edgeSelected, true);
    }
    if (r?.kind === "line") {
      segment(v(r.a), v(r.b), COLOURS.edgeSelected);
      // The line carried on both ways, dashed, as the axis or the edge of the mirror plane.
      const a = v(r.a);
      const b = v(r.b);
      const d = b.clone().sub(a).normalize().multiplyScalar(this.planeSize * 0.5);
      segment(a.clone().sub(d), b.clone().add(d), COLOURS.edgeSelected, true);
      if (r.plane) square(a.clone().add(b).multiplyScalar(0.5), v(r.plane.u), v(r.plane.v));
    }
    const h = this.hoverLine;
    if (h) segment(v(h.a), v(h.b), COLOURS.edgeHover);
  }

  private applyHighlights(): void {
    for (const [id, p] of this.parts) {
      const whole = this.selectedParts.has(id);
      const state = (kind: "face" | "edge", index: number) => {
        if (whole) return 2;
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
    if (e.pointerType === "touch") {
      this.touches.add(e.pointerId);
      // A second finger pinches or pans instead.
      this.orbit = this.touches.size === 1 && !this.sketchController && !this.viewCube.contains(x, y, this.width) ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
    } else if (e.button === 2 && !(e.ctrlKey || e.metaKey)) {
      this.orbit = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.animation = null;
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
    this.pointerDown = { x, y, button: e.button };
    if (this.sketchController && e.button === 0 && !this.viewCube.contains(x, y, this.width)) {
      const ptr = this.sketchPointer(e);
      if (ptr) {
        // Stop the browser's follow-up mousedown moving keyboard focus — a
        // click can open a dimension value box that must keep the focus.
        e.preventDefault();
        this.renderer.domElement.setPointerCapture(e.pointerId);
        this.sketchController.pointerDown(ptr);
      }
    }
    if (this.boxEnabled && !this.sketchController && e.button === 0 && e.pointerType !== "touch" && !this.viewCube.contains(x, y, this.width)) {
      // On empty space (or a plane), a drag draws a selection box; a plain click still picks.
      const hit = this.pickAt(x, y);
      if (hit?.kind !== "part") this.box = { x, y, cx: x, cy: y, shown: false, additive: e.shiftKey || e.ctrlKey || e.metaKey };
    }
    if (this.dragEnabled && !this.sketchController && e.button === 0 && !this.viewCube.contains(x, y, this.width)) {
      const hit = this.pickAt(x, y);
      this.drag = hit?.kind === "part" ? { target: hit, started: false, refused: false } : null;
      this.lastDragDebug = `press hit ${hit ? (hit.kind === "part" ? hit.item.partId : hit.kind === "plane" ? hit.plane : hit.id) : "nothing"}`;
    }
    if (e.button === 2) {
      // Ctrl + right-drag pans, as in Onshape (⌘ + right-drag too, for Macs).
      this.controls.mouseButtons.RIGHT = e.ctrlKey || e.metaKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const orbit = this.orbit;
    if (orbit && orbit.id === e.pointerId) {
      const dx = e.clientX - orbit.x;
      const dy = e.clientY - orbit.y;
      if (dx || dy) {
        this.animation = null;
        this.orbitBy(dx, dy);
        orbit.x = e.clientX;
        orbit.y = e.clientY;
      }
      if (e.pointerType !== "touch") return;
    }
    if (this.sketchController) {
      const ptr = this.sketchPointer(e);
      const leftDown = (e.buttons & 1) === 1;
      if (ptr && (leftDown || e.buttons === 0)) this.sketchController.pointerMove(ptr, leftDown);
      if (e.buttons === 0) this.pendingMove = this.localPoint(e); // view cube hover
      return;
    }
    if (this.box && (e.buttons & 1) === 1) {
      const { x, y } = this.localPoint(e);
      const b = this.box;
      b.cx = x;
      b.cy = y;
      if (!b.shown && Math.hypot(x - b.x, y - b.y) > CLICK_SLOP) {
        b.shown = true;
        this.boxEl.hidden = false;
        this.renderer.domElement.setPointerCapture(e.pointerId);
      }
      if (b.shown) {
        const r = rectOf(b.x, b.y, x, y);
        const s = this.boxEl.style;
        s.left = `${r.x0}px`;
        s.top = `${r.y0}px`;
        s.width = `${r.x1 - r.x0}px`;
        s.height = `${r.y1 - r.y0}px`;
        // Dragged leftwards: dashed, takes anything it touches.
        this.boxEl.classList.toggle("crossing", x < b.x);
      }
      return;
    }
    if (this.drag && this.pointerDown && (e.buttons & 1) === 1) {
      const { x, y } = this.localPoint(e);
      const d = this.drag;
      if (!d.started && !d.refused && Math.hypot(x - this.pointerDown.x, y - this.pointerDown.y) > CLICK_SLOP) {
        d.started = this.callbacks.onDragStart?.(d.target, this.rayAt(x, y), e.shiftKey) ?? false;
        d.refused = !d.started;
        this.lastDragDebug += d.started ? ", drag started" : ", drag refused";
        if (d.started) {
          this.renderer.domElement.setPointerCapture(e.pointerId);
          this.renderer.domElement.style.cursor = "grabbing";
        }
      }
      if (d.started) this.callbacks.onDragMove?.(this.rayAt(x, y));
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

  private onPointerCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.orbit?.id === e.pointerId) this.orbit = null;
  };

  private onPointerUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.orbit?.id === e.pointerId) {
      this.orbit = null;
      if (e.pointerType !== "touch") {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
        return;
      }
    }
    const down = this.pointerDown;
    this.pointerDown = null;
    const drag = this.drag;
    this.drag = null;
    if (drag?.started) {
      if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      this.renderer.domElement.style.cursor = "";
      this.callbacks.onDragEnd?.();
      return;
    }
    const box = this.box;
    if (box) {
      this.endBox();
      if (box.shown) {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
        this.callbacks.onBoxSelect?.(this.partsInBox(rectOf(box.x, box.y, box.cx, box.cy), box.cx < box.x), box.additive);
        return;
      }
    }
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
    const customHit = hit?.kind === "customPlane" ? hit.id : null;
    const lineHit = hit?.kind === "sketchLine" ? this.pickLines.find((l) => l.sketch === hit.id && l.line === hit.line) ?? null : null;
    if (lineHit !== this.hoverLine) {
      this.hoverLine = lineHit;
      this.drawReference();
    }
    if (customHit !== this.hoverCustomPlane) {
      this.hoverCustomPlane = customHit;
      this.setCustomPlanes(this.customPlaneData);
    }
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
    for (const m of this.markersGroup.children) m.scale.setScalar(40 * wpp);
    this.sketchLayer.frameUpdate(wpp);

    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.render(this.scene, this.camera);
    this.viewCube.render(this.renderer, this.camera, this.width, this.height);
    for (const fn of this.frameListeners) fn();
  };
}

/** "Up" for a view looking back along `dir`: world Z, or Y when looking straight down (or up) Z. */
function uprightFor(dir: THREE.Vector3): THREE.Vector3 {
  const up = new THREE.Vector3(0, 0, 1).addScaledVector(dir, -dir.z);
  if (up.lengthSq() > 1e-12) return up.normalize();
  return new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
}
