/**
 * Patterns in an assembly: copies of some instances repeated in a straight
 * line or round an axis. The copies are real instances (so they're in the
 * parts list, drawings, exports and clash checks) that always follow their
 * original: wherever the original is put — by a mate, a drag or typed — each
 * copy sits one step further along.
 */
import { evaluate } from "../model/expr";
import type { Assembly, AssemblyPattern, Instance } from "../model/types";
import { compose, quatFromAxisAngle, rotate, type Placement, type Vec3 } from "./math";
import { nextInstanceName, withMates } from "./assembly";
import { quatFromBasis } from "./connectors";

const AXES: Record<AssemblyPattern["axis"], Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The pattern's step as a number (mm, or degrees between copies), or what's wrong with it. */
export function patternStep(p: AssemblyPattern): { step: number } | { error: string } {
  if (p.kind === "mirror") return { step: 0 };
  if (!Number.isInteger(p.count) || p.count < 2 || p.count > 100) return { error: "How many: enter a whole number from 2 to 100." };
  const v = evaluate(p.amount);
  if (!v.ok) return { error: `${p.kind === "linear" ? "Spacing" : "Spread over"}: ${v.error}` };
  if (p.kind === "linear") {
    if (!(v.value > 0)) return { error: "Spacing: must be more than 0." };
    return { step: v.value };
  }
  if (!(v.value > 0) || v.value > 360) return { error: "Spread over: enter an angle above 0° and up to 360°." };
  return { step: v.value >= 360 - 1e-9 ? 360 / p.count : v.value / (p.count - 1) };
}

/** Where copy number `k` (1, 2…) goes, given where the original is. */
export function placeCopy(p: AssemblyPattern, step: number, original: Placement, k: number): Placement {
  if (p.kind === "mirror") return mirrorPlacement(p, original);
  const dir = AXES[p.axis];
  const sign = p.flip ? -1 : 1;
  if (p.kind === "linear") {
    const d = sign * step * k;
    return { position: [original.position[0] + dir[0] * d, original.position[1] + dir[1] * d, original.position[2] + dir[2] * d], rotation: original.rotation };
  }
  // Turn about the axis through the centre: move the centre to the origin, turn, move back.
  const c = p.centre ?? [0, 0, 0];
  const turn: Placement = { position: [0, 0, 0], rotation: quatFromAxisAngle(dir, (sign * step * k * Math.PI) / 180) };
  const toOrigin: Placement = { position: [-c[0], -c[1], -c[2]], rotation: [0, 0, 0, 1] };
  const back: Placement = { position: c, rotation: [0, 0, 0, 1] };
  return compose(back, compose(turn, compose(toOrigin, original)));
}

/**
 * Where a mirrored copy goes: the original's mirror image across the plane
 * square to the pattern's axis through its centre. The copy shows the part
 * flipped across its own YZ plane (Instance.mirrored), so this is the move
 * and turn that put that flipped part in the mirror-image place. Mirroring
 * twice gets back to the start.
 */
export function mirrorPlacement(p: Pick<AssemblyPattern, "axis" | "centre">, q: Placement): Placement {
  const n = AXES[p.axis];
  const c = p.centre ?? [0, 0, 0];
  const reflect = (v: Vec3): Vec3 => {
    const d = 2 * (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]);
    return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
  };
  // Columns of the copy's turn: the original's axes, X flipped (the part is mirrored in its own X), then reflected.
  const x = reflect(rotate(q.rotation, [-1, 0, 0]));
  const y = reflect(rotate(q.rotation, [0, 1, 0]));
  const z = reflect(rotate(q.rotation, [0, 0, 1]));
  const rel: Vec3 = [q.position[0] - c[0], q.position[1] - c[1], q.position[2] - c[2]];
  const r = reflect(rel);
  return { position: [r[0] + c[0], r[1] + c[1], r[2] + c[2]], rotation: quatFromBasis(x, y, z) };
}

/** Make the copies match the pattern: add the missing ones, drop extras, and put each in place. */
export function syncPattern(a: Assembly, p: AssemblyPattern, newId: () => string): Assembly {
  const step = patternStep(p);
  const seeds = p.seeds.map((id) => a.instances.find((i) => i.id === id)).filter((i): i is Instance => !!i && !i.copyOf);
  const keep: Instance[] = [];
  let instances = a.instances.filter((i) => i.copyOf?.pattern !== p.id);
  const old = a.instances.filter((i) => i.copyOf?.pattern === p.id);
  const count = p.kind === "mirror" ? 2 : p.count;
  for (const seed of seeds) {
    for (let k = 1; k < count; k++) {
      const placement = "step" in step ? placeCopy(p, step.step, seed.placement, k) : seed.placement;
      const was = old.find((i) => i.copyOf!.seed === seed.id && i.copyOf!.index === k && i.partId === seed.partId);
      const made: Instance = was
        ? { ...was, placement }
        : { id: newId(), partId: seed.partId, name: nextInstanceName({ ...a, instances: [...instances, ...keep] }, seed.name.replace(/ <\d+>$/, "")), placement, fixed: false, copyOf: { pattern: p.id, seed: seed.id, index: k } };
      // A mirrored copy is the part's mirror image (and a mirror of a mirror is the part itself).
      const { mirrored: _m, ...unflipped } = made;
      const copy: Instance = p.kind === "mirror" && !seed.mirrored ? { ...unflipped, mirrored: true } : p.kind !== "mirror" && seed.mirrored ? { ...unflipped, mirrored: true } : unflipped;
      // Copies show the part in the same configuration as their original.
      const { configuration: _old, ...plain } = copy;
      keep.push(seed.configuration ? { ...plain, configuration: seed.configuration } : plain);
    }
  }
  // Copies go straight after their pattern's last original, so the list reads naturally.
  const lastSeed = Math.max(-1, ...seeds.map((s) => instances.findIndex((i) => i.id === s.id)));
  instances = [...instances.slice(0, lastSeed + 1), ...keep, ...instances.slice(lastSeed + 1)];
  const gone = new Set(old.filter((i) => !keep.includes(i) && !keep.some((k) => k.id === i.id)).map((i) => i.id));
  const patterns = a.patterns ?? [];
  const next = patterns.some((x) => x.id === p.id) ? patterns.map((x) => (x.id === p.id ? p : x)) : [...patterns, p];
  const out = { ...a, instances, patterns: next };
  return a.mates ? withMates(out, a.mates.filter((m) => !gone.has(m.a.instanceId) && !gone.has(m.b.instanceId))) : out;
}

