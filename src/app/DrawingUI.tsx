/**
 * The drawing tab: a sheet with views of a part (or an assembly) and a title
 * block, its settings panel and toolbar, and saving it as PDF or SVG.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { arrangeViews, putDimension, removeDimension, SHEET_SIZES, toggleView, VIEW_KINDS, VIEW_LABELS } from "../drawing/drawing";
import { sheetDxf, sheetPdf, sheetSvg } from "../drawing/export";
import { surfacePointNearCentre } from "../drawing/annotations";
import { applyPlacement } from "../assembly/math";
import { bottomReserve, drawingViewKeys, fitScale, layoutSheet, type Projections, type BomLine, type SheetInfo, scaleLabel, STANDARD_SCALES, SHEETS, LINE_STYLES, toSheet as toSheetPoint, type Prim, type SheetLayout } from "../drawing/sheet";
import { dimPoint, dragDimension, drawDimension, measureDim, placeLength, resolveDim, snapPoints } from "../drawing/dimensions";
import { newId } from "../model/document";
import { billOfMaterials } from "../assembly/assembly";
import { getKernel } from "../kernel/connect";
import type { InstanceInput, PartMesh } from "../kernel/protocol";
import { activeDrawing, partsInStudio, useStore } from "../model/store";
import { studiosOf } from "../model/studios";
import type { Dimension, Drawing, PartSmithDocument, SectionCut } from "../model/types";
import { addSection, removeSection, SECTION_HOSTS, sectionRequests, toRel, updateSection } from "../drawing/sections";
import { explodeAssembly, instancesForKernel } from "./assemblySolve";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { detectPlatform, shortcut } from "./platform";


/** What a drawing shows, ready for the geometry engine (null when its part has gone). */
function drawingSubject(
  drawing: Drawing,
  doc: PartSmithDocument,
  parts: PartMesh[],
): { name: string; partIds: string[]; instances?: InstanceInput[]; key: unknown[] } | null {
  const src = drawing.source;
  if (!src) return null;
  if (src.kind === "part") {
    const part = parts.find((p) => p.id === src.id);
    return part ? { name: part.name, partIds: [part.id], key: [part] } : null;
  }
  const asm = doc.assemblies?.find((a) => a.id === src.id);
  if (!asm) return null;
  let instances = instancesForKernel(asm, parts);
  if (drawing.exploded) {
    const spread = explodeAssembly(asm, parts, Object.fromEntries(instances.map((i) => [i.id, { position: i.position, rotation: i.rotation }])), asm.explode ?? 1);
    instances = instances.map((i) => ({ ...i, position: spread[i.id]?.position ?? i.position }));
  }
  return { name: asm.name, partIds: [], instances, key: [JSON.stringify(instances), ...parts.filter((p) => instances.some((i) => i.partId === p.id))] };
}

/** The parts list for an assembly drawing (none for a part). */
function bomFor(drawing: Drawing, doc: PartSmithDocument, parts: PartMesh[]): BomLine[] | undefined {
  if (drawing.source?.kind !== "assembly") return undefined;
  const asm = doc.assemblies?.find((a) => a.id === drawing.source!.id);
  if (!asm) return undefined;
  const names = Object.fromEntries(parts.map((p) => [p.id, p.name]));
  return billOfMaterials(asm, names).map((r, i) => ({ item: i + 1, name: r.name, quantity: r.quantity, partId: r.partId }));
}

/** A spot on one copy of each listed part, for the balloons to point at. */
function balloonsFor(bom: BomLine[] | undefined, instances: InstanceInput[] | undefined, parts: PartMesh[]): SheetInfo["balloons"] {
  if (!bom?.length || !instances?.length) return undefined;
  const out: NonNullable<SheetInfo["balloons"]> = [];
  for (const row of bom) {
    const inst = instances.find((i) => i.partId === row.partId);
    const mesh = parts.find((p) => p.id === row.partId);
    const spot = mesh ? surfacePointNearCentre(mesh.vertices) : null;
    if (inst && spot) out.push({ item: row.item, at: applyPlacement({ position: inst.position, rotation: inst.rotation }, spot) });
  }
  return out;
}

