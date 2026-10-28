/**
 * Safari's link window: the small page the JuraCAD extension serves on
 * http://127.0.0.1:<port>/juracad-relay (see "Safari: the link window" in
 * protocol.ts). Safari won't let the https JuraCAD site open ws://127.0.0.1
 * itself, but this page, being http://127.0.0.1, may. The JuraCAD tab opens
 * it with window.open and sends it postMessages; it opens the real
 * WebSockets to the extensions and passes every message both ways untouched.
 *
 * The script is a plain string (no build step, nothing imported at run time),
 * so what the extension serves is exactly what the tests run. Its rules:
 * - it only runs on http://127.0.0.1:<port> (loaded anywhere else it does nothing);
 * - it only obeys messages from the window that opened it (event.source ===
 *   window.opener) whose origin is the JuraCAD site (or, in development mode
 *   only, a page served on this computer), and only replies to that origin;
 * - the first "ping" with a session id ties it to that page; a new session
 *   (the tab was reloaded) closes everything from the old one;
 * - it only opens ws://127.0.0.1:<one of the live ports>/juracad-live with the
 *   live sub-protocol, at most RELAY_MAX_SOCKETS at once, text messages only,
 *   none bigger than MAX_MESSAGE_BYTES;
 * - it never puts anything it's sent into the page (status text is fixed);
 * - when the JuraCAD tab closes (or says "bye") it closes every link and itself.
 */
import { LIVE_PATH, LIVE_PORTS, LIVE_SUBPROTOCOL, MAX_MESSAGE_BYTES, RELAY_MAX_SOCKETS, RELAY_SCRIPT_PATH, RELAY_TAG, SITE_ORIGIN } from "./protocol";

export interface RelayConfig {
  /** The ports it may open links to. */
  ports?: readonly number[];
  /** Development mode (JURACAD_LIVE_DEV=1): also obey JuraCAD served on this computer. */
  allowLocal?: boolean;
}

