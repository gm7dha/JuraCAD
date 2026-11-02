/**
 * Part finishes as three.js materials, and the "photo studio" used for nicer
 * lighting and for Save picture: reflections from a softly lit room made in
 * code (no downloaded pictures, so it works offline), a key light whose
 * shadow falls softly on an invisible ground, and a background.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import type { Finish } from "../model/finishes";

/** Settings every part face material shares (see SceneManager). */
const FACE_BASE = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } as const;

/**
 * A face material for a colour and finish. `physical` (nicer lighting, pictures):
 * a MeshPhysicalMaterial lit by the studio's reflections; otherwise the quick
 * everyday Phong look, which for the matte finish is exactly the old material.
 */
export function finishMaterial(colour: string, finish: Finish, physical: boolean): THREE.MeshPhongMaterial | THREE.MeshPhysicalMaterial {
  const see = finish.opacity < 1;
  const common = { color: colour, transparent: see, opacity: finish.opacity, depthWrite: !see, ...FACE_BASE };
  if (!physical) {
    // Metals' highlights take the metal's own colour; plastics' are white.
    const specular = finish.metalness > 0.5 ? new THREE.Color(colour).multiplyScalar(Math.min(1, finish.specular * 1.6)) : new THREE.Color().setRGB(finish.specular, finish.specular, finish.specular, THREE.SRGBColorSpace);
    return new THREE.MeshPhongMaterial({ ...common, specular, shininess: finish.shininess });
  }
  return new THREE.MeshPhysicalMaterial({
    ...common,
    roughness: finish.roughness,
    metalness: finish.metalness,
    clearcoat: finish.clearcoat,
    clearcoatRoughness: finish.clearcoatRoughness,
    sheen: finish.sheen,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xffffff),
  });
}

/** The studio room's reflections for one renderer (each WebGL renderer needs its own). Z is up here, so the room is turned to match. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): { texture: THREE.Texture; dispose: () => void } {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  room.rotation.x = Math.PI / 2;
  room.updateMatrixWorld(true);
  const target = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  return { texture: target.texture, dispose: () => target.dispose() };
}

/**
 * Lights and a shadow-catching ground for a picture of what's inside `box`,
 * seen from `towardsEye` (model → camera). Four key lights a little apart
 * each cast a shadow, so together the shadow's edge is soft.
 */
export function studioRig(box: THREE.Box3, towardsEye: THREE.Vector3, ground: boolean): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
  group.add(new THREE.HemisphereLight(0xffffff, 0x9aa3ad, 0.35));

  // From above, a little towards the viewer and to their left, so the shadow falls behind and to the right.
  const flat = new THREE.Vector3(towardsEye.x, towardsEye.y, 0);
  if (flat.lengthSq() < 1e-9) flat.set(0, -1, 0);
  flat.normalize();
  const side = new THREE.Vector3(0, 0, 1).cross(flat).normalize();
  const main = new THREE.Vector3(0, 0, 1).addScaledVector(flat, 0.45).addScaledVector(side, -0.35).normalize();
  const spread = 0.06;
  const offsets: [number, number][] = [[spread, 0], [-spread, 0], [0, spread], [0, -spread]];
  const across = main.clone().cross(side).normalize();
  for (const [a, b] of offsets) {
    const dir = main.clone().addScaledVector(side, a).addScaledVector(across, b).normalize();
    const light = new THREE.DirectionalLight(0xffffff, 1.5 / offsets.length);
    light.position.copy(centre).addScaledVector(dir, radius * 3);
    light.target.position.copy(centre);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -radius * 1.8;
    cam.right = cam.top = radius * 1.8;
    cam.near = radius * 0.5;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = radius * 0.004;
    group.add(light, light.target);
  }
  // A soft fill from the other side, without a shadow.
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.copy(centre).addScaledVector(new THREE.Vector3(0, 0, 0.4).addScaledVector(side, 1).addScaledVector(flat, 0.3).normalize(), radius * 3);
  fill.target.position.copy(centre);
  group.add(fill, fill.target);

  let plane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial> | null = null;
  if (ground) {
    plane = new THREE.Mesh(new THREE.PlaneGeometry(radius * 14, radius * 14), new THREE.ShadowMaterial({ color: 0x1d232a, opacity: 0.25, depthWrite: false }));
    plane.position.set(centre.x, centre.y, box.min.z - radius * 0.002);
    plane.receiveShadow = true;
    plane.renderOrder = -2;
    group.add(plane);
  }
  group.updateMatrixWorld(true);
  return {
    group,
    dispose: () => {
      plane?.geometry.dispose();
      plane?.material.dispose();
      group.traverse((o) => (o as THREE.DirectionalLight).shadow?.dispose?.());
    },
  };
}

export type PictureBackground = "light" | "dark" | "none";

/** Paint the picture's background behind what was rendered (a soft top-to-bottom shade, or nothing). */
export function paintBackground(ctx: CanvasRenderingContext2D, width: number, height: number, background: PictureBackground): void {
  if (background === "none") return;
  const g = ctx.createLinearGradient(0, 0, 0, height);
  if (background === "light") {
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#e3e7ec");
  } else {
    g.addColorStop(0, "#3a4049");
    g.addColorStop(1, "#1b1f24");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}
