/**
 * Live with Claude in the app: the one LiveClient (src/live/client.ts), wired
 * to the store. Nothing connects until the user clicks Connect to Claude.
 */
import { useSyncExternalStore } from "react";

import { activeStudioId, useStore } from "../model/store";
import { readDocumentFile, serializeDocument } from "../model/fileFormat";
import { MAIN_STUDIO } from "../model/studios";
import { LiveClient, type LiveHost, type LiveState, type PermissionState, type SocketFactory, type SocketLike } from "../live/client";
import { RelayTransport, type RelayEnv, type RelayWindow } from "../live/relayTransport";
import { APP_VERSION } from "../version";
import { browserKind } from "./install";

/** A number for each document object (cheap "has it changed?" checks). */
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => {
  let id = ids.get(o);
  if (!id) ids.set(o, (id = nextId++));
  return id;
};

/** The browser's permission for reaching apps on this computer (Chrome's Local Network Access), if it says. */
async function loopbackPermission(): Promise<PermissionState> {
  const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
  if (!perms?.query) return "unknown";
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const r = await perms.query({ name } as unknown as PermissionDescriptor);
      return r.state === "granted" || r.state === "denied" || r.state === "prompt" ? r.state : "unknown";
    } catch {
      // This browser doesn't know that permission's name.
    }
  }
  return "unknown";
}

const host: LiveHost = {
  appVersion: APP_VERSION,
  browser: browserKind(),
  current() {
    const s = useStore.getState();
    const studio = activeStudioId(s) ?? MAIN_STUDIO;
    const doc = s.history.present;
    return { key: `${idOf(doc)}|${studio}`, studio, file: () => serializeDocument(doc) };
  },
  busy() {
    const s = useStore.getState();
    if (s.editing) return `The user has ${s.editing.draft.name ? `"${s.editing.draft.name}"` : "a feature"} open for editing in JuraCAD.`;
    if (s.mateDraft) return "The user is adding a mate in JuraCAD.";
    return null;
  },
  apply(file, studio, label, replace) {
    const r = readDocumentFile(file, "Claude's change");
    if (!r.ok) return r.error;
    useStore.getState().applyClaudeChange(r.doc, studio, label, replace);
    return null;
  },
  subscribe: (listener) => useStore.subscribe(listener),
  permission: loopbackPermission,
  // Look for new Claude chats only while JuraCAD is in view (and straight away when it comes back).
  watchVisibility(onChange) {
    if (typeof document === "undefined") return () => {};
    const shown = () => onChange(document.visibilityState === "visible");
    const focused = () => onChange(true);
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", focused);
    return () => {
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", focused);
    };
  },
};

/**
 * Safari won't let this https page open ws://127.0.0.1 (WebKit bug 171934),
 * so there the link goes through the extension's small link window
 * (src/live/relayTransport.ts). `?liveRelay` uses that way in any browser
 * (for the smoke test, and to try it out in Chrome).
 */
export const liveRelayMode = host.browser === "safari" || (typeof location !== "undefined" && new URLSearchParams(location.search).has("liveRelay"));

const relayEnv: RelayEnv = {
  open: (url, name, features) => window.open(url, name, features) as unknown as RelayWindow | null,
  navigate(win, url) {
    (win as unknown as Window).location.href = url;
  },
  listen(fn) {
    const handler = (ev: MessageEvent) => fn({ source: ev.source, origin: ev.origin, data: ev.data });
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  },
  newSession() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  },
};

export const liveRelay: RelayTransport | null = liveRelayMode && typeof window !== "undefined" ? new RelayTransport(relayEnv) : null;

const directSocket: SocketFactory = (url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike;

if (liveRelay) {
  host.prepare = () => liveRelay.start();
  host.release = () => liveRelay.stop();
}

export const liveClient = new LiveClient(host, liveRelay ? liveRelay.makeSocket : directSocket);

if (liveRelay) {
  liveRelay.onLost = () =>
    liveClient.disconnect("The small JuraCAD ↔ Claude window was closed, so JuraCAD disconnected from Claude. Click Connect to Claude to open it again (and keep it open while you work).");
}

/** The live link's state, for React. */
export function useLiveState(): LiveState {
  return useSyncExternalStore(
    (fn) => liveClient.onChange(fn),
    () => liveClient.state,
  );
}

// Close the link cleanly when the page goes away.
if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => {
    if (liveClient.connected) liveClient.disconnect();
    // (Safari: the link window goes too, even if it was still looking for Claude.)
    liveRelay?.stop();
  });
