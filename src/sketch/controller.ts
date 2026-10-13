/**
 * Sketch tools: turns pointer events (already converted to sketch mm by the
 * viewport) into sketch edits, and keeps the live preview (rubber-band line,
 * snap marker) for the viewport to draw.
 */
import { useStore, type SketchTool } from "../model/store";
import { hitTest, inferOrientation, type Hit } from "./hit";
import { offsetFor } from "./layout";
import {
  addArc,
  addCircle,
  addDimension,
  addLine,
  addPoint,
  addRectangle,
  circleThrough,
  curveById,
  dimensionFor,
  dragCircleRim,
  dragCurve,
  dragPoint,
  pointPos,
  radiusOf,
  type Placed,
} from "./ops";
import { addPolygon, addSlot, filletCorner, trimAt } from "./tools";
import { ORIGIN_ID, type SketchData } from "./types";

export interface SketchPointer {
  /** Sketch coordinates (mm). */
  x: number;
  y: number;
  /** Millimetres per screen pixel at the current zoom. */
  mmPerPx: number;
  shift: boolean;
  ctrl: boolean;
}

/** Temporary shapes drawn while a tool is in progress. */
export type PreviewShape =
  | { kind: "line"; a: [number, number]; b: [number, number] }
  | { kind: "circle"; c: [number, number]; r: number }
  | { kind: "arc"; c: [number, number]; r: number; a0: number; a1: number };

export interface SketchTransient {
  hover: Hit | null;
  preview: PreviewShape[];
  /** Where the pointer has snapped to (drawn as a small marker). */
  snap: [number, number] | null;
  /** "H" / "V" shown while a line is snapping horizontal or vertical. */
  inference: { at: [number, number]; text: string } | null;
  /** Items picked so far by the dimension tool. */
  pending: string[];
}

const POINT_PX = 9;
const CURVE_PX = 6;
const DRAG_PX = 3;

interface DragState {
  kind: "point" | "curve" | "rim" | "none";
  id: string;
  start: SketchData;
  startX: number;
  startY: number;
  moved: boolean;
  additive: boolean;
  hit: Hit | null;
}

export class SketchController {
  private transient: SketchTransient = { hover: null, preview: [], snap: null, inference: null, pending: [] };
  /** Clicks collected so far by the current drawing tool. */
  private placed: Placed[] = [];
  private drag: DragState | null = null;
  private lastTool: SketchTool | null = null;
  private readonly listeners = new Set<(t: SketchTransient) => void>();

  onChange(fn: (t: SketchTransient) => void): () => void {
    this.listeners.add(fn);
    fn(this.transient);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<SketchTransient>) {
    this.transient = { ...this.transient, ...patch };
    for (const fn of this.listeners) fn(this.transient);
  }

  // ---------------------------------------------------------------------------
  // Store access

  private get state() {
    return useStore.getState();
  }

  private get data(): SketchData | null {
    return this.state.editing?.draft.sketch?.data ?? null;
  }

  private get tool(): SketchTool {
    const tool = this.state.sketch?.tool ?? "select";
    if (tool !== this.lastTool) {
      // Switching tools abandons anything half-drawn.
      this.lastTool = tool;
      this.placed = [];
      this.transient = { ...this.transient, preview: [], inference: null, pending: [] };
    }
    return tool;
  }

