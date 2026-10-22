/**
 * A small WebSocket server (RFC 6455) for the live link with the JuraCAD tab,
 * written on Node's own http module so the extension needs no extra package.
 * It only does what the link needs: text messages, ping/pong and closing,
 * no compression. Every connection is checked before it's accepted (see
 * `upgradeProblem`): the path, the sub-protocol, the Host (only 127.0.0.1 /
 * localhost on our port) and the Origin (only the JuraCAD site).
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { hostAllowed, LIVE_PATH, LIVE_SUBPROTOCOL, MAX_MESSAGE_BYTES, originAllowed } from "../live/protocol";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The Sec-WebSocket-Accept answer to a client's key. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Why this upgrade request may not connect (null = it may), with the HTTP status to answer. */
export function upgradeProblem(req: Pick<IncomingMessage, "method" | "url" | "headers">, port: number, allowLocalOrigins = false): { status: number; why: string } | null {
  const h = req.headers;
  if (req.method !== "GET") return { status: 405, why: "only GET can open the link" };
  if ((req.url ?? "").split("?")[0] !== LIVE_PATH) return { status: 404, why: `wrong path ${req.url}` };
  if (!hostAllowed(h.host, port)) return { status: 403, why: `wrong host ${h.host}` };
  if (!originAllowed(h.origin, allowLocalOrigins)) return { status: 403, why: `a page from ${h.origin ?? "an unknown place"} isn't JuraCAD` };
  if (String(h.upgrade ?? "").toLowerCase() !== "websocket") return { status: 426, why: "not a WebSocket request" };
  if (h["sec-websocket-version"] !== "13") return { status: 426, why: "an unsupported WebSocket version" };
  const key = h["sec-websocket-key"];
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) return { status: 400, why: "a missing WebSocket key" };
  const protocols = String(h["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  if (!protocols.includes(LIVE_SUBPROTOCOL)) return { status: 400, why: "not JuraCAD's live link" };
  return null;
}

/** One frame, as the server sends it (never masked) or a client sends it (masked with `mask`). */
export function encodeFrame(opcode: number, payload: Buffer, mask?: Buffer, fin = true): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) out[1] = len;
  else if (len < 65536) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  if (mask) {
    out[1] |= 0x80;
    mask.copy(out, head);
    for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  } else payload.copy(out, head);
  return out;
}

/** Close codes used here. */
export const CLOSE = { normal: 1000, protocol: 1002, unsupported: 1003, badData: 1007, policy: 1008, tooBig: 1009 } as const;

/**
 * Reads frames from a byte stream: whole text messages come out of
 * `onMessage`; pings are answered; anything not allowed closes the link with
 * the right code. `masked` is true on the server (clients must mask), false in
 * a client reading the server's frames.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private parts: Buffer[] = [];
  private partBytes = 0;
  private messageOp = 0;
  closed = false;

  constructor(
    private readonly masked: boolean,
    private readonly handlers: {
      onMessage: (text: string) => void;
      onPing: (data: Buffer) => void;
      onClose: (code: number, reason: string) => void;
    },
    private readonly maxBytes = MAX_MESSAGE_BYTES,
  ) {}

  private peek(n: number): Buffer {
    if (this.chunks[0].length < n) {
      const all = Buffer.concat(this.chunks);
      this.chunks = [all];
    }
    return this.chunks[0].subarray(0, n);
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - at);
      c.copy(out, at, 0, k);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.buffered -= n;
    return out;
  }

  private fail(code: number, why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.parts = [];
    this.handlers.onClose(code, why);
  }

  push(data: Buffer): void {
    if (this.closed) return;
    this.chunks.push(data);
    this.buffered += data.length;
    while (!this.closed && this.buffered >= 2) {
      const h = this.peek(2);
      const fin = (h[0] & 0x80) !== 0;
      const rsv = h[0] & 0x70;
      const op = h[0] & 0x0f;
      const isMasked = (h[1] & 0x80) !== 0;
      let len = h[1] & 0x7f;
      let head = 2;
      if (len === 126) head = 4;
      else if (len === 127) head = 10;
      if (this.buffered < head) return;
      const hb = this.peek(head);
      if (len === 126) len = hb.readUInt16BE(2);
      else if (len === 127) {
        const big = hb.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) return this.fail(CLOSE.tooBig, "message too big");
        len = Number(big);
      }
      if (rsv) return this.fail(CLOSE.protocol, "unexpected extension bits");
      if (isMasked !== this.masked) return this.fail(CLOSE.protocol, this.masked ? "client frames must be masked" : "server frames must not be masked");
      const control = op >= 8;
      if (control && (len > 125 || !fin)) return this.fail(CLOSE.protocol, "bad control frame");
      if (!control && this.partBytes + len > this.maxBytes) return this.fail(CLOSE.tooBig, "message too big");
      const total = head + (isMasked ? 4 : 0) + len;
      if (this.buffered < total) return;
      this.take(head);
      const mask = isMasked ? this.take(4) : null;
      const payload = this.take(len);
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal;
        this.closed = true;
        this.handlers.onClose(code, payload.subarray(2).toString("utf8"));
        return;
      }
      if (op === 0x9) {
        this.handlers.onPing(payload);
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x2) return this.fail(CLOSE.unsupported, "only text messages are used");
      if (op === 0x1) {
        if (this.parts.length) return this.fail(CLOSE.protocol, "a new message began before the last one ended");
        this.messageOp = op;
      } else if (op === 0x0) {
        if (!this.parts.length && this.messageOp !== 0x1) return this.fail(CLOSE.protocol, "a continuation with no message");
      } else return this.fail(CLOSE.protocol, `unknown frame type ${op}`);
      this.parts.push(payload);
      this.partBytes += len;
      if (fin) {
        const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        this.parts = [];
        this.partBytes = 0;
        this.messageOp = 0;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(whole);
        } catch {
          return this.fail(CLOSE.badData, "not valid text");
        }
        this.handlers.onMessage(text);
      }
    }
  }
}

/** One accepted connection, seen from the server. */
export class WebSocketConnection {
  private reader: FrameReader;
  private done = false;
  onMessage: (text: string) => void = () => {};
  onClose: (code: number, reason: string) => void = () => {};

