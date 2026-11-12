import { rectOf, shapeInBox, type Rect } from "./boxSelect";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { eventTime, GestureTracker, gestureOptions, reachFor, TouchRouter, type Gesture } from "./gestures";
import { addHeld, additive, shiftHeld } from "./touchKeys";

import type { PartMesh } from "../kernel/protocol";
import type { DatumName, PlaneName, SelectionItem } from "../model/store";
import type { SketchController, SketchPointer, SketchTransient } from "../sketch/controller";
import { planeFrame, type PlaneFrame, type SketchPlane } from "../sketch/planes";
import { rayOnPlane, type AreaShade } from "../sketch/areaClicks";
import type { Pt } from "../sketch/regions";
import type { SketchData } from "../sketch/types";
import type { PickableLine, ReferenceShape } from "../model/patternRefs";
import { labelSprite } from "./labels";
import { SketchLayer, type ActiveSketch } from "./SketchLayer";
import { VIEW_DIRECTIONS, ViewCube, type StandardView } from "./ViewCube";
import { finishOf, type FinishId } from "../model/finishes";
import { fitToBuffer, pictureSize, showGround, supersample } from "./pictureSize";
import { finishMaterial, paintBackground, studioEnvironment, studioRig, type PictureBackground } from "./studio";
import { handleAt, handleUsable, planeAxes, TRIAD_LAYOUT, TRIAD_PIXELS, type TriadHandle } from "./transformDrag";
import type { Triad } from "../model/transformMath";

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
  /** A sketch area another feature already uses. */
  areaTaken: "#8a8f96",
  /** A curve feature (Helix, Fit spline…). */
  curve: "#c2410c",
  /** Inside of a part when it's cut open by a section view. */
  sectionCut: "#d9774f",
};

/** A section view: everything on the far side of this plane is hidden (n·p + c < 0 is cut away). */
export interface SectionPlane {
  normal: [number, number, number];
  constant: number;
}

/** Save picture's choices (see `SceneManager.savePicture`). */
export interface PictureOptions {
  /** 1, 2 or 4 × the view's size on screen. */
  scale: number;
  background: PictureBackground;
  /** Draw the parts' edges (dark lines) too. */
  edges: boolean;
}

/** Which way to look at each default plane for "View normal to". */
const PLANE_VIEWS: Record<PlaneName, StandardView> = { Top: "top", Front: "front", Right: "right" };

/** The page was opened for the browser smoke test (?smoke). */
const SMOKE = typeof location !== "undefined" && /[?&]smoke\b/.test(location.search);

/** A finger-first screen (iPad, Android tablet): a pen there is used like a finger. */
const COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * Does this press go to the finger gestures? Fingers always; a pen only on a touch tablet (a desktop pen
 * tablet — Wacom, Surface — keeps working like a mouse), and only its tip: its side buttons go the old way.
 */
function usesGestures(e: PointerEvent): boolean {
  if (e.pointerType === "touch") return true;
  return e.pointerType === "pen" && COARSE && e.button === 0;
}

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
  /** A mate connector drawn by `setConnectorMarks` (by the key it was given). */
  | { kind: "connector"; key: string }
  /** A curve feature (Helix, Fit spline…) drawn by `setCurves` (`id` its feature id), where it was clicked. */
  | { kind: "curve"; id: string; point: [number, number, number] }
  /** A straight line in a finished sketch (`id` is the sketch feature's id), clickable while a mirror or pattern wants one. */
  | { kind: "sketchLine"; id: string; line: string }
  /** An area of a sketch (`sketch`: its feature id; `index` into `sketchAreas(sketch).areas`): see `setPickAreas`. */
  | {
      kind: "sketchArea";
      sketch: string;
      index: number;
      /** With nothing open: a part's face right there too (the area lies on it), so a second click can pick the face. */
      under?: { item: SelectionItem; point: [number, number, number]; local: [number, number, number] };
    };

/** A curve feature drawn in the 3D view (see `setCurves`). */
export interface CurveDraw {
  id: string;
  lines: number[][];
  lit?: boolean;
}

/** A mate connector drawn in the 3D view (see `setConnectorMarks`). */
export interface ConnectorMark {
  key: string;
  origin: [number, number, number];
  x: [number, number, number];
  z: [number, number, number];
  lit?: boolean;
}

/** How near (screen pixels) a click must be to a mate connector's middle to pick it. */
const CONNECTOR_PICK_PIXELS = 9;

/** One sketch's areas to draw on its plane and make clickable (see `setPickAreas`). */
export interface PickAreaSet {
  /** The sketch feature's id. */
  sketch: string;
  frame: PlaneFrame;
  /** Each area's outline and holes (sketch coordinates). The same array again means the same areas: only their colours are redone. */
  outlines: { outer: Pt[]; holes: Pt[][] }[];
  /** How each area is shaded (same order). */
  shades: AreaShade[];
  /** The area round a sketch point, or -1. */
  areaAt: (p: Pt) => number;
  /** Drawn fainter: not the sketch the feature uses now. */
  faint?: boolean;
  /** Drawn only under the pointer (a hidden sketch that isn't the feature's own). */
  hoverOnly?: boolean;
}

/** Sketch areas that can be clicked, and when they win over parts. */
export interface PickAreas {
  sets: PickAreaSet[];
  /**
   * "first": an area under the pointer wins over parts; "afterParts": only clicks that miss every part reach the
   * areas; "nearest" (nothing open): whichever is nearer, and areas only show under the pointer or when selected.
   */
  mode: "first" | "afterParts" | "nearest";
}

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
  /** A drag taken back (a second finger landed): put the parts back where they were. */
  onDragCancel?: () => void;
  /** A selection box dragged on empty space: the parts it chose (`additive` with Shift/Ctrl/Cmd held). */
  onBoxSelect?: (partIds: string[], additive: boolean) => void;
  /**
   * Move / copy's triad: a drag began on one of its handles (`size`: the triad's size in mm as drawn now; `shift`:
   * no snapping). Return false to ignore it. Then each move (with Shift as it is now), and the end or (a second
   * finger landed, the pointer was lost) a take-back.
   */
  onTriadStart?: (handle: TriadHandle, ray: ScreenRay, shift: boolean, size: number) => boolean;
  onTriadMove?: (ray: ScreenRay, shift: boolean) => void;
  onTriadEnd?: () => void;
  onTriadCancel?: () => void;
}

