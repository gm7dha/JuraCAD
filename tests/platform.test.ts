import { describe, expect, it } from "vitest";

import { detectPlatform, helpRows, shortcut } from "../src/app/platform";

describe("Mac or Windows shortcuts", () => {
  it("recognises Macs and treats everything else like Windows", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(detectPlatform({ platform: "iPad" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectPlatform({ userAgentData: { platform: "Windows" } })).toBe("windows");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("windows");
    expect(detectPlatform(undefined)).toBe("windows");
  });

  it("labels keys the way each keyboard does", () => {
    expect(shortcut("mac", "Z")).toBe("⌘Z");
    expect(shortcut("mac", "Z", { shift: true })).toBe("⇧⌘Z");
    expect(shortcut("windows", "Y")).toBe("Ctrl+Y");
    const mac = helpRows("mac");
    const win = helpRows("windows");
    expect(mac.keys.find(([, what]) => what === "Undo")?.[0]).toBe("⌘ Cmd + Z");
    expect(win.keys.find(([, what]) => what === "Undo")?.[0]).toBe("Ctrl + Z");
    expect(mac.mouse.find(([what]) => what === "Add to selection")?.[1]).toMatch(/Cmd-click/);
    expect(win.mouse.find(([what]) => what === "Pan")?.[1]).toMatch(/Ctrl \+ right-drag/);
    expect(mac.keys.some(([key]) => key === "Delete ⌫")).toBe(true);
  });
});
