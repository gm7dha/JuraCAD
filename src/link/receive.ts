/**
 * A design sent from JuraCUT (src/link/juraLink.ts) as a new sketch: its DXF outlines brought in at full size (the same
 * way as a sketch's Insert DXF), on the Top plane, at the end of a Part Studio — the one on show, or a new one when an
 * assembly or drawing is on show. Pure.
 */
import { newId } from "../model/document";
import { addStudio, inStudio, renameStudio, studioFeatures } from "../model/studios";
import type { Feature, JuraCADDocument } from "../model/types";
import { sketchFeature } from "../library/sketchKit";
import { DxfError, insertDxf, insertSummary, MAX_DXF_SIZE, parseDxf } from "../sketch/dxf";

export interface LinkedSketch {
  doc: JuraCADDocument;
  studioId: string;
  featureId: string;
  /** What came in, in plain words. */
  summary: string;
}

/** A feature name not yet used in the Part Studio: "From JuraCUT: Tag", then "From JuraCUT: Tag (2)"… */
function freeName(features: readonly Feature[], name: string): string {
  const used = new Set(features.map((f) => f.name));
  if (!used.has(name)) return name;
  for (let i = 2; ; i++) if (!used.has(`${name} (${i})`)) return `${name} (${i})`;
}

/** Throws a plain-English `DxfError` when the drawing can't be used. */
export function sketchFromDxf(doc: JuraCADDocument, into: string | "new", name: string, dxf: string): LinkedSketch {
  if (dxf.length > MAX_DXF_SIZE) throw new DxfError("That design is too big to bring in (over 20 MB).");
  const drawing = parseDxf(dxf);
  const r = insertDxf({ points: [], curves: [], constraints: [] }, drawing, 1);
  if (r.error) throw new DxfError(r.error);
  if (!r.count) throw new DxfError("That design has no lines or shapes to bring in.");
  const title = `From JuraCUT: ${name.trim() || "design"}`.slice(0, 120);
  let next = doc;
  let studioId = into;
  if (into === "new") {
    studioId = newId("s");
    next = renameStudio(addStudio(next, studioId), studioId, title);
  }
  const featureId = newId("f");
  const feature = sketchFeature(featureId, freeName(studioFeatures(next, studioId), title), { kind: "default", name: "Top" }, r.sketch);
  next = inStudio(next, studioId, (view) => ({ ...view, features: [...view.features, feature] }));
  return { doc: next, studioId, featureId, summary: insertSummary(drawing, r.count, 1) };
}
