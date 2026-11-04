/**
 * A business card holder for a desk: the cards stand in a stack on a base, leaning back against a sloping back, with a
 * low lip in front. Two side panels hold the base, back and lip by tabs through slots (sidePanels.ts); the sides'
 * outline is worked out from the pieces (a margin round all of them), so it always fits whatever sizes are chosen.
 *
 * Seen side-on (x from the front to the back, z up): the base lies at z = m…m + t from x = m; the lip stands on its front
 * end; the back leans back LEAN degrees from upright, its lower front corner on the base, the stack's room behind the lip.
 */
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { assemblyFeatures, assemblyProblems, evenTabs, sectionOf, sideSlots, type CrossPiece, type SideAssembly } from "../sidePanels";
import { convexHull, offsetPolygon, r6, round6, type P2 } from "../outlines";
import { mm, num } from "./common";

/** How far the back leans from upright (degrees). */
export const LEAN = 15;
/** Room either side of the cards, between the sides (mm). */
export const CARD_ROOM = 1.5;

const rad = (d: number) => (d * Math.PI) / 180;

export interface CardStand {
  a: SideAssembly;
}

export function cardStand(v: DesignValues): CardStand {
  const [cw, ch, stack, lip, t, kerf] = ["cardWidth", "cardHeight", "stack", "lip", "thickness", "kerf"].map((k) => num(v, k));
  const m = Math.max(5, t);
  const zb = m + t;
  // The back, leaning back: along it d (upwards), across it n (forwards and up — its front face, where the cards lean).
  const backLen = r6(ch * 0.75);
  const angle = 90 - LEAN;
  const d: P2 = [Math.cos(rad(angle)), Math.sin(rad(angle))];
  const nrm: P2 = [-Math.sin(rad(angle)), Math.cos(rad(angle))];
  // Its lowest corner (the back one) rests on the base; its front face starts `stack` behind the lip.
  const lowBack: P2 = [m + t + stack + t * Math.sin(rad(angle)), zb];
  const centre: P2 = [r6(lowBack[0] + (backLen / 2) * d[0] + (t / 2) * nrm[0]), r6(lowBack[1] + (backLen / 2) * d[1] + (t / 2) * nrm[1])];
  const back: CrossPiece = { role: "back", label: "Back", centre, angle, length: backLen, tabs: evenTabs(backLen) };
  // The base reaches under the back's lower corners.
  const sec = sectionOf(back, t);
  const baseEnd = Math.max(sec[0][0], sec[3][0]) + 4;
  const baseLen = r6(baseEnd - m);
  const base: CrossPiece = { role: "base", label: "Base", centre: [r6(m + baseLen / 2), r6(m + t / 2)], angle: 0, length: baseLen, tabs: evenTabs(baseLen) };
  const lipPiece: CrossPiece = { role: "lip", label: "Lip", centre: [r6(m + t / 2), r6(zb + lip / 2)], angle: 90, length: lip, tabs: evenTabs(lip, 1) };
  const pieces = [base, lipPiece, back];
  // The sides: a margin m round every piece (the hull of their cross-sections, moved out).
  const hull = convexHull(pieces.flatMap((p) => sectionOf(p, t)));
  const side = round6(offsetPolygon(hull, m, 1.5));
  return { a: { side, pieces, width: r6(cw + 2 * CARD_ROOM), t, kerf } };
}

export function standProblems(v: DesignValues): string[] {
  const [t, kerf, lip] = ["thickness", "kerf", "lip"].map((k) => num(v, k));
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (lip < 3 * t + 3) return [`Make the lip at least ${mm(3 * t + 3)} tall, so its tabs hold.`];
  return assemblyProblems(cardStand(v).a);
}

export const cardStandDesign: LibraryDesign = {
  id: "card-stand",
  name: "Business card holder",
  group: "Boxes and stands",
  description:
    "A desk holder for a stack of business cards: they stand on a base, leaning back against a sloping back, with a low lip in front. Two sides hold the pieces with tabs through slots. Set it for any card size — 85 × 55 mm is the usual one.",
  category: "laser",
  prefix: "cardstand",
  icon: '<path d="M6 40h36M10 40V30M36 40 30 12"/><path d="M14 38V18h12" opacity=".6"/><path d="M8 40l2-12h28l4 12" opacity=".4"/>',
  inputs: [
    { key: "cardWidth", label: "Card width", kind: "length", default: 85, min: 30, max: 280, help: "The long side, standing level." },
    { key: "cardHeight", label: "Card height", kind: "length", default: 55, min: 30, max: 200 },
    { key: "stack", label: "Stack thickness", kind: "length", default: 15, min: 3, max: 60, help: "How thick a pile it holds." },
    { key: "lip", label: "Lip height", kind: "length", default: 15, min: 8, max: 60 },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger and slots this much smaller, so the tabs fit snugly." },
  ],
  problems: standProblems,
  summary: (v) => `5 pieces: 2 sides, a base, a lip and a back leaning ${LEAN}°; for cards ${mm(num(v, "cardWidth"))} wide.`,
  make: (ctx) => assemblyFeatures(ctx, cardStand(ctx.values).a),
  preview: (v) => {
    if (standProblems(v).length) return [];
    const s = cardStand(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: s.a.side }];
    for (const p of s.a.pieces) out.push({ kind: "poly", closed: true, points: sectionOf(p, s.a.t), faint: true });
    for (const q of sideSlots(s.a)) out.push({ kind: "poly", closed: true, points: q });
    out.push({ kind: "text", at: [30, -10], text: "side" });
    return out;
  },
};
