/**
 * STEP export with part names and exact colours.
 *
 * replicad's own exportSTEP hands colours to OpenCascade as plain 0–1 numbers,
 * but OpenCascade treats those as "linear light" and brightens them when
 * writing, so orange came out pale. Here the colour is converted first, so the
 * file holds the same colour that is shown on screen.
 */
import { getOC, type Shape3D } from "replicad";

import { colourToRgb } from "../model/colours";
import type { StepComponent, StepTree } from "./protocol";

export interface StepPart {
  shape: Shape3D;
  name: string;
  /** "#rrggbb" */
  colour: string;
}

/** Screen (sRGB) value 0–1 → linear light 0–1. */
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** An XCAF document to fill in (names, colours, assembly structure), written out as STEP; everything made is freed. */
function writeXcaf(fill: (x: Xcaf) => void): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const toDelete: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(o: T): T => {
    toDelete.push(o);
    return o;
  };
  const text = (s: string) => keep(new oc.TCollection_ExtendedString(s, true));
  try {
    const doc = keep(new oc.TDocStd_Document(text("XmlOcaf")));
    oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
    const main = doc.Main();
    const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(main);
    const colours = oc.XCAFDoc_DocumentTool.ColorTool(main);
    fill({ oc, shapes, keep, name: (label, s) => oc.TDataStd_Name.Set(label, text(s)), colour: (label, c) => {
      const [r, g, b] = colourToRgb(c).map(srgbToLinear);
      colours.SetColor(label, keep(new oc.Quantity_ColorRGBA(r, g, b, 1)), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
    } });
    shapes.UpdateAssemblies();

    oc.Interface_Static.SetCVal("xstep.cascade.unit", "MM");
    oc.Interface_Static.SetCVal("write.step.unit", "MM");
    const session = keep(new oc.XSControl_WorkSession());
    const writer = keep(new oc.STEPCAFControl_Writer(session, false));
    writer.SetColorMode(true);
    writer.SetLayerMode(true);
    writer.SetNameMode(true);
    oc.Interface_Static.SetIVal("write.surfacecurve.mode", 1);
    oc.Interface_Static.SetIVal("write.precision.mode", 0);
    oc.Interface_Static.SetIVal("write.step.assembly", 2);
    oc.Interface_Static.SetIVal("write.step.schema", 5);
    const file = "juracad-export.step";
    const progress = keep(new oc.Message_ProgressRange());
    if (!writer.Perform(doc, file, progress)) throw new Error("The STEP file couldn't be written.");
    const bytes = new Uint8Array(oc.FS.readFile("/" + file));
    oc.FS.unlink("/" + file);
    return bytes;
  } finally {
    for (const o of toDelete.reverse()) {
      try {
        o.delete();
      } catch {
        /* already gone */
      }
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Xcaf {
  oc: any;
  shapes: any;
  keep: <T extends { delete(): void }>(o: T) => T;
  name: (label: any, name: string) => void;
  colour: (label: any, colour: string) => void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Parts side by side, each a named, coloured solid (a Part Studio's parts, or an assembly's copies already placed). */
export function writeStep(parts: StepPart[]): Uint8Array {
  return writeXcaf(({ shapes, name, colour }) => {
    parts.forEach((p, i) => {
      const label = shapes.NewShape();
      shapes.SetShape(label, p.shape.wrapped);
      name(label, p.name || `Part ${i + 1}`);
      colour(label, p.colour);
    });
  });
}

/** A part definition for a structured STEP file: its shape where the part itself sits (not moved into the assembly). */
export interface StepPartShape {
  shape: Shape3D;
  colour: string;
}

/**
 * An assembly with its structure kept: every part written once, as a shared
 * definition (with its name and colour); every assembly and sub-assembly a
 * product whose components point at those definitions, each named after its
 * instance and placed by a move and turn (a location, never a copy of the shape).
 */
export function writeStepAssembly(tree: StepTree, shapeOf: (partKey: string) => StepPartShape | null): Uint8Array {
  return writeXcaf(({ oc, shapes, keep, name, colour }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const products = new Map<string, any>();
    const partLabel = (key: string) => {
      if (parts.has(key)) return parts.get(key);
      const def = tree.parts[key];
      const shape = def ? shapeOf(key) : null;
      let label = null;
      if (def && shape) {
        label = shapes.NewShape();
        shapes.SetShape(label, shape.shape.wrapped);
        name(label, def.name);
        colour(label, shape.colour);
      }
      parts.set(key, label);
      return label;
    };
    const assemblyLabel = (key: string, within: string[]) => {
      if (products.has(key)) return products.get(key);
      const def = tree.assemblies[key];
      if (!def || within.includes(key)) return null;
      const children = def.components
        .map((c) => ({ c, label: c.part ? partLabel(c.part) : c.assembly ? assemblyLabel(c.assembly, [...within, key]) : null }))
        .filter((x) => x.label);
      if (!children.length) {
        products.set(key, null);
        return null;
      }
      const label = shapes.NewShape();
      name(label, def.name);
      for (const { c, label: child } of children) {
        const component = shapes.AddComponent(label, child, keep(new oc.TopLoc_Location(locationOf(oc, keep, c))));
        name(component, c.name);
      }
      products.set(key, label);
      return label;
    };
    if (!assemblyLabel(tree.root, [])) throw new Error("There's nothing in this assembly to export yet.");
  });
}

/** A component's move and turn as OpenCascade's transformation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function locationOf(oc: any, keep: Xcaf["keep"], c: StepComponent) {
  const [x, y, z, w] = c.rotation;
  const n = Math.hypot(x, y, z, w) || 1;
  const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n];
  const t = keep(new oc.gp_Trsf());
  const [px, py, pz] = c.position;
  t.SetValues(
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), px,
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), py,
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy), pz,
  );
  return t;
}
