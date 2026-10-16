/**
 * The directions drawing views look from. Each view has the direction
 * towards the viewer (`toward`) and which way is right on the paper (`right`);
 * up on the paper is toward × right. Z is up, Front looks from −Y (Onshape).
 */
import type { ViewKind } from "../model/types";

type V3 = [number, number, number];
const unit = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

export const VIEW_CAMERAS: Record<ViewKind, { toward: V3; right: V3 }> = {
  front: { toward: [0, -1, 0], right: [1, 0, 0] },
  back: { toward: [0, 1, 0], right: [-1, 0, 0] },
  top: { toward: [0, 0, 1], right: [1, 0, 0] },
  bottom: { toward: [0, 0, -1], right: [1, 0, 0] },
  right: { toward: [1, 0, 0], right: [0, 1, 0] },
  left: { toward: [-1, 0, 0], right: [0, -1, 0] },
  iso: { toward: unit([1, -1, 1]), right: unit([1, 1, 0]) },
  // The front view of the part cut through, with the front part taken away.
  section: { toward: [0, -1, 0], right: [1, 0, 0] },
  // Detail views are worked out from their host view's lines, not seen from a camera of their own.
  detail: { toward: [0, -1, 0], right: [1, 0, 0] },
  // The flat pattern of a sheet metal part is already flat: drawn as it is.
  flat: { toward: [0, 0, 1], right: [1, 0, 0] },
};

/** Up on the paper for a view. */
export function viewUp(kind: ViewKind): V3 {
  const { toward: n, right: x } = VIEW_CAMERAS[kind];
  return [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
}

/** Where a 3D point lands in a view (mm, x right, y up). */
export function projectPoint(kind: ViewKind, p: V3): [number, number] {
  const x = VIEW_CAMERAS[kind].right;
  const y = viewUp(kind);
  return [p[0] * x[0] + p[1] * x[1] + p[2] * x[2], p[0] * y[0] + p[1] * y[1] + p[2] * y[2]];
}
