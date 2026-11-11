/**
 * The fit check (src/assembly/fits.ts), pure: how a measured pair is read as an
 * overlap or a gap, how marked press and clearance fits are judged and worded,
 * which printed fit a gap is like, and fits saved in files.
 */
import { describe, expect, it } from "vitest";

import { assemblyReport, DEFAULT_CLASH_OPTIONS, judgeContacts, parseClashOptions } from "../src/assembly/assemblyCheck";
import { parseAssemblies } from "../src/assembly/assembly";
import { defaultFitRange, FIT_EXPLAINED, fitFor, fitRangeFor, judgeFits, judgeIntended, matePair, MAX_FIT_RANGE, measuredFit, pairKey, parseFits, printFitHint, printFitsFrom, putFit, removeFit, tidyFits } from "../src/assembly/fits";
import { removeInstances, withoutInstances } from "../src/assembly/assembly";
import type { ContactMeasure } from "../src/kernel/protocol";
import { DEFAULT_FITS } from "../src/model/printSettings";
import type { Assembly, IntendedFit } from "../src/model/types";

const ID = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
const asm: Assembly = {
  id: "a",
  name: "A",
  instances: [
    { id: "i1", partId: "plate", name: "Plate <1>", placement: ID, fixed: true },
    { id: "i2", partId: "pin", name: "Pin <1>", placement: ID, fixed: false },
  ],
};
const solvedOk = { placements: {}, mateErrors: {}, drivenBy: {} };
const names = { plate: "Plate", pin: "Pin" };
const press = (min: number, max: number): IntendedFit => ({ id: "f1", a: "i1", b: "i2", kind: "press", min, max });
const clearance = (min: number, max: number): IntendedFit => ({ id: "f1", a: "i2", b: "i1", kind: "clearance", min, max });

/** A ⌀10 pin in a hole `radial` mm bigger all round (negative: the pin is bigger), 10 long. */
function pinMeasure(radial: number): ContactMeasure {
  const base: ContactMeasure = { a: "Plate <1>", b: "Pin <1>", ids: ["i1", "i2"], ring: { radial, diameter: 10 } };
  if (radial >= 0) return { ...base, volume: 0, area: 0, gap: radial };
  const t = -radial;
  const v = Math.PI * (5 * 5 - (5 - t) * (5 - t)) * 10;
  return { ...base, volume: v, area: 2 * Math.PI * 10 * (10 - t) + 2 * Math.PI * (25 - (5 - t) ** 2), boxMin: 10 };
}
const nameOf = (k: string) => ({ i1: "Plate <1>", i2: "Pin <1>" })[k];

describe("measured fits", () => {
  it("reads a pin bigger than its hole as an overlap on the diameter", () => {
    const f = measuredFit(pinMeasure(-0.05))!;
    expect(f.kind).toBe("overlap");
    expect(f.round).toBe(true);
    expect(f.side).toBeCloseTo(0.05, 9);
    expect(f.amount).toBeCloseTo(0.1, 9);
  });
  it("reads a pin smaller than its hole as a gap all round", () => {
    const f = measuredFit(pinMeasure(0.1))!;
    expect(f).toMatchObject({ kind: "gap", round: true, diameter: 10 });
    expect(f.amount).toBeCloseTo(0.2, 9);
  });
  it("estimates flat overlaps and takes flat gaps as they are", () => {
    // A 10 × 10 × 0.2 slab.
    const slab = measuredFit({ a: "A", b: "B", volume: 20, area: 208 })!;
    expect(slab).toMatchObject({ kind: "overlap", round: false });
    expect(slab.side).toBeCloseTo(0.192, 3);
    expect(measuredFit({ a: "A", b: "B", volume: 0, gap: 0.3 })).toMatchObject({ kind: "gap", side: 0.3, amount: 0.3, round: false });
    expect(measuredFit({ a: "A", b: "B", surfaceA: true, area: 4 })).toBeNull();
    expect(measuredFit({ a: "A", b: "B", volume: 0 })).toBeNull();
  });
});

