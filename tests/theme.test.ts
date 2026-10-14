import { describe, expect, it } from "vitest";

import { resolveTheme } from "../src/app/theme";

describe("appearance", () => {
  it("follows the computer when set to automatic", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
