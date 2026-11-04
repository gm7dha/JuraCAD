/**
 * export_for_laser: true-size outlines for a laser cutter (SVG for Bambu
 * Studio's laser mode, or DXF), with the app's own code — the engine reads the
 * faces (GeometryEngine.laserOutlines), src/laser lays them out and writes the file.
 */
import { layerCounts, layoutPieces, LASER_LAYERS, LAYER_ORDER, type LaserPiece } from "../laser/laser";
import { laserDxf, laserSvg } from "../laser/laserFiles";
import { laserDefaultsFor } from "../library/insert";
import { outlinePiece, partFacing, sketchPiece, uniqueSources, type LaserSource } from "../laser/sources";
import type { PartMesh } from "../kernel/protocol";
import { followedSketch } from "../sketch/areaClicks";
import { bool, InputError, list, noExtras, object, oneOf, text, type Obj } from "./args";
import { pickFace, PICK_HELP } from "./picks";
import type { Session } from "./session";
import { checkFree, fileNameFor, needFolder, r2, say, writeOut, type ToolDef } from "./toolKit";

function numberIn(v: unknown, where: string, fallback: number, min: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new InputError(`${where}: give a number of millimetres, at least ${min}.`);
  return v;
}

const COUNTED = { outer: "outer cut", inner: "inner cut", score: "score line", engrave: "engraved area" } as const;

export const LASER_TOOLS: ToolDef[] = [
  {
    name: "export_for_laser",
    title: "Export outlines for a laser cutter",
    description:
      'Save true-size 2D outlines (mm) for a laser cutter to the JuraCAD folder: "svg" (default; opens in Bambu Studio\'s laser mode at true size) or "dxf". Choose ONE source: "faces" (flat faces, [{"part": "Part 1", "face": "top"}] — curved faces are refused), "parts" (part names: each part\'s biggest flat face, so a flat panel gives its outline; a sheet metal part gives its flat pattern), "sketch" (a sketch\'s closed shapes, lines and text), or "flat_pattern" (a sheet metal part). With none, every part. Several pieces are laid out side by side ("gap", default 5 mm; rows up to "width", default 600 mm). Layers by colour: outer cuts red #FF0000 (CUT_OUTER), inner cuts/holes blue #0000FF (CUT_INNER), scores/bend lines green #00FF00 (SCORE), engraving black filled (ENGRAVE). Circles and arcs stay exact; splines are cubic curves in the SVG. Options: "mirror" (flip, for engraving the back), "bend_lines" (flat patterns, default true), for sketches "text" ("engrave" default, or "cut"), "shapes" ("cut" default, or "engrave"), "open_lines" ("cut" default, or "score") and "background" (true: engrave everything inside the outline except the letters and shapes, for a rubber stamp; a library stamp\'s sketch does this by itself).',
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["svg", "dxf"] },
        faces: { type: "array", items: { type: "object", properties: { part: { type: "string" }, face: { type: "string" } }, required: ["face"] }, description: `Flat faces to cut round. ${PICK_HELP.faces}` },
        parts: { type: "array", items: { type: "string" } },
        sketch: { type: "string" },
        flat_pattern: { type: "string" },
        mirror: { type: "boolean" },
        gap: { type: "number" },
        width: { type: "number" },
        bend_lines: { type: "boolean" },
        text: { type: "string", enum: ["engrave", "cut"] },
        shapes: { type: "string", enum: ["cut", "engrave"] },
        open_lines: { type: "string", enum: ["cut", "score"] },
        background: { type: "boolean", description: "Sketches: engrave the background (everything inside the outline but the letters and shapes), as for a rubber stamp. A library stamp's sketch does this by itself." },
        filename: { type: "string" },
        overwrite: { type: "boolean" },
      },
    },
    run: async (s, a) => {
      noExtras(a, ["format", "faces", "parts", "sketch", "flat_pattern", "mirror", "gap", "width", "bend_lines", "text", "shapes", "open_lines", "background", "filename", "overwrite"], "export_for_laser");
      const folder = needFolder(s);
      const format = oneOf(a.format, ["svg", "dxf"] as const, "format", "svg");
      const given = ["faces", "parts", "sketch", "flat_pattern"].filter((k) => a[k] !== undefined);
      if (given.length > 1) throw new InputError(`Give just one of "faces", "parts", "sketch" or "flat_pattern" (you gave ${given.map((g) => `"${g}"`).join(" and ")}).`);
      const pieces = await laserPieces(s, a);
      if (!pieces.pieces.some((p) => p.paths.length)) throw new InputError(`There's nothing to cut there.${pieces.problems.length ? ` ${pieces.problems.join(" ")}` : ""}`);
      const sheet = layoutPieces(pieces.pieces, { gap: numberIn(a.gap, "gap", 5, 0), width: numberIn(a.width, "width", 600, 10), mirror: bool(a.mirror, "mirror") });
      const names = [...new Set(pieces.pieces.map((p) => p.name))];
      const path = folder.pathFor(a.filename === undefined ? fileNameFor(names.length === 1 ? names[0] : `${s.doc.name} laser`) : text(a.filename, "filename"), [`.${format}`], "file");
      checkFree(s, path, a.overwrite);
      await s.checkpoint();
      writeOut(s, path, format === "svg" ? laserSvg(sheet, { title: names.join(", ") }) : laserDxf(sheet));
      const counts = layerCounts(sheet);
      return say(
        `Saved ${path}: ${r2(sheet.size[0])} × ${r2(sheet.size[1])} mm overall, ${pieces.pieces.length} piece${pieces.pieces.length === 1 ? "" : "s"}${bool(a.mirror, "mirror") ? ", mirrored" : ""}.`,
        `Lines: ${LAYER_ORDER.filter((l) => counts[l]).map((l) => `${counts[l]} ${COUNTED[l]}${counts[l] === 1 ? "" : "s"} (${LASER_LAYERS[l].colour}, ${LASER_LAYERS[l].dxf})`).join(", ")}.`,
        pieces.problems.length > 0 && `Left out: ${pieces.problems.join(" ")}`,
        format === "dxf" && counts.engrave > 0 && "In the DXF the engraved areas are outlines only (layer ENGRAVE): the laser program must be told to fill them.",
        "In Bambu Studio's laser mode, import the file and give each colour its own setting: red and blue cut through (blue first), green scores, black engraves.",
      );
    },
  },
];

