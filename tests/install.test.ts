import { describe, expect, it } from "vitest";

import { browserKind, installSteps } from "../src/app/install";

const UA = {
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0",
};

describe("install instructions", () => {
  it("tells the browsers apart", () => {
    expect(browserKind(UA.safari)).toBe("safari");
    expect(browserKind(UA.chrome)).toBe("chrome");
    expect(browserKind(UA.edge)).toBe("edge");
    expect(browserKind(UA.firefox)).toBe("firefox");
  });

  it("gives Safari users the Add to Dock route", () => {
    expect(installSteps("safari")[0]).toMatch(/File › Add to Dock/);
    expect(installSteps("firefox")[0]).toMatch(/can't install/);
  });
});
