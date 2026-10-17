/**
 * Light or dark appearance. A choice for this computer (kept in the
 * browser, not in designs): light, dark, or the same as the computer.
 */
import { useStore } from "../model/store";

export type ThemeChoice = "light" | "dark" | "system";

// Browser-storage key from the app's old name (PartSmith); kept so the chosen theme is remembered.
const KEY = "partsmith.theme";

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;

/** Light or dark, for a choice. */
export function resolveTheme(choice: ThemeChoice, prefersDark = systemDark()): "light" | "dark" {
  return choice === "system" ? (prefersDark ? "dark" : "light") : choice;
}

function apply() {
  const theme = resolveTheme(themeChoice());
  document.documentElement.dataset.theme = theme;
  useStore.getState().setTheme(theme);
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Not kept for next time; still applied now.
  }
  const theme = choice === "system" ? resolveTheme("system") : choice;
  document.documentElement.dataset.theme = theme;
  useStore.getState().setTheme(theme);
}

/** Apply the saved choice, and follow the computer when that's the choice. */
export function initTheme(): void {
  apply();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (themeChoice() === "system") apply();
  });
}