/** The pieces a call asks for (and plain-English reasons for any left out). */
async function laserPieces(s: Session, a: Obj): Promise<{ pieces: LaserPiece[]; problems: string[] }> {
  if (a.sketch !== undefined) {
    const f = s.feature(a.sketch, "sketch", ["sketch"]);
    // A sketch made by a library design (a rubber stamp…) comes with the settings it's meant for.
    const d = laserDefaultsFor(s.doc, f.id);
    const opts = {
      text: oneOf(a.text, ["engrave", "cut"] as const, "text", d?.text ?? "engrave"),
      shapes: oneOf(a.shapes, ["cut", "engrave"] as const, "shapes", d?.shapes ?? "cut"),
      open: oneOf(a.open_lines, ["cut", "score"] as const, "open_lines", d?.open ?? "cut"),
      background: a.background === undefined ? d?.background === true : bool(a.background, "background"),
    };
    // A sketch on a part's face is where the engine moved it to (as the app shows it).
    const data = followedSketch(f, s.build().links ?? {})?.data ?? f.sketch!.data;
    return { pieces: [sketchPiece(f.name, data, opts)], problems: [] };
  }
  const b = s.build();
  const facing = (p: PartMesh) => partFacing(p.featureIds, s.doc.features, (sk) => followedSketch(sk, b.links ?? {})?.plane ?? null);
  const whole = (p: PartMesh): LaserSource => {
    if (p.flat) return { kind: "flat", partId: p.id };
    const toward = facing(p);
    return toward ? { kind: "part", partId: p.id, toward } : { kind: "part", partId: p.id };
  };
  if (!b.parts.length) throw new InputError("There are no parts yet. Give a \"sketch\" to cut, or make a part first.");
  const sources: LaserSource[] = [];
  if (a.faces !== undefined) {
    list(a.faces, "faces").forEach((item, i) => {
      const o = object(item, `faces[${i}]`);
      const part = s.part(b.parts, o.part, `faces[${i}].part`);
      const face = pickFace(part, o.face, `faces[${i}].face`);
      sources.push({ kind: "face", pick: { partId: part.id, ref: face.ref } });
    });
  } else if (a.flat_pattern !== undefined) {
    sources.push({ kind: "flat", partId: s.part(b.parts, a.flat_pattern, "flat_pattern").id });
  } else {
    const chosen = a.parts !== undefined ? list(a.parts, "parts").map((p, i) => s.part(b.parts, p, `parts[${i}]`)) : b.parts.filter((p) => !p.surface);
    for (const p of chosen) sources.push(whole(p));
  }
  await s.checkpoint();
  const outlines = s.withEngine((e) => e.laserOutlines(uniqueSources(sources)));
  const bends = bool(a.bend_lines, "bend_lines", true);
  return {
    pieces: outlines.flatMap((o) => (o.ok ? [outlinePiece(o, { bends })] : [])),
    problems: outlines.flatMap((o) => (o.ok ? [] : [o.error])),
  };
}
