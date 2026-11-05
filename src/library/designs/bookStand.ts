/**
 * A tablet or cookbook stand: the book or tablet stands on a ledge behind a low lip, leaning back against a sloping
 * back rest. Two side panels hold the base, lip and back rest by tabs through slots (sidePanels.ts); the sides' outline
 * is a margin round all the pieces (so it always fits), and the base runs back under the top of the back rest so the
 * stand can't tip over backwards.
 *
 * Seen side-on (x from the front to the back, z up): the base lies at z = m…m + t from x = m; the lip stands on its
 * front end; the back rest leans back `lean` degrees from upright, its lower back corner on the base, its front face
 * `ledge` behind the lip (room for the book or tablet's thickness).
 */
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { assemblyFeatures, assemblyProblems, evenTabs, sectionOf, sideSlots, type CrossPiece, type SideAssembly } from "../sidePanels";
import { convexHull, offsetPolygon, r6, round6, type P2 } from "../outlines";
import { mm, num } from "./common";

const rad = (d: number) => (d * Math.PI) / 180;

export interface BookStand {
  a: SideAssembly;
  /** The back rest's front face, where the book leans: its foot (x, z) and direction up it. */
  restFoot: P2;
  restDir: P2;
}

export function bookStand(v: DesignValues): BookStand {
  const [width, lean, backLen, ledge, lip, t, kerf] = ["width", "lean", "back", "ledge", "lip", "thickness", "kerf"].map((k) => num(v, k));
  const m = Math.max(5, t);
  const zb = m + t;
  const angle = 90 - lean;
  const d: P2 = [Math.cos(rad(angle)), Math.sin(rad(angle))];
  const nrm: P2 = [-Math.sin(rad(angle)), Math.cos(rad(angle))];
  // The back rest's lowest corner (its back one) rests on the base; its front face starts `ledge` behind the lip.
  const lowBack: P2 = [m + t + ledge + t * Math.sin(rad(angle)), zb];
  const centre: P2 = [r6(lowBack[0] + (backLen / 2) * d[0] + (t / 2) * nrm[0]), r6(lowBack[1] + (backLen / 2) * d[1] + (t / 2) * nrm[1])];
  const rest: CrossPiece = { role: "back", label: "Back rest", centre, angle, length: r6(backLen), tabs: evenTabs(backLen) };
  // The base reaches back under the top of the back rest (so it can't tip), and at least under its foot.
  const sec = sectionOf(rest, t);
  const baseEnd = Math.max(...sec.map((p) => p[0])) + 4;
  const baseLen = r6(baseEnd - m);
  const base: CrossPiece = { role: "base", label: "Base", centre: [r6(m + baseLen / 2), r6(m + t / 2)], angle: 0, length: baseLen, tabs: evenTabs(baseLen) };
  const lipPiece: CrossPiece = { role: "lip", label: "Lip", centre: [r6(m + t / 2), r6(zb + lip / 2)], angle: 90, length: lip, tabs: evenTabs(lip, 1) };
  const pieces = [base, lipPiece, rest];
  const hull = convexHull(pieces.flatMap((p) => sectionOf(p, t)));
  const side = round6(offsetPolygon(hull, m, 1.5));
  // The rest's front face starts at its lower front corner: the back corner moved across it by t.
  const foot: P2 = [r6(lowBack[0] + t * nrm[0]), r6(lowBack[1] + t * nrm[1])];
  return { a: { side, pieces, width, t, kerf }, restFoot: foot, restDir: [r6(d[0]), r6(d[1])] };
}

export function bookStandProblems(v: DesignValues): string[] {
  const [t, kerf, lip] = ["thickness", "kerf", "lip"].map((k) => num(v, k));
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (lip < 3 * t + 3) return [`Make the lip at least ${mm(3 * t + 3)} tall, so its tabs hold.`];
  return assemblyProblems(bookStand(v).a, { back: "back rest" });
}

export const bookStandDesign: LibraryDesign = {
  id: "book-stand",
  name: "Tablet or book stand",
  group: "Desk",
  description:
    "A slot-together stand for a tablet, a cookbook or sheet music: it stands on a ledge behind a low lip and leans back against a sloping back rest at the angle you choose. Two sides hold the pieces with tabs through slots, and the base runs back under the rest so it won't tip over.",
  category: "laser",
  prefix: "bookstand",
  icon: '<path d="M6 42h36M10 42V34M36 42 28 8"/><path d="M12 34l18-24" opacity=".6"/><path d="M8 42l2-10h4l24-24 4 34" opacity=".4"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 140, min: 40, max: 280, help: "Between the sides. It can be narrower than the tablet or book: they overhang." },
    { key: "lean", label: "Lean back", kind: "count", default: 20, min: 5, max: 45, help: "Degrees from upright: 15–25° suits reading and watching." },
    { key: "back", label: "Back rest height", kind: "length", default: 150, min: 40, max: 280, help: "Along its slope." },
    { key: "ledge", label: "Ledge depth", kind: "length", default: 20, min: 5, max: 80, help: "Room for the tablet's or book's thickness, between the lip and the back rest." },
    { key: "lip", label: "Lip height", kind: "length", default: 18, min: 8, max: 60 },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger and slots this much smaller, so the tabs fit snugly." },
  ],
  problems: bookStandProblems,
  summary: (v) => `5 pieces: 2 sides, a base, a lip and a back rest leaning ${num(v, "lean")}° from upright; ${mm(num(v, "width") + 2 * num(v, "thickness"))} wide.`,
  make: (ctx) => assemblyFeatures(ctx, bookStand(ctx.values).a),
  preview: (v) => {
    if (bookStandProblems(v).length) return [];
    const s = bookStand(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: s.a.side }];
    for (const p of s.a.pieces) out.push({ kind: "poly", closed: true, points: sectionOf(p, s.a.t), faint: true });
    for (const q of sideSlots(s.a)) out.push({ kind: "poly", closed: true, points: q });
    out.push({ kind: "text", at: [40, -10], text: "side" });
    return out;
  },
};
