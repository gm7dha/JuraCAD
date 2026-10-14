/**
 * The drawing tab: a sheet with views of a part (or an assembly) and a title
 * block, its settings panel and toolbar, and saving it as PDF or SVG.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { arrangeViews, SHEET_SIZES, toggleView, VIEW_KINDS, VIEW_LABELS } from "../drawing/drawing";
import { sheetPdf, sheetSvg } from "../drawing/export";
import { fitScale, layoutSheet, scaleLabel, STANDARD_SCALES, SHEETS, LINE_STYLES, type SheetLayout } from "../drawing/sheet";
import { getKernel } from "../kernel/connect";
import type { InstanceInput, PartMesh, ViewProjection } from "../kernel/protocol";
import { activeDrawing, partsInStudio, useStore } from "../model/store";
import { studiosOf } from "../model/studios";
import type { Drawing, PartSmithDocument, ViewKind } from "../model/types";
import { instancesForKernel } from "./assemblySolve";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { detectPlatform, shortcut } from "./platform";

type Projections = Partial<Record<ViewKind, ViewProjection>>;

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
  const instances = instancesForKernel(asm, parts);
  return { name: asm.name, partIds: [], instances, key: [JSON.stringify(instances), ...parts.filter((p) => instances.some((i) => i.partId === p.id))] };
}

/** Projections already worked out, by drawing (kept while switching tabs). */
const projectionCache = new Map<string, { key: unknown[]; result: Projections }>();
const inFlight = new Map<string, { key: unknown[]; promise: Promise<Projections> }>();
const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The drawing's views from the geometry engine, refreshed when the part or the chosen views change. */
function useProjections(drawing: Drawing): { projections: Projections | null; subject: string | null; busy: boolean; error: string | null } {
  const doc = useStore((s) => s.history.present);
  const parts = useStore((s) => s.parts);
  const ready = useStore((s) => s.kernelStatus === "ready");
  const subject = drawingSubject(drawing, doc, parts);
  const kinds = drawing.views.map((v) => v.kind);
  // The same key object while nothing it's made of changes, so the effect below only runs on real changes.
  const rawKey = subject ? [...subject.key, kinds.join(","), drawing.hiddenLines] : null;
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
        .then(() => kernel.project(subject.partIds, subject.instances, kinds, drawing.hiddenLines))
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

  return { projections: state.result ?? fresh, subject: subject?.name ?? null, busy: state.busy, error: state.error };
}

/** The sheet as last laid out on screen (for saving). */
let shownSheet: { drawingId: string; layout: SheetLayout; name: string } | null = null;

function today(): string {
  return new Date().toLocaleDateString("en-GB");
}

