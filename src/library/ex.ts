/**
 * Sizes that are both a number and the text of the maths behind it.
 *
 * A library design works out its geometry from the design's variables
 * (box_width, box_thickness…). Every size it places is an `Ex`: the value
 * now (mm), and the expression that gives it ("box_width - box_thickness"),
 * which goes into the sketch dimension or feature box. So the part is right
 * today, and stays right when a variable is changed later.
 */
import { evaluate, type Scope } from "../model/expr";

export interface Ex {
  /** The expression, as typed into a box (variables by name). */
  t: string;
  /** What it works out as now (mm, or a plain count). */
  v: number;
}

/** Numbers as short text (no 0.30000000000000004). */
export function tidy(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A plain number. */
export const lit = (v: number): Ex => ({ t: tidy(v), v });
export const ZERO = lit(0);

/** A variable, with its value now. */
export const named = (name: string, scope: Scope): Ex => {
  const v = scope[name];
  if (v === undefined) throw new Error(`The variable ${name} isn't set.`);
  return { t: name, v };
};

const isLit = (e: Ex) => /^-?\d+(\.\d+)?(e-?\d+)?$/.test(e.t);
const isZero = (e: Ex) => isLit(e) && e.v === 0;
/** A name or a number: needs no brackets anywhere. */
const atom = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || /^\d+(\.\d+)?$/.test(t);
const wrap = (t: string) => (atom(t) ? t : `(${t})`);

export function plus(...xs: Ex[]): Ex {
  const terms = xs.filter((x) => !isZero(x));
  if (terms.length === 0) return ZERO;
  let t = terms[0].t;
  let v = terms[0].v;
  for (const x of terms.slice(1)) {
    const neg = /^-\((.*)\)$/.exec(x.t);
    t = neg ? `${t} - (${neg[1]})` : x.t.startsWith("-") ? `${t} - ${x.t.slice(1)}` : `${t} + ${x.t}`;
    v += x.v;
  }
  return { t, v };
}

export function neg(a: Ex): Ex {
  if (isZero(a)) return ZERO;
  if (isLit(a)) return lit(-a.v);
  const inner = /^-\((.*)\)$/.exec(a.t);
  if (inner) return { t: inner[1], v: -a.v };
  return { t: `-(${a.t})`, v: -a.v };
}

export function minus(a: Ex, b: Ex): Ex {
  if (isZero(b)) return a;
  if (isZero(a)) return neg(b);
  if (isLit(a) && isLit(b)) return lit(a.v - b.v);
  return { t: `${a.t} - ${wrap(b.t)}`, v: a.v - b.v };
}

/** a × k (k a plain number, or another size). */
export function times(a: Ex, k: number | Ex): Ex {
  const kk = typeof k === "number" ? lit(k) : k;
  if (isZero(a) || isZero(kk)) return ZERO;
  if (isLit(kk) && kk.v === 1) return a;
  if (isLit(a) && a.v === 1) return kk;
  if (isLit(a) && isLit(kk)) return lit(a.v * kk.v);
  // "2 * box_thickness" reads better than "box_thickness * 2".
  if (isLit(kk)) return { t: `${tidy(kk.v)} * ${wrap(a.t)}`, v: a.v * kk.v };
  return { t: `${wrap(a.t)} * ${wrap(kk.t)}`, v: a.v * kk.v };
}

/** a ÷ k (k a plain number). */
export function over(a: Ex, k: number): Ex {
  if (k === 1 || isZero(a)) return a;
  if (isLit(a)) return lit(a.v / k);
  return { t: `${wrap(a.t)} / ${tidy(k)}`, v: a.v / k };
}

/** a × i / n, written as one fraction ("box_width * 3 / 7"). */
export function fraction(a: Ex, i: number, n: number): Ex {
  if (i === 0) return ZERO;
  if (i === n) return a;
  if (isLit(a)) return lit((a.v * i) / n);
  return { t: `${wrap(a.t)} * ${i} / ${n}`, v: (a.v * i) / n };
}

/** Does the text work out to the value given (with these variables)? For tests and checks. */
export function agrees(e: Ex, scope: Scope, tolerance = 1e-6): boolean {
  const r = evaluate(e.t, scope);
  return r.ok && Math.abs(r.value - e.v) <= tolerance * Math.max(1, Math.abs(e.v));
}

/**
 * A signed distance for a dimension from the origin: which way (+1 / −1) and
 * the (positive) text. "-(box_kerf / 2)" is 1 × box_kerf / 2 the other way,
 * even while the kerf is 0.
 */
export function signed(e: Ex): { sign: 1 | -1; text: string } {
  const inner = /^-\((.*)\)$/.exec(e.t);
  if (inner && !(e.v > 1e-12)) return { sign: -1, text: inner[1] };
  if (e.v < -1e-12) return { sign: -1, text: neg(e).t };
  return { sign: 1, text: e.t };
}
