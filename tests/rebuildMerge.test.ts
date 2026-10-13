import { describe, expect, it } from "vitest";

import { mergeRebuilds } from "../src/kernel/client";
import type { PartMesh, RebuildResult } from "../src/kernel/protocol";

const part = (id: string, studioId: string) => ({ id, studioId, name: id }) as unknown as PartMesh;
const result = (rebuilt: string[], parts: PartMesh[], order = ["main", "s2"]): RebuildResult => ({ parts, featureErrors: {}, durationMs: 1, rebuilt, studioOrder: order });

describe("merging skipped rebuilds", () => {
  it("keeps parts from a skipped rebuild that the next one didn't redo", () => {
    const m = mergeRebuilds(result(["main"], [part("a", "main")]), result([], []));
    expect(m.rebuilt).toEqual(["main"]);
    expect(m.parts.map((p) => p.id)).toEqual(["a"]);
  });

  it("prefers the newer parts, and drops studios that are gone", () => {
    const m = mergeRebuilds(result(["main", "s2"], [part("old", "main"), part("b", "s2")]), result(["main"], [part("new", "main")], ["main"]));
    expect(m.rebuilt).toEqual(["main"]);
    expect(m.parts.map((p) => p.id)).toEqual(["new"]);
  });
});
