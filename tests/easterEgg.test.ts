import { describe, expect, it } from "vitest";

import { eggClick } from "../src/app/easterEgg";

describe("help screen surprise", () => {
  it("appears after 10 clicks within 5 seconds", () => {
    let recent: number[] = [];
    let found = false;
    for (let i = 0; i < 10; i++) ({ recent, found } = eggClick(recent, i * 400));
    expect(found).toBe(true);
    expect(recent).toEqual([]);
  });

  it("doesn't for slower clicking", () => {
    let recent: number[] = [];
    let found = false;
    for (let i = 0; i < 20 && !found; i++) ({ recent, found } = eggClick(recent, i * 600));
    expect(found).toBe(false);
  });
});