describe("judging marked fits", () => {
  const n: [string, string] = ["Plate <1>", "Pin <1>"];
  it("says a press fit in its range is OK", () => {
    const f = judgeIntended(press(0.05, 0.15), n, measuredFit(pinMeasure(-0.04)), 0.01);
    expect(f.level).toBe("ok");
    expect(f.text).toBe("Plate <1> and Pin <1>: press fit OK — 0.08 mm on the diameter (0.04 mm a side) of interference (wanted 0.05–0.15 mm on the diameter).");
  });
  it("warns when a press fit is too tight, too loose, a gap or not touching", () => {
    expect(judgeIntended(press(0.05, 0.15), n, measuredFit(pinMeasure(-0.1)), 0.01).text).toMatch(/too tight — 0.2 mm on the diameter/);
    expect(judgeIntended(press(0.05, 0.15), n, measuredFit(pinMeasure(-0.01)), 0.01).text).toMatch(/too loose — only 0.02 mm/);
    const gap = judgeIntended(press(0.05, 0.15), n, measuredFit(pinMeasure(0.1)), 0.01);
    expect(gap.level).toBe("warn");
    expect(gap.text).toMatch(/gap of 0.2 mm on the diameter \(0.1 mm a side\) instead of an overlap — it won't grip/);
    expect(judgeIntended(press(0.05, 0.15), n, null, 0.01).text).toMatch(/don't touch \(more than 1 mm apart\)/);
  });
  it("judges clearance fits", () => {
    expect(judgeIntended(clearance(0.2, 0.4), n, measuredFit(pinMeasure(0.15)), 0.01)).toMatchObject({ level: "ok" });
    expect(judgeIntended(clearance(0.2, 0.4), n, measuredFit(pinMeasure(0.05)), 0.01).text).toMatch(/too tight — a gap of only 0.1 mm/);
    expect(judgeIntended(clearance(0.2, 0.4), n, measuredFit(pinMeasure(0.3)), 0.01).text).toMatch(/too loose/);
    expect(judgeIntended(clearance(0.2, 0.4), n, measuredFit(pinMeasure(-0.05)), 0.01).text).toMatch(/meant to have a gap, but they overlap by 0.1 mm on the diameter/);
  });
});

describe("printed fits", () => {
  it("names the printer's fit a gap is closest to", () => {
    expect(printFitHint(0.3, DEFAULT_FITS)).toBe("about a sliding fit for your printer (0.3 mm)");
    expect(printFitHint(0.12, DEFAULT_FITS)).toBe("about a press fit for your printer (0.1 mm)");
    expect(printFitHint(0.42, DEFAULT_FITS)).toBe("about a loose fit for your printer (0.5 mm)");
    expect(printFitHint(0.02, DEFAULT_FITS)).toMatch(/^tighter than your printer's press fit \(0.1 mm\)/);
    expect(printFitHint(0.8, DEFAULT_FITS)).toMatch(/^looser than your printer's loose fit/);
    // Follows the printer's own numbers.
    expect(printFitHint(0.3, { ...DEFAULT_FITS, sliding: 0.4, snug: 0.3 })).toBe("about a snug fit for your printer (0.3 mm)");
  });
});

describe("the Fits section", () => {
  it("lists unmarked clearances with the printed fit, and points overlaps to Clashes", () => {
    const r = judgeFits({ measured: [pinMeasure(0.15)], intended: [], tolerance: 0.01, printFits: DEFAULT_FITS, nameOf });
    expect(r.findings[0].text).toBe(FIT_EXPLAINED);
    expect(r.findings[1].text).toBe("Plate <1> and Pin <1>: a gap of 0.3 mm on the diameter (0.15 mm a side) round the pin — about a sliding fit for your printer (0.3 mm).");
    expect(r.findings[1].pair).toMatchObject({ a: "i1", b: "i2" });
    expect(r.warnings).toBe(0);
    const o = judgeFits({ measured: [pinMeasure(-0.05)], intended: [], tolerance: 0.01, nameOf });
    expect(o.handled.size).toBe(0);
    expect(o.findings[1].text).toMatch(/listed under Clashes/);
    // Flat faces that touch aren't clearances; nothing close says so.
    const none = judgeFits({ measured: [{ a: "A", b: "B", volume: 0, gap: 0 }], intended: [], tolerance: 0.01, nameOf });
    expect(none.findings[1].text).toMatch(/No parts sit close together/);
  });

  it("takes a marked press fit out of the clashes and judges it", () => {
    const measured = [pinMeasure(-0.05)];
    const fits = judgeFits({ measured, intended: [press(0.05, 0.15)], tolerance: 0.01, printFits: DEFAULT_FITS, nameOf });
    expect(fits.handled.has(pairKey("i1", "i2"))).toBe(true);
    const contacts = judgeContacts(measured, DEFAULT_CLASH_OPTIONS);
    expect(contacts).toHaveLength(1);
    const report = assemblyReport(asm, solvedOk, names, contacts, DEFAULT_CLASH_OPTIONS, {}, [], fits);
    expect(report.level).toBe("ok");
    expect(report.parts.map((p) => p.name)).toEqual(["Mates", "Clashes", "Fits"]);
    expect(report.parts[1].findings[0].text).toBe("No parts overlap");
    expect(report.parts[2].findings[1].text).toMatch(/press fit OK — 0.1 mm on the diameter/);
  });

  it("keeps an unmarked overlap a clash, with how deep it goes", () => {
    const contacts = judgeContacts([pinMeasure(-0.05)], DEFAULT_CLASH_OPTIONS);
    const report = assemblyReport(asm, solvedOk, names, contacts);
    expect(report.parts[1].findings[0].text).toMatch(/^Plate <1> and Pin <1> overlap by 15.6 mm³ \(the pin is 0.1 mm too big on the diameter, 0.05 mm a side\) — they'd be in each other's way.$/);
    // A flat one is "about".
    const flat = judgeContacts([{ a: "A", b: "B", volume: 20, area: 208 }], DEFAULT_CLASH_OPTIONS);
    expect(assemblyReport(asm, solvedOk, names, flat).parts[1].findings[0].text).toMatch(/overlap by 20 mm³ \(about 0.192 mm deep\)/);
  });

  it("puts fits to look at in the headline", () => {
    const fits = judgeFits({ measured: [pinMeasure(0.1)], intended: [press(0.05, 0.15)], tolerance: 0.01, nameOf });
    const report = assemblyReport(asm, solvedOk, names, [], DEFAULT_CLASH_OPTIONS, {}, [], fits);
    expect(report.level).toBe("warn");
    expect(report.headline).toBe("1 fit to look at — not as tight or loose as marked.");
    // A marked part that's gone isn't judged.
    const gone = judgeFits({ measured: [], intended: [{ ...press(0.05, 0.15), b: "i9" }], tolerance: 0.01, nameOf });
    expect(gone.warnings).toBe(0);
    expect(gone.findings[1].text).toMatch(/wasn't checked/);
    // …but it can still be changed or taken away from the Check window.
    expect(gone.findings[1].pair).toMatchObject({ a: "i1", b: "i9", fit: { id: "f1" } });
  });
});

describe("saving fits", () => {
  it("adds, replaces and removes fits by pair", () => {
    let a = putFit(asm, press(0.05, 0.15));
    a = putFit(a, { ...clearance(0.2, 0.4), id: "f2" });
    expect(a.fits).toHaveLength(1);
    expect(fitFor(a, "i1", "i2")?.kind).toBe("clearance");
    expect(removeFit(a, "f2").fits).toBeUndefined();
    expect(removeFit(a, "nope")).toBe(a);
  });
  it("reads them back carefully, and old files have none", () => {
    expect(parseFits([press(0.05, 0.15), { ...press(0.2, 0.1), id: "bad" }, { ...press(0, 1), a: "gone" }, { ...press(0, 1), id: "dup" }, { id: "k", a: "i1", b: "i2/x", kind: "snug", min: 0, max: 1 }], new Set(["i1", "i2"]))).toEqual([press(0.05, 0.15)]);
    const [back] = parseAssemblies(JSON.parse(JSON.stringify([putFit(asm, press(0.05, 0.15))])));
    expect(back.fits).toEqual([press(0.05, 0.15)]);
    expect("fits" in parseAssemblies(JSON.parse(JSON.stringify([asm])))[0]).toBe(false);
  });
  it("finds the pair a mate joins, and the check option", () => {
    const pick = { partId: "pin", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] } };
    expect(matePair({ id: "m", name: "M", type: "fastened", a: { instanceId: "i1", pick }, b: { instanceId: "s", path: ["p"], pick }, flip: false, values: {} })).toEqual(["i1", "s/p"]);
    expect(matePair({ id: "m", name: "M", type: "fastened", a: { instanceId: "@origin", pick }, b: { instanceId: "i2", pick }, flip: false, values: {} })).toBeNull();
    expect(parseClashOptions({ checkFits: true }).checkFits).toBe(true);
    expect("checkFits" in parseClashOptions({})).toBe(false);
  });
});

describe("fits that can't be judged as they are", () => {
  const n: [string, string] = ["Plate <1>", "Pin <1>"];
  it("says a pin that isn't lined up with its hole, instead of an amount", () => {
    // ⌀9.8 pin 0.2 off the middle of a ⌀10 hole: it overlaps one side, but that's not a press fit.
    const m: ContactMeasure = { a: "Plate <1>", b: "Pin <1>", ids: ["i1", "i2"], volume: 3, area: 60, boxMin: 0.1, offAxis: { radial: 0.1, diameter: 9.8, off: 0.2 } };
    const got = measuredFit(m)!;
    expect(got.offAxis).toBe(0.2);
    const f = judgeIntended(press(0.05, 0.15), n, got, 0.01);
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/the pin isn't lined up with the hole \(off by 0.2 mm\)/);
    // Not marked: noted in Fits.
    expect(judgeFits({ measured: [m], intended: [], tolerance: 0.01, nameOf }).findings.some((x) => /0.2 mm off the middle of its hole/.test(x.text))).toBe(true);
  });
  it("never says a press fit is OK from an estimate", () => {
    const f = judgeIntended(press(0.05, 0.25), n, measuredFit({ a: "A", b: "B", volume: 20, area: 208 }), 0.01);
    expect(f.level).toBe("warn");
    expect(f.text).toMatch(/press fit not checked exactly — about 0.192 mm of interference, only an estimate/);
  });
});

describe("printed press fits", () => {
  const n: [string, string] = ["Plate <1>", "Pin <1>"];
  it("are a small gap, judged round the printer's press fit", () => {
    expect(defaultFitRange("printed", DEFAULT_FITS)).toEqual([0.05, 0.15]);
    expect(defaultFitRange("printed", { ...DEFAULT_FITS, press: 0.02 })).toEqual([0, 0.07]);
    const printed: IntendedFit = { id: "p", a: "i1", b: "i2", kind: "printed", min: 0.05, max: 0.15 };
    expect(judgeIntended(printed, n, measuredFit(pinMeasure(0.05)), 0.01).text).toBe(
      "Plate <1> and Pin <1>: printed press fit OK — a gap of 0.1 mm on the diameter (0.05 mm a side) (wanted 0.05–0.15 mm on the diameter).",
    );
    expect(judgeIntended(printed, n, measuredFit(pinMeasure(0.15)), 0.01).text).toMatch(/printed press fit too loose/);
    expect(judgeIntended(printed, n, measuredFit(pinMeasure(-0.05)), 0.01).text).toMatch(/printed, it would be far too tight/);
    expect(parseFits([printed], new Set(["i1", "i2"]))).toEqual([printed]);
  });
  it("explain themselves when a press fit is drawn with a gap", () => {
    const f = judgeIntended(press(0.05, 0.15), n, measuredFit(pinMeasure(0.05)), 0.01, DEFAULT_FITS);
    expect(f.text).toMatch(/a printed press fit is drawn with a small gap \(yours is 0.1 mm on the diameter\) — mark it as a printed press fit instead/);
    expect(judgeIntended(press(0.05, 0.15), n, measuredFit(pinMeasure(0.05)), 0.01).text).not.toMatch(/printed/);
  });
  it("use the design's fit variables over the printer's", () => {
    const read = (t: string) => (/^[\d.]+ mm$/.test(t) ? parseFloat(t) : null);
    expect(printFitsFrom([{ name: "fit_press", value: "0.15 mm" }, { name: "fit_loose", value: "fit_snug * 2" }], read, DEFAULT_FITS)).toEqual({ ...DEFAULT_FITS, press: 0.15 });
    expect(printFitsFrom(undefined, read, DEFAULT_FITS)).toEqual(DEFAULT_FITS);
  });
  it("measure a bounded range", () => {
    expect(fitRangeFor([])).toBe(1);
    expect(fitRangeFor([{ ...clearance(0.2, 1.5) }])).toBe(2);
    expect(fitRangeFor([{ ...clearance(0.2, 9) }])).toBe(MAX_FIT_RANGE);
    expect(fitRangeFor([press(0.05, 5)])).toBe(1);
  });
});

describe("marks follow the copies", () => {
  it("drops a mark when one of its copies is removed", () => {
    const marked = putFit(asm, press(0.05, 0.15));
    expect(tidyFits(marked)).toBe(marked);
    const left = withoutInstances(marked, ["i2"]);
    expect(left.fits).toBeUndefined();
    const doc = { features: [], assemblies: [marked] } as unknown as Parameters<typeof removeInstances>[0];
    expect(removeInstances(doc, "a", ["i1"]).assemblies![0].fits).toBeUndefined();
    // A mark on a part inside a sub-assembly copy goes with the copy.
    const inner = putFit(asm, { ...press(0.05, 0.15), b: "i2/inner" });
    expect(withoutInstances(inner, ["i2"]).fits).toBeUndefined();
    expect(withoutInstances(inner, ["nope"]).fits).toHaveLength(1);
  });
});