  private commit(result: { sketch: SketchData; error?: string }, selection?: string[]): boolean {
    if (result.error) {
      this.state.setSketchMessage(result.error, "error");
      return false;
    }
    this.state.updateSketch(result.sketch, { record: true, selection });
    this.state.setSketchMessage(null);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Snapping

  private hitAt(e: SketchPointer, ignore?: Set<string>): Hit | null {
    const d = this.data;
    if (!d) return null;
    return hitTest(d, e.x, e.y, POINT_PX * e.mmPerPx, CURVE_PX * e.mmPerPx, { ignore });
  }

  /** Where a click lands, snapped to points, the origin or curves. */
  private placeAt(e: SketchPointer): Placed {
    const d = this.data!;
    const hit = this.hitAt(e);
    if (hit?.kind === "point") {
      const [x, y] = pointPos(d, hit.id);
      return { x, y, snap: hit.id === ORIGIN_ID ? { kind: "origin" } : { kind: "point", id: hit.id } };
    }
    if (hit?.kind === "curve") {
      const c = curveById(d, hit.id)!;
      let [x, y] = [e.x, e.y];
      if (c.type === "line") {
        const [ax, ay] = pointPos(d, c.p1);
        const [bx, by] = pointPos(d, c.p2);
        const dx = bx - ax, dy = by - ay;
        const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
        [x, y] = [ax + t * dx, ay + t * dy];
      } else {
        const [cx, cy] = pointPos(d, c.center);
        const r = radiusOf(d, c);
        const a = Math.atan2(y - cy, x - cx);
        [x, y] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }
      return { x, y, snap: { kind: "curve", id: c.id } };
    }
    return { x: e.x, y: e.y, snap: null };
  }

  private snapMarker(p: Placed): [number, number] | null {
    return p.snap ? [p.x, p.y] : null;
  }

  // ---------------------------------------------------------------------------
  // Pointer events

  pointerDown(e: SketchPointer): void {
    const d = this.data;
    if (!d) return;
    const tool = this.tool;
    if (tool === "select") return this.selectDown(e);
    if (tool === "dimension") return this.dimensionClick(e);
    if (tool === "trim") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage("Click the part of a line, arc or circle you want to cut away.", "info");
        return;
      }
      this.commit(trimAt(d, hit.id, { x: e.x, y: e.y }), []);
      this.emit({ hover: null });
      return;
    }
    if (tool === "sketchFillet") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "point" || hit.id === ORIGIN_ID) {
        this.state.setSketchMessage("Click the corner point where two lines meet.", "info");
        return;
      }
      const r = filletCorner(d, hit.id, this.state.sketch?.filletRadius ?? "2");
      this.commit(r, r.arcId ? [r.arcId] : []);
      return;
    }

    const p = this.placeAt(e);
    const construction = this.state.sketch?.construction ?? false;

    switch (tool) {
      case "point": {
        const r = addPoint(d, p);
        this.commit(r, [r.pointId]);
        return;
      }
      case "line": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const start = this.placed[0];
        let end = p;
        let orientation: "horizontal" | "vertical" | null = null;
        if (!p.snap) {
          const inf = inferOrientation(start.x, start.y, p.x, p.y);
          end = { x: inf.x, y: inf.y, snap: null };
          orientation = inf.orientation;
        }
        const r = addLine(d, start, end, { construction, orientation });
        if (!this.commit(r)) return;
        // Keep drawing from the new end, unless we just closed the shape.
        const closed = p.snap?.kind === "point" || p.snap?.kind === "origin";
        this.placed = closed ? [] : [{ ...end, snap: { kind: "point", id: r.endId } }];
        this.emit({ preview: [], inference: null });
        return;
      }
      case "rectangle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addRectangle(d, this.placed[0], p, construction);
        if (this.commit(r)) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
      case "circle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const c = this.placed[0];
        const r = addCircle(d, c, Math.hypot(p.x - c.x, p.y - c.y), construction);
        if (this.commit(r, [r.circleId])) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
      case "slot": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const [a, b] = this.placed;
        const r = addSlot(d, a, b, slotRadius(a, b, p), construction);
        if (this.commit(r, r.curveIds)) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
      case "polygon": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addPolygon(d, this.placed[0], p, this.state.sketch?.polygonSides ?? 6, construction);
        if (this.commit(r, r.lineIds)) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
      case "arc": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const r = addArc(d, this.placed[0], this.placed[1], { x: p.x, y: p.y }, construction);
        if (this.commit(r, [r.arcId])) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
    }
  }

  pointerMove(e: SketchPointer, dragging: boolean): void {
    const d = this.data;
    if (!d) return;
    const tool = this.tool;
    if (tool === "select") {
      if (dragging && this.drag) return this.selectDrag(e);
      this.emit({ hover: this.hitAt(e), preview: [], snap: null, inference: null });
      return;
    }
    if (tool === "dimension" || tool === "trim" || tool === "sketchFillet") {
      const hit = this.hitAt(e);
      this.emit({ hover: tool === "trim" && hit?.kind !== "curve" ? null : hit, snap: null, preview: [] });
      return;
    }

    const p = this.placeAt(e);
    const preview: PreviewShape[] = [];
    let inference: SketchTransient["inference"] = null;
    let snap = this.snapMarker(p);
    const first = this.placed[0];
    if (tool === "line" && first) {
      let end: [number, number] = [p.x, p.y];
      if (!p.snap) {
        const inf = inferOrientation(first.x, first.y, p.x, p.y);
        end = [inf.x, inf.y];
        if (inf.orientation) {
          inference = { at: end, text: inf.orientation === "horizontal" ? "H" : "V" };
          snap = end;
        }
      }
      preview.push({ kind: "line", a: [first.x, first.y], b: end });
    } else if (tool === "rectangle" && first) {
      const a: [number, number] = [first.x, first.y];
      const c: [number, number] = [p.x, p.y];
      const b: [number, number] = [c[0], a[1]];
      const dd: [number, number] = [a[0], c[1]];
      preview.push({ kind: "line", a, b }, { kind: "line", a: b, b: c }, { kind: "line", a: c, b: dd }, { kind: "line", a: dd, b: a });
    } else if (tool === "slot" && first) {
      if (this.placed.length === 1) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else preview.push(...slotPreview(first, this.placed[1], slotRadius(first, this.placed[1], p)));
    } else if (tool === "polygon" && first) {
      const n = Math.max(3, Math.min(64, Math.round(this.state.sketch?.polygonSides ?? 6)));
      const R = Math.hypot(p.x - first.x, p.y - first.y);
      const a0 = Math.atan2(p.y - first.y, p.x - first.x);
      const corner = (i: number): [number, number] => [first.x + R * Math.cos(a0 + (2 * Math.PI * i) / n), first.y + R * Math.sin(a0 + (2 * Math.PI * i) / n)];
      for (let i = 0; i < n; i++) preview.push({ kind: "line", a: corner(i), b: corner(i + 1) });
    } else if (tool === "circle" && first) {
      preview.push({ kind: "circle", c: [first.x, first.y], r: Math.hypot(p.x - first.x, p.y - first.y) });
    } else if (tool === "arc" && first) {
      if (this.placed.length === 1) {
        preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      } else {
        const second = this.placed[1];
        const centre = circleThrough([first.x, first.y], [p.x, p.y], [second.x, second.y]);
        if (centre) {
          const r = Math.hypot(first.x - centre[0], first.y - centre[1]);
          const cross = (second.x - first.x) * (p.y - first.y) - (second.y - first.y) * (p.x - first.x);
          const [from, to] = cross < 0 ? [first, second] : [second, first];
          preview.push({
            kind: "arc",
            c: centre,
            r,
            a0: Math.atan2(from.y - centre[1], from.x - centre[0]),
            a1: Math.atan2(to.y - centre[1], to.x - centre[0]),
          });
        } else preview.push({ kind: "line", a: [first.x, first.y], b: [second.x, second.y] });
      }
    }
    this.emit({ hover: p.snap?.kind === "curve" ? { kind: "curve", id: p.snap.id } : null, preview, snap, inference });
  }

  pointerUp(): void {
    if (this.tool !== "select" || !this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.moved) {
      this.state.recordSketchStep(drag.start);
      return;
    }
    // A click without dragging: select.
    const sel = this.state.sketch?.selection ?? [];
    if (!drag.hit) {
      if (!drag.additive) this.state.setSketchSelection([]);
      return;
    }
    const id = drag.hit.id;
    if (drag.additive) this.state.setSketchSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else this.state.setSketchSelection(sel.length === 1 && sel[0] === id ? [] : [id]);
  }

  pointerLeave(): void {
    this.emit({ hover: null, snap: null, inference: null });
  }

  /** Esc: abandon a half-drawn shape. Returns true if there was one. */
  cancel(): boolean {
    const had = this.placed.length > 0 || this.transient.pending.length > 0 || this.drag !== null;
    if (this.drag?.moved) this.state.updateSketch(this.drag.start, { record: false });
    this.placed = [];
    this.drag = null;
    this.emit({ preview: [], inference: null, pending: [], snap: null });
    return had;
  }

  // ---------------------------------------------------------------------------
  // Select tool: click to select, drag to move

  private selectDown(e: SketchPointer) {
    const d = this.data!;
    const hit = this.hitAt(e);
    let kind: DragState["kind"] = "none";
    if (hit?.kind === "point" && hit.id !== ORIGIN_ID) kind = "point";
    if (hit?.kind === "curve") {
      const c = curveById(d, hit.id)!;
      // Dragging a circle's rim resizes it; drag its centre point to move it.
      kind = c.type === "circle" ? "rim" : "curve";
    }
    this.drag = { kind, id: hit?.id ?? "", start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit };
  }

  private selectDrag(e: SketchPointer) {
    const drag = this.drag!;
    if (drag.kind === "none") return;
    if (!drag.moved && Math.hypot(e.x - drag.startX, e.y - drag.startY) < DRAG_PX * e.mmPerPx) return;
    drag.moved = true;
    let next = drag.start;
    if (drag.kind === "point") next = dragPoint(drag.start, drag.id, e.x, e.y);
    else if (drag.kind === "curve") next = dragCurve(drag.start, drag.id, e.x - drag.startX, e.y - drag.startY);
    else {
      const c = curveById(drag.start, drag.id);
      if (c?.type === "circle") {
        const [cx, cy] = pointPos(drag.start, c.center);
        next = dragCircleRim(drag.start, c.id, Math.hypot(e.x - cx, e.y - cy));
      }
    }
    this.state.updateSketch(next, { record: false });
  }

  // ---------------------------------------------------------------------------
  // Dimension tool: pick one or two things, then click where the value goes

  private dimensionClick(e: SketchPointer) {
    const d = this.data!;
    const hit = this.hitAt(e);
    const pending = this.transient.pending;
    if (hit && pending.length < 2 && !pending.includes(hit.id)) {
      const next = [...pending, hit.id];
      // Only keep a second pick if it makes a valid pair; otherwise start again with it.
      const ok = next.length === 1 || typeof dimensionFor(d, next) !== "string";
      this.emit({ pending: ok ? next : [hit.id] });
      this.state.setSketchMessage("Now click where the dimension should go.", "info");
      return;
    }
    if (pending.length === 0) {
      this.state.setSketchMessage("Click a line, circle or arc — or two points, a point and a line, or two lines.", "info");
      return;
    }
    const spec = dimensionFor(d, pending);
    if (typeof spec === "string") {
      this.state.setSketchMessage(spec, "error");
      this.emit({ pending: [] });
      return;
    }
    const offset = offsetFor(d, { id: "tmp", ...spec }, [e.x, e.y]);
    const r = addDimension(d, pending, offset);
    this.emit({ pending: [] });
    if (this.commit(r)) this.state.setEditingDimension(r.dimensionId);
  }
}

/** Half the slot's width: how far the third click is from the line through the two centres. */
function slotRadius(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / (Math.hypot(dx, dy) || 1);
}

function slotPreview(a: { x: number; y: number }, b: { x: number; y: number }, r: number): PreviewShape[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * r, ny = (dx / L) * r;
  const ang = Math.atan2(ny, nx);
  return [
    { kind: "line", a: [a.x + nx, a.y + ny], b: [b.x + nx, b.y + ny] },
    { kind: "line", a: [a.x - nx, a.y - ny], b: [b.x - nx, b.y - ny] },
    { kind: "arc", c: [a.x, a.y], r, a0: ang, a1: ang + Math.PI },
    { kind: "arc", c: [b.x, b.y], r, a0: ang + Math.PI, a1: ang },
  ];
}