/** Projections already worked out, by drawing (kept while switching tabs). */
const projectionCache = new Map<string, { key: unknown[]; result: Projections }>();
const inFlight = new Map<string, { key: unknown[]; promise: Promise<Projections> }>();
const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The drawing's views from the geometry engine, refreshed when the part or the chosen views change. */
function useProjections(drawing: Drawing): { projections: Projections | null; subject: string | null; instances?: InstanceInput[]; busy: boolean; error: string | null } {
  const doc = useStore((s) => s.history.present);
  const parts = useStore((s) => s.parts);
  const ready = useStore((s) => s.kernelStatus === "ready");
  const subject = drawingSubject(drawing, doc, parts);
  const kinds = drawing.views.map((v) => v.kind).filter((k) => k !== "section");
  const sections = sectionRequests(drawing);
  // The same key object while nothing it's made of changes, so the effect below only runs on real changes.
  const rawKey = subject ? [...subject.key, kinds.join(","), drawing.hiddenLines, JSON.stringify(sections)] : null;
  const keyRef = useRef<unknown[] | null>(null);
  if (!rawKey) keyRef.current = null;
  else if (!keyRef.current || !sameKey(keyRef.current, rawKey)) keyRef.current = rawKey;
  const key = keyRef.current;
  const cached = key ? projectionCache.get(drawing.id) : undefined;
  const fresh = cached && key && sameKey(cached.key, key) ? cached.result : null;
  const [state, setState] = useState<{ result: Projections | null; error: string | null; busy: boolean }>({ result: fresh, error: null, busy: false });

  useEffect(() => {
    if (!key || !subject || !ready) return;
    const hit = projectionCache.get(drawing.id);
    if (hit && sameKey(hit.key, key)) {
      setState({ result: hit.result, error: null, busy: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    // Share one request between the panel and the sheet.
    let job = inFlight.get(drawing.id);
    if (!job || !sameKey(job.key, key)) {
      const kernel = getKernel();
      const promise = kernel
        .whenIdle()
        .then(() => kernel.project(subject.partIds, subject.instances, kinds, drawing.hiddenLines, sections))
        .then((list) => {
          const result: Projections = {};
          for (const p of list) result[p.kind] = p;
          projectionCache.set(drawing.id, { key, result });
          return result;
        });
      promise.finally(() => inFlight.get(drawing.id)?.promise === promise && inFlight.delete(drawing.id)).catch(() => {});
      job = { key, promise };
      inFlight.set(drawing.id, job);
    }
    job.promise.then(
        (result) => {
          if (live) setState({ result, error: null, busy: false });
        },
        (e: unknown) => live && setState({ result: null, error: e instanceof Error ? e.message : String(e), busy: false }),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, drawing.id]);

  return { projections: state.result ?? fresh, subject: subject?.name ?? null, instances: subject?.instances, busy: state.busy, error: state.error };
}

/** The sheet as last laid out on screen (for saving). */
let shownSheet: { drawingId: string; layout: SheetLayout; name: string } | null = null;

function today(): string {
  return new Date().toLocaleDateString("en-GB");
}

/** Save the drawing on show as a PDF or SVG file. */
export function exportDrawing(format: "pdf" | "svg" | "dxf") {
  const s = useStore.getState();
  const d = activeDrawing(s);
  if (!d || !shownSheet || shownSheet.drawingId !== d.id) {
    s.showToast("The drawing isn't ready yet — wait for its views to appear, then try again.", "error");
    return;
  }
  const base = safeFileName(`${s.history.present.name} ${d.name}`, "drawing");
  const title = `${s.history.present.name} — ${d.name}`;
  if (format === "pdf") downloadFile(new Blob([sheetPdf(shownSheet.layout.prims, shownSheet.layout.size, title) as BlobPart], { type: "application/pdf" }), `${base}.pdf`);
  else if (format === "svg") downloadFile(new Blob([sheetSvg(shownSheet.layout.prims, shownSheet.layout.size, title)], { type: "image/svg+xml" }), `${base}.svg`);
  else downloadFile(new Blob([sheetDxf(shownSheet.layout.prims)], { type: "application/dxf" }), `${base}.dxf`);
  s.showToast(`Saved ${base}.${format}`, "success");
}

function ToolButton({ label, icon, onClick, disabled, title }: { label: string; icon: ReactNode; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button className="tool-button" onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function DrawingToolbar() {
  const tool = useStore((s) => s.drawingTool);
  const canUndo = useStore((s) => s.history.past.length > 0);
  const canRedo = useStore((s) => s.history.future.length > 0);
  const platform = detectPlatform();
  return (
    <div className="toolbar" role="toolbar" aria-label="Drawing tools">
      <div className="tool-group">
        <ToolButton label="Undo" icon={<Icons.Undo />} onClick={() => useStore.getState().undo()} disabled={!canUndo} title={`Undo (${shortcut(platform, "Z")})`} />
        <ToolButton label="Redo" icon={<Icons.Redo />} onClick={() => useStore.getState().redo()} disabled={!canRedo} title="Redo" />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolButton label="PDF" icon={<Icons.Export />} onClick={() => exportDrawing("pdf")} title="Save the drawing as a PDF, ready to print or send (true size)" />
        <ToolButton label="SVG" icon={<Icons.Export />} onClick={() => exportDrawing("svg")} title="Save the drawing as an SVG picture (true size, opens in drawing programs)" />
        <ToolButton label="DXF" icon={<Icons.Export />} onClick={() => exportDrawing("dxf")} title="Save the drawing as a DXF file (for other CAD programs, laser cutters and CNC)" />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <button
          className={`tool-button${tool === "dimension" ? " active" : ""}`}
          onClick={() => useStore.getState().setDrawingTool(tool === "dimension" ? "select" : "dimension")}
          title="Dimension (D) — click two corners, an edge, or a circle. Drag a dimension's number to move it; Delete removes it"
          aria-label="Dimension"
          aria-pressed={tool === "dimension"}
        >
          <Icons.Dimension />
          <span>Dimension</span>
        </button>
        <button
          className={`tool-button${tool === "section" ? " active" : ""}`}
          onClick={() => useStore.getState().setDrawingTool(tool === "section" ? "select" : "section")}
          title="Section — click two points across the front, top or a side view to cut the part open there. Flip or remove sections in the panel"
          aria-label="Section"
          aria-pressed={tool === "section"}
        >
          <Icons.Section />
          <span>Section</span>
        </button>
        <ToolButton
          label="Arrange"
          icon={<Icons.Fit />}
          onClick={() => useStore.getState().changeDrawing(arrangeViews)}
          title="Put every view back in its standard place"
        />
      </div>
    </div>
  );
}

/** A text box that saves on Enter or when you leave it (one undo step). */
function TitleField({ label, value, placeholder, multiline, onCommit }: { label: string; value: string; placeholder?: string; multiline?: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = `drawing-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const commit = () => text !== value && onCommit(text);
  return (
    <div className="drawing-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} value={text} rows={3} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <input
          id={id}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      )}
    </div>
  );
}

export function DrawingPanel({ drawing }: { drawing: Drawing }) {
  const doc = useStore((s) => s.history.present);
  const parts = useStore((s) => s.parts);
  const change = useStore((s) => s.changeDrawing);
  const { projections, subject } = useProjections(drawing);
  const auto = projections
    ? fitScale(projections, drawingViewKeys(drawing), drawing.sheet, bottomReserve(drawing, bomFor(drawing, doc, parts)))
    : null;
  const studios = studiosOf(doc);
  const sourceValue = drawing.source ? `${drawing.source.kind}:${drawing.source.id}` : "";

  return (
    <aside className="side-panel drawing-panel" aria-label="Drawing settings">
      <section className="panel-section">
        <h3>Drawing</h3>
        <div className="drawing-fields">
          <div className="drawing-field">
            <label htmlFor="drawing-source">Drawing of</label>
            <select
              id="drawing-source"
              value={sourceValue}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                const id = rest.join(":");
                change((d) => ({ ...arrangeViews(d), source: kind === "part" || kind === "assembly" ? { kind, id } : null }));
              }}
            >
              {!drawing.source && <option value="">Choose a part…</option>}
              {drawing.source && !subject && <option value={sourceValue}>(missing — choose another)</option>}
              {studios.map((st) => {
                const mine = partsInStudio(parts, st.id);
                return mine.length ? (
                  <optgroup key={st.id} label={st.name}>
                    {mine.map((p) => (
                      <option key={p.id} value={`part:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
              {(doc.assemblies ?? []).length > 0 && (
                <optgroup label="Assemblies">
                  {doc.assemblies!.map((a) => (
                    <option key={a.id} value={`assembly:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="drawing-field">
            <span className="field-label">Sheet</span>
            <div className="segmented three" role="radiogroup" aria-label="Sheet size">
              {SHEET_SIZES.map((size) => (
                <button
                  type="button"
                  key={size}
                  role="radio"
                  aria-checked={drawing.sheet === size}
                  className={drawing.sheet === size ? "selected" : ""}
                  onClick={() => change((d) => ({ ...arrangeViews(d), sheet: size }))}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          <div className="drawing-field">
            <label htmlFor="drawing-scale">Scale</label>
            <select
              id="drawing-scale"
              value={drawing.scale ? String(drawing.scale) : "fit"}
              onChange={(e) =>
                change((d) => {
                  const { scale: _old, ...rest } = arrangeViews(d);
                  return e.target.value === "fit" ? rest : { ...rest, scale: Number(e.target.value) };
                })
              }
            >
              <option value="fit">Fit to sheet{auto ? ` (${scaleLabel(auto.scale)})` : ""}</option>
              {STANDARD_SCALES.map((sc) => (
                <option key={sc} value={String(sc)}>
                  {scaleLabel(sc)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
      <section className="panel-section">
        <h3>Views</h3>
        <div className="drawing-views">
          {VIEW_KINDS.map((k) => (
            <label key={k} className="check-row">
              <input type="checkbox" checked={drawing.views.some((v) => v.kind === k)} onChange={() => change((d) => toggleView(d, k))} />
              {VIEW_LABELS[k]}
            </label>
          ))}
          <label className="check-row">
            <input type="checkbox" checked={drawing.hiddenLines} onChange={(e) => change((d) => ({ ...d, hiddenLines: e.target.checked }))} />
            Show hidden lines (dashed)
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={drawing.centreLines !== false}
              onChange={(e) =>
                change((d) => {
                  const { centreLines: _old, ...rest } = d;
                  return e.target.checked ? rest : { ...rest, centreLines: false };
                })
              }
            />
            Centre lines on holes and round parts
          </label>
          {drawing.source?.kind === "assembly" && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={drawing.balloons !== false}
                onChange={(e) =>
                  change((d) => {
                    const { balloons: _old, ...rest } = d;
                    return e.target.checked ? rest : { ...rest, balloons: false };
                  })
                }
              />
              Numbered balloons (match the parts list)
            </label>
          )}
          {drawing.source?.kind === "assembly" && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!drawing.exploded}
                onChange={(e) =>
                  change((d) => {
                    const { exploded: _old, ...rest } = arrangeViews(d);
                    return e.target.checked ? { ...rest, exploded: true } : rest;
                  })
                }
              />
              Exploded (parts spread apart)
            </label>
          )}
        </div>
      </section>
      <SectionsList drawing={drawing} change={change} />
      <section className="panel-section">
        <h3>Title block</h3>
        <div className="drawing-fields">
          <TitleField label="Title" value={drawing.title.title ?? ""} placeholder={subject ?? ""} onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, title: v.trim() || undefined } }))} />
          <TitleField label="Drawn by" value={drawing.title.drawnBy ?? ""} onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, drawnBy: v.trim() || undefined } }))} />
          <TitleField label="Material" value={drawing.title.material ?? ""} placeholder="e.g. Nylon PA12, Stainless 316" onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, material: v.trim() || undefined } }))} />
          <TitleField label="Notes" multiline value={drawing.title.notes ?? ""} placeholder="One note per line" onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, notes: v.trim() || undefined } }))} />
        </div>
      </section>
    </aside>
  );
}

/** The drawing's section cuts: flip which way each looks, or remove it. */
function SectionsList({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const sections = drawing.sections ?? [];
  return (
    <section className="panel-section">
      <h3>Sections</h3>
      <div className="drawing-views">
        {sections.length === 0 && (
          <p className="panel-hint">
            To cut the part open, choose <strong>Section</strong> in the toolbar, then click two points across the front, top or side view.
          </p>
        )}
        {sections.map((s: SectionCut) => (
          <div className="section-row" key={s.id}>
            <span>
              Section {s.letter}-{s.letter} <span className="muted small">(on {VIEW_LABELS[s.host]})</span>
            </span>
            <span className="row-actions-inline">
              <button
                type="button"
                className="text-button small-text"
                onClick={() => change((d) => updateSection(d, s.id, (c) => ({ ...c, flip: !c.flip })))}
                title="Look the other way (keep the other side of the cut)"
                aria-label={`Flip section ${s.letter}`}
              >
                Flip
              </button>
              <button
                type="button"
                className="text-button small-text danger-text"
                onClick={() => change((d) => removeSection(d, s.id))}
                title="Remove this section and its view"
                aria-label={`Remove section ${s.letter}`}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

type P2 = [number, number];

/** Something on a view a dimension can attach to, in view and sheet coordinates. */
type Snap =
  | { kind: "point"; view: string; at: P2; sheet: P2 }
  | { kind: "line"; view: string; a: P2; b: P2; sheetA: P2; sheetB: P2 }
  | { kind: "circle"; view: string; centre: P2; r: number; full: boolean; sheet: P2; sheetR: number };

function snapsOf(layout: SheetLayout, projections: Projections): Snap[] {
  const out: Snap[] = [];
  for (const v of layout.views) {
    const p = projections[v.key];
    if (!p) continue;
    const at = (q: P2) => toSheetPoint(v, p, layout.scale, q[0], q[1]);
    for (const q of snapPoints(p)) out.push({ kind: "point", view: v.key, at: q, sheet: at(q) });
    for (const c of p.circles) if (!c.hidden) out.push({ kind: "circle", view: v.key, centre: [c.cx, c.cy], r: c.r, full: c.full, sheet: at([c.cx, c.cy]), sheetR: c.r * layout.scale });
    for (const l of p.visible) if (l.length === 4) out.push({ kind: "line", view: v.key, a: [l[0], l[1]], b: [l[2], l[3]], sheetA: at([l[0], l[1]]), sheetB: at([l[2], l[3]]) });
  }
  return out;
}

function segDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The nearest thing to attach to: points first, then circle outlines, then straight edges. */
function findSnap(snaps: Snap[], at: P2, tol: number): Snap | null {
  let best: Snap | null = null;
  let bestD = tol;
  for (const s of snaps) if (s.kind === "point" && Math.hypot(s.sheet[0] - at[0], s.sheet[1] - at[1]) < bestD) {
    best = s;
    bestD = Math.hypot(s.sheet[0] - at[0], s.sheet[1] - at[1]);
  }
  if (best) return best;
  for (const s of snaps) if (s.kind === "circle" && Math.abs(Math.hypot(s.sheet[0] - at[0], s.sheet[1] - at[1]) - s.sheetR) < bestD) {
    best = s;
    bestD = Math.abs(Math.hypot(s.sheet[0] - at[0], s.sheet[1] - at[1]) - s.sheetR);
  }
  if (best) return best;
  for (const s of snaps) if (s.kind === "line" && segDist(at, s.sheetA, s.sheetB) < bestD) {
    best = s;
    bestD = segDist(at, s.sheetA, s.sheetB);
  }
  return best;
}

/** A dimension being made: its view and first point, then its second. */
type Pending = { view: string; a: P2; b?: P2 };

/** The sheet itself, with views you can drag about. Scroll to zoom, middle- or right-drag to pan. */
export function DrawingSheet({ drawing }: { drawing: Drawing }) {
  const docName = useStore((s) => s.history.present.name);
  const doc = useStore((s) => s.history.present);
  const allParts = useStore((s) => s.parts);
  const bom = useMemo(() => bomFor(drawing, doc, allParts), [drawing, doc, allParts]);
  const change = useStore((s) => s.changeDrawing);
  const tool = useStore((s) => s.drawingTool);
  const selectedDim = useStore((s) => s.selectedDim);
  const { projections, subject, instances, busy, error } = useProjections(drawing);
  const instancesKey = instances ? JSON.stringify(instances) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const balloons = useMemo(() => balloonsFor(bom, instances, allParts), [bom, instancesKey, allParts]);
  const [drag, setDrag] = useState<{ viewId: string; start: P2; from: P2; at: P2 } | null>(null);
  const [dimDrag, setDimDrag] = useState<{ id: string; patch: { offset: number; angle?: number } } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** Section tool: the cutting line's first point (view mm), on its view. */
  const [cutStart, setCutStart] = useState<{ view: string; at: P2 } | null>(null);
  const [cursor, setCursor] = useState<P2 | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [W, H] = SHEETS[drawing.sheet];
  const pad = 12;
  const [box, setBox] = useState<[number, number, number, number]>([-pad, -pad, W + 2 * pad, H + 2 * pad]);
  const pan = useRef<{ x: number; y: number; box: [number, number, number, number] } | null>(null);
  useEffect(() => setBox([-pad, -pad, W + 2 * pad, H + 2 * pad]), [W, H]);
  useEffect(() => {
    setPending(null);
    setCutStart(null);
  }, [tool, drawing.id]);

  // While a view or a dimension is dragged, show it where it's going.
  const shown = useMemo(() => {
    let d = drawing;
    if (drag) d = { ...d, views: d.views.map((v) => (v.id === drag.viewId ? { ...v, at: drag.at } : v)) };
    if (dimDrag) d = { ...d, dimensions: d.dimensions?.map((x) => (x.id === dimDrag.id ? { ...x, ...dimDrag.patch } : x)) };
    return d;
  }, [drawing, drag, dimDrag]);
  const layout = useMemo(
    () => (projections ? layoutSheet(shown, projections, { designName: docName, subject: subject ?? "", date: today(), bom, balloons }) : null),
    [shown, projections, docName, subject, bom, balloons],
  );
  useEffect(() => {
    if (layout && !drag && !dimDrag) shownSheet = { drawingId: drawing.id, layout, name: drawing.name };
  }, [layout, drag, dimDrag, drawing.id, drawing.name]);
  const snaps = useMemo(() => (layout && projections && tool !== "select" ? snapsOf(layout, projections) : []), [layout, projections, tool]);

  // Delete removes the selected dimension; Esc steps back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const s = useStore.getState();
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedDim) {
        e.preventDefault();
        const id = s.selectedDim;
        s.changeDrawing((d) => removeDimension(d, id));
        s.selectDim(null);
      } else if (e.key === "Escape") {
        if (cutStart) setCutStart(null);
        else if (pending) setPending(null);
        else if (s.selectedDim) s.selectDim(null);
        else if (s.drawingTool !== "select") s.setDrawingTool("select");
      } else if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        s.setDrawingTool(s.drawingTool === "dimension" ? "select" : "dimension");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, cutStart]);

  const toSheet = (e: { clientX: number; clientY: number }): P2 => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, H - p.y];
  };
  /** About 8 screen pixels, in sheet millimetres. */
  const tolerance = () => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? Math.max(box[2] / r.width, box[3] / r.height) * 8 : 2;
  };

  const viewAt = (key: string) => {
    const v = layout?.views.find((x) => x.key === key);
    const p = projections?.[key];
    return v && p && layout ? (q: P2) => toSheetPoint(v, p, layout.scale, q[0], q[1]) : null;
  };

  /** The length dimension the pending points and the pointer would make. */
  const previewDim = (): Dimension | null => {
    if (!pending?.b || !cursor || !projections?.[pending.view]) return null;
    const at = viewAt(pending.view);
    if (!at) return null;
    const p = projections[pending.view]!;
    const place = placeLength(at(pending.a), at(pending.b), cursor);
    return { id: "preview", view: pending.view, type: place.type, a: dimPoint(pending.a, p), b: dimPoint(pending.b, p), offset: place.offset };
  };

  const dimensionClick = (e: ReactPointerEvent<SVGSVGElement>) => {
    const here = toSheet(e);
    const preview = previewDim();
    if (preview) {
      change((d) => putDimension(d, { ...preview, id: newId("dm") }));
      setPending(null);
      return;
    }
    const snap = findSnap(snaps, here, tolerance());
    if (!snap) return;
    const p = projections?.[snap.view];
    if (!p) return;
    if (snap.kind === "circle" && !pending) {
      const angle = Math.round((Math.atan2(here[1] - snap.sheet[1], here[0] - snap.sheet[0]) * 180) / Math.PI);
      change((d) => putDimension(d, { id: newId("dm"), view: snap.view, type: snap.full ? "diameter" : "radius", a: dimPoint(snap.centre, p), r: snap.r, offset: 8, angle }));
      return;
    }
    if (snap.kind === "line") {
      setPending({ view: snap.view, a: snap.a, b: snap.b });
      return;
    }
    const point = snap.kind === "point" ? snap.at : snap.centre;
    if (pending && pending.view === snap.view && Math.hypot(point[0] - pending.a[0], point[1] - pending.a[1]) > 1e-9) setPending({ ...pending, b: point });
    else setPending({ view: snap.view, a: point });
  };

  /** Where the section tool would put a point: on a front/top/side view, snapped to corners and hole centres. */
  const cutPoint = (here: P2, onView?: string): { view: string; at: P2; sheet: P2 } | null => {
    if (!layout || !projections) return null;
    const snap = findSnap(snaps, here, tolerance());
    if (snap && snap.kind !== "line" && (!onView || snap.view === onView) && SECTION_HOSTS.includes(snap.view as SectionCut["host"])) {
      return snap.kind === "point" ? { view: snap.view, at: snap.at, sheet: snap.sheet } : { view: snap.view, at: snap.centre, sheet: snap.sheet };
    }
    const v = layout.views.find(
      (x) => (onView ? x.key === onView : SECTION_HOSTS.includes(x.kind)) && here[0] > x.box[0] - 8 && here[0] < x.box[2] + 8 && here[1] > x.box[1] - 8 && here[1] < x.box[3] + 8,
    );
    const p = v && projections[v.key];
    if (!v || !p?.bounds) return null;
    const cx = (p.bounds[0] + p.bounds[2]) / 2;
    const cy = (p.bounds[1] + p.bounds[3]) / 2;
    return { view: v.key, at: [cx + (here[0] - v.centre[0]) / layout.scale, cy + (here[1] - v.centre[1]) / layout.scale], sheet: here };
  };
  /** The section line's end for the pointer: straightened when it's within a few degrees of across or up-and-down. */
  const cutEnd = (here: P2): { at: P2; sheet: P2 } | null => {
    if (!cutStart || !layout) return null;
    const hit = cutPoint(here, cutStart.view);
    if (!hit) return null;
    const [ax, ay] = cutStart.at;
    let [bx, by] = hit.at;
    const ang = Math.abs((Math.atan2(by - ay, bx - ax) * 180) / Math.PI);
    if (ang < 4 || ang > 176) by = ay;
    else if (Math.abs(ang - 90) < 4) bx = ax;
    const at = viewAt(cutStart.view);
    return at ? { at: [bx, by], sheet: at([bx, by]) } : null;
  };
  const sectionClick = (here: P2) => {
    if (!cutStart) {
      const p = cutPoint(here);
      if (p) setCutStart({ view: p.view, at: p.at });
      return;
    }
    const end = cutEnd(here);
    const p = projections?.[cutStart.view];
    if (!end || !p?.bounds || !layout || Math.hypot(end.at[0] - cutStart.at[0], end.at[1] - cutStart.at[1]) * layout.scale < 2) return;
    const host = cutStart.view as SectionCut["host"];
    const a = toRel(p.bounds, cutStart.at);
    const b = toRel(p.bounds, end.at);
    change((d) => addSection(d, { id: newId("sc"), host, a, b }));
    setCutStart(null);
    useStore.getState().setDrawingTool("select");
  };

  const onWheel = (e: React.WheelEvent) => {
    const [x, y] = toSheet(e);
    const sy = H - y;
    const k = Math.exp(e.deltaY * 0.0015);
    const [bx, by, bw, bh] = box;
    const nw = Math.min(Math.max(bw * k, 20), (W + 2 * pad) * 4);
    const f = nw / bw;
    setBox([x - (x - bx) * f, sy - (sy - by) * f, nw, bh * f]);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button === 1 || e.button === 2) {
      pan.current = { x: e.clientX, y: e.clientY, box };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (tool === "dimension") dimensionClick(e);
    else if (tool === "section") sectionClick(toSheet(e));
    else useStore.getState().selectDim(null);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (pan.current && svgRef.current) {
      const r = svgRef.current.getBoundingClientRect();
      const perPx = Math.max(pan.current.box[2] / r.width, pan.current.box[3] / r.height);
      setBox([pan.current.box[0] - (e.clientX - pan.current.x) * perPx, pan.current.box[1] - (e.clientY - pan.current.y) * perPx, pan.current.box[2], pan.current.box[3]]);
      return;
    }
    const here = toSheet(e);
    if (tool !== "select") setCursor(here);
    if (drag) setDrag({ ...drag, at: [drag.from[0] + here[0] - drag.start[0], drag.from[1] + here[1] - drag.start[1]] });
    if (dimDrag) {
      const dim = drawing.dimensions?.find((x) => x.id === dimDrag.id);
      const placed = layout?.dims.find((x) => x.id === dimDrag.id);
      if (dim && placed) setDimDrag({ id: dim.id, patch: dragDimension(dim, placed.a, placed.b, placed.rad, here) });
    }
  };
  const onPointerUp = () => {
    pan.current = null;
    if (drag) {
      const { viewId, at } = drag;
      setDrag(null);
      if (Math.hypot(at[0] - drag.from[0], at[1] - drag.from[1]) > 0.2) {
        change((d) => ({ ...d, views: d.views.map((v) => (v.id === viewId ? { ...v, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10] } : v)) }));
      }
    }
    if (dimDrag) {
      const { id, patch } = dimDrag;
      setDimDrag(null);
      change((d) => ({ ...d, dimensions: d.dimensions?.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    }
  };

  let message: string | null = null;
  if (!drawing.source) message = "Choose what to draw in the panel on the left.";
  else if (!subject) message = "The part this drawing shows no longer exists. Choose another in the panel on the left.";
  else if (error) message = `Couldn't make the views: ${error}`;
  else if (!layout) message = "Making the views…";
  else if (drawing.views.length === 0) message = "Tick some views in the panel on the left.";
  else if (tool === "dimension")
    message = pending?.b
      ? "Move to place the dimension (above or below for across, beside for up-and-down), then click."
      : pending
        ? "Now click a second point (or click a circle for its diameter). Esc to start again."
        : "Click a corner, then another — or click an edge for its length, or a circle for its diameter.";
  else if (tool === "section")
    message = cutStart
      ? "Click where the cutting line ends (it straightens when nearly across or up-and-down). Esc to start again."
      : "Click where the cutting line starts, on the front, top or a side view (corners and hole centres snap).";

  const hover = tool === "dimension" && cursor && !pending?.b ? findSnap(snaps, cursor, tolerance()) : null;
  const cutHover = tool === "section" && cursor ? (cutStart ? cutEnd(cursor) : cutPoint(cursor)) : null;
  const cutFrom = cutStart ? viewAt(cutStart.view)?.(cutStart.at) : null;
  const preview = previewDim();
  const previewPrims = (() => {
    if (!preview || !projections) return [];
    const at = viewAt(preview.view);
    const p = projections[preview.view];
    if (!at || !p) return [];
    const r = resolveDim(preview, p);
    return drawDimension(preview, r, at, measureDim(preview, r)).prims;
  })();
  const selected = layout?.dims.find((d) => d.id === selectedDim);
  const lost = new Set(layout?.dims.filter((d) => !d.found).map((d) => d.id));

  const renderPrim = (p: Prim, i: number, colour: string) => {
    if (p.kind === "path") {
      const st = LINE_STYLES[p.style];
      const pts = [];
      for (let k = 0; k < p.points.length; k += 2) pts.push(`${p.points[k]},${H - p.points[k + 1]}`);
      const props = { points: pts.join(" "), fill: p.fill ? colour : "none", stroke: colour, strokeWidth: st.width, strokeDasharray: st.dash?.join(" "), strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
      return p.closed || p.fill ? <polygon key={i} {...props} /> : <polyline key={i} {...props} />;
    }
    return (
      <text
        key={i}
        x={p.x}
        y={H - p.y}
        fontSize={p.size}
        textAnchor={p.anchor}
        fontWeight={p.bold ? 700 : 400}
        className="drawing-text"
        fill={colour}
        transform={p.rotate ? `rotate(${-p.rotate} ${p.x} ${H - p.y})` : undefined}
      >
        {p.text}
      </text>
    );
  };
  const colourOf = (i: number) => {
    const d = layout?.dims.find((x) => i >= x.from && i < x.to);
    if (!d) return "#111";
    if (d.id === selectedDim) return "#1f6fd1";
    return lost.has(d.id) ? "#c2410c" : "#111";
  };

  return (
    <div className={`drawing-area${tool !== "select" ? " dimensioning" : ""}`}>
      <svg
        ref={svgRef}
        className="drawing-svg"
        viewBox={box.join(" ")}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Drawing sheet"
        data-testid="drawing-sheet"
      >
        <rect x={0} y={0} width={W} height={H} className="drawing-paper" />
        {layout?.prims.map((p, i) => renderPrim(p, i, colourOf(i)))}
        {tool === "select" &&
          layout?.views.map((v) => (
            <rect
              key={v.id}
              className={`drawing-view-handle${drag?.viewId === v.id ? " dragging" : ""}`}
              x={v.box[0] - 3}
              y={H - v.box[3] - 3}
              width={v.box[2] - v.box[0] + 6}
              height={v.box[3] - v.box[1] + 6}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                useStore.getState().selectDim(null);
                (e.target as Element).setPointerCapture(e.pointerId);
                const start = toSheet(e);
                setDrag({ viewId: v.id, start, from: v.centre, at: v.centre });
              }}
            >
              <title>{`${v.kind === "section" ? `Section ${drawing.sections?.find((c) => `section:${c.id}` === v.key)?.letter ?? ""}` : VIEW_LABELS[v.kind]} view — drag to move`}</title>
            </rect>
          ))}
        {tool === "select" &&
          layout?.dims.map((d) => (
            <circle
              key={d.id}
              className={`drawing-dim-handle${d.id === selectedDim ? " selected" : ""}`}
              cx={d.label[0]}
              cy={H - d.label[1] - 1.5}
              r={4}
              data-dim={d.id}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                useStore.getState().selectDim(d.id);
                (e.target as Element).setPointerCapture(e.pointerId);
                const dim = drawing.dimensions?.find((x) => x.id === d.id);
                if (dim) setDimDrag({ id: d.id, patch: { offset: dim.offset, ...(dim.angle !== undefined ? { angle: dim.angle } : {}) } });
              }}
            >
              <title>{d.found ? "Drag to move this dimension; Delete removes it" : "What this dimension measured has changed too much — delete it and add it again"}</title>
            </circle>
          ))}
        {previewPrims.map((p, i) => renderPrim(p, -1 - i, "#1f6fd1"))}
        {pending && viewAt(pending.view) && (
          <circle cx={viewAt(pending.view)!(pending.a)[0]} cy={H - viewAt(pending.view)!(pending.a)[1]} r={1.2} className="drawing-snap picked" />
        )}
        {hover && (
          <circle
            cx={hover.kind === "line" ? (hover.sheetA[0] + hover.sheetB[0]) / 2 : hover.sheet[0]}
            cy={H - (hover.kind === "line" ? (hover.sheetA[1] + hover.sheetB[1]) / 2 : hover.sheet[1])}
            r={hover.kind === "circle" ? hover.sheetR : 1.2}
            className={`drawing-snap ${hover.kind}`}
          />
        )}
        {hover?.kind === "line" && <line x1={hover.sheetA[0]} y1={H - hover.sheetA[1]} x2={hover.sheetB[0]} y2={H - hover.sheetB[1]} className="drawing-snap-line" />}
        {selected && <circle cx={selected.label[0]} cy={H - selected.label[1] - 1.5} r={4.5} className="drawing-dim-selected" />}
        {cutFrom && <circle cx={cutFrom[0]} cy={H - cutFrom[1]} r={1.2} className="drawing-snap picked" />}
        {cutFrom && cutHover && <line x1={cutFrom[0]} y1={H - cutFrom[1]} x2={cutHover.sheet[0]} y2={H - cutHover.sheet[1]} className="drawing-cut-preview" />}
        {cutHover && <circle cx={cutHover.sheet[0]} cy={H - cutHover.sheet[1]} r={1.2} className="drawing-snap point" />}
      </svg>
      {message && <div className="drawing-message">{message}</div>}
      {layout?.tooBig && <div className="drawing-message warn">The part is too big for this sheet even at {scaleLabel(layout.scale)}. Try a bigger sheet.</div>}
      {busy && layout && <div className="drawing-busy">Updating views…</div>}
    </div>
  );
}