/** Save the drawing on show as a PDF or SVG file. */
export function exportDrawing(format: "pdf" | "svg") {
  const s = useStore.getState();
  const d = activeDrawing(s);
  if (!d || !shownSheet || shownSheet.drawingId !== d.id) {
    s.showToast("The drawing isn't ready yet — wait for its views to appear, then try again.", "error");
    return;
  }
  const base = safeFileName(`${s.history.present.name} ${d.name}`, "drawing");
  const title = `${s.history.present.name} — ${d.name}`;
  if (format === "pdf") downloadFile(new Blob([sheetPdf(shownSheet.layout.prims, shownSheet.layout.size, title) as BlobPart], { type: "application/pdf" }), `${base}.pdf`);
  else downloadFile(new Blob([sheetSvg(shownSheet.layout.prims, shownSheet.layout.size, title)], { type: "image/svg+xml" }), `${base}.svg`);
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
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
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
  const auto = projections ? fitScale(projections, drawing.views.map((v) => v.kind), drawing.sheet) : null;
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
        </div>
      </section>
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

/** The sheet itself, with views you can drag about. Scroll to zoom, middle- or right-drag to pan. */
export function DrawingSheet({ drawing }: { drawing: Drawing }) {
  const docName = useStore((s) => s.history.present.name);
  const change = useStore((s) => s.changeDrawing);
  const { projections, subject, busy, error } = useProjections(drawing);
  const [drag, setDrag] = useState<{ viewId: string; start: [number, number]; from: [number, number]; at: [number, number] } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [W, H] = SHEETS[drawing.sheet];
  const pad = 12;
  const [box, setBox] = useState<[number, number, number, number]>([-pad, -pad, W + 2 * pad, H + 2 * pad]);
  const pan = useRef<{ x: number; y: number; box: [number, number, number, number] } | null>(null);
  useEffect(() => setBox([-pad, -pad, W + 2 * pad, H + 2 * pad]), [W, H]);

  // While a view is dragged, show it where it's going.
  const shown = useMemo(
    () => (drag ? { ...drawing, views: drawing.views.map((v) => (v.id === drag.viewId ? { ...v, at: drag.at } : v)) } : drawing),
    [drawing, drag],
  );
  const layout = useMemo(
    () => (projections ? layoutSheet(shown, projections, { designName: docName, subject: subject ?? "", date: today() }) : null),
    [shown, projections, docName, subject],
  );
  useEffect(() => {
    if (layout && !drag) shownSheet = { drawingId: drawing.id, layout, name: drawing.name };
  }, [layout, drag, drawing.id, drawing.name]);

  const toSheet = (e: { clientX: number; clientY: number }): [number, number] => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, H - p.y];
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
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (pan.current && svgRef.current) {
      const r = svgRef.current.getBoundingClientRect();
      const perPx = Math.max(pan.current.box[2] / r.width, pan.current.box[3] / r.height);
      setBox([pan.current.box[0] - (e.clientX - pan.current.x) * perPx, pan.current.box[1] - (e.clientY - pan.current.y) * perPx, pan.current.box[2], pan.current.box[3]]);
      return;
    }
    if (drag) {
      const [x, y] = toSheet(e);
      setDrag({ ...drag, at: [drag.from[0] + x - drag.start[0], drag.from[1] + y - drag.start[1]] });
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
  };

  let message: string | null = null;
  if (!drawing.source) message = "Choose what to draw in the panel on the left.";
  else if (!subject) message = "The part this drawing shows no longer exists. Choose another in the panel on the left.";
  else if (error) message = `Couldn't make the views: ${error}`;
  else if (!layout) message = "Making the views…";
  else if (drawing.views.length === 0) message = "Tick some views in the panel on the left.";

  return (
    <div className="drawing-area">
      <svg
        ref={svgRef}
        className="drawing-svg"
        viewBox={box.join(" ")}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Drawing sheet"
        data-testid="drawing-sheet"
      >
        <rect x={0} y={0} width={W} height={H} className="drawing-paper" />
        {layout?.prims.map((p, i) => {
          if (p.kind === "path") {
            const st = LINE_STYLES[p.style];
            const pts = [];
            for (let k = 0; k < p.points.length; k += 2) pts.push(`${p.points[k]},${H - p.points[k + 1]}`);
            const props = { points: pts.join(" "), fill: "none", stroke: "#111", strokeWidth: st.width, strokeDasharray: st.dash?.join(" "), strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
            return p.closed ? <polygon key={i} {...props} /> : <polyline key={i} {...props} />;
          }
          return (
            <text key={i} x={p.x} y={H - p.y} fontSize={p.size} textAnchor={p.anchor} fontWeight={p.bold ? 700 : 400} className="drawing-text">
              {p.text}
            </text>
          );
        })}
        {layout?.views.map((v) => (
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
              (e.target as Element).setPointerCapture(e.pointerId);
              const start = toSheet(e);
              setDrag({ viewId: v.id, start, from: v.centre, at: v.centre });
            }}
          >
            <title>{`${VIEW_LABELS[v.kind]} view — drag to move`}</title>
          </rect>
        ))}
      </svg>
      {message && <div className="drawing-message">{message}</div>}
      {layout?.tooBig && <div className="drawing-message warn">The part is too big for this sheet even at {scaleLabel(layout.scale)}. Try a bigger sheet.</div>}
      {busy && layout && <div className="drawing-busy">Updating views…</div>}
    </div>
  );
}
