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