/** The link window's script, as served (JavaScript source). */
export function relayScript(config: RelayConfig = {}): string {
  const settings = {
    site: SITE_ORIGIN,
    allowLocal: !!config.allowLocal,
    ports: [...(config.ports ?? LIVE_PORTS)],
    path: LIVE_PATH,
    protocol: LIVE_SUBPROTOCOL,
    max: MAX_MESSAGE_BYTES,
    tag: RELAY_TAG,
    maxSockets: RELAY_MAX_SOCKETS,
  };
  return `"use strict";
(function (S) {
  if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d{1,5}$/.test(String(window.location && window.location.origin))) return;
  var LOCAL = /^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d{1,5})?$/;
  var partner = null;
  var sockets = {};
  var count = 0;
  var watch = null;
  function allowed(origin) {
    return origin === S.site || (S.allowLocal && LOCAL.test(origin));
  }
  function say(text) {
    var el = document.getElementById("status");
    if (el) el.textContent = text;
  }
  function post(msg) {
    var to = window.opener;
    if (!partner || !to) return;
    msg.juracad = S.tag;
    msg.session = partner.session;
    try { to.postMessage(msg, partner.origin); } catch (e) { /* the tab has gone */ }
  }
  function isId(v) {
    return typeof v === "number" && v >= 0 && v === Math.floor(v) && v < 9007199254740992;
  }
  function drop(id) {
    if (sockets[id]) { delete sockets[id]; count--; }
  }
  function closeAll() {
    for (var id in sockets) {
      var ws = sockets[id];
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000, "disconnected"); } catch (e) { /* already closed */ }
    }
    sockets = {};
    count = 0;
  }
  function open(id, port) {
    if (!isId(id) || sockets[id]) return;
    if (S.ports.indexOf(port) < 0 || count >= S.maxSockets) {
      post({ kind: "closed", id: id, code: 1008, reason: "refused by the link window" });
      return;
    }
    var ws;
    try {
      ws = new WebSocket("ws://127.0.0.1:" + port + S.path, S.protocol);
    } catch (e) {
      post({ kind: "error", id: id });
      post({ kind: "closed", id: id, code: 1006, reason: "couldn't open" });
      return;
    }
    sockets[id] = ws;
    count++;
    ws.onopen = function () { post({ kind: "opened", id: id }); };
    ws.onmessage = function (ev) {
      if (typeof ev.data !== "string" || ev.data.length > S.max) return;
      post({ kind: "message", id: id, data: ev.data });
    };
    ws.onerror = function () { post({ kind: "error", id: id }); };
    ws.onclose = function (ev) {
      drop(id);
      post({ kind: "closed", id: id, code: (ev && ev.code) || 1006, reason: String((ev && ev.reason) || "").slice(0, 200) });
    };
  }
  function finish(text) {
    closeAll();
    partner = null;
    if (watch !== null) { clearInterval(watch); watch = null; }
    say(text);
    try { window.close(); } catch (e) { /* not ours to close */ }
  }
  window.addEventListener("message", function (ev) {
    if (!window.opener || ev.source !== window.opener || !allowed(ev.origin)) return;
    var m = ev.data;
    if (!m || typeof m !== "object" || m.juracad !== S.tag || typeof m.session !== "string" || !m.session || m.session.length > 100) return;
    if (!partner || partner.session !== m.session || partner.origin !== ev.origin) {
      if (m.kind !== "ping") return;
      closeAll();
      partner = { origin: ev.origin, session: m.session };
    }
    switch (m.kind) {
      case "ping":
        post({ kind: "pong" });
        say("Linked to JuraCAD. Keep this window open while you work with Claude (you can move it out of the way). Closing it disconnects.");
        return;
      case "open":
        open(m.id, m.port);
        return;
      case "send": {
        var ws = sockets[m.id];
        if (ws && ws.readyState === 1 && typeof m.data === "string" && m.data.length <= S.max) ws.send(m.data);
        return;
      }
      case "close": {
        var w = sockets[m.id];
        if (w) {
          try { w.close(1000, "disconnected"); } catch (e) { /* already closed */ }
        }
        return;
      }
      case "bye":
        finish("JuraCAD disconnected from Claude. You can close this window.");
        return;
    }
  });
  // The JuraCAD tab was closed: let every link go (the extension then frees its place for the next tab).
  watch = setInterval(function () {
    if (!window.opener || window.opener.closed) finish("JuraCAD was closed, so the link to Claude has stopped. You can close this window.");
  }, 1000);
})(${JSON.stringify(settings)});
`;
}

/** The link window's page (HTML). Its only script is RELAY_SCRIPT_PATH. */
export function relayPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>JuraCAD – link to Claude</title>
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --fg: #1d2330; --muted: #5b6475; --accent: #2f6fde; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1f27; --fg: #e7eaf0; --muted: #a4adbd; --accent: #6d9cff; } }
body { margin: 0; padding: 20px 18px; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
h1::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
p { margin: 0 0 8px; }
.muted { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<h1>JuraCAD ↔ Claude</h1>
<p id="status">Waiting for JuraCAD… (open JuraCAD in Safari and click Connect to Claude).</p>
<p class="muted">Safari doesn't let websites reach apps on your Mac directly, so this little window passes messages between JuraCAD and the JuraCAD extension in the Claude app. It stays on this computer.</p>
<script src="${RELAY_SCRIPT_PATH}"></script>
</body>
</html>
`;
}

/**
 * The HTTP headers for the link window's page and script: no caching, never
 * inside a frame, no referrer, and a content policy that allows only its own
 * script and WebSockets to the live ports on 127.0.0.1. No
 * `upgrade-insecure-requests` (Safari would then try https on 127.0.0.1) and
 * no Cross-Origin-Opener-Policy (the window must keep its opener).
 */
export function relayHeaders(kind: "page" | "script", ports: readonly number[] = LIVE_PORTS): Record<string, string> {
  const connect = ports.map((p) => `ws://127.0.0.1:${p}`).join(" ");
  return {
    "Content-Type": kind === "page" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  };
}
