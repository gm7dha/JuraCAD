/**
 * Checking what Claude sends to the JuraCAD tools, with plain-English
 * messages that say what was wrong and how to put it right.
 */
import { evaluate, type Scope } from "../model/expr";

/** A problem with a tool's input: the message is shown to Claude as it is. */
export class InputError extends Error {}

export type Obj = Record<string, unknown>;

/** A size or position as given: a number, or maths/a variable as text ("w / 2", "1 in"). */
export interface Amount {
  value: number;
  /** As it's stored in the design (so the app shows what was typed). */
  text: string;
}

export function object(v: unknown, where: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError(`${where} should be an object like {"type": …}.`);
  return v as Obj;
}

/** Turn "12.0000000001" into "12" so saved designs stay tidy. */
export function tidy(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

/** The largest size or position accepted (mm): bigger is almost always a units mistake, and slow to build. */
export const MAX_LENGTH = 10_000;

export function amount(v: unknown, where: string, scope: Scope, opts: { positive?: boolean; min?: number; integer?: boolean; unit?: string } = {}): Amount {
  const unit = opts.unit ?? "mm";
  let a: Amount;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new InputError(`${where} must be a real number.`);
    a = { value: v, text: tidy(v) };
  } else if (typeof v === "string" && v.trim()) {
    const r = evaluate(v, scope);
    if (!r.ok) throw new InputError(`${where}: "${v}" can't be worked out (${r.error}). Give a number${unit === "mm" ? " in millimetres" : ""}, e.g. 10.`);
    a = { value: r.value, text: v.trim() };
  } else {
    throw new InputError(`${where} is missing: give a number${unit === "mm" ? " in millimetres" : unit === "°" ? " of degrees" : ""}, e.g. ${unit === "°" ? 90 : 10}.`);
  }
  if (unit === "mm" && Math.abs(a.value) > MAX_LENGTH) throw new InputError(`${where} is ${tidy(a.value)} mm — too big. Sizes and positions here are in millimetres and can be at most ${MAX_LENGTH} mm (10 m).`);
  if (opts.integer && !Number.isInteger(a.value)) throw new InputError(`${where} must be a whole number (got ${a.value}).`);
  if (opts.positive && !(a.value > 0)) throw new InputError(`${where} must be more than 0 (got ${tidy(a.value)}).`);
  if (opts.min !== undefined && a.value < opts.min) throw new InputError(`${where} must be at least ${opts.min} (got ${tidy(a.value)}).`);
  return a;
}

export function optionalAmount(v: unknown, where: string, scope: Scope, opts: Parameters<typeof amount>[3] = {}): Amount | undefined {
  return v === undefined || v === null ? undefined : amount(v, where, scope, opts);
}

/** A 2D point [x, y]. */
export function xy(v: unknown, where: string, scope: Scope): [Amount, Amount] {
  if (!Array.isArray(v) || v.length !== 2) throw new InputError(`${where} should be a point [x, y] in millimetres, e.g. [10, 5].`);
  return [amount(v[0], `${where}[0] (x)`, scope), amount(v[1], `${where}[1] (y)`, scope)];
}

/** A 3D point [x, y, z]. */
export function xyz(v: unknown, where: string, scope: Scope): [Amount, Amount, Amount] {
  if (!Array.isArray(v) || v.length !== 3) throw new InputError(`${where} should be a point [x, y, z] in millimetres, e.g. [0, 0, 10].`);
  return [amount(v[0], `${where}[0] (x)`, scope), amount(v[1], `${where}[1] (y)`, scope), amount(v[2], `${where}[2] (z)`, scope)];
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string, fallback?: T): T {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v === "string") {
    const hit = allowed.find((a) => a.toLowerCase() === v.trim().toLowerCase());
    if (hit) return hit;
  }
  const shown = v === undefined ? "nothing" : JSON.stringify(v);
  throw new InputError(`${where} must be one of ${allowed.map((a) => `"${a}"`).join(", ")} (got ${shown}).`);
}

export function bool(v: unknown, where: string, fallback = false): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  throw new InputError(`${where} must be true or false.`);
}

export function text(v: unknown, where: string, fallback?: string): string {
  if ((v === undefined || v === null || v === "") && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !v.trim()) throw new InputError(`${where} should be some text.`);
  return v.trim();
}

export function list(v: unknown, where: string, opts: { allowEmpty?: boolean } = {}): unknown[] {
  if (v === undefined || v === null) {
    if (opts.allowEmpty) return [];
    throw new InputError(`${where} is missing: give a list.`);
  }
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length && !opts.allowEmpty) throw new InputError(`${where} is empty: give at least one.`);
  return arr;
}

/** Complain about keys the tool doesn't know (usually a typo), naming the ones it does. */
export function noExtras(o: Obj, known: readonly string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !known.includes(k));
  if (extra.length) {
    throw new InputError(`${where}: ${extra.map((k) => `"${k}"`).join(", ")} ${extra.length > 1 ? "aren't settings" : "isn't a setting"} here. The settings are: ${known.join(", ")}.`);
  }
}
