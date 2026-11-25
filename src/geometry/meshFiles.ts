/**
 * Reading 3MF and OBJ meshes as plain triangles (pure). Both become the same triangle soup an STL is, so JuraCAD
 * imports them through the STL path (see model/meshImport.ts): corners in millimetres, three per triangle, the
 * corners of each triangle in order round its outside.
 *
 * 3MF: a zip holding XML (`3D/3dmodel.model`, named by `_rels/.rels`): objects are meshes (vertices + triangles) or
 * components (other objects moved by a transform, possibly in other model files of the zip — Bambu Studio and
 * PrusaSlicer save that way); the build's items say which objects to place where. The model's `unit` scales it to mm.
 * Colours and materials aren't read.
 * OBJ: text — `v x y z` corners, `f a b c …` faces (fanned into triangles; `a/t/n` forms; negative = counted back).
 * OBJ files have no units: their numbers are taken as millimetres (the Import dialog's File units changes that).
 */

/** Triangles as corners: x, y, z of each corner, three corners per triangle. */
export interface MeshSoup {
  corners: Float64Array;
  /** Separate objects or bodies found (for the dialog's note). */
  objects: number;
  /** Millimetres per unit the file said it uses (3MF; the corners are already in millimetres). Missing = millimetres. */
  unitMm?: number;
  /** Slicer parts left out (modifiers, negative parts, support blockers/enforcers). */
  skipped?: number;
}

/** A file that can't be read: the message says why in plain words. */
export class MeshFileError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Zip (just enough to read a 3MF: stored or deflated entries, no zip64).

export interface ZipEntry {
  name: string;
  method: number;
  data: Uint8Array;
  size: number;
}

/** The entries of a zip file, still compressed (`inflate` them by `method`). */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new MeshFileError("it isn't a proper 3MF file (a 3MF is a zip file, and this one can't be opened)");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new MeshFileError("it's a kind of zip file JuraCAD can't read (too big, zip64)");
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new MeshFileError("it's damaged (its list of contents can't be read)");
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    if (packed === 0xffffffff || size === 0xffffffff) throw new MeshFileError("it's a kind of zip file JuraCAD can't read (too big, zip64)");
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new MeshFileError("it's damaged (a part of it can't be found)");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > bytes.length) throw new MeshFileError("it's damaged or cut short");
    entries.set(name.replace(/^\/+/, "").toLowerCase(), { name, method, data: bytes.subarray(start, start + packed), size });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// XML, just enough for 3MF: tags with attributes, in order.

interface Tag {
  name: string;
  attrs: Record<string, string>;
  close: boolean;
  empty: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m,
  );

function* tags(xml: string): Generator<Tag> {
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    for (let a = attrRe.exec(m[3]); a; a = attrRe.exec(m[3])) attrs[local(a[1])] = unescape(a[2] ?? a[3] ?? "");
    attrRe.lastIndex = 0;
    yield { name: local(m[2]), attrs, close: m[1] === "/", empty: m[4] === "/" };
  }
}
/** "m:vertex" → "vertex", "p:path" → "path" (3MF's extensions use prefixes). */
const local = (name: string) => name.slice(name.indexOf(":") + 1);

// ---------------------------------------------------------------------------------------------------------------
// 3MF

/** A 3MF transform: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (points are rows: p' = p · M). */
export type Transform3mf = number[];
export const IDENTITY_3MF: Transform3mf = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** First `a`, then `b`. */
export function composeTransforms(a: Transform3mf, b: Transform3mf): Transform3mf {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0);
    }
  }
  return out;
}

function parseTransform(text: string | undefined): Transform3mf {
  if (!text) return IDENTITY_3MF;
  const n = text.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((x) => !Number.isFinite(x))) throw new MeshFileError("one of its parts has a position JuraCAD can't read");
  return n;
}

/** Millimetres per 3MF unit. */
export const UNITS_3MF: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

interface Object3mf {
  vertices?: number[];
  triangles?: number[];
  components?: { objectid: string; path?: string; transform: Transform3mf }[];
  type: string;
}

