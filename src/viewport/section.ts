/** Turning a section view setting into the cutting plane the 3D view uses. Pure, so it's easy to test. */
import type { PlaneName, SectionView } from "../model/store";
import type { SectionPlane } from "./SceneManager";

/**
 * Which way each plane looks when cut, matching the standard views: Top looks down (keep below the cut),
 * Front looks from the front (keep behind it), Right looks from the right (keep to its left).
 */
const KEEP_DIRECTION: Record<PlaneName, [number, number, number]> = {
  Top: [0, 0, -1],
  Front: [0, 1, 0],
  Right: [-1, 0, 0],
};

/** The axis a plane's offset is measured along (+Z for Top, +Y for Front, +X for Right). */
export const SECTION_AXIS: Record<PlaneName, [number, number, number]> = {
  Top: [0, 0, 1],
  Front: [0, 1, 0],
  Right: [1, 0, 0],
};

export function sectionPlane(s: SectionView): SectionPlane {
  const n = KEEP_DIRECTION[s.plane].map((v) => (s.flip ? -v : v)) as [number, number, number];
  const axis = SECTION_AXIS[s.plane];
  // A point at the cut: offset along the plane's axis. n·p + c = 0 there.
  const p = axis.map((v) => v * s.offset) as [number, number, number];
  return { normal: n, constant: -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) };
}

/** Is a point kept (not cut away) by the section? */
export function keeps(plane: SectionPlane, p: [number, number, number]): boolean {
  return plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] + plane.constant >= 0;
}
