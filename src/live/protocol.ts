/**
 * "Live with Claude": the messages JuraCAD (in the browser) and the JuraCAD
 * extension for Claude (on the same computer) send each other over a local
 * WebSocket, and the rules both sides follow. Pure: used by the app
 * (src/live/client.ts) and by the extension (src/mcp/live.ts).
 *
 * How it goes:
 * - The user clicks Connect to Claude. The app tries every one of LIVE_PORTS on
 *   127.0.0.1 (one extension per Claude chat) and sends each "hello" with its
 *   design (a .juracad file's text), the Part Studio on show and a version
 *   number (1 to start). Each link counts its own versions. While connected,
 *   the app looks again every few seconds for chats started since.
 * - Each change the user makes (including undo/redo) is sent as "doc" with the
 *   next version.
 * - When Claude changes the design, the extension sends "change", based on the
 *   latest version it has. The app applies it as one undo step if it's still at
 *   that version ("applied", version + 1), or refuses it ("refused") if the
 *   user changed something in the meantime or has a dialog open. Nothing is
 *   ever merged silently: a refused change is reported to Claude, which looks
 *   again and retries.
 */

/**
 * The ports the extension listens on (the first free one). Claude starts the
 * extension once for each chat, so several may be running: the app links all of them.
 */
export const LIVE_PORTS = [47615, 47616, 47617, 47618, 47619, 47620, 47621, 47622, 47623, 47624] as const;
/** The address path and WebSocket sub-protocol both sides use (anything else is refused). */
export const LIVE_PATH = "/juracad-live";
export const LIVE_SUBPROTOCOL = "juracad-live.1";
/** Biggest message either side accepts (a design with imported models can be large). */
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/** The JuraCAD website. */
export const SITE_ORIGIN = "https://gm7dha.github.io";

/**
 * May a web page from this origin connect? Only the JuraCAD site. Browsers
 * always send the page's origin and pages can't fake it, so this keeps every
 * other website out — including pages served on this computer (a local dev
 * server, or a page from some other program). Those are only let in when
 * `allowLocal` is set, which the extension does only when JURACAD_LIVE_DEV=1
 * (for JuraCAD's own tests and development).
 *
 * Note: the origin is the whole GitHub Pages site, so any other site the
 * account publishes under https://gm7dha.github.io/… shares it.
 */
export function originAllowed(origin: string | undefined | null, allowLocal = false): boolean {
  if (!origin) return false;
  if (origin === SITE_ORIGIN) return true;
  return allowLocal && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin);
}

/**
 * Is the Host header one this server answers to? Only its own loopback
 * address and port: a page on another site can't get here through a DNS name
 * pointed at 127.0.0.1 ("DNS rebinding").
 */
export function hostAllowed(host: string | undefined | null, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

// ---------------------------------------------------------------------------
// Messages

/** Why the app didn't take one of Claude's changes. */
export type RefusedReason = "changed" | "busy" | "invalid";

/** From the app (browser) to the extension. */
export type AppMessage =
  | { type: "hello"; protocol: 1; app: string; version: number; studio: string; file: string }
  | { type: "doc"; version: number; studio: string; file: string }
  | { type: "applied"; id: number; version: number }
  | { type: "refused"; id: number; version: number; reason: RefusedReason; message: string };

/** From the extension to the app. */
export type ExtensionMessage =
  | { type: "welcome"; protocol: 1; extension: string }
  | { type: "busy"; message: string }
  | { type: "change"; id: number; base: number; studio: string; file: string; label: string; replace: boolean }
  | { type: "error"; message: string };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isText = (v: unknown, max = MAX_MESSAGE_BYTES): v is string => typeof v === "string" && v.length <= max;
const SHORT = 2000;

function parseObject(text: string): Record<string, unknown> | string {
  if (typeof text !== "string") return "not text";
  if (text.length > MAX_MESSAGE_BYTES) return "too big";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return "not an object";
  return data as Record<string, unknown>;
}

/** Check a message from the app. Returns the message, or why it's not acceptable. */
export function parseAppMessage(text: string): AppMessage | { error: string } {
  const d = parseObject(text);
  if (typeof d === "string") return { error: d };
  switch (d.type) {
    case "hello":
      if (d.protocol !== 1) return { error: "a different version of the live link" };
      if (!isText(d.app, 100) || !isInt(d.version) || !isText(d.studio, 200) || !isText(d.file)) return { error: "a damaged hello" };
      return { type: "hello", protocol: 1, app: d.app, version: d.version, studio: d.studio, file: d.file };
    case "doc":
      if (!isInt(d.version) || !isText(d.studio, 200) || !isText(d.file)) return { error: "a damaged design" };
      return { type: "doc", version: d.version, studio: d.studio, file: d.file };
    case "applied":
      if (!isInt(d.id) || !isInt(d.version)) return { error: "a damaged reply" };
      return { type: "applied", id: d.id, version: d.version };
    case "refused":
      if (!isInt(d.id) || !isInt(d.version) || !["changed", "busy", "invalid"].includes(d.reason as string) || !isText(d.message, SHORT)) return { error: "a damaged reply" };
      return { type: "refused", id: d.id, version: d.version, reason: d.reason as RefusedReason, message: d.message };
    default:
      return { error: "an unknown message" };
  }
}

/** Check a message from the extension. */
export function parseExtensionMessage(text: string): ExtensionMessage | { error: string } {
  const d = parseObject(text);
  if (typeof d === "string") return { error: d };
  switch (d.type) {
    case "welcome":
      if (d.protocol !== 1 || !isText(d.extension, 100)) return { error: "a different version of the live link" };
      return { type: "welcome", protocol: 1, extension: d.extension };
    case "busy":
    case "error":
      if (!isText(d.message, SHORT)) return { error: "a damaged message" };
      return { type: d.type, message: d.message };
    case "change":
      if (!isInt(d.id) || !isInt(d.base) || !isText(d.studio, 200) || !isText(d.file) || !isText(d.label, 300) || typeof d.replace !== "boolean") return { error: "a damaged change" };
      return { type: "change", id: d.id, base: d.base, studio: d.studio, file: d.file, label: d.label, replace: d.replace };
    default:
      return { error: "an unknown message" };
  }
}

// ---------------------------------------------------------------------------
// Versions

/**
 * The app's decision on a change from Claude: apply it (and move to the next
 * version) only if it was made from exactly the design on show, and the user
 * isn't half-way through editing something.
 */
export function decideChange(current: number, base: number, busy: string | null):
  | { apply: true; version: number }
  | { apply: false; reason: RefusedReason; message: string } {
  if (busy) return { apply: false, reason: "busy", message: busy };
  if (base !== current) {
    return {
      apply: false,
      reason: "changed",
      message: "The design was changed in JuraCAD at the same moment, so Claude's change wasn't applied (nothing was lost).",
    };
  }
  return { apply: true, version: current + 1 };
}

/**
 * The extension's view of the open design: is a message about a version
 * newer than the one it has? (Messages arrive in order on one connection, but
 * a stale one is never allowed to go back in time.)
 */
export function isNewer(have: number, incoming: number): boolean {
  return incoming > have;
}