/** The objects of one .model file, by id. */
export function parseModel3mf(xml: string): { unit: string; objects: Map<string, Object3mf>; items: { objectid: string; path?: string; transform: Transform3mf }[] } {
  const objects = new Map<string, Object3mf>();
  const items: { objectid: string; path?: string; transform: Transform3mf }[] = [];
  let unit = "millimeter";
  let current: Object3mf | null = null;
  let sawModel = false;
  for (const t of tags(xml)) {
    if (t.close) {
      if (t.name === "object") current = null;
      continue;
    }
    switch (t.name) {
      case "model":
        sawModel = true;
        if (t.attrs.unit) unit = t.attrs.unit.toLowerCase();
        break;
      case "object":
        current = { type: t.attrs.type ?? "model" };
        if (t.attrs.id) objects.set(t.attrs.id, current);
        if (t.empty) current = null;
        break;
      case "vertex":
        if (current) {
          const x = Number(t.attrs.x), y = Number(t.attrs.y), z = Number(t.attrs.z);
          if (![x, y, z].every(Number.isFinite)) throw new MeshFileError("one of its corners has numbers JuraCAD can't read");
          (current.vertices ??= []).push(x, y, z);
        }
        break;
      case "triangle":
        if (current) {
          const v = [t.attrs.v1, t.attrs.v2, t.attrs.v3].map(Number);
          if (!v.every((i) => Number.isInteger(i) && i >= 0)) throw new MeshFileError("one of its triangles has corners JuraCAD can't read");
          (current.triangles ??= []).push(v[0], v[1], v[2]);
        }
        break;
      case "component":
        if (current && t.attrs.objectid) (current.components ??= []).push({ objectid: t.attrs.objectid, path: t.attrs.path, transform: parseTransform(t.attrs.transform) });
        break;
      case "item":
        if (t.attrs.objectid) items.push({ objectid: t.attrs.objectid, path: t.attrs.path, transform: parseTransform(t.attrs.transform) });
        break;
    }
  }
  if (!sawModel) throw new MeshFileError("it has no 3D model in it");
  return { unit, objects, items };
}

/** The main model file's name in the zip (from `_rels/.rels`, else the usual `3D/3dmodel.model`). */
export function mainModelPath(rels: string | undefined): string {
  if (rels) {
    for (const t of tags(rels)) {
      if (t.name === "Relationship" && /3dmodel$/i.test(t.attrs.Type ?? "") && t.attrs.Target) return t.attrs.Target.replace(/^\/+/, "");
    }
  }
  return "3D/3dmodel.model";
}

/** How many triangles a 3MF may give before reading stops (the caller refuses more than it can take). */
const MOST_3MF_TRIANGLES = 5_000_000;

/**
 * What a slicer's own settings say isn't part of the shape (pure): Bambu Studio / Orca's `Metadata/model_settings.config`
 * (`<object id><part id subtype>`: part id = the component's objectid; anything but "normal_part" — modifiers,
 * negative parts, support blockers/enforcers — is left out) and PrusaSlicer's `Metadata/Slic3r_PE_model.config`
 * (`<object id><volume firstid lastid>` triangle ranges of the object's mesh; a `volume_type` other than ModelPart, or
 * `modifier` 1, is left out).
 */
export interface SlicerSkips {
  /** Root object id → component objectids to leave out (Bambu). */
  parts: Map<string, Set<string>>;
  /** Object id → triangle ranges [first, last] to leave out (PrusaSlicer). */
  ranges: Map<string, [number, number][]>;
}