  constructor(private readonly socket: Duplex) {
    this.reader = new FrameReader(true, {
      onMessage: (t) => this.onMessage(t),
      onPing: (d) => this.write(encodeFrame(0xa, d)),
      onClose: (code, reason) => this.close(code === 1005 || code < 1000 ? CLOSE.normal : code, reason),
    });
    socket.on("data", (d: Buffer) => this.reader.push(d));
    socket.on("close", () => this.finish(1006, "connection lost"));
    socket.on("error", () => this.finish(1006, "connection lost"));
    socket.on("end", () => this.finish(1006, "connection lost"));
  }

  get open(): boolean {
    return !this.done;
  }

  private write(b: Buffer): void {
    if (!this.done && !this.socket.destroyed) this.socket.write(b);
  }

  send(text: string): void {
    this.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  close(code: number = CLOSE.normal, reason = ""): void {
    if (this.done) return;
    const r = Buffer.from(reason.slice(0, 100), "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.write(encodeFrame(0x8, payload));
    this.socket.end();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.done) return;
    this.done = true;
    this.reader.closed = true;
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
    this.onClose(code, reason);
  }
}

export interface LiveServerOptions {
  ports: readonly number[];
  /** Called for each accepted connection. Return a reason to turn it away (e.g. another tab is connected). */
  accept: (conn: WebSocketConnection, origin: string) => void;
  /** Also let in pages served on this computer (http(s)://localhost…): only for JuraCAD's own tests and development. */
  allowLocalOrigins?: boolean;
  log?: (msg: string) => void;
}

/**
 * Listen on 127.0.0.1 (never any other address) on the first free port of
 * `ports`. Resolves with the server and the port, or null if none was free.
 */
export async function startLiveServer(opts: LiveServerOptions): Promise<{ server: Server; port: number } | null> {
  const log = opts.log ?? (() => {});
  for (const wanted of opts.ports) {
    // (0 = any free port, for tests; the real port is known once listening.)
    let port = wanted;
    const server = createServer((req, res) => {
      // Plain web requests (someone opening the address in a browser): say what this is, nothing more.
      res.writeHead(hostAllowed(req.headers.host, port) ? 426 : 403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("This is the JuraCAD extension's link for Claude. Open JuraCAD (https://gm7dha.github.io/JuraCAD/) and click Connect to Claude.\n");
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      socket.on("error", () => socket.destroy());
      const problem = upgradeProblem(req, port, opts.allowLocalOrigins ?? false);
      if (problem) {
        log(`Live link: turned away a connection (${problem.why}).`);
        socket.end(`HTTP/1.1 ${problem.status} ${problem.status === 403 ? "Forbidden" : "Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(String(req.headers["sec-websocket-key"]))}\r\nSec-WebSocket-Protocol: ${LIVE_SUBPROTOCOL}\r\n\r\n`,
      );
      (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
      opts.accept(new WebSocketConnection(socket), String(req.headers.origin));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(wanted, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      // From now on, a problem (say, too many open files) is logged, never allowed to stop the extension.
      server.on("error", (e) => log(`Live link: ${e instanceof Error ? e.message : String(e)}`));
      const at = server.address();
      if (at && typeof at === "object") port = at.port;
      return { server, port };
    }
    log(`Live link: port ${wanted} is in use; trying the next one.`);
  }
  return null;
}
