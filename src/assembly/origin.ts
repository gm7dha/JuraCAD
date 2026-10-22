/**
 * Mating a part to the assembly's origin (as in Onshape) — so it can be held
 * in place, or allowed to turn or slide, without fixing it. The origin acts
 * like a fixed part that's always there, with a mate connector on each of its
 * three planes (Z out of the plane, like a flat face).
 */
import type { MateConnector } from "../model/types";
import type { Frame } from "./connectors";
import type { Vec3 } from "./math";

/** The "instance" a mate connector names when it's on the assembly's origin. */
export const ORIGIN_ID = "@origin";

export type OriginPlane = "Top" | "Front" | "Right";

/** Each plane's connector: Z out of the plane (as its normal in the Part Studio), X along the plane. */
const PLANES: Record<OriginPlane, { z: Vec3; x: Vec3 }> = {
  Top: { z: [0, 0, 1], x: [1, 0, 0] },
  Front: { z: [0, -1, 0], x: [1, 0, 0] },
  Right: { z: [1, 0, 0], x: [0, 1, 0] },
};

export const ORIGIN_PLANES = Object.keys(PLANES) as OriginPlane[];

export const isOrigin = (c: Pick<MateConnector, "instanceId"> | undefined): boolean => c?.instanceId === ORIGIN_ID;

/** A mate connector on one of the origin's planes. */
export function originConnector(plane: OriginPlane): MateConnector {
  return { instanceId: ORIGIN_ID, pick: { partId: ORIGIN_ID, ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: PLANES[plane].z } } };
}

/** Which of the origin's planes a connector is on (null if it isn't on the origin, or its direction is unknown). */
export function originPlaneOf(c: MateConnector): OriginPlane | null {
  if (!isOrigin(c) || c.pick.ref.kind !== "face") return null;
  const n = c.pick.ref.normal;
  return ORIGIN_PLANES.find((p) => PLANES[p].z.every((v, k) => Math.abs(v - n[k]) < 1e-6)) ?? null;
}

/** The connector's frame at the origin (null when it isn't a known origin plane). */
export function originFrame(c: MateConnector): Frame | null {
  const plane = originPlaneOf(c);
  return plane ? { origin: [0, 0, 0], z: PLANES[plane].z, x: PLANES[plane].x, surface: "plane" } : null;
}
