/**
 * Reading assembly features' and Edit in context's parts of a file, kept in a
 * small module of its own (document.ts reads files and mustn't pull in the
 * assembly solver). See assemblyFeatures.ts and inContext.ts.
 */
import { parsePlacement } from "./math";
import type { ContextPart, EditContext, Feature, FeatureType, JuraCADDocument } from "../model/types";
import type { ContextInput } from "../kernel/protocol";

/** The kinds of feature an assembly can hold: sketches, and what cuts with them. */
export const ASSEMBLY_FEATURE_TYPES: readonly FeatureType[] = ["sketch", "extrude", "revolve", "hole"];

/** Kinds that cut parts (the others are sketches). */
export const ASSEMBLY_CUT_TYPES: readonly FeatureType[] = ["extrude", "revolve", "hole"];

/** Whether a feature is one an assembly can hold (and cut with). */
export function isAssemblyFeature(f: Pick<Feature, "type" | "operation">): boolean {
  if (!ASSEMBLY_FEATURE_TYPES.includes(f.type)) return false;
  return f.type === "sketch" || f.type === "hole" || f.operation === "remove";
}

/** Read `featureParts` from a file: only lists of strings, for features that exist. */
export function parseFeatureParts(raw: unknown, features: readonly Feature[]): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const ids = new Set(features.map((f) => f.id));
  const out: Record<string, string[]> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id) || !Array.isArray(v)) continue;
    out[id] = v.filter((x): x is string => typeof x === "string").slice(0, 500);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Read contexts from a file (bad entries dropped). */
export function parseContexts(raw: unknown): EditContext[] {
  if (!Array.isArray(raw)) return [];
  const out: EditContext[] = [];
  for (const x of raw) {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || r.id.includes(":") || out.some((c) => c.id === r.id)) continue;
    if (typeof r.studioId !== "string" || typeof r.assemblyId !== "string" || typeof r.instance !== "string") continue;
    const parts: ContextPart[] = [];
    for (const y of Array.isArray(r.parts) ? r.parts : []) {
      const p = (y ?? {}) as Record<string, unknown>;
      if (typeof p.key !== "string" || typeof p.partId !== "string" || typeof p.studioId !== "string") continue;
      parts.push({
        key: p.key,
        partId: p.partId,
        studioId: p.studioId,
        name: typeof p.name === "string" ? p.name.slice(0, 200) : "Part",
        placement: parsePlacement(p.placement),
        ...(p.mirrored === true ? { mirrored: true } : {}),
      });
    }
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 200) : "Context",
      studioId: r.studioId,
      assemblyId: r.assemblyId,
      instance: r.instance,
      parts,
      ...(r.hidden === true ? { hidden: true } : {}),
    });
  }
  return out;
}

/** The id a context's part has in the Part Studio it's shown in. */
export const contextPartId = (contextId: string, key: string): string => `ctx:${contextId}:${key}`;

/** The engine's view of one Part Studio's contexts (undefined when it has none, so older designs build exactly as before). */
export function contextInputs(doc: Pick<JuraCADDocument, "contexts">, studioId: string): ContextInput[] | undefined {
  const list = (doc.contexts ?? []).filter((c) => c.studioId === studioId);
  if (!list.length) return undefined;
  return list.map((c) => ({
    id: c.id,
    parts: c.parts.map((p) => ({ id: contextPartId(c.id, p.key), partId: p.partId, studioId: p.studioId, placement: p.placement, ...(p.mirrored ? { mirrored: true } : {}) })),
  }));
}
