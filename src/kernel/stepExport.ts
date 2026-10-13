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

export interface StepPart {
  shape: Shape3D;
  name: string;
  /** "#rrggbb" */
  colour: string;
}

/** Screen (sRGB) value 0–1 → linear light 0–1. */
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function writeStep(parts: StepPart[]): Uint8Array {
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
    parts.forEach((p, i) => {
      const label = shapes.NewShape();
      shapes.SetShape(label, p.shape.wrapped);
      oc.TDataStd_Name.Set(label, text(p.name || `Part ${i + 1}`));
      const [r, g, b] = colourToRgb(p.colour).map(srgbToLinear);
      colours.SetColor(label, keep(new oc.Quantity_ColorRGBA(r, g, b, 1)), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
    });
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
    const file = "partsmith-export.step";
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
