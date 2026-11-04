/**
 * A set of printed bolts, nuts and washers (M3–M12 or a custom size), with real modelled threads and a printed fit.
 * The bolts stand on their heads, so the thread prints round and clean with no supports; nuts and washers lie flat.
 */
import { lit, minus, plus, times, ZERO, type Ex } from "../ex";
import { copyFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { boltCore, grooveDepth, nutHoleDiameter, rodDiameter, roundFace, threadFeature, threadGap, threadOverlap } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { acrossCorners, coarsePitch, PRINT_SIZES, printFastener, type PrintFastener } from "./boltSizes";
import { mm, num } from "./common";

/** How long (× pitch) the plain run-out just above a threaded bolt's head is, so the thread's groove ends there clear of the head. */
export const RELIEF = 1.75;
const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** Room between the parts on the bed (mm). */
export const SET_GAP = 6;

export const fastenerOf = (v: DesignValues): PrintFastener => printFastener(String(v.size), num(v, "diameter"), num(v, "pitch"));
const countOf = (v: DesignValues, key: string) => Math.max(0, Math.round(num(v, key)));
const socketHead = (v: DesignValues) => v.head === "socket";

/** Where everything goes on the bed: a column each for bolts, nuts and washers (left to right), copies one behind another. */
export function boltSetLayout(v: DesignValues) {
  const f = fastenerOf(v);
  const counts = { bolt: countOf(v, "bolts"), nut: countOf(v, "nuts"), washer: countOf(v, "washers") };
  const widths = { bolt: socketHead(v) ? f.socket.dk : acrossCorners(f.flats), nut: acrossCorners(f.flats), washer: f.washerOd };
  const kinds = (["bolt", "nut", "washer"] as const).filter((k) => counts[k] > 0);
  const x: Record<"bolt" | "nut" | "washer", number> = { bolt: 0, nut: 0, washer: 0 };
  let at = 0;
  kinds.forEach((k, i) => {
    if (i > 0) at += widths[kinds[i - 1]] / 2 + SET_GAP + widths[k] / 2;
    x[k] = Math.round(at * 1e4) / 1e4;
  });
  const row = Math.round((Math.max(...kinds.map((k) => widths[k]), 1) + SET_GAP) * 1e4) / 1e4;
  return { f, counts, widths, x, row, kinds };
}

/** The printed sizes worked out from the values (the fit as a number): rod and nut-hole diameters and the gap between threads. */
export function boltSetSizes(v: DesignValues) {
  const f = fastenerOf(v);
  const fit = lit(num(v, "fit"));
  const threaded = v.thread === true;
  const rod = threaded ? rodDiameter(lit(f.d), f.pitch, fit) : lit(f.d);
  const hole = threaded ? nutHoleDiameter(lit(f.d), f.pitch, fit) : plus(lit(f.d), times(fit, 2));
  return { f, rod: rod.v, hole: hole.v, gap: threaded ? threadGap(rod.v, hole.v, f.pitch) : (hole.v - rod.v) / 2 };
}

/** The least a printed bolt's thread should reach into its nut's, each side (mm), so it holds. */
export const minOverlap = (pitch: number) => Math.max(0.15, 0.2 * pitch);
/** The biggest printed fit that still leaves that much overlap (the teeth overlap 0.634 × pitch − 2 × fit). */
export const maxFit = (pitch: number) => Math.floor(((boltSetOverlapAtZero(pitch) - minOverlap(pitch)) / 2) * 100) / 100;
const boltSetOverlapAtZero = (pitch: number) => threadOverlap(rodDiameter(lit(10), pitch, ZERO).v, nutHoleDiameter(lit(10), pitch, ZERO).v);

const SIZE_CHOICES = [...PRINT_SIZES.map((s) => ({ value: s, label: s })), { value: "custom", label: "Custom size" }];

export const boltSet: LibraryDesign = {
  id: "bolt-set",
  name: "Bolt, nut and washer set",
  description:
    "Printed metric bolts, nuts and washers (M3 to M12, or your own size), with real threads that screw together. The bolts stand on their heads: that way the thread prints round and clean, with no supports — lying down it would come out flat-sided and need supports under it. Nuts and washers lie flat. The printed fit is the gap between the threads, so printed bolts and nuts turn freely; 0.2 mm suits most printers. Threads finer than M6 are hard to print well — for M3 to M5 use metal screws, or turn the thread off.",
  category: "print",
  group: "Fixings",
  prefix: "bolts",
  icon: '<path d="M8 8h14v6H8zM12 14h6v26h-6z"/><path d="M12 18l6 2M12 23l6 2M12 28l6 2M12 33l6 2" opacity=".6"/><path d="M30 24l4-7h8l4 7-4 7h-8z"/><circle cx="38" cy="24" r="3"/>',
  inputs: [
    { key: "size", label: "Size", kind: "choice", default: "M8", choices: SIZE_CHOICES, help: "M8 means 8 mm across the thread." },
    { key: "diameter", label: "Custom diameter", kind: "length", default: 16, min: 3, max: 40, help: "Only for a custom size: across the thread." },
    { key: "pitch", label: "Custom pitch", kind: "length", default: 2, min: 0.35, max: 6, help: "Only for a custom size: the distance from one thread to the next. Standard: M14 and M16 2 mm, M20 2.5 mm, M24 3 mm." },
    {
      key: "head",
      label: "Bolt head",
      kind: "choice",
      default: "hex",
      choices: [
        { value: "hex", label: "Hex head (spanner)" },
        { value: "socket", label: "Socket head (Allen key)" },
      ],
    },
    { key: "length", label: "Bolt length", kind: "length", default: 25, min: 4, max: 200, variable: true, help: "Under the head." },
    { key: "thread", label: "Model the thread", kind: "toggle", default: true, help: "Off: a plain pin, and nuts with a plain hole (like a thick washer)." },
    { key: "fit", label: "Printed fit", kind: "length", default: 0.2, min: 0, max: 1, variable: true, help: "The gap between the threads (or round a plain pin). 0.2 mm suits most printers; more if they bind, less if they're loose." },
    { key: "bolts", label: "How many bolts", kind: "count", default: 1, min: 0, max: 10 },
    { key: "nuts", label: "How many nuts", kind: "count", default: 1, min: 0, max: 10 },
    { key: "washers", label: "How many washers", kind: "count", default: 1, min: 0, max: 10 },
  ],
  problems: (v) => {
    const out: string[] = [];
    const L = boltSetLayout(v);
    if (L.kinds.length === 0) out.push("Choose at least one bolt, nut or washer.");
    const s = boltSetSizes(v);
    const f = s.f;
    if (v.size === "custom" && f.pitch > f.d / 3) out.push(`A ${mm(f.pitch)} pitch is too coarse for a ${mm(f.d)} bolt: use at most ${mm(f.d / 3)} (the standard is about ${mm(coarsePitch(f.d))}).`);
    else if (v.thread === true && boltCore(s.rod, f.pitch) < 1.5) out.push(`The bolt's thread would leave too thin a core: make the printed fit smaller, or choose a bigger size.`);
    else if (v.thread === true && threadOverlap(s.rod, s.hole) < minOverlap(f.pitch)) {
      out.push(`With a ${mm(num(v, "fit"))} printed fit an ${f.name} thread would hardly catch: make the fit at most ${mm(Math.max(0, maxFit(f.pitch)))}, choose a bigger size, or turn the thread off.`);
    }
    if (L.counts.bolt > 0 && v.thread === true && num(v, "length") < (RELIEF + 2) * f.pitch + 1) out.push(`A threaded bolt must be at least ${mm((RELIEF + 2) * f.pitch + 1)} long.`);
    if (L.counts.washer > 0 && f.washerHole >= f.washerOd - 1.6) out.push("The washer's ring would be too thin to print.");
    return out;
  },
  summary: (v) => {
    const L = boltSetLayout(v);
    const s = boltSetSizes(v);
    const parts = [
      L.counts.bolt ? `${L.counts.bolt} bolt${L.counts.bolt > 1 ? "s" : ""}` : "",
      L.counts.nut ? `${L.counts.nut} nut${L.counts.nut > 1 ? "s" : ""}` : "",
      L.counts.washer ? `${L.counts.washer} washer${L.counts.washer > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    const fine = v.thread === true && s.f.d < 6 ? " Threads this fine are hard to print — check the first one before printing a batch." : "";
    const thread = v.thread === true ? `${s.f.name} × ${s.f.pitch} thread; a printed bolt is ${mm(s.rod)} across its thread and turns in a printed nut with ${mm(s.gap)} to spare, the threads overlapping by ${mm(threadOverlap(s.rod, s.hole))}.` : `Plain pins ${mm(s.rod)} across in holes ${mm(s.hole)} across.`;
    return `${parts.join(", ")}. ${thread}${fine}`;
  },
  make: (ctx) => {
    const v = ctx.values;
    const { length, fit } = ctx.vars;
    const L = boltSetLayout(v);
    const f = L.f;
    const threaded = v.thread === true;
    const top = { kind: "default", name: "Top" } as const;
    const features: Feature[] = [];
    const partNames: Record<string, string> = {};
    const copies = (role: string, label: string, partId: string, n: number) => {
      partNames[partId] = `${ctx.name} ${role}`;
      for (let i = 1; i < n; i++) {
        const id = ctx.id(`${role}-${i + 1}`);
        features.push(copyFeature(id, `${label} ${i + 1}`, partId, { dy: lit(L.row * i) }));
        partNames[id] = `${ctx.name} ${role} ${i + 1}`;
      }
    };
    const hex = (x: number, flats: number) => ({ type: "polygon", center: [String(x), "0"], sides: 6, diameter: String(flats), across: "flats" });
    const circle = (x: number, d: Ex) => ({ type: "circle", center: [String(x), "0"], diameter: d.t });

    if (L.counts.bolt > 0) {
      const id = ctx.id("bolt");
      const socket = socketHead(v);
      const k = socket ? f.socket.k : f.head;
      const rod = threaded ? rodDiameter(lit(f.d), f.pitch, fit) : lit(f.d);
      const relief = RELIEF * f.pitch;
      features.push(
        // Standing on its head. The rod first, all the way down to the bed …
        sketchFeature(ctx.id("bolt-rod-sketch"), "Bolt rod sketch", top, shapesSketch([circle(0, rod)], ctx.scope)),
        extrudeFeature(id, "Bolt rod", ctx.id("bolt-rod-sketch"), { depth: plus(lit(k), length), operation: "new" }),
      );
      if (threaded) {
        // … then just above the head it's turned down to the thread's root, so the thread can run out there without
        // cutting into the head …
        features.push(
          sketchFeature(ctx.id("bolt-relief-sketch"), "Bolt thread run-out sketch", top, shapesSketch([circle(0, plus(rod, lit(2))), circle(0, minus(rod, lit(six(2 * grooveDepth(f.pitch)))))], ctx.scope)),
          extrudeFeature(ctx.id("bolt-relief"), "Bolt thread run-out", ctx.id("bolt-relief-sketch"), { depth: lit(six(k + relief)), operation: "remove" }),
        );
      }
      // … and the head (its top on the bed) put back round it.
      features.push(
        sketchFeature(ctx.id("bolt-head-sketch"), "Bolt head sketch", top, shapesSketch([socket ? circle(0, lit(f.socket.dk)) : hex(0, f.flats)], ctx.scope)),
        extrudeFeature(ctx.id("bolt-head"), "Bolt head", ctx.id("bolt-head-sketch"), { depth: lit(k), operation: "add" }),
      );
      if (socket) {
        features.push(
          sketchFeature(ctx.id("bolt-socket-sketch"), "Bolt socket sketch", top, shapesSketch([hex(0, f.socket.s)], ctx.scope)),
          extrudeFeature(ctx.id("bolt-socket"), "Bolt socket", ctx.id("bolt-socket-sketch"), { depth: lit(f.socket.t), operation: "remove" }),
        );
      }
      if (threaded) {
        // The whole threaded length (it runs out into the run-out and past the end).
        const lo = k + relief;
        const mid = (lo + k + length.v) / 2;
        features.push(threadFeature(ctx.id("bolt-thread"), "Bolt thread", roundFace(id, [0, 0, mid], [0.5, 0.5, mid / (k + length.v)]), f.pitch, ZERO));
      }
      copies("bolt", "Bolt", id, L.counts.bolt);
    }
    if (L.counts.nut > 0) {
      const id = ctx.id("nut");
      const hole = threaded ? nutHoleDiameter(lit(f.d), f.pitch, fit) : plus(lit(f.d), times(fit, 2));
      features.push(
        sketchFeature(ctx.id("nut-sketch"), "Nut sketch", top, shapesSketch([hex(L.x.nut, f.flats), circle(L.x.nut, hole)], ctx.scope)),
        extrudeFeature(id, "Nut", ctx.id("nut-sketch"), { depth: lit(f.nut), operation: "new" }),
      );
      if (threaded) features.push(threadFeature(ctx.id("nut-thread"), "Nut thread", roundFace(id, [L.x.nut, 0, f.nut / 2], [0.5, 0.5, 0.5]), f.pitch, ZERO));
      copies("nut", "Nut", id, L.counts.nut);
    }
    if (L.counts.washer > 0) {
      const id = ctx.id("washer");
      features.push(
        sketchFeature(ctx.id("washer-sketch"), "Washer sketch", top, shapesSketch([circle(L.x.washer, lit(f.washerOd)), circle(L.x.washer, lit(f.washerHole))], ctx.scope)),
        extrudeFeature(id, "Washer", ctx.id("washer-sketch"), { depth: lit(f.washerThickness), operation: "new" }),
      );
      copies("washer", "Washer", id, L.counts.washer);
    }
    return { features, partNames };
  },
  preview: (v) => {
    const L = boltSetLayout(v);
    const s = boltSetSizes(v);
    const f = L.f;
    const out: PreviewShape[] = [];
    const hexPts = (x: number, y: number, flats: number): [number, number][] =>
      Array.from({ length: 6 }, (_, i) => [x + (flats / Math.sqrt(3)) * Math.cos((Math.PI / 3) * i), y + (flats / Math.sqrt(3)) * Math.sin((Math.PI / 3) * i)]);
    for (let i = 0; i < L.counts.bolt; i++) {
      const y = i * L.row;
      if (socketHead(v)) out.push({ kind: "circle", c: [0, y], r: f.socket.dk / 2 });
      else out.push({ kind: "poly", closed: true, points: hexPts(0, y, f.flats) });
      out.push({ kind: "circle", c: [0, y], r: s.rod / 2, faint: true });
    }
    for (let i = 0; i < L.counts.nut; i++) out.push({ kind: "poly", closed: true, points: hexPts(L.x.nut, i * L.row, f.flats) }, { kind: "circle", c: [L.x.nut, i * L.row], r: s.hole / 2 });
    for (let i = 0; i < L.counts.washer; i++) out.push({ kind: "circle", c: [L.x.washer, i * L.row], r: f.washerOd / 2 }, { kind: "circle", c: [L.x.washer, i * L.row], r: f.washerHole / 2 });
    const below = -Math.max(...L.kinds.map((k) => L.widths[k]), 1) / 2 - f.d * 0.6;
    const label = { bolt: `bolt, ${mm(num(v, "length"))}`, nut: "nut", washer: "washer" };
    for (const k of L.kinds) out.push({ kind: "text", at: [L.x[k], below], text: label[k] });
    return out;
  },
};
