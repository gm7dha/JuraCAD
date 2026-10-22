import { describe, expect, it } from "vitest";

import { parseAssemblies, removeInstances } from "../src/assembly/assembly";
import type { Frame } from "../src/assembly/connectors";
import { planDrag } from "../src/assembly/drag";
import { applyPlacement, IDENTITY, type Vec3 } from "../src/assembly/math";
import { connectorFrameFor, pickConnector, solveAssembly } from "../src/assembly/mates";
import { isOrigin, ORIGIN_ID, originConnector, originFrame, originPlaneOf } from "../src/assembly/origin";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, MateType } from "../src/model/types";

const pick = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, -1] as Vec3 } };
/** Each part's connector: its bottom face's centre, Z pointing down out of it. */
const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
const frames = (m: Mate, side: "a" | "b") => (isOrigin(m[side]) ? originFrame(m[side]) : bottom);
const inst = (id: string, x = 0, fixed = false): Instance => ({ id, partId: "p", name: `${id} <1>`, placement: { position: [x, 7, 3], rotation: [0, 0, 0, 1] }, fixed });
const mate = (type: MateType, b: string, values: Record<string, string> = {}, plane: "Top" | "Front" | "Right" = "Top"): Mate => ({
  id: "m",
  name: "M",
  type,
  a: originConnector(plane),
  b: { instanceId: b, pick },
  flip: false,
  values,
});

describe("mating to the origin", () => {
  it("has a connector on each of the origin's planes", () => {
    expect(originFrame(originConnector("Top"))).toEqual({ origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0], surface: "plane" });
    expect(originFrame(originConnector("Front"))!.z).toEqual([0, -1, 0]);
    expect(originFrame(originConnector("Right"))!.z).toEqual([1, 0, 0]);
    expect(originPlaneOf(originConnector("Right"))).toBe("Right");
    expect(originPlaneOf({ instanceId: "i1", pick })).toBe(null);
    // The app's frame lookup knows the origin without any part.
    const asm: Assembly = { id: "a", name: "A", instances: [] };
    expect(connectorFrameFor(asm, [], originConnector("Front"))!.z).toEqual([0, -1, 0]);
  });

  it("holds a part without fixing anything", () => {
    // No fixed parts: a Fasten to the origin's Top plane puts the part's bottom on it.
    const asm: Assembly = { id: "a", name: "A", instances: [inst("box", 40)], mates: [mate("fastened", "box")] };
    const r = solveAssembly(asm, frames);
    expect(r.mateErrors).toEqual({});
    expect(r.drivenBy.box).toBe("m");
    expect(r.placements.box.position.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 0]);
    // The origin isn't a part: it's not in the solved places.
    expect(r.placements[ORIGIN_ID]).toBe(undefined);
    // A gap lifts it off the plane; on the Front plane it sits in front of it (towards −Y).
    const lifted = solveAssembly({ ...asm, mates: [mate("fastened", "box", { gap: "5" })] }, frames);
    expect(lifted.placements.box.position[2]).toBeCloseTo(5, 9);
    const front = solveAssembly({ ...asm, mates: [mate("fastened", "box", {}, "Front")] }, frames);
    // The part's bottom (its own −Z) now faces the Front plane, so its own +Z points along −Y.
    const up = applyPlacement({ position: [0, 0, 0], rotation: front.placements.box.rotation }, [0, 0, 1]);
    expect(up.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, -1, 0]);
  });

  it("lets a part slide or turn against the origin, and drags it", () => {
    const asm: Assembly = { id: "a", name: "A", instances: [inst("slide", 40)], mates: [{ ...mate("slider", "slide", { distance: "12" }) }] };
    const r = solveAssembly(asm, frames);
    // The slider's axis is the origin's Z (the part sits upside down on it): 12 along it.
    expect(r.placements.slide.position.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 12]);
    // Dragging it sideways-on slides it along the axis.
    const plan = planDrag(asm, r, frames, "slide", [0, 0, 12], [0, -1, 0]);
    if (!("plan" in plan)) throw new Error(`refused: ${plan.refuse}`);
    expect(plan.plan.update({ origin: [0, 100, 20], dir: [0, -1, 0] })).toEqual({ kind: "mate", id: "m", values: { distance: "20" } });
  });

  it("is saved and read back; removing the part removes the mate; a mate needs a part", () => {
    const doc = { ...emptyDocument(), assemblies: [{ id: "a", name: "A", instances: [inst("box")], mates: [mate("fastened", "box")] }] };
    const back = parseAssemblies(JSON.parse(JSON.stringify(doc.assemblies)))[0];
    expect(back.mates![0].a).toEqual(originConnector("Top"));
    expect(removeInstances(doc, "a", ["box"]).assemblies![0].mates).toBe(undefined);
    const both: Assembly = { id: "a", name: "A", instances: [inst("box")], mates: [{ ...mate("fastened", "box"), b: originConnector("Front") }] };
    expect(solveAssembly(both, frames).mateErrors.m).toBe("Both connectors are on the origin — pick a face or edge on a part for one of them.");
    // A fixed part elsewhere doesn't stop the origin mate working.
    const withFixed: Assembly = { id: "a", name: "A", instances: [{ ...inst("base", 100, true), placement: IDENTITY }, inst("box")], mates: [mate("fastened", "box")] };
    expect(solveAssembly(withFixed, frames).mateErrors).toEqual({});
  });
});

