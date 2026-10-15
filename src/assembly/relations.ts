/**
 * Mate relations (Onshape's Gear, Rack and pinion and Screw relations): one
 * mate's movement drives another's.
 *  - Gear: two hinges turn together, the second by `ratio` times the first's angle (the other way round, as meshing gears do).
 *  - Rack and pinion: a hinge (the pinion) drives a slider (the rack); `ratio` is the pinion's radius (mm).
 *  - Screw: a hinge drives a slider by `ratio` mm per turn (the thread's lead).
 * Set `reverse` to run the driven mate the other way.
 */
import { evaluate } from "../model/expr";
import type { Assembly, Mate, MateRelation } from "../model/types";
import { MATE_TYPES, mateValues } from "./mates";

export const RELATION_KINDS: Record<MateRelation["kind"], { label: string; ratioLabel: string; ratioUnit: string; defaultRatio: string; drivenKey: "angle" | "distance"; hint: string }> = {
  gear: { label: "Gear", ratioLabel: "Ratio", ratioUnit: "×", defaultRatio: "1", drivenKey: "angle", hint: "Two hinges turning together, like meshing gears." },
  rack: { label: "Rack and pinion", ratioLabel: "Pinion radius", ratioUnit: "mm", defaultRatio: "10", drivenKey: "distance", hint: "A hinge (the gear) drives a slider (the rack)." },
  screw: { label: "Screw", ratioLabel: "Travel per turn", ratioUnit: "mm", defaultRatio: "1", drivenKey: "distance", hint: "A hinge (the screw) drives a slider (the nut)." },
};

/** Can this mate drive (it turns) or be driven by this kind of relation? */
export function canDrive(m: Mate): boolean {
  return MATE_TYPES[m.type].values.some((d) => d.key === "angle" && d.free);
}
export function canBeDriven(m: Mate, kind: MateRelation["kind"]): boolean {
  return MATE_TYPES[m.type].values.some((d) => d.key === RELATION_KINDS[kind].drivenKey && d.free);
}

/** The driven amount for a driver angle (degrees). */
export function drivenValue(kind: MateRelation["kind"], ratio: number, angle: number, reverse: boolean): number {
  const sign = reverse ? -1 : 1;
  if (kind === "gear") return -sign * ratio * angle;
  if (kind === "rack") return sign * ratio * ((angle * Math.PI) / 180);
  return sign * ratio * (angle / 360);
}

/**
 * The assembly with each relation's driven amount worked out from its driver,
 * which amounts are now driven (so loops leave them alone: "mateId:key"), and
 * any relations that can't work.
 */
export function applyRelations(assembly: Assembly): { assembly: Assembly; driven: Set<string>; errors: Record<string, string> } {
  const relations = assembly.relations ?? [];
  const errors: Record<string, string> = {};
  const driven = new Set<string>();
  if (!relations.length) return { assembly, driven, errors };
  let mates = assembly.mates ?? [];
  const byId = (id: string) => mates.find((m) => m.id === id);
  for (const r of relations) {
    const kind = RELATION_KINDS[r.kind];
    const a = byId(r.driver);
    const b = byId(r.driven);
    if (!a || !b) {
      errors[r.id] = "One of its mates has been deleted. Edit or remove this relation.";
      continue;
    }
    if (a.id === b.id) {
      errors[r.id] = "Pick two different mates.";
      continue;
    }
    if (!canDrive(a)) {
      errors[r.id] = `${a.name} doesn't turn, so it can't drive this. Use a Hinge (or Cylindrical) mate.`;
      continue;
    }
    if (!canBeDriven(b, r.kind)) {
      errors[r.id] = r.kind === "gear" ? `${b.name} doesn't turn. A gear relation joins two hinges.` : `${b.name} doesn't slide. Use a Slider (or Cylindrical) mate.`;
      continue;
    }
    if (driven.has(`${b.id}:${kind.drivenKey}`)) {
      errors[r.id] = `${b.name} is already driven by another relation.`;
      continue;
    }
    const ratio = evaluate(r.ratio);
    if (!ratio.ok) {
      errors[r.id] = `${kind.ratioLabel}: ${ratio.error}`;
      continue;
    }
    const angle = mateValues(a).values.angle ?? 0;
    const value = drivenValue(r.kind, ratio.value, angle, !!r.reverse);
    driven.add(`${b.id}:${kind.drivenKey}`);
    mates = mates.map((m) => (m.id === b.id ? { ...m, values: { ...m.values, [kind.drivenKey]: String(Math.round(value * 1e6) / 1e6) } } : m));
  }
  return { assembly: { ...assembly, mates }, driven, errors };
}

/** Next free name for a relation: "Gear 1", "Screw 2"… */
export function nextRelationName(assembly: Assembly, kind: MateRelation["kind"]): string {
  const base = RELATION_KINDS[kind].label;
  const used = new Set((assembly.relations ?? []).map((r) => r.name));
  let n = 1;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** A relation read back from a file (null if it's broken). */
export function parseRelation(raw: unknown): MateRelation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.driver !== "string" || typeof r.driven !== "string") return null;
  if (r.kind !== "gear" && r.kind !== "rack" && r.kind !== "screw") return null;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.trim() ? r.name : RELATION_KINDS[r.kind].label,
    kind: r.kind,
    driver: r.driver,
    driven: r.driven,
    ratio: typeof r.ratio === "string" ? r.ratio : typeof r.ratio === "number" ? String(r.ratio) : RELATION_KINDS[r.kind].defaultRatio,
    ...(r.reverse === true ? { reverse: true } : {}),
  };
}
