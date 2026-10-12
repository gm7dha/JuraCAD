import * as THREE from "three";

import { textTexture } from "./labels";

export type StandardView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

/**
 * Direction from the model towards the camera for each standard view.
 * PartSmith is Z-up like Onshape: Front looks along +Y, Top looks down -Z.
 * Top/Bottom are nudged slightly so "up" on screen stays well defined.
 */
export const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, -1e-4, 1).normalize(),
  bottom: new THREE.Vector3(0, -1e-4, -1).normalize(),
  iso: new THREE.Vector3(1, -1, 1).normalize(),
};

// BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
const FACE_VIEWS: StandardView[] = ["right", "left", "back", "front", "top", "bottom"];
const FACE_LABELS = ["Right", "Left", "Back", "Front", "Top", "Bottom"];
/**
 * BoxGeometry maps each face's texture differently. These clockwise rotations
 * make every label read upright when that face is viewed straight on with
 * Z up (worked out from three.js BoxGeometry's UV layout).
 */
const FACE_TEXT_ROTATION = [-Math.PI / 2, Math.PI / 2, Math.PI, 0, 0, Math.PI];

const FACE_COLOUR = new THREE.Color("#ffffff");
const HOVER_COLOUR = new THREE.Color("#cfe3ff");

/** The small labelled cube in the corner of the viewport (like Onshape's). */
export class ViewCube {
  readonly size = 112; // CSS pixels
  readonly margin = 12;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);
  private readonly cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial[]>;
  private readonly raycaster = new THREE.Raycaster();
  private hovered = -1;

  constructor() {
    const materials = FACE_LABELS.map(
      (label, i) =>
        new THREE.MeshBasicMaterial({
          map: textTexture(label, {
            width: 256,
            height: 256,
            font: '600 56px system-ui, -apple-system, "Segoe UI", sans-serif',
            color: "#3c4652",
            background: "#ffffff",
            border: "#9aa6b2",
            rotation: FACE_TEXT_ROTATION[i],
          }),
        }),
    );
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
    this.scene.add(this.cube);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: "#7d8996" }),
    );
    this.cube.add(edges);

    // Small axis triad at the cube's corner.
    const axes = new THREE.Group();
    const axis = (dir: THREE.Vector3, colour: string) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(1.1)]);
      axes.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, depthTest: false })));
    };
    axis(new THREE.Vector3(1, 0, 0), "#d43c3c");
    axis(new THREE.Vector3(0, 1, 0), "#2f9e44");
    axis(new THREE.Vector3(0, 0, 1), "#2f6fd1");
    axes.position.set(-1.25, -1.25, -1.25);
    axes.renderOrder = 5;
    this.scene.add(axes);
  }

  /** Screen rectangle (CSS pixels, from the top-left) the cube occupies. */
  rect(width: number): { x: number; y: number; w: number; h: number } {
    return { x: width - this.size - this.margin, y: this.margin, w: this.size, h: this.size };
  }

  contains(px: number, py: number, width: number): boolean {
    const r = this.rect(width);
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  /** Which standard view (if any) is under the given point. */
  pick(px: number, py: number, width: number): StandardView | null {
    const index = this.pickFace(px, py, width);
    return index >= 0 ? FACE_VIEWS[index] : null;
  }

  setHover(px: number | null, py: number | null, width: number): boolean {
    const index = px === null || py === null ? -1 : this.pickFace(px, py, width);
    if (index === this.hovered) return false;
    this.hovered = index;
    this.cube.material.forEach((m, i) => m.color.copy(i === index ? HOVER_COLOUR : FACE_COLOUR));
    return true;
  }

  private pickFace(px: number, py: number, width: number): number {
    const r = this.rect(width);
    const ndc = new THREE.Vector2(((px - r.x) / r.w) * 2 - 1, -((py - r.y) / r.h) * 2 + 1);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return -1;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    return hit?.face ? hit.face.materialIndex : -1;
  }

  /** Draw the cube in its corner, matching the main camera's orientation. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera, width: number, height: number): void {
    this.camera.quaternion.copy(mainCamera.quaternion);
    this.camera.position.set(0, 0, 6).applyQuaternion(mainCamera.quaternion);
    const r = this.rect(width);
    const y = height - r.y - r.h; // WebGL origin is bottom-left
    renderer.setScissorTest(true);
    renderer.setScissor(r.x, y, r.w, r.h);
    renderer.setViewport(r.x, y, r.w, r.h);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
  }

  dispose(): void {
    this.cube.geometry.dispose();
    this.cube.material.forEach((m) => {
      m.map?.dispose();
      m.dispose();
    });
  }
}
