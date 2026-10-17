/**
 * Mate relations (Onshape's Gear, Rack and pinion, Screw and Linear
 * relations): one mate's movement drives another's.
 *  - Gear: two hinges turn together, the second by `ratio` times the first's angle (the other way round, as meshing gears do).
 *  - Rack and pinion: a hinge (the pinion) drives a slider (the rack); `ratio` is the pinion's radius (mm).
 *  - Screw: a hinge drives a slider by `ratio` mm per turn (the thread's lead).
 *  - Linear: a slider drives another slider, `ratio` times as far (a pulley, a lever, a pantograph).
 * Set `reverse` to run the driven mate the other way. A relation can drive a
 * mate that drives another (a gear train): they're worked out in that order.
 */
import { evaluate } from "../model/expr";
import type { Assembly, Mate, MateRelation } from "../model/types";
import { MATE_TYPES, mateValues } from "./mates";

type Key = "angle" | "distance";

export const RELATION_KINDS: Record<
  MateRelation["kind"],
  { label: string; ratioLabel: string; ratioUnit: string; defaultRatio: string; driverKey: Key; drivenKey: Key; hint: string }
> = {
  gear: { label: "Gear", ratioLabel: "Ratio", ratioUnit: "×", defaultRatio: "1", driverKey: "angle", drivenKey: "angle", hint: "Two hinges turning together, like meshing gears." },
  rack: { label: "Rack and pinion", ratioLabel: "Pinion radius", ratioUnit: "mm", defaultRatio: "10", driverKey: "angle", drivenKey: "distance", hint: "A hinge (the gear) drives a slider (the rack)." },
  screw: { label: "Screw", ratioLabel: "Travel per turn", ratioUnit: "mm", defaultRatio: "1", driverKey: "angle", drivenKey: "distance", hint: "A hinge (the screw) drives a slider (the nut)." },
  linear: { label: "Linear", ratioLabel: "Ratio", ratioUnit: "×", defaultRatio: "1", driverKey: "distance", drivenKey: "distance", hint: "One slider drives another, a set number of times as far (like a pulley or lever)." },
};

export const RELATION_KIND_NAMES = Object.keys(RELATION_KINDS) as MateRelation["kind"][];

const moves = (m: Mate, key: Key) => MATE_TYPES[m.type].values.some((d) => d.key === key && d.free);

/** Can this mate drive this kind of relation (it turns, or for Linear, slides)? */
export function canDrive(m: Mate, kind: MateRelation["kind"] = "gear"): boolean {
  return moves(m, RELATION_KINDS[kind].driverKey);
}
export function canBeDriven(m: Mate, kind: MateRelation["kind"]): boolean {
  return moves(m, RELATION_KINDS[kind].drivenKey);
}

/** The driven amount for a driver's amount (degrees, or mm for Linear). */
export function drivenValue(kind: MateRelation["kind"], ratio: number, amount: number, reverse: boolean): number {
  const sign = reverse ? -1 : 1;
  if (kind === "gear") return -sign * ratio * amount;
  if (kind === "rack") return sign * ratio * ((amount * Math.PI) / 180);
  if (kind === "linear") return sign * ratio * amount;
  return sign * ratio * (amount / 360);
}

/**
 * The assembly with each relation's driven amount worked out from its driver,
 * which amounts are now driven (so loops leave them alone: "mateId:key"), and
 * any relations that can't work. A relation whose driver is itself driven
 * waits for that one first, whatever order they were made in.
 */
export function applyRelations(assembly: Assembly): { assembly: Assembly; driven: Set<string>; errors: Record<string, string> } {
  const relations = assembly.relations ?? [];
  const errors: Record<string, string> = {};
  const driven = new Set<string>();
  if (!relations.length) return { assembly, driven, errors };
  let mates = assembly.mates ?? [];
  const byId = (id: string) => mates.find((m) => m.id === id);
  // Check each relation first; the good ones are worked out below.
  const ok: MateRelation[] = [];
  const ratios = new Map<string, number>();
  const claimed = new Set<string>();
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
    if (!canDrive(a, r.kind)) {
      errors[r.id] = r.kind === "linear" ? `${a.name} doesn't slide, so it can't drive this. Use a Slider (or Cylindrical) mate.` : `${a.name} doesn't turn, so it can't drive this. Use a Hinge (or Cylindrical) mate.`;
      continue;
    }
    if (!canBeDriven(b, r.kind)) {
      errors[r.id] = r.kind === "gear" ? `${b.name} doesn't turn. A gear relation joins two hinges.` : `${b.name} doesn't slide. Use a Slider (or Cylindrical) mate.`;
      continue;
    }
    if (claimed.has(`${b.id}:${kind.drivenKey}`)) {
      errors[r.id] = `${b.name} is already driven by another relation.`;
      continue;
    }
    const ratio = evaluate(r.ratio);
    if (!ratio.ok) {
      errors[r.id] = `${kind.ratioLabel}: ${ratio.error}`;
      continue;
    }
    claimed.add(`${b.id}:${kind.drivenKey}`);
    ratios.set(r.id, ratio.value);
    ok.push(r);
  }
  // Work them out drivers first: a relation waits while its driver's amount is still to be set by another.
  let pending = ok;
  while (pending.length) {
    const waiting = new Set(pending.map((r) => `${r.driven}:${RELATION_KINDS[r.kind].drivenKey}`));
    const ready = pending.filter((r) => !waiting.has(`${r.driver}:${RELATION_KINDS[r.kind].driverKey}`));
    if (!ready.length) {
      for (const r of pending) errors[r.id] = "These relations drive each other round in a circle. Remove one of them.";
      break;
    }
    for (const r of ready) {
      const kind = RELATION_KINDS[r.kind];
      const amount = mateValues(byId(r.driver)!).values[kind.driverKey] ?? 0;
      const value = drivenValue(r.kind, ratios.get(r.id)!, amount, !!r.reverse);
      driven.add(`${r.driven}:${kind.drivenKey}`);
      mates = mates.map((m) => (m.id === r.driven ? { ...m, values: { ...m.values, [kind.drivenKey]: String(Math.round(value * 1e6) / 1e6) } } : m));
    }
    pending = pending.filter((r) => !ready.includes(r));
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
  if (r.kind !== "gear" && r.kind !== "rack" && r.kind !== "screw" && r.kind !== "linear") return null;
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