/** The triad's colours: X red, Y green, Z blue (as the origin's), the ball dark; under the pointer or dragged, orange. */
const TRIAD_COLOURS = { x: "#d43c3c", y: "#2f9e44", z: "#2f6fd1", ball: "#3a4048", active: "#ff8a00" };
const handleKey = (h: TriadHandle) => (h.kind === "ball" ? "ball" : `${h.kind}${h.axis}`);

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
  /** An old version's parts, see-through, while comparing versions (never picked). */
  private readonly ghostGroup = new THREE.Group();
  private ghostMaterials: { faces: THREE.Material; edges: THREE.Material } | null = null;
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
  private readonly colourMaterials = new Map<string, THREE.MeshPhongMaterial | THREE.MeshPhysicalMaterial>();
  /** Part finishes by part id (missing = matte). */
  private finishes: Record<string, FinishId> = {};
  /** "Nicer lighting" in the live view: physical materials and the studio's reflections. */
  private nice = false;
  /** True only while Save picture draws (synchronously): physical materials for everything. */
  private rendering = false;
  private liveEnvironment: { texture: THREE.Texture; dispose: () => void } | null = null;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly headlight: THREE.DirectionalLight;
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
  /** Fingers (and the pen) on the screen: worked out into gestures (see gestures.ts). The mouse never goes there. */
  private readonly gestures = new GestureTracker();
  /** Which pointers the gestures follow, and fingers ignored while the pen draws (see TouchRouter). */
  private readonly touchIds = new TouchRouter();
  private touchKind = "touch";
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFrame: number | null = null;
  /**
   * What one finger (or the pen) is doing: drawing in the sketch (`sent`: the sketch tools have had its press),
   * pressing on the view cube, or (`holdDrag`) dragging a part after a long press in an assembly.
   */
  private touchStroke: { sketch: boolean; cube: boolean; sent: boolean; holdDrag: boolean; triad?: TriadHandle | null; triadOn?: boolean } | null = null;
  /** Move / copy's triad (null: none shown), drawn in `triadGroup`, with each handle's materials for highlighting. */
  private triad: Triad | null = null;
  private readonly triadGroup = new THREE.Group();
  private triadMaterials = new Map<string, { mats: THREE.Material[]; colour: string; handle: TriadHandle; opacity: number[] }>();
  /** What the triad's drawing was made for (its handles and directions): a move only shifts it. */
  private triadShape = "";
  private triadHover: TriadHandle | null = null;
  /** The mouse (or desktop pen) dragging a triad handle. */
  private triadDrag: { pointerId: number; handle: TriadHandle } | null = null;
  /** Parts shown moved before they're rebuilt (a triad drag): id → 4×4 matrix, applied on top of any placement. */
  private previewMoves: Record<string, number[]> = {};

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
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x8a96a3, 1.1);
    this.scene.add(this.hemiLight);
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.headlight = headlight;
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

    this.scene.add(this.partsGroup, this.ghostGroup, this.planesGroup, this.customPlanesGroup, this.originGroup, this.markersGroup, this.connectorGroup, this.sketchLayer.group, this.triadGroup);
    this.buildPlanes();
    this.buildOrigin();

    // Our pointer handlers must run before OrbitControls' so Ctrl + right-drag can pan.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("pointercancel", this.onPointerCancel);
    // (A finger whose capture is lost without an up or cancel mustn't stay "down" for ever.)
    el.addEventListener("lostpointercapture", this.onPointerCancel);
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    // Onshape mouse: right-drag orbits, middle-drag pans, wheel zooms towards the cursor.
    this.controls = new OrbitControls(this.camera, el);
    this.controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    // Fingers and the pen never reach OrbitControls (onPointerDown stops them): gestures.ts handles them.
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

  /** Draw these parts see-through in orange over the model (an old version, when comparing); [] clears them. */
  setGhosts(parts: PartMesh[]): void {
    for (const child of [...this.ghostGroup.children]) {
      (child as THREE.Mesh).geometry?.dispose();
      this.ghostGroup.remove(child);
    }
    if (!parts.length) return;
    if (!this.ghostMaterials) {
      this.ghostMaterials = {
        faces: new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
        edges: new THREE.LineBasicMaterial({ color: 0xe06a00, transparent: true, opacity: 0.85 }),
      };
    }
    for (const data of parts) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));
      const mesh = new THREE.Mesh(geometry, this.ghostMaterials.faces);
      mesh.renderOrder = 2;
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.BufferAttribute(data.lines, 3));
      const lines = new THREE.LineSegments(lineGeometry, this.ghostMaterials.edges);
      lines.renderOrder = 2;
      this.ghostGroup.add(mesh, lines);
    }
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
      const preview = this.previewMoves[id];
      for (const o of [p.mesh, p.lines, p.cut]) {
        o.matrixAutoUpdate = false;
        if (m) o.matrix.fromArray(m);
        else o.matrix.identity();
        if (preview) o.matrix.premultiply(new THREE.Matrix4().fromArray(preview));
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

  /** Points along one of a part's edges (its drawn line, in order), e.g. to find a round edge's centre. */
  edgePoints(partId: string, edgeIndex: number): [number, number, number][] {
    const p = this.parts.get(partId);
    const g = p?.data.edgeGroups[edgeIndex];
    if (!p || !g) return [];
    const l = p.data.lines;
    const out: [number, number, number][] = [];
    // The points come in pairs, one segment each: each segment's start, then the last one's end.
    for (let k = g.start; k < g.start + g.count; k += 2) out.push([l[3 * k], l[3 * k + 1], l[3 * k + 2]]);
    const last = g.start + g.count - 1;
    if (g.count > 0) out.push([l[3 * last], l[3 * last + 1], l[3 * last + 2]]);
    return out;
  }

  /** What a click at this screen point (CSS px within the viewport) would pick, e.g. "face:PLANE" — for the browser smoke test. */
  pickKindAt(x: number, y: number): string | null {
    const hit = this.pickAt(x, y);
    if (!hit) return null;
    if (hit.kind !== "part") return hit.kind;
    const refs = hit.item.kind === "face" ? this.parts.get(hit.item.partId)?.data.faceRefs : this.parts.get(hit.item.partId)?.data.edgeRefs;
    const ref = refs?.[hit.item.index];
    return `${hit.item.kind}:${ref ? (ref.kind === "face" ? ref.surface : ref.curve) : "?"}`;
  }

  /** Which part (or assembly mesh key) a click at this screen point would land on, or null (for the browser smoke test). */
  pickPartAt(x: number, y: number): string | null {
    const hit = this.pickAt(x, y);
    return hit?.kind === "part" ? hit.item.partId : null;
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

  /**
   * Mate connectors to draw and make clickable (Part Studio mate connectors; in an assembly while a mate is being
   * made, the parts' own ones): each a small X/Y/Z triad, `lit` drawn larger. Clicks within a few pixels of one's
   * middle give PickTarget "connector" with its key.
   */
  setConnectorMarks(marks: ConnectorMark[]): void {
    const same = JSON.stringify(marks) === JSON.stringify(this.connectorMarks);
    if (same) return;
    this.connectorMarks = marks;
    for (const child of [...this.connectorGroup.children]) {
      this.connectorGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Line || o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    for (const m of marks) {
      const z = new THREE.Vector3(...m.z).normalize();
      const x = new THREE.Vector3(...m.x).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      const g = new THREE.Group();
      const arm = (dir: THREE.Vector3, colour: string, len: number) => {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(len)]), new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
        line.renderOrder = 6;
        return line;
      };
      g.add(arm(x, "#d43c3c", 0.6), arm(y, "#2f9e44", 0.6), arm(z, "#2f6fd1", 0.9));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(m.lit ? 0.13 : 0.09, 12, 8), new THREE.MeshBasicMaterial({ color: m.lit ? "#f08c00" : "#1d232a", depthTest: false }));
      dot.renderOrder = 6;
      g.add(dot);
      g.position.set(...m.origin);
      g.userData.lit = !!m.lit;
      this.connectorGroup.add(g);
    }
  }
  private connectorMarks: ConnectorMark[] = [];
  /** Whether clicks can pick mate connectors (only while the tool open takes one; else they fall through to faces and edges). */
  private connectorPicking: boolean | "notOnRound" = true;
  /** "notOnRound": only when the click isn't on a round face (Text wraps onto those). */
  setConnectorPicking(on: boolean | "notOnRound"): void {
    this.connectorPicking = on;
  }
  /** Is a face hit on a curved face (not flat)? */
  private roundFaceHit(hit: THREE.Intersection): boolean {
    if (hit.faceIndex === undefined || hit.faceIndex === null) return false;
    const data = this.parts.get(hit.object.userData.partId as string)?.data;
    const tri = hit.faceIndex * 3;
    const index = data?.faceGroups.findIndex((g) => tri >= g.start && tri < g.start + g.count) ?? -1;
    const ref = index >= 0 ? data?.faceRefs?.[index] : undefined;
    return !!ref && ref.surface !== "PLANE";
  }
  private readonly connectorGroup = new THREE.Group();

  /** The mate connector mark under a screen point (CSS px), if any. */
  private connectorAt(x: number, y: number, reach: number, inFront: (origin: [number, number, number]) => boolean): string | null {
    let best: { key: string; d: number } | null = null;
    for (const m of this.connectorMarks) {
      if (!inFront(m.origin)) continue;
      const p = new THREE.Vector3(...m.origin).project(this.camera);
      if (p.z > 1) continue;
      const sx = ((p.x + 1) / 2) * this.width;
      const sy = ((1 - p.y) / 2) * this.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d <= CONNECTOR_PICK_PIXELS * reach && (!best || d < best.d)) best = { key: m.key, d };
    }
    return best?.key ?? null;
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

  /** Part finishes (part id → finish; missing = the usual matte look). */
  setPartFinishes(finishes: Record<string, FinishId>): void {
    this.finishes = finishes;
    for (const [id, p] of this.parts) p.mesh.material = this.faceMaterialsFor(id);
  }

  /**
   * Nicer lighting in the live view: finishes drawn with reflections from a
   * studio room (a little slower to draw, so it's a choice). Off = the quick look.
   */
  setNiceLighting(on: boolean): void {
    if (on === this.nice) return;
    this.nice = on;
    if (on && !this.liveEnvironment) this.liveEnvironment = studioEnvironment(this.renderer);
    this.scene.environment = on ? this.liveEnvironment!.texture : null;
    this.hemiLight.intensity = on ? 0.45 : 1.1;
    this.headlight.intensity = on ? 0.9 : 1.6;
    for (const [id, p] of this.parts) p.mesh.material = this.faceMaterialsFor(id);
  }

  /**
   * A picture of the view as it is (same camera), `scale` times the view's
   * size in screen pixels (so 1× is what the screen shows, sharp screens
   * included), drawn on a renderer of its own with physical materials, studio
   * lighting, a soft shadow on the ground, and without planes, sketches, the
   * grid, the view cube or highlights. The live view is put back exactly as it
   * was before the next frame, and its own renderer is never touched.
   */
  async savePicture(opts: PictureOptions): Promise<Blob> {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const size = pictureSize(this.width * dpr, this.height * dpr, opts.scale, Math.min(8192, this.renderer.capabilities.maxTextureSize || 4096));
    const pr = this.pictureRendererFor();
    const renderer = pr.renderer;
    try {
      // Small pictures are drawn twice as big and shrunk, which smooths their edges (the renderer has no antialiasing of its own,
      // so big pictures don't ask the graphics card for a huge multisampled buffer).
      const ss = supersample(size);
      let draw = { width: size.width * ss, height: size.height * ss };
      renderer.setSize(draw.width, draw.height, false);
      const gl = renderer.getContext();
      const fitted = fitToBuffer(draw, { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight });
      if (!fitted) throw new Error("Your browser couldn't make a picture that big. Try a smaller size.");
      // The browser may quietly give a smaller drawing area than asked: draw at what it gave, the same shape, so nothing is cut off.
      if (fitted !== draw) {
        draw = fitted;
        renderer.setSize(draw.width, draw.height, false);
      }
      const final = ss > 1 ? { width: Math.max(1, Math.round(draw.width / ss)), height: Math.max(1, Math.round(draw.height / ss)) } : draw;
      const out = document.createElement("canvas");
      out.width = final.width;
      out.height = final.height;

      const box = new THREE.Box3();
      for (const p of this.parts.values()) if (p.mesh.visible) box.expandByObject(p.mesh);
      if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(10, 10, 10));
      const towardsEye = this.camera.position.clone().sub(this.controls.target).normalize();
      const rig = studioRig(box, towardsEye, showGround(towardsEye.toArray() as [number, number, number]));

      // Everything but the parts is hidden for the picture, and put back straight after.
      const shown = this.scene.children.map((o) => o.visible);
      const was = { environment: this.scene.environment, headlight: this.headlight.visible, background: this.scene.background };
      const lines = [...this.parts.values()].map((p) => p.lines.visible);
      try {
        this.scene.children.forEach((o) => {
          if (o !== this.partsGroup && o !== this.camera) o.visible = false;
        });
        this.headlight.visible = false;
        this.scene.add(rig.group);
        this.scene.environment = pr.environment.texture;
        this.scene.background = null;
        this.rendering = true;
        for (const [id, p] of this.parts) {
          p.mesh.material = this.faceMaterialsFor(id);
          p.mesh.geometry.groups.forEach((g) => (g.materialIndex = 0));
          p.lines.geometry.groups.forEach((g) => (g.materialIndex = 0));
          p.lines.visible = p.mesh.visible && opts.edges;
          p.mesh.castShadow = true;
        }
        renderer.render(this.scene, this.camera);
        const ctx = out.getContext("2d");
        if (!ctx) throw new Error("Your browser couldn't make the picture. Try a smaller size.");
        paintBackground(ctx, final.width, final.height, opts.background);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(renderer.domElement, 0, 0, final.width, final.height);
      } finally {
        this.scene.remove(rig.group);
        rig.dispose();
        this.scene.children.forEach((o, i) => (o.visible = shown[i] ?? o.visible));
        this.headlight.visible = was.headlight;
        this.scene.environment = was.environment;
        this.scene.background = was.background;
        this.rendering = false;
        [...this.parts.values()].forEach((p, i) => {
          p.lines.visible = lines[i];
          p.mesh.castShadow = false;
        });
        for (const [id, p] of this.parts) p.mesh.material = this.faceMaterialsFor(id);
        this.applyHighlights();
      }
      return await new Promise<Blob>((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("Your browser couldn't make the picture. Try a smaller size."))), "image/png"),
      );
    } finally {
      // Kept for the next picture, but shrunk so its big drawing area doesn't sit in graphics memory.
      renderer.setSize(1, 1, false);
    }
  }

  /** The picture renderer (made the first time a picture is saved, then kept), with its own studio reflections. */
  private pictureRendererFor(): { renderer: THREE.WebGLRenderer; environment: { texture: THREE.Texture; dispose: () => void } } {
    if (this.pictureRenderer && !this.pictureRenderer.renderer.getContext().isContextLost()) return this.pictureRenderer;
    // (The browser may have taken a kept one back to save memory: make it again.)
    if (this.pictureRenderer) {
      this.pictureRenderer.environment.dispose();
      this.pictureRenderer.renderer.dispose();
      this.pictureRenderer = null;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
    } catch {
      throw new Error("Your browser couldn't start the 3D graphics for the picture. Close a few other tabs, or try a smaller size.");
    }
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    this.pictureRenderer = { renderer, environment: studioEnvironment(renderer) };
    return this.pictureRenderer;
  }
  private pictureRenderer: { renderer: THREE.WebGLRenderer; environment: { texture: THREE.Texture; dispose: () => void } } | null = null;

  /** Parts drawn see-through, so you can see inside or behind them. */
  setTransparent(ids: string[]): void {
    this.transparent = new Set(ids);
    for (const [id, p] of this.parts) p.mesh.material = this.faceMaterialsFor(id);
  }
  private transparent = new Set<string>();

  /** Normal, hover and selected materials for a part: its own colour and finish, then the shared highlights. */
  private faceMaterialsFor(partId: string): THREE.Material[] {
    const see = this.transparent.has(partId);
    const finish = this.finishes[partId];
    const physical = this.nice || this.rendering;
    const colour = this.colours[partId] ?? (see || finish || physical ? COLOURS.part : undefined);
    // Grey, matte and quick: the shared material, exactly as before finishes.
    if (!colour) return this.materials.faces;
    const key = [colour, see ? "see" : "", finish ?? "", physical ? "pbr" : ""].join("|");
    let m = this.colourMaterials.get(key);
    if (!m) {
      // Matte in the quick view keeps the original material; the rest come from studio.ts.
      m = !finish && !physical ? this.makeFaceMaterial(colour) : finishMaterial(colour, finishOf(finish), physical);
      if (see) {
        m.transparent = true;
        m.opacity = Math.min(m.opacity, 0.3);
        m.depthWrite = false;
      }
      m.clippingPlanes = this.section ? [this.section] : [];
      m.side = this.section ? THREE.FrontSide : THREE.DoubleSide;
      this.colourMaterials.set(key, m);
    }
    if (see) return [m, m, this.materials.faces[2]];
    // A see-through finish stays see-through when hovered or selected (just tinted), so it never suddenly looks solid.
    if (m.opacity < 1) return [m, this.seeThroughHighlight(1, m.opacity), this.seeThroughHighlight(2, m.opacity)];
    return [m, this.materials.faces[1], this.materials.faces[2]];
  }

  /** The hover (1) or selected (2) colour, see-through, for parts with a see-through finish (kept with the colour materials, so a section view updates them too). */
  private seeThroughHighlight(state: 1 | 2, opacity: number): THREE.Material {
    const key = `highlight|${state}|${opacity}`;
    let m = this.colourMaterials.get(key);
    if (!m) {
      m = this.makeFaceMaterial(state === 1 ? COLOURS.partHover : COLOURS.partSelected);
      m.transparent = true;
      m.opacity = Math.min(0.75, opacity + 0.25);
      m.depthWrite = false;
      m.clippingPlanes = this.section ? [this.section] : [];
      m.side = this.section ? THREE.FrontSide : THREE.DoubleSide;
      this.colourMaterials.set(key, m);
    }
    return m;
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

  /**
   * 3D-print check marks: triangles (9 numbers each, model mm) drawn over the
   * parts in a colour — overhangs, thin walls, and so on. Null clears them.
   */
  setPrintMarks(marks: { triangles: Float32Array; colour: string; opacity?: number }[] | null): void {
    const g = this.printMarksGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      const o = child as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    if (!marks?.length) return;
    if (!g.parent) this.scene.add(g);
    for (const m of marks) {
      if (!m.triangles.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.triangles, 3));
      const mat = new THREE.MeshBasicMaterial({
        color: m.colour,
        transparent: true,
        opacity: m.opacity ?? 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
        // Drawn just in front of the part's own faces.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.raycast = () => {};
      mesh.renderOrder = 2;
      g.add(mesh);
    }
  }

  private readonly printMarksGroup = new THREE.Group();

  /** The canvas the view is drawn on (and that takes the mouse). */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** How fast the mouse wheel zooms (OrbitControls' zoomSpeed). */
  get wheelZoomSpeed(): number {
    return this.controls.zoomSpeed;
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

  /** Whether the view is still turning or zooming to where it was sent (for the browser smoke test). */
  cameraMoving(): boolean {
    return this.animation !== null;
  }

  /**
   * Whether the view is at rest where "zoom to fit" puts it for what's shown now
   * (for the browser smoke test: some buttons fit the view a moment after they're
   * clicked, so "not moving" alone can be read before that move has even begun).
   */
  restingAtFit(): boolean {
    if (this.animation) return false;
    const goal = this.fitGoal();
    const near = this.controls.target.distanceTo(goal.target) <= 1e-3 * Math.max(1, goal.target.length());
    return near && Math.abs(this.camera.zoom - goal.zoom) <= 1e-3 * goal.zoom;
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
    return this.sketchPointerAt(x, y, e);
  }

  /** The sketch tools' view of the pointer at (x, y) in the view: fingers and the pen reach further (`reach`). */
  private sketchPointerAt(x: number, y: number, e: PointerEvent): SketchPointer | null {
    const p = this.unprojectToSketch(x, y);
    if (!p) return null;
    // (Wider only for fingers and a tablet's pen; a mouse or a desktop pen tablet keeps the mouse's distances.)
    const reach = usesGestures(e) || (e.pointerType === "pen" && COARSE) ? reachFor(e.pointerType) : 1;
    return { x: p.x, y: p.y, mmPerPx: this.worldPerPixel(), ...(reach !== 1 ? { reach } : {}), shift: shiftHeld(e), ctrl: addHeld(e), screenX: x };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    if (this.longPressFrame !== null) cancelAnimationFrame(this.longPressFrame);
    this.longPressTimer = null;
    this.gestures.reset();
    this.touchIds.reset();
    this.sketchLayer.dispose();
    this.setTriad(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerCancel);
    el.removeEventListener("lostpointercapture", this.onPointerCancel);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    for (const p of this.parts.values()) {
      p.mesh.geometry.dispose();
      p.lines.geometry.dispose();
    }
    this.materials.faces.forEach((m) => m.dispose());
    this.colourMaterials.forEach((m) => m.dispose());
    this.liveEnvironment?.dispose();
    if (this.pictureRenderer) {
      this.pictureRenderer.environment.dispose();
      this.pictureRenderer.renderer.dispose();
      this.pictureRenderer.renderer.forceContextLoss();
      this.pictureRenderer = null;
    }
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

  /** What's at (x, y) in the view; `reach` (fingers: more than 1) widens how near an edge must be. */
  private pickAt(x: number, y: number, reach = 1): PickTarget | null {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const threshold = EDGE_PICK_PIXELS * reach * this.worldPerPixel();
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
    // A sketch area (while an Extrude, Revolve or Sweep is open): before parts, unless the extrude's end is being picked.
    const area = this.areaUnderPointer();
    const areaTarget = area ? ({ kind: "sketchArea", sketch: this.pickAreas!.sets[area.set].sketch, index: area.index } as const) : null;
    if (areaTarget && this.pickAreas?.mode === "first") return areaTarget;
    const faceHit = this.raycaster.intersectObjects(meshes, false).find(kept);
    const edgeHit = this.raycaster.intersectObjects(lines, false).find(kept);
    // A mate connector's middle (when the tool open takes one) wins over the faces and edges round it — unless it's
    // hidden behind the part.
    if (this.connectorPicking && this.connectorMarks.length && !(this.connectorPicking === "notOnRound" && faceHit && this.roundFaceHit(faceHit))) {
      const ray = this.raycaster.ray;
      const key = this.connectorAt(x, y, reach, (o) => !faceHit || new THREE.Vector3(...o).sub(ray.origin).dot(ray.direction) <= faceHit.distance + threshold * 2);
      if (key) return { kind: "connector", key };
    }
    // Nothing open: an area wins when it's in front of the part (or on its face), unless an edge in front of it is under the pointer.
    if (area && areaTarget && this.pickAreas?.mode === "nearest" && (!faceHit || area.distance <= faceHit.distance + threshold) && (!edgeHit || this.facesOnly || edgeHit.distance > area.distance + threshold * 2)) {
      // The area lies on a face: say which, so clicking a selected area again can pick the face.
      if (faceHit && faceHit.faceIndex !== undefined && faceHit.faceIndex !== null && Math.abs(faceHit.distance - area.distance) <= threshold) {
        const partId = faceHit.object.userData.partId as string;
        const groups = this.parts.get(partId)?.data.faceGroups ?? [];
        const triIndex = faceHit.faceIndex * 3;
        const index = groups.findIndex((g) => triIndex >= g.start && triIndex < g.start + g.count);
        if (index >= 0)
          return {
            ...areaTarget,
            under: { item: { partId, kind: "face", index }, point: faceHit.point.toArray() as [number, number, number], local: faceHit.object.worldToLocal(faceHit.point.clone()).toArray() as [number, number, number] },
          };
      }
      return areaTarget;
    }

    // A curve feature, unless it's hidden behind a face.
    if (this.curveGroup.children.length) {
      const hit = this.raycaster.intersectObjects(this.curveGroup.children, false)[0];
      if (hit && (!faceHit || hit.distance <= faceHit.distance + threshold * 2)) return { kind: "curve", id: hit.object.userData.curve as string, point: hit.point.toArray() as [number, number, number] };
    }
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

    if (areaTarget && this.pickAreas?.mode !== "nearest") return areaTarget;
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
  // Sketch areas, clickable while an Extrude, Revolve or Sweep is open (every earlier sketch's, hidden ones too),
  // or, with nothing open, the areas of the sketches on show (to select before choosing Extrude), as in Onshape.

  private pickAreas: PickAreas | null = null;
  private hoverArea: { set: number; index: number } | null = null;
  private readonly areasGroup = new THREE.Group();
  /**
   * Each sketch's areas drawn as one mesh (fills) and one set of line pieces (outlines), whatever their number:
   * each area's vertices are a range, coloured (with see-through-ness) per vertex. Kept per sketch.
   */
  private areaDrawings = new Map<string, {
    outlines: PickAreaSet["outlines"];
    frameKey: string;
    fill: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    fillRanges: [number, number][];
    edgeRanges: [number, number][];
  }>();

  /** Draw these sketches' areas on their planes and let them be clicked (null: none). Only colours are redone for sketches whose areas and plane are unchanged. */
  setPickAreas(areas: PickAreas | null): void {
    this.pickAreas = areas;
    const sets = areas?.sets ?? [];
    if (this.hoverArea && (this.hoverArea.set >= sets.length || this.hoverArea.index >= sets[this.hoverArea.set].outlines.length)) this.hoverArea = null;
    const keep = new Map(sets.map((a) => [a.sketch, a] as const));
    for (const [id, d] of this.areaDrawings) {
      const a = keep.get(id);
      if (a && d.outlines === a.outlines && d.frameKey === JSON.stringify(a.frame)) continue;
      this.areasGroup.remove(d.fill, d.edges);
      d.fill.geometry.dispose();
      d.fill.material.dispose();
      d.edges.geometry.dispose();
      d.edges.material.dispose();
      this.areaDrawings.delete(id);
    }
    if (!this.areasGroup.parent) this.scene.add(this.areasGroup);
    for (const a of sets) if (!this.areaDrawings.has(a.sketch)) this.areaDrawings.set(a.sketch, this.buildAreas(a));
    this.colourAreas();
  }

  private buildAreas(areas: PickAreaSet): NonNullable<ReturnType<SceneManager["areaDrawings"]["get"]>> {
    const { origin, u, v, n } = areas.frame;
    const place = new THREE.Matrix4().makeBasis(new THREE.Vector3(...u), new THREE.Vector3(...v), new THREE.Vector3(...n)).setPosition(...origin);
    const fillPos: number[] = [];
    const edgePos: number[] = [];
    const fillRanges: [number, number][] = [];
    const edgeRanges: [number, number][] = [];
    const v2 = (poly: Pt[]) => {
      const pts = poly.map(([x, y]) => new THREE.Vector2(x, y));
      // Triangulation wants no repeated last point.
      if (pts.length > 1 && pts[0].equals(pts[pts.length - 1])) pts.pop();
      return pts;
    };
    for (const a of areas.outlines) {
      const outer = v2(a.outer);
      const holes = a.holes.map(v2);
      const startF = fillPos.length / 3;
      const all = [outer, ...holes].flat();
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(outer, holes)) for (const q of [all[i], all[j], all[k]]) fillPos.push(q.x, q.y, 0);
      fillRanges.push([startF, fillPos.length / 3 - startF]);
      const startE = edgePos.length / 3;
      for (const loop of [outer, ...holes]) loop.forEach((q, i) => {
        const r = loop[(i + 1) % loop.length];
        edgePos.push(q.x, q.y, 0, r.x, r.y, 0);
      });
      edgeRanges.push([startE, edgePos.length / 3 - startE]);
    }
    const geometry = (pos: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
      return g;
    };
    const fill = new THREE.Mesh(geometry(fillPos), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    const edges = new THREE.LineSegments(geometry(edgePos), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }));
    for (const [o, order] of [[fill, 5], [edges, 6]] as const) {
      o.matrixAutoUpdate = false;
      o.matrix.copy(place);
      o.renderOrder = order;
      o.raycast = () => {};
      o.frustumCulled = false;
    }
    this.areasGroup.add(fill, edges);
    return { outlines: areas.outlines, frameKey: JSON.stringify(areas.frame), fill, edges, fillRanges, edgeRanges };
  }

  /** Faint when just clickable, grey when another feature uses it, medium when "every closed shape" uses it, strong when picked; orange under the pointer. */
  private colourAreas(): void {
    (this.pickAreas?.sets ?? []).forEach((a, set) => {
      const d = this.areaDrawings.get(a.sketch);
      if (!d) return;
      d.fillRanges.forEach((_r, i) => this.paintArea(set, i, false));
      for (const o of [d.fill, d.edges]) {
        const attr = o.geometry.getAttribute("color") as THREE.BufferAttribute;
        attr.clearUpdateRanges(); // all of it
        attr.needsUpdate = true;
      }
    });
  }

  /** Recolour one area (just its own vertices; `upload` sends just those to the graphics card). */
  private paintArea(set: number, i: number, upload: boolean): void {
    const a = this.pickAreas?.sets[set];
    const d = a ? this.areaDrawings.get(a.sketch) : undefined;
    if (!a || !d || i < 0 || i >= d.fillRanges.length) return;
    const shade = a.shades[i] ?? "none";
    const hover = this.hoverArea?.set === set && this.hoverArea.index === i;
    const c = new THREE.Color();
    const paint = (o: THREE.Mesh | THREE.LineSegments, [start, count]: [number, number], colour: string, alpha: number) => {
      const attr = o.geometry.getAttribute("color") as THREE.BufferAttribute;
      c.set(colour);
      for (let k = start; k < start + count; k++) attr.setXYZW(k, c.r, c.g, c.b, alpha);
      if (upload && count) {
        attr.addUpdateRange(start * 4, count * 4);
        attr.needsUpdate = true;
      }
    };
    // With nothing open, areas only show under the pointer or when selected (the sketch's own lines are drawn anyway).
    const quiet = (this.pickAreas?.mode === "nearest" || a.hoverOnly) && (shade === "none" || (a.hoverOnly && shade === "taken")) && !hover;
    // Areas of sketches other than the feature's own are fainter still.
    const faint = a.faint ? 0.5 : 1;
    const fillColour = hover ? COLOURS.partHover : shade === "picked" || shade === "used" ? COLOURS.partSelected : shade === "taken" ? COLOURS.areaTaken : COLOURS.part;
    const fillAlpha = quiet ? 0 : (shade === "picked" ? 0.55 : shade === "used" ? 0.25 : shade === "taken" ? 0.3 * faint : 0.12 * faint) + (hover ? 0.2 : 0);
    paint(d.fill, d.fillRanges[i], fillColour, fillAlpha);
    const edgeColour = hover ? COLOURS.edgeHover : shade === "picked" || shade === "used" ? COLOURS.edgeSelected : COLOURS.part;
    paint(d.edges, d.edgeRanges[i], edgeColour, quiet ? 0 : shade === "picked" || shade === "used" || hover ? 0.9 : 0.5 * faint);
  }

  /** The pointer moved onto another area (or off them all): recolour just the two. */
  private setHoverArea(next: { set: number; index: number } | null): void {
    const was = this.hoverArea;
    if (was?.set === next?.set && was?.index === next?.index) return;
    this.hoverArea = next;
    if (was) this.paintArea(was.set, was.index, true);
    if (next) this.paintArea(next.set, next.index, true);
  }

  /** The nearest area under the raycaster's current ray (null: none). On the same plane, the earlier sketch in the list wins. */
  private areaUnderPointer(): { set: number; index: number; distance: number } | null {
    const sets = this.pickAreas?.sets;
    if (!sets?.length) return null;
    const r = this.raycaster.ray;
    let best: { set: number; index: number; distance: number } | null = null;
    // The feature's own sketch (not faint) wins wherever its area is under the pointer; then the nearest of the others.
    const passes = [sets.map((_a, i) => i).filter((i) => !sets[i].faint), sets.map((_a, i) => i).filter((i) => sets[i].faint)];
    for (const pass of passes) {
      if (best) break;
      for (const set of pass) {
        const a = sets[set];
        const hit = rayOnPlane(a.frame, r.origin.toArray() as [number, number, number], r.direction.toArray() as [number, number, number]);
        if (!hit) continue;
        // With a section on, areas in the part of the view cut away can't be clicked.
        if (this.section) {
          const p = r.at(hit.distance, new THREE.Vector3());
          if (this.section.distanceToPoint(p) < -1e-6) continue;
        }
        if (best && hit.distance >= best.distance - 1e-6) continue;
        const index = a.areaAt(hit.at);
        if (index >= 0) best = { set, index, distance: hit.distance };
      }
    }
    return best;
  }

  /**
   * For the browser smoke test: each clickable area's outline-points middle on screen (CSS px; inside round
   * or other convex areas), the size of its outline's box (mm²) and the sketch it's in.
   */
  areaScreenPoints(): { x: number; y: number; box: number; sketch: string }[] {
    return (this.pickAreas?.sets ?? []).flatMap((a) => {
      const { origin: o, u, v } = a.frame;
      return a.outlines.map(({ outer }) => {
        const xs = outer.map((q) => q[0]);
        const ys = outer.map((q) => q[1]);
        const x = xs.reduce((t, q) => t + q, 0) / xs.length;
        const y = ys.reduce((t, q) => t + q, 0) / ys.length;
        const p = new THREE.Vector3(o[0] + x * u[0] + y * v[0], o[1] + x * u[1] + y * v[1], o[2] + x * u[2] + y * v[2]).project(this.camera);
        return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height, box: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)), sketch: a.sketch };
      });
    });
  }

  // -------------------------------------------------------------------------
  // Move / copy's triad (Onshape's Transform manipulator): arrows, squares, rings and a ball to drag.

  /** Show the triad (null: hide it). It's kept the same size on screen. */
  setTriad(triad: Triad | null): void {
    this.triad = triad;
    const g = this.triadGroup;
    // Only moved (a drag, or a typed move): the same drawing, put somewhere else.
    const shape = triad ? JSON.stringify([triad.arrows, triad.planes, triad.rings, triad.ball, triad.frame.x, triad.frame.y, triad.frame.z]) : "";
    if (triad && shape === this.triadShape && g.children.length) {
      g.position.set(...triad.frame.origin);
      return;
    }
    this.triadShape = shape;
    for (const child of [...g.children]) {
      g.remove(child);
      const o = child as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    this.triadMaterials.clear();
    if (!triad) {
      this.triadHover = null;
      return;
    }
    const colours = ["x", "y", "z"] as const;
    const keep = (h: TriadHandle, colour: string, ...objects: (THREE.Mesh | THREE.Line)[]) => {
      const mats = objects.map((o) => o.material as THREE.Material);
      this.triadMaterials.set(handleKey(h), { mats, colour, handle: h, opacity: mats.map((m) => m.opacity) });
      for (const o of objects) {
        o.renderOrder = 20;
        g.add(o);
      }
    };
    const basic = (colour: string, opacity = 1) => new THREE.MeshBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity, side: THREE.DoubleSide });
    const lineMat = (colour: string) => new THREE.LineBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true });
    const unitVec = (i: number) => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
    // Drawn 1 unit long in the triad's own directions; the group is turned, placed and scaled every frame.
    for (const axis of triad.arrows) {
      const colour = TRIAD_COLOURS[colours[axis]];
      const d = unitVec(axis);
      const shaft = new THREE.Line(new THREE.BufferGeometry().setFromPoints([d.clone().multiplyScalar(TRIAD_LAYOUT.arrowFrom), d.clone().multiplyScalar(0.84)]), lineMat(colour));
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 16), basic(colour));
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      head.position.copy(d.clone().multiplyScalar(0.92));
      // (A thicker, see-through stalk so the arrow is easy to see and grab.)
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.84 - TRIAD_LAYOUT.arrowFrom, 8), basic(colour, 0.85));
      stalk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      stalk.position.copy(d.clone().multiplyScalar((0.84 + TRIAD_LAYOUT.arrowFrom) / 2));
      keep({ kind: "arrow", axis }, colour, shaft, head, stalk);
    }
    for (const axis of triad.planes) {
      const colour = TRIAD_COLOURS[colours[axis]];
      const [i, j] = planeAxes(axis);
      const u = unitVec(i);
      const v = unitVec(j);
      const at = (a: number, b: number) => u.clone().multiplyScalar(a).add(v.clone().multiplyScalar(b));
      const lo = TRIAD_LAYOUT.planeFrom;
      const hi = TRIAD_LAYOUT.planeTo;
      const c = [at(lo, lo), at(hi, lo), at(hi, hi), at(lo, hi)];
      const fill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]), basic(colour, 0.28));
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), lineMat(colour));
      keep({ kind: "plane", axis }, colour, fill, edge);
    }
    for (const axis of triad.rings) {
      const colour = TRIAD_COLOURS[colours[axis]];
      const [i, j] = planeAxes(axis);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < 96; k++) {
        const a = (2 * Math.PI * k) / 96;
        pts.push(unitVec(i).multiplyScalar(TRIAD_LAYOUT.ring * Math.cos(a)).add(unitVec(j).multiplyScalar(TRIAD_LAYOUT.ring * Math.sin(a))));
      }
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat(colour));
      // A thin tube along it too, so it reads as a handle.
      const curve = new THREE.CatmullRomCurve3(pts, true);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.012, 6, true), basic(colour, 0.8));
      keep({ kind: "ring", axis }, colour, ring, tube);
    }
    if (triad.ball) keep({ kind: "ball" }, TRIAD_COLOURS.ball, new THREE.Mesh(new THREE.SphereGeometry(TRIAD_LAYOUT.ball, 20, 14), basic(TRIAD_COLOURS.ball, 0.9)));
    const f = triad.frame;
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
    g.quaternion.setFromRotationMatrix(basis);
    g.position.set(...f.origin);
    if (this.triadHover && !this.triadMaterials.has(handleKey(this.triadHover))) this.triadHover = null;
    this.colourTriad();
  }

  /** The triad's size (mm from its middle to an arrow's tip) as drawn now. */
  triadSize(): number {
    return TRIAD_PIXELS * this.worldPerPixel();
  }

  /** Screen position (CSS px within the viewport) of a world point (for the triad and the browser smoke test). */
  worldToScreen(p: readonly number[]): { x: number; y: number } | null {
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** The triad on show, if any (for the browser smoke test). */
  triadShown(): Triad | null {
    return this.triad;
  }

  /** The triad handle at this screen point (CSS px), or null. */
  triadHandleAt(x: number, y: number, reach = 1): TriadHandle | null {
    if (!this.triad || this.sketchController) return null;
    const project = (p: [number, number, number]): [number, number] | null => {
      const s = this.worldToScreen(p);
      return s ? [s.x, s.y] : null;
    };
    return handleAt(this.triad, this.triadSize(), project, x, y, reach, this.viewDirection());
  }

  /** Which way the camera looks (world). */
  private viewDirection(): [number, number, number] {
    return this.camera.getWorldDirection(new THREE.Vector3()).toArray() as [number, number, number];
  }

  /** Take back a triad drag in progress (Esc): the pointer is let go and onTriadCancel is called. */
  cancelTriadDrag(): void {
    const d = this.triadDrag;
    const st = this.touchStroke;
    if (!d && !st?.triadOn) return;
    this.triadDrag = null;
    // (A release after Esc near where the drag began mustn't count as a click.)
    this.pointerDown = null;
    if (st?.triadOn) st.triadOn = false;
    if (d && this.renderer.domElement.hasPointerCapture(d.pointerId)) this.renderer.domElement.releasePointerCapture(d.pointerId);
    this.renderer.domElement.style.cursor = "";
    this.callbacks.onTriadCancel?.();
    this.colourTriad();
  }

  /** Arrows pointing at the eye and squares seen edge-on are faded (they can't be grabbed). */
  private fadeTriad(): void {
    if (!this.triad) return;
    const view = this.viewDirection();
    for (const { mats, handle, opacity } of this.triadMaterials.values()) {
      const k = handleUsable(this.triad, handle, view) ? 1 : 0.2;
      mats.forEach((m, i) => (m.opacity = opacity[i] * k));
    }
  }

  /** Show a part moved (before it's rebuilt): a 4×4 matrix (column by column), or null to show it where it is. */
  setPreviewMove(id: string, matrix: number[] | null): void {
    const next = { ...this.previewMoves };
    if (matrix) next[id] = matrix;
    else delete next[id];
    this.previewMoves = next;
    this.applyPlacements();
  }

  /** Stop showing any part moved ahead of its rebuild. */
  clearPreviewMoves(): void {
    if (!Object.keys(this.previewMoves).length) return;
    this.previewMoves = {};
    this.applyPlacements();
  }

  private colourTriad(): void {
    const lit = this.triadDrag?.handle ?? (this.touchStroke?.triadOn ? this.touchStroke.triad : null) ?? this.triadHover;
    for (const [key, { mats, colour }] of this.triadMaterials) {
      const c = lit && handleKey(lit) === key ? TRIAD_COLOURS.active : colour;
      for (const m of mats) (m as THREE.MeshBasicMaterial).color.set(c);
    }
  }

  // -------------------------------------------------------------------------
  // Curve features (Helix, Fit spline…): drawn as lines, clickable.

  private readonly curveGroup = new THREE.Group();
  private curveData: CurveDraw[] = [];
  private hoverCurve: string | null = null;

  /** The curve features to draw (each its lines, flat x, y, z…), and which are lit (selected or used by what's open). */
  setCurves(curves: CurveDraw[]): void {
    this.curveData = curves;
    const g = this.curveGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      const o = child as THREE.Line;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    if (!g.parent) this.scene.add(g);
    for (const c of curves) {
      for (const line of c.lines) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(line, 3));
        const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COLOURS.curve, transparent: true }));
        l.userData.curve = c.id;
        l.renderOrder = 5;
        g.add(l);
      }
    }
    if (this.hoverCurve && !curves.some((c) => c.id === this.hoverCurve)) this.hoverCurve = null;
    this.colourCurves();
  }

  private colourCurves(): void {
    const lit = new Set(this.curveData.filter((c) => c.lit).map((c) => c.id));
    for (const child of this.curveGroup.children) {
      const id = child.userData.curve as string;
      const m = (child as THREE.Line).material as THREE.LineBasicMaterial;
      m.color.set(id === this.hoverCurve ? COLOURS.edgeHover : lit.has(id) ? COLOURS.edgeSelected : COLOURS.curve);
    }
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
    if (usesGestures(e)) {
      // Fingers and a tablet's pen: gestures (OrbitControls, added after this listener, never sees them).
      e.stopImmediatePropagation();
      this.touchDown(e);
      return;
    }
    const { x, y } = this.localPoint(e);
    if (e.button === 2 && !(e.ctrlKey || e.metaKey)) {
      this.orbit = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.animation = null;
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
    this.pointerDown = { x, y, button: e.button };
    // Move / copy's triad: a press on one of its handles starts dragging it (nothing else happens with that press).
    if (this.triad && !this.sketchController && e.button === 0 && !this.viewCube.contains(x, y, this.width)) {
      const handle = this.triadHandleAt(x, y);
      if (handle && this.callbacks.onTriadStart?.(handle, this.rayAt(x, y), shiftHeld(e), this.triadSize())) {
        e.preventDefault();
        this.triadDrag = { pointerId: e.pointerId, handle };
        this.renderer.domElement.setPointerCapture(e.pointerId);
        this.renderer.domElement.style.cursor = "grabbing";
        this.colourTriad();
        return;
      }
    }
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
      if (hit?.kind !== "part") this.box = { x, y, cx: x, cy: y, shown: false, additive: additive(e) };
    }
    if (this.dragEnabled && !this.sketchController && e.button === 0 && !this.viewCube.contains(x, y, this.width)) {
      const hit = this.pickAt(x, y);
      this.drag = hit?.kind === "part" ? { target: hit, started: false, refused: false } : null;
      this.lastDragDebug = `press hit ${hit ? (hit.kind === "part" ? hit.item.partId : hit.kind === "plane" ? hit.plane : hit.kind === "sketchArea" ? "sketch area" : hit.kind === "connector" ? hit.key : hit.id) : "nothing"}`;
    }
    if (e.button === 2) {
      // Ctrl + right-drag pans, as in Onshape (⌘ + right-drag too, for Macs).
      this.controls.mouseButtons.RIGHT = e.ctrlKey || e.metaKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const route = this.touchIds.route(e.pointerId);
    if (route === "ignore") return;
    if (route === "gesture") {
      const { x, y } = this.localPoint(e);
      this.runGestures(this.gestures.move(e.pointerId, x, y, eventTime(e)), e);
      return;
    }
    if (this.triadDrag && this.triadDrag.pointerId === e.pointerId) {
      const { x, y } = this.localPoint(e);
      this.callbacks.onTriadMove?.(this.rayAt(x, y), shiftHeld(e));
      return;
    }
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
      return;
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
    this.setHoverArea(null);
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
    const route = this.touchIds.end(e.pointerId);
    if (route === "ignore") return;
    if (route === "gesture") {
      this.runGestures(this.gestures.cancel(e.pointerId), e);
      this.scheduleLongPress(e);
      return;
    }
    if (this.orbit?.id === e.pointerId) this.orbit = null;
    // The triad's drag lost its pointer: what it did is taken back.
    if (this.triadDrag?.pointerId === e.pointerId) {
      this.triadDrag = null;
      this.renderer.domElement.style.cursor = "";
      this.callbacks.onTriadCancel?.();
      this.colourTriad();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const route = this.touchIds.end(e.pointerId);
    if (route === "ignore") return;
    if (route === "gesture") {
      const { x, y } = this.localPoint(e);
      if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      this.runGestures(this.gestures.up(e.pointerId, x, y, eventTime(e)), e);
      this.scheduleLongPress(e);
      return;
    }
    if (this.orbit?.id === e.pointerId) {
      this.orbit = null;
      if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      return;
    }
    if (this.triadDrag?.pointerId === e.pointerId) {
      // (Cleared first: letting go of the capture below fires lostpointercapture, which mustn't take the drag back.)
      this.triadDrag = null;
      this.pointerDown = null;
      if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      this.renderer.domElement.style.cursor = "";
      this.callbacks.onTriadEnd?.();
      this.colourTriad();
      return;
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
    // The sketch's Use tool: another sketch's curve under the pointer is copied in (else a part's edge is picked).
    if (this.sketchPicksParts && this.sketchControllerRaw) {
      const ptr = this.sketchPointer(e);
      if (ptr && this.sketchControllerRaw.useAt(ptr)) return;
    }
    this.callbacks.onPick(this.pickAt(x, y), additive(e));
  };

  // -------------------------------------------------------------------------
  // Fingers and the pen (Onshape's tablet gestures): one finger turns the view, two pan and pinch to
  // zoom, a tap picks, a double-tap fits the view; in a sketch one finger (or the pen) draws with the
  // tool and two fingers still only pan and zoom. In an assembly, press and hold a part, then drag it.

  private touchDown(e: PointerEvent): void {
    const { x, y } = this.localPoint(e);
    // A hand resting on the screen while the pen draws is ignored, down to its lift (it mustn't cancel or take over the stroke).
    if (!this.touchIds.down(e.pointerId, e.pointerType)) return;
    if (!this.gestures.active) {
      this.touchKind = e.pointerType;
      // A long press only where it does something: picking up a part in an assembly. (Elsewhere a still press
      // then a drag just turns the view, and in a sketch it must still draw.)
      const longPress = this.dragEnabled && !this.sketchController && this.touchTiming.longPressMs;
      this.gestures.options = { ...gestureOptions(e.pointerType, longPress), doubleTapMs: this.touchTiming.doubleTapMs };
      this.animation = null;
    }
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // (A pointer the browser has already let go of.)
    }
    if (this.touchIds.count === 1) {
      const cube = this.viewCube.contains(x, y, this.width);
      const sketch = !!this.sketchController && !cube;
      // A finger (or the pen) on one of the triad's handles drags it instead of turning the view.
      const triad = !sketch && !cube ? this.triadHandleAt(x, y, reachFor(e.pointerType)) : null;
      this.touchStroke = { sketch, cube, sent: false, holdDrag: false, triad, triadOn: false };
      if (sketch) {
        // (As with the mouse: keep the keyboard focus where it is, e.g. in a dimension's value box.)
        e.preventDefault();
        // Show what the tool would do here (there's no hovering on a touch screen).
        const ptr = this.sketchPointerAt(x, y, e);
        if (ptr) this.sketchController!.pointerMove(ptr, false);
      }
    }
    this.runGestures(this.gestures.down(e.pointerId, x, y, eventTime(e)), e);
    this.scheduleLongPress(e);
  }

  private scheduleLongPress(e: PointerEvent): void {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    const due = this.gestures.longPressDue;
    if (due === null) return;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      // After the next frame: a finger already lifted (its event waiting to be handled) is then a tap, not a long press.
      const at = performance.now();
      this.longPressFrame = requestAnimationFrame(() => {
        this.longPressFrame = null;
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          this.runGestures(this.gestures.tick(at), e);
        }, 0);
      });
    }, Math.max(0, due - performance.now()) + 5);
  }

  private runGestures(list: Gesture[], e: PointerEvent): void {
    for (const g of list) this.onGesture(g, e);
  }

  /**
   * How long (ms) a finger is held still for a long press, and the most time between a double-tap's taps.
   * (The smoke test lengthens both: its slow software-drawn browser takes a while to get each tap through.)
   */
  touchTiming = { longPressMs: 500, doubleTapMs: 350 };

  /** The last few finger gestures seen (with ?smoke only: for the smoke test's error messages). */
  touchDebug: string[] = [];

  private onGesture(g: Gesture, e: PointerEvent): void {
    if (SMOKE) this.touchDebug = [...this.touchDebug.slice(-11), g.type === "tap" ? `tap×${g.count}` : g.type];
    const st = this.touchStroke;
    const ctl = this.sketchController;
    switch (g.type) {
      case "dragStart": {
        if (st?.triad) {
          st.triadOn = this.callbacks.onTriadStart?.(st.triad, this.rayAt(g.x, g.y), shiftHeld({}), this.triadSize()) ?? false;
          this.colourTriad();
          break;
        }
        // With Select, a drag moves what's under it (or draws a box); with a drawing tool it starts the
        // shape where the finger went down, and lifting the finger finishes it.
        if (!st?.sketch || !ctl) break;
        const ptr = this.sketchPointerAt(g.x, g.y, e);
        if (ptr && ctl.touchDragStarts()) {
          ctl.beginStroke();
          ctl.pointerDown(ptr);
          st.sent = true;
        }
        break;
      }
      case "drag": {
        if (!st || st.cube) break;
        // A finger that landed on a handle never turns the view (even when the drag was refused or taken back).
        if (st.triad) {
          if (st.triadOn) this.callbacks.onTriadMove?.(this.rayAt(g.x, g.y), shiftHeld({}));
          break;
        }
        if (st.sketch) {
          const ptr = this.sketchPointerAt(g.x, g.y, e);
          if (ptr && ctl) ctl.pointerMove(ptr, st.sent);
        } else this.orbitBy(g.dx, g.dy);
        break;
      }
      case "dragEnd": {
        if (st?.triadOn) {
          this.touchStroke = null;
          this.callbacks.onTriadEnd?.();
          this.colourTriad();
          break;
        }
        if (st?.sketch && ctl) {
          const ptr = this.sketchPointerAt(g.x, g.y, e);
          // Lifting the finger is a click there (the shape's other end, or the next point) — except with Select.
          if (ptr && ctl.touchLiftClicks()) ctl.pointerDown(ptr);
          ctl.pointerUp();
          ctl.endStroke();
          ctl.pointerLeave();
        }
        this.touchStroke = null;
        break;
      }
      case "tap": {
        this.touchStroke = null;
        // A tap on one of the triad's handles does nothing (it mustn't pick the part, or a face, under it).
        if (st?.triad) break;
        if (st?.sketch && ctl) {
          const ptr = this.sketchPointerAt(g.x, g.y, e);
          if (ptr) {
            ctl.pointerDown(ptr);
            ctl.pointerUp();
          }
          break;
        }
        this.tapAt(g.x, g.y, g.count, e);
        break;
      }
      case "longPress": {
        if (!st || st.sketch || st.cube || !this.dragEnabled) break;
        const hit = this.pickAt(g.x, g.y, reachFor(this.touchKind));
        if (hit?.kind === "part") st.holdDrag = this.callbacks.onDragStart?.(hit, this.rayAt(g.x, g.y), false) ?? false;
        break;
      }
      case "holdDrag":
        // Held on a part: it moves; held anywhere else, the drag turns the view as usual.
        if (st?.holdDrag) this.callbacks.onDragMove?.(this.rayAt(g.x, g.y));
        else if (st && !st.cube && !st.sketch) this.orbitBy(g.dx, g.dy);
        break;
      case "holdEnd":
        if (st?.holdDrag) this.callbacks.onDragEnd?.();
        this.touchStroke = null;
        break;
      case "cancel":
        // A second finger came down: take back what the first one began (no stray point), then pan and zoom.
        if (st?.sketch && ctl) {
          if (st.sent) ctl.cancelStroke();
          ctl.pointerLeave();
        }
        // A part being moved goes back where it was (and so does a triad drag).
        if (st?.holdDrag) (this.callbacks.onDragCancel ?? this.callbacks.onDragEnd)?.();
        if (st?.triadOn) this.callbacks.onTriadCancel?.();
        this.touchStroke = null;
        this.colourTriad();
        break;
      case "pan":
        this.panBy(g.dx, g.dy);
        break;
      case "zoom":
        this.zoomAt(g.x, g.y, g.factor);
        break;
      default:
        break;
    }
  }

  /** A tap (not in a sketch): the view cube turns the view, a double-tap fits everything in, anything else picks. */
  private tapAt(x: number, y: number, count: number, e: PointerEvent): void {
    if (this.viewCube.contains(x, y, this.width)) {
      const view = this.viewCube.pick(x, y, this.width);
      if (view) this.setView(view);
      return;
    }
    if (count >= 2 && !this.sketchControllerRaw) {
      this.fit();
      return;
    }
    if (this.sketchPicksParts && this.sketchControllerRaw) {
      const ptr = this.sketchPointerAt(x, y, e);
      if (ptr && this.sketchControllerRaw.useAt(ptr)) return;
    }
    this.callbacks.onPick(this.pickAt(x, y, reachFor(e.pointerType)), additive(e));
  }

  /** Slide the view by (dx, dy) screen pixels (the model follows the fingers). */
  panBy(dx: number, dy: number): void {
    const wpp = this.worldPerPixel();
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const move = right.multiplyScalar(-dx * wpp).addScaledVector(up, dy * wpp);
    this.animation = null;
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.camera.updateMatrixWorld();
  }

  /** Zoom by `factor` (above 1: closer), keeping the point at (x, y) in the view where it is. */
  zoomAt(x: number, y: number, factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const before = this.worldPerPixel();
    const zoom = Math.min(this.controls.maxZoom, Math.max(this.controls.minZoom, this.camera.zoom * factor));
    if (zoom === this.camera.zoom) return;
    this.animation = null;
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
    const after = this.worldPerPixel();
    // The point under the fingers stays put: slide by its offset from the middle times the change in scale.
    const k = (before - after) / after;
    this.panBy(-(x - this.width / 2) * k, -(y - this.height / 2) * k);
  }

  private processHover(): void {
    const move = this.pendingMove;
    if (!move) return;
    this.pendingMove = null;
    const overCube = this.viewCube.contains(move.x, move.y, this.width);
    this.viewCube.setHover(overCube ? move.x : null, overCube ? move.y : null, this.width);
    // Over one of the triad's handles: it lights up (and nothing else is hovered).
    const handle = overCube ? null : this.triadHandleAt(move.x, move.y);
    if ((handle ? handleKey(handle) : null) !== (this.triadHover ? handleKey(this.triadHover) : null)) {
      this.triadHover = handle;
      this.colourTriad();
    }
    // While sketching, the sketch tools handle hover themselves.
    const hit = overCube || this.sketchController || handle ? null : this.pickAt(move.x, move.y);
    this.renderer.domElement.style.cursor = overCube && this.viewCube.pick(move.x, move.y, this.width) ? "pointer" : handle ? "grab" : "";
    const partHit = hit?.kind === "part" ? hit.item : null;
    const planeHit = hit?.kind === "plane" ? hit.plane : null;
    const customHit = hit?.kind === "customPlane" ? hit.id : null;
    const lineHit = hit?.kind === "sketchLine" ? this.pickLines.find((l) => l.sketch === hit.id && l.line === hit.line) ?? null : null;
    const areaSet = hit?.kind === "sketchArea" ? (this.pickAreas?.sets.findIndex((a) => a.sketch === hit.sketch) ?? -1) : -1;
    this.setHoverArea(hit?.kind === "sketchArea" && areaSet >= 0 ? { set: areaSet, index: hit.index } : null);
    if (areaSet >= 0) this.renderer.domElement.style.cursor = "pointer";
    if (lineHit !== this.hoverLine) {
      this.hoverLine = lineHit;
      this.drawReference();
    }
    const curveHit = hit?.kind === "curve" ? hit.id : null;
    if (curveHit !== this.hoverCurve) {
      this.hoverCurve = curveHit;
      this.colourCurves();
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
    for (const m of this.connectorGroup.children) m.scale.setScalar((m.userData.lit ? 44 : 34) * wpp);
    this.triadGroup.scale.setScalar(TRIAD_PIXELS * wpp);
    this.fadeTriad();
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