/** Remove a pattern and its copies. */
export function removePattern(a: Assembly, id: string): Assembly {
  const gone = new Set(a.instances.filter((i) => i.copyOf?.pattern === id).map((i) => i.id));
  const { patterns: _old, ...rest } = a;
  const patterns = (a.patterns ?? []).filter((p) => p.id !== id);
  const mates = (a.mates ?? []).filter((m) => !gone.has(m.a.instanceId) && !gone.has(m.b.instanceId));
  return withMates({ ...rest, instances: a.instances.filter((i) => !gone.has(i.id)), ...(patterns.length ? { patterns } : {}) }, mates);
}

/**
 * After instances are removed: patterns lose those originals (and their copies);
 * a pattern with no originals left goes. Removed copies just stay removed until
 * the pattern is next changed.
 */
export function tidyPatterns(a: Assembly): Assembly {
  if (!a.patterns?.length) return a;
  const present = new Set(a.instances.map((i) => i.id));
  const patterns = a.patterns.map((p) => ({ ...p, seeds: p.seeds.filter((s) => present.has(s)) })).filter((p) => p.seeds.length);
  const live = new Map(patterns.map((p) => [p.id, new Set(p.seeds)]));
  const orphan = new Set(a.instances.filter((i) => i.copyOf && !live.get(i.copyOf.pattern)?.has(i.copyOf.seed)).map((i) => i.id));
  const { patterns: _old, ...rest } = a;
  const out: Assembly = { ...rest, instances: a.instances.filter((i) => !orphan.has(i.id)), ...(patterns.length ? { patterns } : {}) };
  if (orphan.size && a.mates) return withMates(out, a.mates.filter((m) => !orphan.has(m.a.instanceId) && !orphan.has(m.b.instanceId)));
  return out;
}

/** Put every copy one step on from where its original ended up. Returns the problems by pattern id. */
export function placeCopies(a: Assembly, placements: Record<string, Placement>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const p of a.patterns ?? []) {
    const step = patternStep(p);
    if ("error" in step) {
      errors[p.id] = step.error;
      continue;
    }
    for (const i of a.instances) {
      if (i.copyOf?.pattern !== p.id) continue;
      const original = placements[i.copyOf.seed];
      if (original) placements[i.id] = placeCopy(p, step.step, original, i.copyOf.index);
    }
  }
  return errors;
}

/** "Pattern 1", "Pattern 2"… (or "Mirror 1"…) */
export function nextPatternName(a: Assembly, prefix = "Pattern"): string {
  const used = new Set((a.patterns ?? []).map((p) => p.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/** Read a saved pattern (null if it's unusable). */
export function parsePattern(raw: unknown, instanceIds: Set<string>): AssemblyPattern | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || (r.kind !== "linear" && r.kind !== "circular" && r.kind !== "mirror")) return null;
  const seeds = (Array.isArray(r.seeds) ? r.seeds : []).filter((s): s is string => typeof s === "string" && instanceIds.has(s));
  if (!seeds.length) return null;
  const count = typeof r.count === "number" && Number.isInteger(r.count) ? Math.max(2, Math.min(100, r.count)) : 2;
  const centre = Array.isArray(r.centre) && r.centre.length === 3 && r.centre.every((v) => typeof v === "number" && Number.isFinite(v)) ? (r.centre as [number, number, number]) : undefined;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 80) : "Pattern",
    kind: r.kind,
    seeds,
    count: r.kind === "mirror" ? 2 : count,
    amount: typeof r.amount === "string" ? r.amount : r.kind === "linear" ? "20" : "360",
    axis: r.axis === "x" || r.axis === "y" ? r.axis : "z",
    ...(r.flip === true ? { flip: true } : {}),
    ...(centre ? { centre } : {}),
  };
}

/** Where a point (mm) ends up on copy number `k`. */
export const turnPoint = (p: AssemblyPattern, step: number, v: Vec3, k: number): Vec3 => {
  const c = p.centre ?? [0, 0, 0];
  if (p.kind === "mirror") return mirrorPlacement(p, { position: v, rotation: [0, 0, 0, 1] }).position;
  if (p.kind === "linear") {
    const dir = AXES[p.axis];
    const d = (p.flip ? -1 : 1) * step * k;
    return [v[0] + dir[0] * d, v[1] + dir[1] * d, v[2] + dir[2] * d];
  }
  const q = quatFromAxisAngle(AXES[p.axis], ((p.flip ? -1 : 1) * step * k * Math.PI) / 180);
  const r = rotate(q, [v[0] - c[0], v[1] - c[1], v[2] - c[2]]);
  return [r[0] + c[0], r[1] + c[1], r[2] + c[2]];
};
