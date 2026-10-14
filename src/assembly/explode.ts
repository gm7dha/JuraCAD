/**
 * Exploded views: the parts of an assembly pulled apart so you can see how
 * they go together. Each part moves straight out from the middle of the
 * assembly — or, when some parts are fixed, from the middle of the fixed
 * parts, which stay where they are. Only the picture changes: mates,
 * exports and clash checks still use the parts' real places.
 */
import { placedBox, type Box3 } from "./assembly";
import type { Placement, Vec3 } from "./math";

export interface ExplodeItem {
  id: string;
  placement: Placement;
  /** The part's own box (before it's placed), or null if unknown. */
  box: Box3 | null;
  fixed?: boolean;
}

const centre = (b: Box3): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

function union(boxes: Box3[]): Box3 | null {
  if (!boxes.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  return { min, max };
}

/** How far each part moves for an exploded view spread by `amount` (0 = not at all). */
export function explodeOffsets(items: ExplodeItem[], amount: number): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  if (!(amount > 0)) return out;
  const placed = items.map((i) => ({ item: i, box: i.box ? placedBox(i.box, i.placement) : null }));
  const known = placed.filter((p) => p.box) as { item: ExplodeItem; box: Box3 }[];
  const fixed = known.filter((p) => p.item.fixed);
  const all = union((fixed.length && fixed.length < known.length ? fixed : known).map((p) => p.box));
  if (!all) return out;
  const middle = centre(all);
  const keepFixed = fixed.length > 0 && fixed.length < known.length;
  for (const { item, box } of known) {
    if (keepFixed && item.fixed) continue;
    const c = centre(box);
    const d: Vec3 = [(c[0] - middle[0]) * amount, (c[1] - middle[1]) * amount, (c[2] - middle[2]) * amount];
    if (Math.hypot(...d) > 1e-9) out[item.id] = d;
  }
  return out;
}

/** Placements moved by the offsets. */
export function explodedPlacements(placements: Record<string, Placement>, offsets: Record<string, Vec3>): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  for (const [id, p] of Object.entries(placements)) {
    const d = offsets[id];
    out[id] = d ? { position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]], rotation: p.rotation } : p;
  }
  return out;
}