describe("picking the origin in the mate dialog", () => {
  const part = { instanceId: "box", pick };
  it("always puts the origin first (it stays put), moving a part already picked to second", () => {
    // Part first, then the origin: swapped, so the part is the one that moves.
    expect(pickConnector({ type: "planar", a: part }, originConnector("Top"))).toEqual({ a: originConnector("Top"), b: part });
    // Origin first, then the part.
    expect(pickConnector({ type: "planar", a: originConnector("Top") }, part)).toEqual({ a: originConnector("Top"), b: part });
    // Another plane replaces the first.
    expect(pickConnector({ type: "planar", a: originConnector("Top") }, originConnector("Front"))).toEqual({ a: originConnector("Front"), b: undefined });
    // Ordinary picks are as before.
    const other = { instanceId: "lid", pick };
    expect(pickConnector({ type: "planar", a: part }, other)).toEqual({ a: part, b: other });
    expect(pickConnector({ type: "planar", a: part, b: other }, other)).toEqual({ a: other, b: undefined });
  });

  it("drags a Planar part against the origin, whichever side it was picked on", () => {
    // Picked part first and origin second, as the dialog now stores it: origin on side a.
    const picked = pickConnector({ type: "planar", a: { instanceId: "box", pick } }, originConnector("Top"));
    const asm: Assembly = { id: "a", name: "A", instances: [inst("box", 40)], mates: [{ ...mate("planar", "box"), a: picked.a!, b: picked.b! }] };
    const r = solveAssembly(asm, frames);
    const plan = planDrag(asm, r, frames, "box", [0, 0, 0], [0, 0, -1]);
    if (!("plan" in plan)) throw new Error(`refused: ${plan.refuse}`);
    expect(plan.plan.update({ origin: [5, 3, 100], dir: [0, 0, -1] })).toEqual({ kind: "mate", id: "m", values: { dx: "5", dy: "3" } });
    // An older mate with the origin second (side b): dragging the part on side a slides it too, the right way.
    const old: Assembly = { ...asm, mates: [{ ...asm.mates![0], a: { instanceId: "box", pick }, b: originConnector("Top") }] };
    const ro = solveAssembly(old, frames);
    const before = ro.placements.box.position;
    const plan2 = planDrag(old, ro, frames, "box", before, [0, 0, -1]);
    if (!("plan" in plan2)) throw new Error(`refused: ${plan2.refuse}`);
    const change = plan2.plan.update({ origin: [before[0] + 5, before[1] + 3, 100], dir: [0, 0, -1] });
    if (!change || change.kind !== "mate") throw new Error("no change");
    const moved = solveAssembly({ ...old, mates: [{ ...old.mates![0], values: change.values }] }, frames).placements.box.position;
    expect(moved[0] - before[0]).toBeCloseTo(5, 6);
    expect(moved[1] - before[1]).toBeCloseTo(3, 6);
  });
});
