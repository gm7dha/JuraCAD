import { describe, expect, it } from "vitest";

import { inPopup, MODAL_SELECTOR, POPUP_SELECTOR } from "../src/app/popupGuard";

/** A stand-in element: `closest` answers for the selectors of the popups it sits in. */
const el = (inside: "none" | "popup" | "featureDialog") => ({
  closest: (selector: string) => (selector === POPUP_SELECTOR && inside === "popup" ? {} : null),
});
const page = (modalOpen: boolean) => ({ querySelector: (selector: string) => (modalOpen && selector === MODAL_SELECTOR ? {} : null) });

describe("shortcut keys and popups", () => {
  it("leaves keys alone while a dialog box is open, wherever they were pressed", () => {
    expect(inPopup(el("none"), page(true))).toBe(true);
    expect(inPopup(null, page(true))).toBe(true);
  });

  it("leaves keys pressed inside a smaller popup (Settings, a colour picker) alone", () => {
    expect(inPopup(el("popup"), page(false))).toBe(true);
  });

  it("lets keys through from the 3D view, the page, and feature-dialog panels", () => {
    expect(inPopup(el("none"), page(false))).toBe(false);
    expect(inPopup(el("featureDialog"), page(false))).toBe(false);
    expect(inPopup(null, page(false))).toBe(false);
    expect(inPopup({}, page(false))).toBe(false); // e.g. the window itself: no closest()
    expect(inPopup(el("none"), undefined)).toBe(false);
  });

  it("treats feature-dialog panels (Insert parts) as part of the app, and Modal boxes as popups", () => {
    expect(POPUP_SELECTOR).toContain(':not(.feature-dialog)');
    expect(POPUP_SELECTOR).toContain(MODAL_SELECTOR);
  });
});
