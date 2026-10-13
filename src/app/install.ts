/**
 * Installing PartSmith as an app (Chrome and Edge offer this), and opening
 * .partsmith files that were double-clicked once it's installed.
 */
import { useSyncExternalStore } from "react";

import { openFile } from "./fileActions";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own Install button instead of the browser's banner
    deferred = e as InstallPrompt;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });

  // Files double-clicked (or "Open with PartSmith") after installing.
  const launchQueue = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: { getFile(): Promise<File> }[] }) => void): void } })
    .launchQueue;
  launchQueue?.setConsumer(async (params) => {
    const handle = params.files[0];
    if (handle) void openFile(await handle.getFile());
  });
}

/** True when PartSmith is already running as an installed app (its own window). */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true; // Safari "Add to Dock"
  return standalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export type BrowserKind = "safari" | "chrome" | "edge" | "firefox" | "other";

/** Which browser this is, for install instructions. */
export function browserKind(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): BrowserKind {
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\/|Chromium\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "safari";
  return "other";
}

/** Step-by-step install instructions for browsers where we can't install with one click. */
export function installSteps(kind: BrowserKind): string[] {
  switch (kind) {
    case "safari":
      return ["In the Safari menu bar, choose File › Add to Dock…", "Click Add. PartSmith then opens from the Dock in its own window and works offline."];
    case "chrome":
      return [
        "Click the install icon at the right-hand end of the address bar (a small screen with a down arrow), or open the ⋮ menu › Cast, save and share › Install PartSmith…",
        "If neither is there, PartSmith is probably already installed — look for it in your Applications folder, Start menu or Launchpad.",
      ];
    case "edge":
      return [
        "Click the install icon at the right-hand end of the address bar, or open the … menu › Apps › Install PartSmith.",
        "If it isn't offered, PartSmith is probably already installed — look for it in your Start menu or Applications folder.",
      ];
    case "firefox":
      return ["Firefox can't install websites as apps. Open PartSmith in Chrome, Edge or Safari to install it — your designs are saved as files, so you can move between browsers."];
    default:
      return ["Look in your browser's menu for Install, Add to Dock or Add to Home Screen."];
  }
}

/** True when the browser will let us offer "Install". */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => deferred !== null,
    () => false,
  );
}

export async function installApp(): Promise<void> {
  const p = deferred;
  if (!p) return;
  await p.prompt();
  await p.userChoice;
  deferred = null;
  notify();
}