export function slicerSkips(bambu: string | undefined, prusa: string | undefined): SlicerSkips {
  const parts = new Map<string, Set<string>>();
  const ranges = new Map<string, [number, number][]>();
  let object: string | null = null;
  if (bambu) {
    for (const t of tags(bambu)) {
      if (t.name === "object") {
        if (t.close) object = null;
        else if (!t.empty) object = t.attrs.id ?? null;
      } else if (t.name === "part" && !t.close && object && t.attrs.id && t.attrs.subtype && t.attrs.subtype !== "normal_part") {
        let set = parts.get(object);
        if (!set) parts.set(object, (set = new Set()));
        set.add(t.attrs.id);
      }
    }
  }
  if (prusa) {
    let volume: { first: number; last: number; skip: boolean } | null = null;
    object = null;
    for (const t of tags(prusa)) {
      if (t.name === "object") {
        if (t.close) object = null;
        else if (!t.empty) object = t.attrs.id ?? null;
      } else if (t.name === "volume") {
        if (t.close) {
          const v = volume;
          if (v && object && v.skip && Number.isInteger(v.first) && Number.isInteger(v.last)) {
            let list = ranges.get(object);
            if (!list) ranges.set(object, (list = []));
            list.push([v.first, v.last]);
          }
          volume = null;
        } else if (!t.empty) volume = { first: Number(t.attrs.firstid), last: Number(t.attrs.lastid), skip: false };
      } else if (t.name === "metadata" && volume && t.attrs.type === "volume") {
        if (t.attrs.key === "volume_type" && t.attrs.value && t.attrs.value !== "ModelPart") volume.skip = true;
        if (t.attrs.key === "modifier" && t.attrs.value === "1") volume.skip = true;
      }
    }
  }
  return { parts, ranges };
}

const NO_SKIPS: SlicerSkips = { parts: new Map(), ranges: new Map() };

/**
 * A 3MF's placed triangles, in millimetres. `read` gives a file of the zip as text (or undefined if it isn't there);
 * `main` is the main model file's path.
 */
export async function read3mfMeshes(read: (path: string) => Promise<string | undefined>, main: string, skips: SlicerSkips = NO_SKIPS): Promise<MeshSoup> {
  const models = new Map<string, ReturnType<typeof parseModel3mf>>();
  const model = async (path: string) => {
    const key = path.replace(/^\/+/, "").toLowerCase();
    let m = models.get(key);
    if (!m) {
      const xml = await read(key);
      if (xml === undefined) throw new MeshFileError(`a part of it (${path}) is missing`);
      m = parseModel3mf(xml);
      models.set(key, m);
    }
    return m;
  };
  const root = await model(main);
  const scale = UNITS_3MF[root.unit];
  if (scale === undefined) throw new MeshFileError(`it uses a unit JuraCAD doesn't know ("${root.unit}")`);
  if (root.items.length === 0) throw new MeshFileError("it has nothing to print in it (no parts are placed on its plate)");
  const out: number[] = [];
  let objects = 0;
  let skipped = 0;
  const place = async (path: string, id: string, at: Transform3mf, depth: number): Promise<void> => {
    if (depth > 16) throw new MeshFileError("its parts are nested too deeply (or loop round)");
    const m = await model(path);
    const obj = m.objects.get(id);
    if (!obj) throw new MeshFileError(`one of its parts (object ${id}) is missing`);
    if (obj.type === "support" || obj.type === "solidsupport" || obj.type === "other") return;
    if (obj.vertices && obj.triangles && obj.triangles.length > 0) {
      objects++;
      const v = obj.vertices;
      const n = v.length / 3;
      const p = new Float64Array(v.length);
      for (let i = 0; i < n; i++) {
        const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2];
        p[3 * i] = (x * at[0] + y * at[3] + z * at[6] + at[9]) * scale;
        p[3 * i + 1] = (x * at[1] + y * at[4] + z * at[7] + at[10]) * scale;
        p[3 * i + 2] = (x * at[2] + y * at[5] + z * at[8] + at[11]) * scale;
      }
      // A mirroring transform turns triangles inside out: walk them the other way round.
      const flip = determinant(at) < 0;
      const t = obj.triangles;
      // PrusaSlicer's modifier volumes are triangle ranges of the main model's meshes.
      const leave = path === main ? skips.ranges.get(id) : undefined;
      if (leave) skipped += leave.length;
      for (let k = 0; k < t.length; k += 3) {
        if (leave && leave.some(([a, b]) => k / 3 >= a && k / 3 <= b)) continue;
        const a = t[k], b = flip ? t[k + 2] : t[k + 1], c = flip ? t[k + 1] : t[k + 2];
        if (a >= n || b >= n || c >= n) throw new MeshFileError("one of its triangles uses a corner that isn't there");
        out.push(p[3 * a], p[3 * a + 1], p[3 * a + 2], p[3 * b], p[3 * b + 1], p[3 * b + 2], p[3 * c], p[3 * c + 1], p[3 * c + 2]);
      }
      if (out.length / 9 > MOST_3MF_TRIANGLES) throw new MeshFileError("it has far too many triangles");
    }
    const leaveParts = depth === 0 && path === main ? skips.parts.get(id) : undefined;
    for (const c of obj.components ?? []) {
      if (leaveParts?.has(c.objectid)) {
        skipped++;
        continue;
      }
      await place(c.path ?? path, c.objectid, composeTransforms(c.transform, at), depth + 1);
    }
  };
  for (const item of root.items) await place(item.path ?? main, item.objectid, item.transform, 0);
  if (out.length === 0 && skipped > 0) throw new MeshFileError("it only has slicer settings parts in it (modifiers or negative parts), no shape");
  return { corners: Float64Array.from(out), objects, ...(scale !== 1 ? { unitMm: scale } : {}), ...(skipped ? { skipped } : {}) };
}

