/**
 * A box for a deck of cards (playing cards, tarot, a card game), sized from the cards and how thick the deck is: an
 * open-topped finger-joint box (the finger box's maths, fingers.ts) with a thumb notch in the top of the front and
 * back, so the cards can be pinched out, and a lift-off lid — a plate on top with a smaller plate glued under it that
 * drops just inside the walls, so it stays put.
 *
 * Inside: the cards' width and height and the deck's thickness, each with `clearance` round them. Outside: W = card
 * width + 2c + 2t, D = deck + 2c + 2t, H = card height + c + t (+ t more with the lid, for the plate under it).
 */
import { lit, minus, over, plus, times, ZERO, type Ex } from "../ex";
import { boxProblems, fingerCounts, panelOutlines, type BoxSizes, type PanelName, type Pt } from "../fingers";
import { copyFeature, extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import type { SketchPlane } from "../../sketch/planes";
import { mm, num, varsOf } from "./common";

const VARS = ["cardWidth", "cardHeight", "deck", "clearance", "thickness", "kerf"];
/** Room round the lid's under-plate inside the walls (mm, each side). */
export const LID_ROOM = 0.25;

const PLANES: Record<PanelName, SketchPlane> = {
  bottom: { kind: "default", name: "Top" },
  front: { kind: "default", name: "Front" },
  left: { kind: "default", name: "Right" },
};
const LABEL: Record<PanelName, string> = { bottom: "Bottom", front: "Front", left: "Left end" };

export interface DeckBox {
  b: BoxSizes;
  notch: Ex;
  lid: boolean;
}

export function deckBox(values: DesignValues, vars: Record<string, Ex> = varsOf(values, VARS)): DeckBox {
  const { cardWidth, cardHeight, deck, clearance: c, thickness: t, kerf } = vars;
  const notch = lit(num(values, "notch"));
  const lid = values.lid !== false;
  const two = (e: Ex) => times(e, 2);
  return {
    b: {
      W: plus(cardWidth, two(c), two(t)),
      D: plus(deck, two(c), two(t)),
      H: plus(cardHeight, c, lid ? two(t) : t),
      t,
      kerf,
      lid: false,
      finger: num(values, "finger"),
    },
    notch,
    lid,
  };
}

/** The lid's top plate and the plate under it (true sizes, centred on the box): x0, y0, x1, y1. */
export function deckLid(d: DeckBox): { top: [Ex, Ex, Ex, Ex]; under: [Ex, Ex, Ex, Ex] } {
  const { W, D, t } = d.b;
  const room = plus(t, lit(LID_ROOM));
  return { top: [ZERO, ZERO, W, D], under: [room, room, minus(W, room), minus(D, room)] };
}

function deckProblems(v: DesignValues): string[] {
  const d = deckBox(v);
  const out = boxProblems(d.b);
  if (out.length) return out;
  const [W, H, t] = [d.b.W.v, d.b.H.v, d.b.t.v];
  const r = d.notch.v / 2;
  if (r > 0 && 2 * r > W - 4 * t - 4) out.push(`The thumb notch is too wide for the box: at most ${mm(Math.floor(W - 4 * t - 4))}.`);
  if (r > 0 && r > H / 2) out.push("The thumb notch is too deep for the box: make it smaller.");
  return out;
}

const rect = (x0: Ex, y0: Ex, x1: Ex, y1: Ex): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

export const deckBoxDesign: LibraryDesign = {
  id: "deck-box",
  name: "Card deck box",
  group: "Boxes and stands",
  description:
    "A finger-joint box for a deck of playing cards, tarot cards or a card game, sized from the cards and how thick the deck is. A thumb notch in the front and back lets you pinch the cards out, and the lift-off lid has a plate under it that drops inside the walls so it stays on. Shown put together.",
  category: "laser",
  prefix: "deck",
  icon: '<path d="M10 10h28v32H10z"/><path d="M19 10a5 5 0 0 0 10 0" /><path d="M14 16h20v22H14z" opacity=".5"/><path d="M8 6h32v4H8z" opacity=".7"/>',
  inputs: [
    { key: "cardWidth", label: "Card width", kind: "length", default: 63, min: 20, max: 250, variable: true, help: "Playing cards are 63 × 88 mm; bridge 57 × 89; tarot 70 × 120." },
    { key: "cardHeight", label: "Card height", kind: "length", default: 88, min: 20, max: 250, variable: true },
    { key: "deck", label: "Deck thickness", kind: "length", default: 18, min: 3, max: 200, variable: true, help: "Measure the stack: a deck of 54 cards is about 17–19 mm (more in sleeves)." },
    { key: "clearance", label: "Room round the cards", kind: "length", default: 1, min: 0, max: 5, variable: true, help: "Each side, so the deck slides in and out." },
    { key: "notch", label: "Thumb notch", kind: "length", default: 24, min: 0, max: 100, help: "How wide the round notch is at the top of the front and back; 0 for none." },
    { key: "lid", label: "Lid", kind: "toggle", default: true, help: "A lift-off lid. Off: an open box." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1, max: 10, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "finger", label: "Finger width", kind: "length", default: 8, min: 2, max: 100, help: "Roughly — each edge gets an odd number of equal fingers that fit exactly." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, variable: true, help: "How much your laser burns away (often 0.1–0.2 mm). Panels are drawn this much bigger so the fingers fit snugly." },
  ],
  problems: deckProblems,
  summary: (v) => {
    const d = deckBox(v);
    const n = fingerCounts(d.b);
    return `${d.lid ? 7 : 5} pieces, ${mm(d.b.W.v)} × ${mm(d.b.D.v)} × ${mm(d.b.H.v)} outside; ${n.width} fingers along the front, ${n.height} up the corners.`;
  },
  make: (ctx) => {
    const d = deckBox(ctx.values, ctx.vars);
    const { W, D, H, t } = d.b;
    const k2 = over(d.b.kerf, 2);
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const name = (role: string, label: string) => (partNames[ctx.id(role)] = `${ctx.name} ${label.toLowerCase()}`);
    for (const p of panelOutlines(d.b)) {
      const sk = ctx.id(`${p.name}-sketch`);
      features.push(sketchFeature(sk, `${LABEL[p.name]} sketch`, PLANES[p.name], outlineSketch(p.outline, ctx.scope)));
      features.push(extrudeFeature(ctx.id(p.name), LABEL[p.name], sk, { depth: t, operation: "new", flip: p.name === "front" }));
      name(p.name, LABEL[p.name]);
      if (p.name === "front" && d.notch.v > 0) {
        // The notch: a circle centred on the top edge, cut from the front (the latest part) before it's copied to the back.
        // Drawn kerf smaller across, so it comes out its true size.
        const circle = shapesSketch([{ type: "circle", center: [over(W, 2).t, H.t], diameter: minus(d.notch, d.b.kerf).t }], ctx.scope);
        features.push(sketchFeature(ctx.id("notch-sketch"), "Thumb notch sketch", PLANES.front, circle));
        features.push(extrudeFeature(ctx.id("notch"), "Thumb notch", ctx.id("notch-sketch"), { depth: t, operation: "remove", flip: true }));
      }
      if (p.name === "bottom") continue;
      const [copy, label, move] = p.name === "front" ? ["back", "Back", { dy: minus(D, t) }] : ["right", "Right end", { dx: minus(W, t) }];
      features.push(copyFeature(ctx.id(copy), label, ctx.id(p.name), move));
      name(copy, label);
    }
    if (d.lid) {
      const l = deckLid(d);
      const grown = (r: [Ex, Ex, Ex, Ex]) => rect(minus(r[0], k2), minus(r[1], k2), plus(r[2], k2), plus(r[3], k2));
      features.push(
        sketchFeature(ctx.id("lid-sketch"), "Lid sketch", PLANES.bottom, outlineSketch(grown(l.top), ctx.scope)),
        extrudeFeature(ctx.id("lid"), "Lid", ctx.id("lid-sketch"), { depth: t, operation: "new" }),
        moveFeature(ctx.id("lid-move"), "Lid on the box", ctx.id("lid"), { dz: H }),
        sketchFeature(ctx.id("lid-under-sketch"), "Lid under-plate sketch", PLANES.bottom, outlineSketch(grown(l.under), ctx.scope)),
        extrudeFeature(ctx.id("lid-under"), "Lid under-plate", ctx.id("lid-under-sketch"), { depth: t, operation: "new" }),
        moveFeature(ctx.id("lid-under-move"), "Lid under-plate in place", ctx.id("lid-under"), { dz: minus(H, t) }),
      );
      name("lid", "Lid");
      name("lid-under", "Lid under-plate");
    }
    return { features, partNames };
  },
  preview: (v) => {
    if (deckProblems(v).length) return [];
    const d = deckBox(v);
    const panels = panelOutlines(d.b);
    const flat = (p: Pt[]) => p.map(([x, y]) => [x.v, y.v] as [number, number]);
    const gap = 8;
    const out: PreviewShape[] = [];
    const front = panels.find((p) => p.name === "front")!;
    const left = panels.find((p) => p.name === "left")!;
    const bottom = panels.find((p) => p.name === "bottom")!;
    const [W, D, H] = [d.b.W.v, d.b.D.v, d.b.H.v];
    for (const [i, label] of ["front", "back"].entries()) {
      const dx = i * (W + gap);
      out.push({ kind: "poly", closed: true, points: flat(front.nominal).map(([x, y]) => [x + dx, y]) });
      if (d.notch.v > 0) out.push({ kind: "circle", c: [dx + W / 2, H], r: d.notch.v / 2, faint: true });
      out.push({ kind: "text", at: [dx + W / 2, H / 2], text: label });
    }
    const x0 = 2 * (W + gap);
    for (const [i, label] of ["end", "end"].entries()) out.push({ kind: "poly", closed: true, points: flat(left.nominal).map(([x, y]) => [x + x0 + i * (D + gap), y]) }, { kind: "text", at: [x0 + i * (D + gap) + D / 2, -6], text: label });
    out.push({ kind: "poly", closed: true, points: flat(bottom.nominal).map(([x, y]) => [x, y - D - gap]) }, { kind: "text", at: [W / 2, -D / 2 - gap], text: "bottom" });
    if (d.lid) {
      const l = deckLid(d);
      for (const [i, r] of [l.top, l.under].entries()) {
        const dx = (i + 1) * (W + gap);
        out.push({ kind: "poly", closed: true, points: flat(rect(...r)).map(([x, y]) => [x + dx, y - D - gap]) });
      }
      out.push({ kind: "text", at: [W * 1.5 + gap, -D / 2 - gap], text: "lid" });
    }
    return out;
  },
};

/** For tests: the pieces' volumes at kerf 0 (mm³) — the box's walls and bottom, and the lid's two plates. */
export function deckVolume(v: DesignValues): { box: number; lid: number } {
  const d = deckBox(v);
  const [W, D, H, t] = [d.b.W.v, d.b.D.v, d.b.H.v, d.b.t.v];
  const r = d.notch.v / 2;
  const box = W * D * H - (W - 2 * t) * (D - 2 * t) * (H - t) - (r > 0 ? 2 * t * (Math.PI * r * r) / 2 : 0);
  const u = W - 2 * t - 2 * LID_ROOM;
  const w = D - 2 * t - 2 * LID_ROOM;
  return { box, lid: d.lid ? t * (W * D + u * w) : 0 };
}
