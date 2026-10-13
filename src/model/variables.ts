/**
 * Variables: named sizes such as `wall = 2` that can be typed into any box,
 * sketch dimension or other variable. Change the value once and everything
 * that uses it updates.
 */
import { solveSketch } from "../sketch/solver";
import { evaluate, namesIn, RESERVED_NAMES, setCurrentScope, type Scope } from "./expr";
import type { PartSmithDocument } from "./types";

export interface Variable {
  /** Permanent ID (so renames can be followed). */
  id: string;
  name: string;
  /** What was typed, e.g. "2", "wall * 2", "1/4 in". */
  value: string;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Problem with a variable name, or null if it's fine. */
export function checkName(name: string, otherNames: string[]): string | null {
  if (!name) return "Give it a name";
  if (!NAME_PATTERN.test(name)) return "Use letters, numbers and _ only, starting with a letter (e.g. wall_2)";
  if (RESERVED_NAMES.has(name.toLowerCase())) return `"${name}" is a unit or constant — choose another name`;
  if (otherNames.includes(name)) return "Another variable already has this name";
  return null;
}

export interface ResolvedVariables {
  /** Values in mm by name (only the ones that worked out). */
  values: Record<string, number>;
  /** Problems by variable id. */
  errors: Record<string, string>;
}

/** Work out every variable's value, top to bottom: each can use the ones above it. */
export function resolveVariables(variables: readonly Variable[] = []): ResolvedVariables {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const seen: string[] = [];
  for (const v of variables) {
    const nameError = checkName(v.name, seen);
    seen.push(v.name);
    if (nameError) {
      errors[v.id] = nameError;
      continue;
    }
    const later = variables.slice(variables.indexOf(v) + 1).map((x) => x.name);
    if (namesIn(v.value).includes(v.name)) {
      errors[v.id] = "A variable can't use itself";
      continue;
    }
    const r = evaluate(v.value, values);
    if (!r.ok) {
      const forward = namesIn(v.value).find((n) => later.includes(n) && !(n in values));
      errors[v.id] = forward ? `"${forward}" is further down the list — move it above this one` : r.error;
      continue;
    }
    values[v.name] = r.value;
  }
  return { values, errors };
}

/** Replace a whole-word variable name in an expression (leaves "2 in" and longer names alone). */
export function renameInExpression(src: string, from: string, to: string): string {
  if (!from || from === to) return src;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return src.replace(new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_])`, "g"), to);
}

/** Every expression in the document, with a way to replace it. */
function mapExpressions(doc: PartSmithDocument, fn: (src: string) => string): PartSmithDocument {
  return {
    ...doc,
    features: doc.features.map((f) => {
      const params = Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, fn(v)]));
      const changedParams = Object.keys(params).some((k) => params[k] !== f.params[k]);
      let sketch = f.sketch;
      if (sketch) {
        const constraints = sketch.data.constraints.map((c) => (c.value === undefined ? c : { ...c, value: fn(c.value) }));
        const before = sketch.data.constraints;
        if (constraints.some((c, i) => c.value !== before[i].value)) {
          sketch = { ...sketch, data: { ...sketch.data, constraints } };
        }
      }
      return changedParams || sketch !== f.sketch ? { ...f, params: changedParams ? params : f.params, sketch } : f;
    }),
  };
}

/** How many boxes and dimensions use a variable. */
export function usageCount(doc: PartSmithDocument, name: string): number {
  let n = 0;
  mapExpressions(doc, (src) => {
    if (namesIn(src).includes(name)) n++;
    return src;
  });
  return n;
}

/**
 * Store a new list of variables in the document: names that changed are
 * renamed wherever they're used, and sketches whose dimensions use variables
 * are re-solved so their shapes match the new values.
 */
export function applyVariables(doc: PartSmithDocument, variables: Variable[]): PartSmithDocument {
  let next: PartSmithDocument = { ...doc, variables };
  for (const v of variables) {
    const old = doc.variables?.find((o) => o.id === v.id);
    if (old && old.name !== v.name) next = mapExpressions(next, (src) => renameInExpression(src, old.name, v.name));
  }
  const { values } = resolveVariables(variables);
  setCurrentScope(values);
  return resolveSketches(next, values);
}

/** Re-solve every sketch whose dimensions use variables, with these values. */
export function resolveSketches(doc: PartSmithDocument, values: Scope): PartSmithDocument {
  setCurrentScope(values);
  return {
    ...doc,
    features: doc.features.map((f) => {
      if (!f.sketch) return f;
      const usesNames = f.sketch.data.constraints.some((c) => c.value !== undefined && namesIn(c.value).length > 0);
      if (!usesNames) return f;
      const r = solveSketch(f.sketch.data);
      return r.ok ? { ...f, sketch: { ...f.sketch, data: r.sketch } } : f;
    }),
  };
}

/** Plain list from untrusted JSON. */
export function parseVariables(raw: unknown): Variable[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .filter((v) => typeof v.id === "string" && typeof v.name === "string" && (typeof v.value === "string" || typeof v.value === "number"))
    .map((v) => ({ id: v.id as string, name: v.name as string, value: String(v.value) }));
}