function determinant(m: Transform3mf): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/** Inflate a raw-deflated zip entry (in the browser and Node alike). */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).DecompressionStream;
  const tooOld = new MeshFileError("this browser is too old to open 3MF files (update it, or export the model as STL)");
  if (!DS) throw tooOld;
  let stream: ReadableWritablePair<Uint8Array, Uint8Array>;
  try {
    // (Browsers from before 2023 — Safari before 16.4, Firefox before 113 — have no "deflate-raw".)
    stream = new DS("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  } catch {
    throw tooOld;
  }
  const out = new Response(new Blob([new Uint8Array(data)]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A whole 3MF file's triangles, in millimetres. */
export async function read3mf(bytes: Uint8Array): Promise<MeshSoup> {
  const entries = zipEntries(bytes);
  const decoder = new TextDecoder();
  const read = async (path: string): Promise<string | undefined> => {
    const e = entries.get(path.replace(/^\/+/, "").toLowerCase());
    if (!e) return undefined;
    if (e.method === 0) return decoder.decode(e.data);
    if (e.method !== 8) throw new MeshFileError("it's packed in a way JuraCAD can't unpack");
    try {
      return decoder.decode(await inflateRaw(e.data));
    } catch (err) {
      if (err instanceof MeshFileError) throw err;
      throw new MeshFileError("it's damaged (a part of it can't be unpacked)");
    }
  };
  const skips = slicerSkips(await read("Metadata/model_settings.config"), await read("Metadata/Slic3r_PE_model.config"));
  return read3mfMeshes(read, mainModelPath(await read("_rels/.rels")), skips);
}

// ---------------------------------------------------------------------------------------------------------------
// OBJ

/** An OBJ file's triangles (its numbers as they are: OBJ files have no units). */
export function readObj(text: string): MeshSoup {
  const v: number[] = [];
  const out: number[] = [];
  let objects = 0;
  let facesInObject = false;
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);
    const kind = parts[0];
    if (kind === "v") {
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if (![x, y, z].every(Number.isFinite)) throw new MeshFileError(`line ${ln + 1} has a corner JuraCAD can't read`);
      v.push(x, y, z);
    } else if (kind === "o" || kind === "g") {
      facesInObject = false;
    } else if (kind === "f") {
      const n = v.length / 3;
      const idx = parts.slice(1).map((p) => {
        const i = parseInt(p.split("/")[0], 10);
        const at = i < 0 ? n + i : i - 1;
        if (!Number.isInteger(i) || i === 0 || at < 0 || at >= n) throw new MeshFileError(`line ${ln + 1} has a face with a corner that isn't there`);
        return at;
      });
      if (idx.length < 3) continue;
      if (!facesInObject) {
        objects++;
        facesInObject = true;
      }
      // Fanned from the first corner (faces in OBJ files are flat and nearly always convex).
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const c of [idx[0], idx[k], idx[k + 1]]) out.push(v[3 * c], v[3 * c + 1], v[3 * c + 2]);
      }
    }
  }
  if (out.length === 0) throw new MeshFileError(v.length ? "it has corners but no faces (perhaps it's only points or lines)" : "it has no shapes in it");
  return { corners: Float64Array.from(out), objects };
}
