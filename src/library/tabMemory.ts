/** Which section of the Design library was open last, remembered per browser (never in the design file). */
import { categoryFrom } from "./insert";
import type { DesignCategory } from "./types";

export const LIBRARY_TAB_KEY = "juracad.libraryTab";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined | null;

const storage = (): Store => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

/** The section last open (3D printing the first time, or when the browser keeps nothing). */
export function rememberedTab(store: Store = storage()): DesignCategory {
  try {
    return categoryFrom(store?.getItem(LIBRARY_TAB_KEY)) ?? "print";
  } catch {
    return "print";
  }
}

export function rememberTab(tab: DesignCategory, store: Store = storage()): void {
  try {
    store?.setItem(LIBRARY_TAB_KEY, tab);
  } catch {
    // Private windows and blocked storage: it's only a convenience.
  }
}
