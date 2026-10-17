/**
 * The drawing tab: a sheet with views of a part (or an assembly) and a title
 * block, its settings panel and toolbar, and saving it as PDF or SVG.
 */
import { putShortening, removeShortening, withShortenings } from "../drawing/shorten";
import { itemsInBox, toggled } from "../drawing/select";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { arrangeLinedUp, arrangeViews, nextRevision, PLACES, projectionKinds, putDimension, putNote, removeDimension, removeNote, SHEET_LABELS, SHEET_SIZES, toggleView, VIEW_KINDS, VIEW_LABELS } from "../drawing/drawing";
import { sheetDxf, sheetPdf, sheetSvg } from "../drawing/export";
import { surfacePointNearCentre } from "../drawing/annotations";
import { autoDimensions } from "../drawing/autoDimension";
import { holeRows, holeTableView } from "../drawing/holeTable";
import { holeOfCircle, tapSizes } from "../drawing/holeCallouts";
import { describeSymbol, GDT_CHARACTERISTICS, nextDatumLetter, symbolPrims } from "../drawing/symbols";
import { advanceRun, nextLinear, startRun, type LinearKind, type LinearRun } from "../drawing/linearDims";
import { applyPlacement } from "../assembly/math";
import { findMesh } from "../assembly/configured";
import { bottomReserve, dimStyle, drawingViewKeys, fitScale, layoutSheet, type Projections, type BomLine, type SheetInfo, scaleLabel, STANDARD_SCALES, SHEETS, LINE_STYLES, toSheet as toSheetPoint, fromSheet as fromSheetPoint, type Prim, type SheetLayout } from "../drawing/sheet";
import { angleGeometry, dimPoint, dragDimension, placeAngle, dragDimensionText, drawDimension, measureDim, pairFor, placeLength, resolveDim, sameTarget, snapPoints, type DimTarget } from "../drawing/dimensions";
import { newId } from "../model/document";
import { billOfMaterials } from "../assembly/assembly";
import { getKernel } from "../kernel/connect";
import type { InstanceInput, PartMesh } from "../kernel/protocol";
import { activeDrawing, partsInStudio, useLengthUnit, useStore } from "../model/store";
import { fromUnit, lengthNumber } from "../model/units";
import { studiosOf } from "../model/studios";
import type { Shortening, BreakOut, DetailView, Dimension, Drawing, DrawingRevision, DrawingSymbol, GdtCharacteristic, PartSmithDocument, SectionCut } from "../model/types";
import { addSection, breakOutRequests, missedSections, putBreakOut, removeBreakOut, removeSection, SECTION_HOSTS, sectionRequests, toRel, updateSection } from "../drawing/sections";
import { addDetail, DETAIL_ZOOMS, removeDetail, updateDetail, withDetails } from "../drawing/details";
import { explodeAssembly, instancesForKernel } from "./assemblySolve";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { ToolGroupButton } from "./ToolGroupButton";
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
  return { name: asm.name, partIds: [], instances, key: [JSON.stringify(instances), ...instances.map((i) => findMesh(parts, i.partId))] };
}

/** The parts list for an assembly drawing (none for a part). */
function bomFor(drawing: Drawing, doc: PartSmithDocument, parts: PartMesh[]): BomLine[] | undefined {
  if (drawing.source?.kind !== "assembly") return undefined;
  const asm = doc.assemblies?.find((a) => a.id === drawing.source!.id);
  if (!asm) return undefined;
  const names = Object.fromEntries(parts.map((p) => [p.id, p.name]));
  const configurations = Object.fromEntries((doc.configurations ?? []).map((c) => [c.id, c.name]));
  return billOfMaterials(asm, names, configurations).map((r, i) => ({ item: i + 1, name: r.name, quantity: r.quantity, partId: r.partId }));
}

/** A spot on one copy of each listed part, for the balloons to point at. */
function balloonsFor(bom: BomLine[] | undefined, instances: InstanceInput[] | undefined, parts: PartMesh[]): SheetInfo["balloons"] {
  if (!bom?.length || !instances?.length) return undefined;
  const out: NonNullable<SheetInfo["balloons"]> = [];
  for (const row of bom) {
    // Mirrored copies are their own line ("…~mirrored").
    const mirrored = !!row.partId?.endsWith("~mirrored");
    const partId = mirrored ? row.partId!.slice(0, -"~mirrored".length) : row.partId;
    const inst = instances.find((i) => i.partId === partId && !!i.mirrored === mirrored);
    const mesh = partId ? findMesh(parts, partId) : undefined;
    const local = mesh ? surfacePointNearCentre(mesh.vertices) : null;
    const spot = local && mirrored ? ([-local[0], local[1], local[2]] as typeof local) : local;
    if (inst && spot) out.push({ item: row.item, at: applyPlacement({ position: inst.position, rotation: inst.rotation }, spot) });
  }
  return out;
}

/** Projections already worked out, by drawing (kept while switching tabs). */
const projectionCache = new Map<string, { key: unknown[]; result: Projections }>();
const inFlight = new Map<string, { key: unknown[]; promise: Promise<Projections> }>();
const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The drawing's views from the geometry engine, refreshed when the part or the chosen views change. */
function useProjections(drawing: Drawing): { projections: Projections | null; subject: string | null; instances?: InstanceInput[]; busy: boolean; error: string | null; upToDate: boolean } {
  const doc = useStore((s) => s.history.present);
  const parts = useStore((s) => s.parts);
  const ready = useStore((s) => s.kernelStatus === "ready");
  const subject = drawingSubject(drawing, doc, parts);
  // (Sections are asked for separately; details are worked out here from their host views.)
  const kinds = projectionKinds(drawing);
  const sections = sectionRequests(drawing);
  const breakouts = breakOutRequests(drawing);
  // The same key object while nothing it's made of changes, so the effect below only runs on real changes.
  const tangent = drawing.tangentEdges !== false;
  const rawKey = subject ? [...subject.key, kinds.join(","), drawing.hiddenLines, tangent, JSON.stringify(sections), JSON.stringify(breakouts)] : null;
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
        .then(() => kernel.project(subject.partIds, subject.instances, kinds, drawing.hiddenLines, sections, breakouts, tangent))
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

  const base = state.result ?? fresh;
  const detailsKey = JSON.stringify(drawing.details ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shortKey = JSON.stringify(drawing.shortened ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projections = useMemo(() => (base ? withShortenings(withDetails(base, drawing), drawing) : null), [base, detailsKey, shortKey]);
  // True once the views shown are the ones for the drawing as it is now (not the last ones, kept while new ones are worked out).
  const upToDate = !!fresh && (state.result === null || state.result === fresh);
  return { projections, subject: subject?.name ?? null, instances: subject?.instances, busy: state.busy, error: state.error, upToDate };
}

/** The sheet as last laid out on screen (for saving). */
let shownSheet: { drawingId: string; layout: SheetLayout; name: string; projections: Projections } | null = null;

function today(): string {
  return new Date().toLocaleDateString("en-GB");
}

/** Auto dimension: add the sizes the drawing needs (see autoDimension.ts). One undo step. */
export function autoDimensionDrawing() {
  const s = useStore.getState();
  const d = activeDrawing(s);
  if (!d || !shownSheet || shownSheet.drawingId !== d.id) {
    s.showToast("The drawing isn't ready yet — wait for its views to appear, then try again.", "error");
    return;
  }
  const added = autoDimensions(shownSheet.projections, drawingViewKeys(d), d.dimensions ?? [], shownSheet.layout.scale, () => newId("dm"), d.projection === "third");
  if (!added.length) {
    const hasViews = drawingViewKeys(d).some((k) => k !== "iso" && !k.startsWith("section:"));
    s.showToast(hasViews ? "Nothing more to add — it's already dimensioned." : "Auto dimension needs a front, top or side view.", "info");
    return;
  }
  s.changeDrawing((x) => ({ ...x, dimensions: [...(x.dimensions ?? []), ...added] }));
  s.showToast(`Added ${added.length} dimension${added.length > 1 ? "s" : ""}. Drag a number to move it, or select one and press Delete.`, "success");
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
        <ToolGroupButton
          id="drawing-dimensions"
          name="dimension"
          items={(
            [
              ["dimension", "Dimension", <Icons.Dimension key="d" />, "Dimension (D) — click two corners, an edge, or a circle. Drag a dimension's number to move it (hold Shift to move just the number, anywhere); Delete removes it", "D"],
              ["baseline", "Baseline", <Icons.BaselineDim key="b" />, "Baseline — click a datum corner, then the next point, the next… each measured from the datum, stacked outwards. Esc to finish", ""],
              ["chain", "Chain", <Icons.ChainDim key="c" />, "Chain — click a starting corner, then the next point, the next… each measured from the one before, end to end. Esc to finish", ""],
              ["ordinate", "Ordinate", <Icons.OrdinateDim key="o" />, "Ordinate — click a datum corner (0), then the points to label with their distance from it. Esc to finish", ""],
              ["holeCallout", "Hole callout", <Icons.HoleCallout key="h" />, "Hole callout — click a hole to label it with its size, depth, counterbore or countersink, thread and how many there are (e.g. 4× Ø6.6 THRU)", ""],
            ] as const
          ).map(([t, label, icon, title, key]) => ({
            key: t,
            label,
            icon,
            title,
            shortcut: key || undefined,
            active: tool === t,
            onClick: () => useStore.getState().setDrawingTool(tool === t ? "select" : t),
          }))}
        />
        <ToolGroupButton
          id="drawing-notes"
          name="note"
          items={(
            [
              ["note", "Note", <Icons.Note key="n" />, "Note — click on the sheet to add text (edit it in the panel; drag to move)"],
              ["datum", "Datum", <Icons.Datum key="d" />, "Datum — click the edge or surface it marks, then where the lettered box goes"],
              ["fcf", "Tolerance frame", <Icons.Fcf key="f" />, "Feature control frame (GD&T) — click what it applies to, then where the frame goes; set flatness, position… in the panel"],
              ["finish", "Surface finish", <Icons.SurfaceFinish key="s" />, "Surface finish — click the surface, then where the mark goes; set the roughness (Ra) in the panel"],
            ] as const
          ).map(([t, label, icon, title]) => ({
            key: t,
            label,
            icon,
            title,
            active: tool === t,
            onClick: () => useStore.getState().setDrawingTool(tool === t ? "select" : t),
          }))}
        />
        <ToolGroupButton
          id="drawing-views"
          name="section"
          items={(
            [
              ["section", "Section", <Icons.Section key="s" />, "Section — click two points across the front, top or a side view to cut the part open there. Flip or remove sections in the panel"],
              ["auxiliary", "Auxiliary view", <Icons.AuxView key="a" />, "Auxiliary view — click two points along a sloping edge on the front, top or a side view: the part is shown looking square-on to it, so the sloping face is drawn at its true size"],
              ["breakout", "Broken-out", <Icons.BreakOut key="b" />, "Broken-out — click two corners of an area on the front, top or a side view: the part is cut away there to show what's inside (set the depth in the panel)"],
              ["shorten", "Shortened view", <Icons.Shorten key="sh" />, "Shortened view — click two points along a long view (front, top or a side): the stretch between them is taken out so it fits the sheet. Dimensions still show the real length"],
              ["detail", "Detail", <Icons.Detail key="d" />, "Detail — click the middle of a small area on a view, then the circle's size: it's shown again bigger"],
            ] as const
          ).map(([t, label, icon, title]) => ({
            key: t,
            label,
            icon,
            title,
            active: tool === t,
            onClick: () => useStore.getState().setDrawingTool(tool === t ? "select" : t),
          }))}
        />
        <ToolButton
          label="Auto dimension"
          icon={<Icons.AutoDimension />}
          onClick={autoDimensionDrawing}
          title="Auto dimension — add the overall sizes, steps, hole sizes and hole positions the drawing needs, measured from one corner (choosing baseline, chain or ordinate for each row, whichever reads best)"
        />
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
/** The selected note: its text — or, for a symbol, its settings. */
function NoteProperties({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const selected = useStore((s) => s.selectedDim);
  const note = drawing.notes?.find((n) => n.id === selected);
  if (!note) return null;
  if (note.symbol) {
    const sym = note.symbol;
    const set = (s: DrawingSymbol) => change((d) => putNote(d, { ...note, symbol: s }));
    return (
      <section className="panel-section">
        <h3>{describeSymbol(sym)}</h3>
        <div className="drawing-fields">
          {sym.kind === "datum" && <TitleField label="Letter" value={sym.letter} onCommit={(v) => set({ ...sym, letter: v.trim().toUpperCase().slice(0, 3) || sym.letter })} />}
          {sym.kind === "finish" && (
            <>
              <TitleField label="Roughness Ra (µm)" value={sym.ra} placeholder="e.g. 1.6" onCommit={(v) => set({ ...sym, ra: v.trim() })} />
              <label className="check-row">
                <input type="checkbox" checked={sym.machined !== false} onChange={(e) => set(e.target.checked ? { kind: "finish", ra: sym.ra } : { ...sym, machined: false })} />
                Machined (material removed)
              </label>
            </>
          )}
          {sym.kind === "fcf" && (
            <>
              <label className="field-label" htmlFor="fcf-characteristic">
                Tolerance
              </label>
              <select id="fcf-characteristic" value={sym.characteristic} onChange={(e) => set({ ...sym, characteristic: e.target.value as GdtCharacteristic })}>
                {GDT_CHARACTERISTICS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <TitleField label="Tolerance (mm)" value={sym.tolerance} onCommit={(v) => set({ ...sym, tolerance: v.trim() })} />
              <label className="check-row">
                <input type="checkbox" checked={!!sym.diameter} onChange={(e) => set(e.target.checked ? { ...sym, diameter: true } : (({ diameter: _d, ...rest }) => rest)(sym))} />
                Round zone (Ø)
              </label>
              {GDT_CHARACTERISTICS.find((c) => c.key === sym.characteristic)?.datums &&
                ["Primary datum", "Secondary datum", "Tertiary datum"].map((label, i) => (
                  <TitleField
                    key={label}
                    label={label}
                    value={sym.datums[i] ?? ""}
                    placeholder={i === 0 ? "e.g. A" : "optional"}
                    onCommit={(v) => {
                      const datums = [...sym.datums];
                      datums[i] = v.trim().toUpperCase();
                      set({ ...sym, datums: datums.slice(0, 3) });
                    }}
                  />
                ))}
            </>
          )}
        </div>
        {note.leader && (
          <button className="text-button" onClick={() => change((d) => putNote(d, (({ leader: _l, ...rest }) => rest)(note)))}>
            Remove the leader line
          </button>
        )}
        <p className="dialog-hint">Drag it to move it; Delete removes it.</p>
      </section>
    );
  }
  return (
    <section className="panel-section">
      <h3>Selected note</h3>
      <div className="drawing-fields">
        <TitleField label="Note text" value={note.text} multiline onCommit={(v) => change((d) => (v.trim() ? putNote(d, { ...note, text: v }) : removeNote(d, note.id)))} />
      </div>
      <p className="dialog-hint">One line per row. Drag the note to move it; Delete removes it.</p>
    </section>
  );
}

/** More than one dimension or note selected: how many, and a way to delete them. */
function SeveralSelected({ change }: { change: (fn: (d: Drawing) => Drawing) => void }) {
  const ids = useStore((s) => s.selectedDims);
  const selectDim = useStore((s) => s.selectDim);
  if (ids.length < 2) return null;
  return (
    <section className="panel-section">
      <h3>{ids.length} selected</h3>
      <p className="dialog-hint">Ctrl-click (⌘-click on a Mac) a dimension or note to add or take it away. Delete removes them all.</p>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          change((d) => ids.reduce((acc, id) => removeNote(removeDimension(acc, id), id), d));
          selectDim(null);
        }}
      >
        Delete {ids.length}
      </button>
    </section>
  );
}

/** The selected dimension: text before and after its number, and its tolerance. */
function DimensionProperties({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const selectedDim = useStore((s) => s.selectedDim);
  const unit = useLengthUnit();
  const dim = drawing.dimensions?.find((d) => d.id === selectedDim);
  if (!dim) return null;
  const edit = (patch: Partial<Dimension>) =>
    change((d) => ({
      ...d,
      dimensions: d.dimensions?.map((x) => {
        if (x.id !== dim.id) return x;
        const next: Dimension = { ...x, ...patch };
        for (const k of ["prefix", "suffix", "tolerance", "places", "frame"] as const) if (next[k] === undefined || next[k] === "") delete next[k];
        return next;
      }),
    }));
  const t = dim.tolerance;
  const mode = !t ? "none" : Math.abs(t.plus - t.minus) < 1e-9 ? "sym" : "limits";
  // An angle's tolerance is in degrees; a length's in the design's unit.
  const angle = dim.type === "angle";
  const tolUnit = angle ? "°" : unit;
  const shown = (mm: number) => (angle ? String(Math.round(mm * 100) / 100) : lengthNumber(mm, unit));
  const parse = (v: string) => {
    const n = Number(v.replace(/^[+±−-]/, "").replace(/°$/, "").trim());
    return Number.isFinite(n) ? (angle ? Math.abs(n) : fromUnit(Math.abs(n), unit)) : null;
  };
  return (
    <section className="panel-section">
      <h3>Selected dimension</h3>
      <div className="drawing-fields">
        <TitleField label="Text before" value={dim.prefix ?? ""} placeholder="e.g. 4×" onCommit={(v) => edit({ prefix: v ? `${v.trimEnd()} ` : undefined })} />
        <TitleField label="Text after" value={dim.suffix ?? ""} placeholder="e.g. TYP" onCommit={(v) => edit({ suffix: v ? ` ${v.trimStart()}` : undefined })} />
        <div className="drawing-field">
          <span className="field-label">Tolerance</span>
          <div className="segmented three" role="radiogroup" aria-label="Tolerance">
            {(
              [
                ["none", "None"],
                ["sym", "±"],
                ["limits", "+ / −"],
              ] as const
            ).map(([m, label]) => (
              <button
                type="button"
                key={m}
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "selected" : ""}
                onClick={() => {
                  const d = angle ? 0.5 : unit === "in" ? 0.127 : 0.1;
                  if (m === "none") edit({ tolerance: undefined });
                  else if (m === "sym") edit({ tolerance: { plus: t?.plus ?? d, minus: t?.plus ?? d } });
                  else edit({ tolerance: { plus: t?.plus ?? d, minus: t && mode === "limits" ? t.minus : 0 } });
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {t && (
          <TitleField
            label={mode === "sym" ? `Tolerance ± (${tolUnit})` : `Plus (${tolUnit})`}
            value={shown(t.plus)}
            onCommit={(v) => {
              const n = parse(v);
              if (n !== null) edit({ tolerance: { plus: n, minus: mode === "sym" ? n : t.minus } });
            }}
          />
        )}
        {t && mode === "limits" && (
          <TitleField
            label={`Minus (${tolUnit})`}
            value={shown(t.minus)}
            onCommit={(v) => {
              const n = parse(v);
              if (n !== null) edit({ tolerance: { plus: t.plus, minus: n } });
            }}
          />
        )}
        <div className="drawing-field">
          <label htmlFor="dim-places">Decimal places</label>
          <select id="dim-places" value={dim.places === undefined ? "" : String(dim.places)} onChange={(e) => edit({ places: e.target.value === "" ? undefined : Number(e.target.value) })}>
            <option value="">Same as the drawing</option>
            {PLACES.map((n) => (
              <option key={n} value={String(n)}>
                {n === 0 ? "None (whole numbers)" : `${n} (${(0).toFixed(n)})`}
              </option>
            ))}
          </select>
        </div>
        {!dim.callout && (
          <div className="drawing-field">
            <span className="field-label">Box round the number</span>
            <div className="segmented three" role="radiogroup" aria-label="Box round the number">
              {(
                [
                  [undefined, "None", "Just the number"],
                  ["basic", "Exact (basic)", "A box: the exact (basic) size, with its tolerance given by a GD&T frame"],
                  ["inspection", "Inspect", "A rounded box: an inspection dimension — measure this one when checking the part"],
                ] as const
              ).map(([f, label, tip]) => (
                <button type="button" key={label} role="radio" title={tip} aria-checked={dim.frame === f} className={dim.frame === f ? "selected" : ""} onClick={() => edit({ frame: f })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <p className="dialog-hint">Drag its number to move it (Shift to move just the number). Delete removes it.</p>
    </section>
  );
}

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

/** How many rows the hole table has (for fitting the views above it). */
function holeCount(drawing: Drawing, projections: Projections): number {
  if (!drawing.holeTable) return 0;
  const key = holeTableView(drawing, projections);
  return key ? holeRows(projections[key]!).length : 0;
}

export function DrawingPanel({ drawing }: { drawing: Drawing }) {
  const unit = useLengthUnit();
  const doc = useStore((s) => s.history.present);
  const parts = useStore((s) => s.parts);
  const change = useStore((s) => s.changeDrawing);
  const { projections, subject, upToDate } = useProjections(drawing);
  const auto = projections
    ? fitScale(projections, drawingViewKeys(drawing), drawing.sheet, bottomReserve(drawing, bomFor(drawing, doc, parts), holeCount(drawing, projections)), drawing.projection === "third")
    : null;
  const studios = studiosOf(doc);
  const sourceValue = drawing.source ? `${drawing.source.kind}:${drawing.source.id}` : "";

  return (
    <aside className="side-panel drawing-panel" aria-label="Drawing settings">
      <SeveralSelected change={change} />
      <DimensionProperties drawing={drawing} change={change} />
      <NoteProperties drawing={drawing} change={change} />
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
            <label htmlFor="drawing-sheet">Sheet</label>
            <select id="drawing-sheet" value={drawing.sheet} onChange={(e) => change((d) => ({ ...arrangeViews(d), sheet: e.target.value as Drawing["sheet"] }))}>
              {SHEET_SIZES.map((size) => (
                <option key={size} value={size}>
                  {SHEET_LABELS[size]}
                </option>
              ))}
            </select>
          </div>
          <div className="drawing-field">
            <span className="field-label">Views arranged</span>
            <div className="segmented two" role="radiogroup" aria-label="Projection">
              {(
                [
                  [false, "First angle", "ISO (UK, Europe, most of the world): the top view goes below the front view, the right view to its left. Switching puts the lined-up views back in place; 3D, section and detail views you moved stay put."],
                  [true, "Third angle", "US (ANSI): the top view goes above the front view, the right view to its right. Switching puts the lined-up views back in place; 3D, section and detail views you moved stay put."],
                ] as const
              ).map(([third, label, tip]) => (
                <button
                  type="button"
                  key={label}
                  role="radio"
                  title={tip}
                  aria-checked={(drawing.projection === "third") === third}
                  className={(drawing.projection === "third") === third ? "selected" : ""}
                  onClick={() =>
                    change((d) => {
                      const { projection: _old, ...rest } = arrangeLinedUp(d);
                      return third ? { ...rest, projection: "third" } : rest;
                    })
                  }
                >
                  {label}
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
          <div className="drawing-field">
            <label htmlFor="drawing-places">Dimension decimals</label>
            <select
              id="drawing-places"
              value={drawing.places === undefined ? "" : String(drawing.places)}
              onChange={(e) =>
                change((d) => {
                  const { places: _old, ...rest } = d;
                  return e.target.value === "" ? rest : { ...rest, places: Number(e.target.value) };
                })
              }
            >
              <option value="">As needed ({unit === "in" ? "up to 3" : "up to 2"})</option>
              {PLACES.map((n) => (
                <option key={n} value={String(n)}>
                  {n === 0 ? "None (whole numbers)" : `Always ${n} (${(0).toFixed(n)})`}
                </option>
              ))}
            </select>
          </div>
          <label className="check-row" title={unit === "in" ? "Each size also in millimetres, in brackets: 1.575 [40]" : "Each size also in inches, in brackets: 40 [1.575]"}>
            <input
              type="checkbox"
              checked={!!drawing.dualUnits}
              onChange={(e) =>
                change((d) => {
                  const { dualUnits: _old, ...rest } = d;
                  return e.target.checked ? { ...rest, dualUnits: true } : rest;
                })
              }
            />
            Sizes in {unit === "in" ? "millimetres" : "inches"} too
          </label>
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
          <label className="check-row" title="The lines where a rounded edge (fillet) or curved face meets a flat face smoothly. Hide them for a cleaner look.">
            <input
              type="checkbox"
              checked={drawing.tangentEdges !== false}
              onChange={(e) =>
                change((d) => {
                  const { tangentEdges: _old, ...rest } = d;
                  return e.target.checked ? rest : { ...rest, tangentEdges: false };
                })
              }
            />
            Show tangent edges (where rounds meet flat faces)
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
          <label className="check-row" title="Threads drawn the standard way: a thin three-quarter circle seen end-on, thin lines along the thread seen from the side — on tapped holes, threaded rods and fasteners">
            <input
              type="checkbox"
              checked={drawing.threadSymbols !== false}
              onChange={(e) =>
                change((d) => {
                  const { threadSymbols: _old, ...rest } = d;
                  return e.target.checked ? rest : { ...rest, threadSymbols: false };
                })
              }
            />
            Thread symbols (bolts, rods, tapped holes)
          </label>
          <label className="check-row" title="Tag each hole on the top view (or the first view showing holes) and list where it is and its size in a table">
            <input
              type="checkbox"
              checked={drawing.holeTable === true}
              onChange={(e) =>
                change((d) => {
                  const { holeTable: _old, ...rest } = d;
                  return e.target.checked ? { ...rest, holeTable: true } : rest;
                })
              }
            />
            Hole table
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
      <SectionsList drawing={drawing} change={change} missed={missedSections(drawing, projections, upToDate)} />
      <DetailsList drawing={drawing} change={change} />
      <BreakOutsList drawing={drawing} change={change} />
      <ShortenedList drawing={drawing} change={change} />
      <RevisionsList drawing={drawing} change={change} />
      <section className="panel-section">
        <h3>Title block</h3>
        <div className="drawing-fields">
          <TitleField label="Title" value={drawing.title.title ?? ""} placeholder={subject ?? ""} onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, title: v.trim() || undefined } }))} />
          <TitleField label="Part number" value={drawing.title.partNumber ?? ""} placeholder="e.g. BRK-001" onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, partNumber: v.trim() || undefined } }))} />
          <TitleField label="Drawn by" value={drawing.title.drawnBy ?? ""} onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, drawnBy: v.trim() || undefined } }))} />
          <TitleField label="Company" value={drawing.title.company ?? ""} placeholder="Your name or workshop" onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, company: v.trim() || undefined } }))} />
          <TitleField label="Material" value={drawing.title.material ?? ""} placeholder="e.g. Nylon PA12, Stainless 316" onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, material: v.trim() || undefined } }))} />
          <TitleField label="Notes" multiline value={drawing.title.notes ?? ""} placeholder="One note per line" onCommit={(v) => change((d) => ({ ...d, title: { ...d.title, notes: v.trim() || undefined } }))} />
        </div>
      </section>
    </aside>
  );
}

/** The drawing's revision history: add a revision (next letter, today's date), edit or remove one. */
function RevisionsList({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const revs = drawing.revisions ?? [];
  const put = (list: DrawingRevision[]) =>
    change((d) => {
      const { revisions: _old, ...rest } = d;
      return list.length ? { ...rest, revisions: list } : rest;
    });
  const edit = (id: string, patch: Partial<DrawingRevision>) => put(revs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <section className="panel-section">
      <h3>
        Revisions
        <button
          type="button"
          className="text-button small-text"
          onClick={() => put([...revs, { id: newId("rv"), rev: nextRevision(drawing), description: revs.length ? "" : "First issue", date: today() }])}
          title="Add a revision (shown in a table above the title block)"
        >
          + Add
        </button>
      </h3>
      {revs.length === 0 ? (
        <p className="panel-hint">Record changes to the drawing: each revision gets a letter, a description and a date. The latest letter shows in the title block (REV).</p>
      ) : (
        <ul className="revision-list">
          {[...revs].reverse().map((r) => (
            <li key={r.id} className="revision-row">
              <input className="revision-rev" value={r.rev} aria-label="Revision" onChange={(e) => edit(r.id, { rev: e.target.value.slice(0, 8) })} />
              <input value={r.description} aria-label={`Revision ${r.rev} description`} placeholder="What changed" onChange={(e) => edit(r.id, { description: e.target.value.slice(0, 200) })} />
              <input className="revision-date" value={r.date} aria-label={`Revision ${r.rev} date`} onChange={(e) => edit(r.id, { date: e.target.value.slice(0, 20) })} />
              <button type="button" className="icon-button small" onClick={() => put(revs.filter((x) => x.id !== r.id))} aria-label={`Remove revision ${r.rev}`} title="Remove">
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The drawing's section cuts: flip which way each looks, or remove it. */
function BreakOutsList({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const list = drawing.breakouts ?? [];
  if (!list.length) return null;
  return (
    <section className="panel-section">
      <h3>Broken-out</h3>
      <div className="drawing-views">
        {list.map((b, i) => (
          <div className="section-row" key={b.id}>
            <span>
              Cut {i + 1} <span className="muted small">(on {VIEW_LABELS[b.host]})</span>
              <br />
              <DepthBox value={b.depth} label={`Broken-out cut ${i + 1} depth`} onCommit={(depth) => change((d) => putBreakOut(d, { ...b, depth }))} />
            </span>
            <span className="row-actions-inline">
              <button
                type="button"
                className="text-button small-text danger-text"
                onClick={() => change((d) => removeBreakOut(d, b.id))}
                title="Remove this cut (the view shows the whole part again)"
                aria-label={`Remove broken-out cut ${i + 1}`}
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

/** The drawing's shortened views: remove one to show the whole length again. */
function ShortenedList({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const list = drawing.shortened ?? [];
  if (!list.length) return null;
  return (
    <section className="panel-section">
      <h3>Shortened views</h3>
      <div className="drawing-views">
        {list.map((s, i) => (
          <div className="section-row" key={s.id}>
            <span>
              Break {i + 1} <span className="muted small">(on {VIEW_LABELS[s.host]}, {s.axis === "x" ? "across" : "up and down"})</span>
            </span>
            <span className="row-actions-inline">
              <button
                type="button"
                className="text-button small-text danger-text"
                onClick={() => change((d) => removeShortening(d, s.id))}
                title="Remove this break (the view shows its whole length again)"
                aria-label={`Remove break ${i + 1}`}
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

/** How deep a broken-out cut goes (mm, or the design's units), saved on Enter or leaving the box. */
function DepthBox({ value, label, onCommit }: { value: number; label: string; onCommit: (v: number) => void }) {
  const unit = useLengthUnit();
  const [text, setText] = useState(lengthNumber(value, unit));
  useEffect(() => setText(lengthNumber(value, unit)), [value, unit]);
  const take = () => {
    const v = Number(text);
    if (v > 0) onCommit(fromUnit(v, unit));
    else setText(lengthNumber(value, unit));
  };
  return (
    <label className="small muted" title="How deep the cut goes, from the front of the part as this view sees it">
      Depth{" "}
      <input className="short-input" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={take} onKeyDown={(e) => e.key === "Enter" && take()} />{" "}
      {unit}
    </label>
  );
}

function DetailsList({ drawing, change }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void }) {
  const details = drawing.details ?? [];
  return (
    <section className="panel-section">
      <h3>Details</h3>
      <div className="drawing-views">
        {details.length === 0 && (
          <p className="panel-hint">
            To show a small area bigger, choose <strong>Detail</strong> in the toolbar, click the middle of the area on a view, then click to set the circle&apos;s size.
          </p>
        )}
        {details.map((x) => (
          <div className="section-row" key={x.id}>
            <span>
              Detail {x.letter} <span className="muted small">(on {VIEW_LABELS[x.host]})</span>
            </span>
            <span className="row-actions-inline">
              <select
                aria-label={`Detail ${x.letter} enlargement`}
                value={String(x.zoom)}
                onChange={(e) => change((d) => updateDetail(d, x.id, (v) => ({ ...v, zoom: Number(e.target.value) })))}
              >
                {[...new Set([...DETAIL_ZOOMS, x.zoom])].sort((a, b) => a - b).map((z) => (
                  <option key={z} value={String(z)}>
                    {z}×
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-button small-text danger-text"
                onClick={() => change((d) => removeDetail(d, x.id))}
                title="Remove this detail and its view"
                aria-label={`Remove detail ${x.letter}`}
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

function SectionsList({ drawing, change, missed }: { drawing: Drawing; change: (fn: (d: Drawing) => Drawing) => void; missed: Set<string> }) {
  const sections = drawing.sections ?? [];
  return (
    <section className="panel-section">
      <h3>Sections</h3>
      <div className="drawing-views">
        {sections.length === 0 && (
          <p className="panel-hint">
            To cut the part open, choose <strong>Section</strong> in the toolbar, then click two points across the front, top or side view.
            <strong> Auxiliary view</strong> (under Section's ▾) shows a sloping face square-on instead.
          </p>
        )}
        {sections.map((s: SectionCut) => (
          <div className="section-row" key={s.id}>
            <span>
              {s.aux ? `View ${s.letter} (auxiliary)` : `Section ${s.letter}-${s.letter}`} <span className="muted small">(on {VIEW_LABELS[s.host]})</span>
              {missed.has(s.id) && (
                <span className="muted small" role="note">
                  {" "}
                  — its line misses the part, so there's nothing to show. Remove it and draw the line across the part.
                </span>
              )}
            </span>
            <span className="row-actions-inline">
              <button
                type="button"
                className="text-button small-text"
                onClick={() => change((d) => updateSection(d, s.id, (c) => ({ ...c, flip: !c.flip })))}
                title={s.aux ? "Look from the other side" : "Look the other way (keep the other side of the cut)"}
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

/**
 * A dimension being made: the first thing clicked on its view (a corner, an
 * edge or a circle), then — once a second thing is clicked — the two points
 * it measures between, ready to place.
 */
type Pending = { view: string; first: DimTarget; a?: P2; b?: P2; force?: "horizontal" | "vertical"; angle?: { a: P2; b: P2; c: P2; d: P2 } };

const targetOf = (s: Snap): DimTarget =>
  s.kind === "point" ? { kind: "point", at: s.at } : s.kind === "line" ? { kind: "line", a: s.a, b: s.b } : { kind: "circle", centre: s.centre, r: s.r, full: s.full };

/** The sheet itself, with views you can drag about. Scroll to zoom, middle- or right-drag to pan. */
export function DrawingSheet({ drawing }: { drawing: Drawing }) {
  const docName = useStore((s) => s.history.present.name);
  const doc = useStore((s) => s.history.present);
  const allParts = useStore((s) => s.parts);
  const bom = useMemo(() => bomFor(drawing, doc, allParts), [drawing, doc, allParts]);
  const change = useStore((s) => s.changeDrawing);
  const tool = useStore((s) => s.drawingTool);
  const selectedDims = useStore((s) => s.selectedDims);
  const isSelected = (id: string) => selectedDims.includes(id);
  /** A selection box being dragged out over empty paper (sheet mm). */
  const [selBox, setSelBox] = useState<{ from: P2; to: P2; additive: boolean } | null>(null);
  const { projections, subject, instances, busy, error } = useProjections(drawing);
  const instancesKey = instances ? JSON.stringify(instances) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const balloons = useMemo(() => balloonsFor(bom, instances, allParts), [bom, instancesKey, allParts]);
  const [drag, setDrag] = useState<{ viewId: string; start: P2; from: P2; at: P2 } | null>(null);
  const [dimDrag, setDimDrag] = useState<{ id: string; patch: { offset: number; angle?: number; textAlong?: number; textAcross?: number } } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** A note being dragged: where the pointer started and where the note was. */
  const [noteDrag, setNoteDrag] = useState<{ id: string; start: P2; from: P2; at: P2 } | null>(null);
  /** Datum, tolerance frame or finish mark being placed: the point it's for (its leader's end). */
  const [symbolStart, setSymbolStart] = useState<P2 | null>(null);
  useEffect(() => setSymbolStart(null), [tool]);
  /** Section tool: the cutting line's first point (view mm), on its view. */
  const [cutStart, setCutStart] = useState<{ view: string; at: P2 } | null>(null);
  /** Detail tool: the circle's middle (view mm), on its view. */
  const [detailStart, setDetailStart] = useState<{ view: string; at: P2 } | null>(null);
  /** Broken-out tool: the first corner clicked. */
  const [breakStart, setBreakStart] = useState<{ view: string; at: P2 } | null>(null);
  /** Shortened view tool: the first edge clicked. */
  const [shortStart, setShortStart] = useState<{ view: string; at: P2 } | null>(null);
  const [cursor, setCursor] = useState<P2 | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [W, H] = SHEETS[drawing.sheet];
  const pad = 12;
  const [box, setBox] = useState<[number, number, number, number]>([-pad, -pad, W + 2 * pad, H + 2 * pad]);
  const pan = useRef<{ x: number; y: number; box: [number, number, number, number] } | null>(null);
  useEffect(() => setBox([-pad, -pad, W + 2 * pad, H + 2 * pad]), [W, H]);
  /** Baseline / chain / ordinate tools: the run of dimensions being made. */
  const [run, setRun] = useState<LinearRun | null>(null);
  const linear = tool === "baseline" || tool === "chain" || tool === "ordinate";
  useEffect(() => {
    setPending(null);
    setCutStart(null);
    setDetailStart(null);
    setBreakStart(null);
    setShortStart(null);
    setRun(null);
  }, [tool, drawing.id]);

  // While a view or a dimension is dragged, show it where it's going.
  const shown = useMemo(() => {
    let d = drawing;
    if (drag) d = { ...d, views: d.views.map((v) => (v.id === drag.viewId ? { ...v, at: drag.at } : v)) };
    if (dimDrag) d = { ...d, dimensions: d.dimensions?.map((x) => (x.id === dimDrag.id ? { ...x, ...dimDrag.patch } : x)) };
    if (noteDrag) d = { ...d, notes: d.notes?.map((x) => (x.id === noteDrag.id ? { ...x, at: noteDrag.at } : x)) };
    return d;
  }, [drawing, drag, dimDrag, noteDrag]);
  const unit = useLengthUnit();
  const taps = useMemo(() => tapSizes(doc, drawing), [doc, drawing]);
  const layout = useMemo(
    () => (projections ? layoutSheet(shown, projections, { designName: docName, subject: subject ?? "", date: today(), bom, balloons, taps }) : null),
    // The units change the dimension numbers and the title block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, projections, docName, subject, bom, balloons, unit, taps],
  );
  useEffect(() => {
    if (layout && projections && !drag && !dimDrag) shownSheet = { drawingId: drawing.id, layout, name: drawing.name, projections };
  }, [layout, projections, drag, dimDrag, drawing.id, drawing.name]);
  const snaps = useMemo(() => (layout && projections && tool !== "select" ? snapsOf(layout, projections) : []), [layout, projections, tool]);

  // Delete removes the selected dimension; Esc steps back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const s = useStore.getState();
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedDims.length) {
        e.preventDefault();
        const ids = s.selectedDims;
        s.changeDrawing((d) => ids.reduce((acc, id) => removeNote(removeDimension(acc, id), id), d));
        s.selectDim(null);
      } else if (e.key === "Escape") {
        if (symbolStart) setSymbolStart(null);
        else if (cutStart) setCutStart(null);
        else if (detailStart) setDetailStart(null);
        else if (breakStart) setBreakStart(null);
        else if (shortStart) setShortStart(null);
        else if (pending) setPending(null);
        else if (run) setRun(null);
        else if (s.selectedDims.length) s.selectDim(null);
        else if (s.drawingTool !== "select") s.setDrawingTool("select");
      } else if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        s.setDrawingTool(s.drawingTool === "dimension" ? "select" : "dimension");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, cutStart, run, detailStart, breakStart, shortStart, symbolStart]);

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

  /**
   * The dimension the pending clicks and the pointer would make (like
   * Onshape's single Dimension tool): a circle on its own gives its diameter
   * (or an arc's radius), an edge on its own its length, and two things the
   * distance between them.
   */
  const previewDim = (): Dimension | null => {
    if (!pending || !cursor || !projections?.[pending.view]) return null;
    const at = viewAt(pending.view);
    if (!at) return null;
    const p = projections[pending.view]!;
    const f = pending.first;
    if (!pending.b && f.kind === "circle") {
      const c = at(f.centre);
      const angle = Math.round((Math.atan2(cursor[1] - c[1], cursor[0] - c[0]) * 180) / Math.PI);
      const offset = Math.max(2, Math.round((Math.hypot(cursor[0] - c[0], cursor[1] - c[1]) - f.r * (layout?.scale ?? 1)) * 10) / 10);
      return { id: "preview", view: pending.view, type: f.full ? "diameter" : "radius", a: dimPoint(f.centre, p), r: f.r, offset, angle };
    }
    if (pending.angle) {
      const g = pending.angle;
      const place = placeAngle(at(g.a), at(g.b), at(g.c), at(g.d), cursor);
      if (!place) return null;
      return { id: "preview", view: pending.view, type: "angle", a: dimPoint(g.a, p), b: dimPoint(g.b, p), c: dimPoint(g.c, p), d: dimPoint(g.d, p), ...place };
    }
    const [a, b] = pending.b && pending.a ? [pending.a, pending.b] : f.kind === "line" ? [f.a, f.b] : [null, null];
    if (!a || !b) return null;
    const place = placeLength(at(a), at(b), cursor, pending.force);
    return { id: "preview", view: pending.view, type: place.type, a: dimPoint(a, p), b: dimPoint(b, p), offset: place.offset };
  };

  const dimensionClick = (e: ReactPointerEvent<SVGSVGElement>) => {
    const here = toSheet(e);
    const s = useStore.getState();
    const placeIt = () => {
      const preview = previewDim();
      if (!preview) return false;
      change((d) => putDimension(d, { ...preview, id: newId("dm") }));
      setPending(null);
      return true;
    };
    // Two things picked: this click places the dimension.
    if (pending?.b) {
      placeIt();
      return;
    }
    const snap = findSnap(snaps, here, tolerance());
    if (!pending) {
      if (snap) setPending({ view: snap.view, first: targetOf(snap) });
      return;
    }
    // A click away from the drawing places a circle's diameter or an edge's length.
    if (!snap || snap.view !== pending.view || sameTarget(pending.first, targetOf(snap))) {
      if (pending.first.kind !== "point" && placeIt()) return;
      if (snap && snap.view !== pending.view) setPending({ view: snap.view, first: targetOf(snap) });
      return;
    }
    // Two edges at an angle: the angle between them.
    const second = targetOf(snap);
    if (pending.first.kind === "line" && second.kind === "line" && angleGeometry(pending.first.a, pending.first.b, second.a, second.b)) {
      setPending({ ...pending, a: pending.first.a, b: pending.first.b, angle: { a: pending.first.a, b: pending.first.b, c: second.a, d: second.b } });
      return;
    }
    // A second thing: the distance between them.
    const pair = pairFor(pending.first, targetOf(snap));
    if ("error" in pair) {
      s.showToast(pair.error, "info");
      return;
    }
    setPending({ ...pending, a: pair.a, b: pair.b, force: pair.force });
  };

  /** Symbols: the first click is what it points at (snapping to corners and edges), the second where it goes. */
  const snapped = (here: P2): P2 => {
    const snap = findSnap(snaps, here, tolerance());
    if (!snap) return here;
    if (snap.kind === "point") return snap.sheet;
    if (snap.kind === "circle") {
      const d = Math.hypot(here[0] - snap.sheet[0], here[1] - snap.sheet[1]) || 1;
      return [snap.sheet[0] + ((here[0] - snap.sheet[0]) / d) * snap.sheetR, snap.sheet[1] + ((here[1] - snap.sheet[1]) / d) * snap.sheetR];
    }
    // Onto the edge.
    const [a, b] = [snap.sheetA, snap.sheetB];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((here[0] - a[0]) * dx + (here[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return [a[0] + t * dx, a[1] + t * dy];
  };
  const newSymbol = (): DrawingSymbol =>
    tool === "datum" ? { kind: "datum", letter: nextDatumLetter(drawing.notes) } : tool === "fcf" ? { kind: "fcf", characteristic: "flatness", tolerance: "0.1", datums: [] } : { kind: "finish", ra: "3.2" };
  const symbolClick = (here: P2) => {
    if (!symbolStart) {
      setSymbolStart(snapped(here));
      return;
    }
    const id = newId("nt");
    const r = (v: number) => Math.round(v * 10) / 10;
    const at: P2 = [r(here[0]), r(here[1])];
    const leader: P2 = [r(symbolStart[0]), r(symbolStart[1])];
    change((d) => putNote(d, { id, at, text: "", symbol: newSymbol(), leader }));
    setSymbolStart(null);
    useStore.getState().setDrawingTool("select");
    useStore.getState().selectDim(id);
  };

  /** Hole callout: label the clicked hole, its leader pointing away from the middle of the view. */
  const calloutClick = (here: P2) => {
    const s = useStore.getState();
    const snap = findSnap(snaps, here, tolerance());
    const p = snap && projections?.[snap.view];
    if (!snap || snap.kind !== "circle" || !p) {
      s.showToast("Click the edge of a hole (a circle on a view).", "info");
      return;
    }
    const hole = holeOfCircle(p, snap.centre, snap.r);
    if (!hole) {
      s.showToast("That circle isn't a hole seen end-on — click a hole on a view looking straight into it.", "info");
      return;
    }
    const [x0, y0, x1, y1] = p.bounds ?? [0, 0, 0, 0];
    const away = Math.atan2(hole.cy - (y0 + y1) / 2, hole.cx - (x0 + x1) / 2);
    const angle = Math.hypot(hole.cx - (x0 + x1) / 2, hole.cy - (y0 + y1) / 2) < 1e-6 ? 45 : Math.round((away * 180) / Math.PI);
    const id = newId("dm");
    change((d) => putDimension(d, { id, view: snap.view, type: "diameter", callout: true, a: dimPoint([hole.cx, hole.cy], p), r: hole.d / 2, offset: 8, angle }));
    s.selectDim(id);
  };

  /** Baseline / chain / ordinate: a corner or hole centre under the pointer, as a point on its view. */
  const linearTarget = (here: P2): { view: string; at: P2 } | null => {
    const snap = findSnap(snaps, here, tolerance());
    if (!snap || snap.kind === "line") return null;
    return { view: snap.view, at: snap.kind === "point" ? snap.at : snap.centre };
  };
  /** The dimensions a click here would add to the run. */
  const linearNext = (here: P2 | null): Dimension[] => {
    if (!run || !here || !layout || !projections) return [];
    const t = linearTarget(here);
    const p = projections[run.view];
    if (!t || t.view !== run.view || !p) return [];
    return nextLinear(run, p, t.at, layout.scale, drawing.dimensions ?? []).map((d, i) => ({ ...d, id: `preview${i}` }));
  };
  const linearClick = (here: P2) => {
    const t = linearTarget(here);
    if (!t) return;
    if (!run || t.view !== run.view) {
      setRun(startRun(t.view, tool as LinearKind, t.at, drawing.projection === "third", drawingViewKeys(drawing)));
      return;
    }
    const made = linearNext(here);
    if (!made.length) {
      useStore.getState().showToast(run.count ? "That's already measured, or level with where it measures from." : "Click a point further across or up from the datum.", "info");
      return;
    }
    change((d) => made.reduce((x, m) => putDimension(x, { ...m, id: newId("dm") }), d));
    setRun(advanceRun(run, t.at, made));
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
    return { view: v.key, at: fromSheetPoint(v, p, layout.scale, here[0], here[1]), sheet: here };
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
  /** Detail tool: radius (view mm) of the circle for the pointer, from its middle. */
  const detailRadius = (here: P2): number | null => {
    if (!detailStart || !layout) return null;
    const at = viewAt(detailStart.view);
    if (!at) return null;
    const c = at(detailStart.at);
    return Math.hypot(here[0] - c[0], here[1] - c[1]) / layout.scale;
  };
  const detailClick = (here: P2) => {
    if (!detailStart) {
      const p = cutPoint(here);
      if (p) setDetailStart({ view: p.view, at: p.at });
      return;
    }
    const r = detailRadius(here);
    const p = projections?.[detailStart.view];
    if (!r || !p?.bounds || !layout || r * layout.scale < 2) return;
    const host = detailStart.view as DetailView["host"];
    const centre = toRel(p.bounds, detailStart.at);
    change((d) => addDetail(d, { id: newId("dt"), host, centre, radius: Math.round(r * 100) / 100, zoom: 2 }));
    setDetailStart(null);
    useStore.getState().setDrawingTool("select");
  };

  /** Broken-out tool: two corners of a rectangle on a front, top or side view; it starts cut halfway through. */
  const breakClick = (here: P2) => {
    if (!breakStart) {
      const p = cutPoint(here);
      if (p) setBreakStart({ view: p.view, at: p.at });
      return;
    }
    const end = cutPoint(here, breakStart.view);
    const p = projections?.[breakStart.view];
    if (!end || !p?.bounds || !layout) return;
    const [ax, ay] = breakStart.at;
    const [bx, by] = end.at;
    if (Math.abs(bx - ax) * layout.scale < 2 || Math.abs(by - ay) * layout.scale < 2) return;
    const depth = Math.max(0.1, Math.round(((p.depth ?? 10) / 2) * 10) / 10);
    change((d) => putBreakOut(d, { id: newId("bo"), host: breakStart.view as BreakOut["host"], a: toRel(p.bounds!, breakStart.at), b: toRel(p.bounds!, end.at), depth }));
    setBreakStart(null);
    useStore.getState().setDrawingTool("select");
  };

  /** Shortened view: the two edges of the stretch to take out, along whichever way they're further apart. */
  const shortenClick = (here: P2) => {
    if (!shortStart) {
      const p = cutPoint(here);
      if (p) setShortStart({ view: p.view, at: p.at });
      return;
    }
    const end = cutPoint(here, shortStart.view);
    const p = projections?.[shortStart.view];
    if (!end || !p?.bounds || !layout) return;
    const dx = Math.abs(end.at[0] - shortStart.at[0]);
    const dy = Math.abs(end.at[1] - shortStart.at[1]);
    if (Math.max(dx, dy) * layout.scale < 3) return;
    const axis = dx >= dy ? "x" : "y";
    const i = axis === "x" ? 0 : 1;
    const lo = p.bounds[i];
    const span = p.bounds[i + 2] - lo;
    if (!(span > 0)) return;
    const frac = (v: number) => Math.round(Math.max(0, Math.min(1, (v - lo) / span)) * 1e6) / 1e6;
    const a = frac(shortStart.at[i]);
    const b = frac(end.at[i]);
    if (Math.abs(b - a) < 1e-3) return;
    change((d) => putShortening(d, { id: newId("sh"), host: shortStart.view as Shortening["host"], axis, from: Math.min(a, b), to: Math.max(a, b) }));
    setShortStart(null);
    useStore.getState().setDrawingTool("select");
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
    const aux = useStore.getState().drawingTool === "auxiliary";
    change((d) => addSection(d, { id: newId("sc"), host, a, b, ...(aux ? { aux: true } : {}) }));
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
    if (tool === "note") {
      const at = toSheet(e);
      const id = newId("nt");
      change((d) => putNote(d, { id, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10], text: "Note" }));
      useStore.getState().setDrawingTool("select");
      useStore.getState().selectDim(id);
      return;
    }
    if (tool === "datum" || tool === "fcf" || tool === "finish") {
      symbolClick(toSheet(e));
      return;
    }
    if (tool === "dimension") dimensionClick(e);
    else if (tool === "holeCallout") calloutClick(toSheet(e));
    else if (linear) linearClick(toSheet(e));
    else if (tool === "section" || tool === "auxiliary") sectionClick(toSheet(e));
    else if (tool === "detail") detailClick(toSheet(e));
    else if (tool === "breakout") breakClick(toSheet(e));
    else if (tool === "shorten") shortenClick(toSheet(e));
    else {
      // Empty paper: drag out a box to select dimensions and notes (Shift or Ctrl adds to what's selected).
      const at = toSheet(e);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setSelBox({ from: at, to: at, additive: e.shiftKey || e.ctrlKey || e.metaKey });
    }
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
    if (selBox) setSelBox({ ...selBox, to: here });
    if (drag) setDrag({ ...drag, at: [drag.from[0] + here[0] - drag.start[0], drag.from[1] + here[1] - drag.start[1]] });
    if (noteDrag) setNoteDrag({ ...noteDrag, at: [noteDrag.from[0] + here[0] - noteDrag.start[0], noteDrag.from[1] + here[1] - noteDrag.start[1]] });
    if (dimDrag) {
      const dim = drawing.dimensions?.find((x) => x.id === dimDrag.id);
      const placed = layout?.dims.find((x) => x.id === dimDrag.id);
      // Shift: move just the number (anywhere, off the line too); otherwise move the dimension.
      const lengthDim = dim && dim.type !== "diameter" && dim.type !== "radius" && dim.type !== "ordinate" && dim.type !== "angle";
      if (dim && placed && e.shiftKey && lengthDim && placed.b) {
        setDimDrag({ id: dim.id, patch: { offset: dim.offset, ...dragDimensionText(dim, placed.a, placed.b, here) } });
      } else if (dim && placed) {
        setDimDrag({ id: dim.id, patch: { ...dragDimension(dim, placed.a, placed.b, placed.rad, here, placed.cd), textAcross: 0 } });
      }
    }
  };
  const onPointerUp = () => {
    pan.current = null;
    if (selBox) {
      setSelBox(null);
      const st = useStore.getState();
      const moved = Math.hypot(selBox.to[0] - selBox.from[0], selBox.to[1] - selBox.from[1]) > 1;
      const ids = moved && layout ? itemsInBox(layout, selBox.from, selBox.to) : [];
      if (selBox.additive) st.selectDims([...st.selectedDims, ...ids.filter((id) => !st.selectedDims.includes(id))]);
      else st.selectDims(ids);
    }
    if (drag) {
      const { viewId, at } = drag;
      setDrag(null);
      if (Math.hypot(at[0] - drag.from[0], at[1] - drag.from[1]) > 0.2) {
        change((d) => ({ ...d, views: d.views.map((v) => (v.id === viewId ? { ...v, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10] } : v)) }));
      }
    }
    if (noteDrag) {
      const { id, at, from } = noteDrag;
      setNoteDrag(null);
      if (Math.hypot(at[0] - from[0], at[1] - from[1]) > 0.2) {
        change((d) => ({ ...d, notes: d.notes?.map((x) => (x.id === id ? { ...x, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10] } : x)) }));
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
      ? "Move to place the dimension, then click."
      : pending?.first.kind === "circle"
        ? "Click to place the size of the circle — or click an edge, corner or another circle to measure to its centre."
        : pending?.first.kind === "line"
          ? "Click to place the edge's length — or click a hole, corner or parallel edge to measure the distance to it, or a slanted edge for the angle between them."
          : pending
            ? "Now click a second corner, an edge or a circle. Esc to start again."
            : "Click a circle, an edge or a corner. Then click to place it, or click a second thing to measure between them.";
  else if (tool === "datum" || tool === "fcf" || tool === "finish")
    message = symbolStart ? "Now click where the symbol goes. Esc to start again." : "Click the edge or surface it's for (corners and edges snap).";
  else if (tool === "holeCallout") message = "Click a hole to label it (size, depth, counterbore, thread and how many). Drag the label to move it.";
  else if (tool === "note") message = "Click where the note goes (its top-left corner). Then type its text in the panel on the left.";
  else if (linear) {
    const what = tool === "baseline" ? "each measured from it" : tool === "chain" ? "each measured from the one before" : "each labelled with its distance from it";
    message = run
      ? `Click the next corner or hole centre (${what}). Esc to finish, or click another view's point to start again there.`
      : "Click the datum: the corner or hole centre to measure from.";
  } else if (tool === "shorten")
    message = shortStart
      ? "Click the other end of the stretch to take out (along the view, or up and down it). Esc to start again."
      : "Click one end of the stretch to take out of a long view (front, top or a side view).";
  else if (tool === "breakout")
    message = breakStart
      ? "Click the opposite corner of the area to cut away. Set how deep it goes in the panel. Esc to start again."
      : "Click one corner of the area to cut away, on the front, top or a side view.";
  else if (tool === "detail")
    message = detailStart
      ? "Click to set the size of the circle — everything inside it is shown bigger. Esc to start again."
      : "Click the middle of the area to show bigger, on the front, top or a side view.";
  else if (tool === "section")
    message = cutStart
      ? "Click where the cutting line ends (it straightens when nearly across or up-and-down). Esc to start again."
      : "Click where the cutting line starts, on the front, top or a side view (corners and hole centres snap).";
  else if (tool === "auxiliary")
    message = cutStart
      ? "Click the other end of the sloping edge. The new view looks square-on to it. Esc to start again."
      : "Click one end of a sloping edge on the front, top or a side view (corners snap).";

  const hover =
    (tool === "dimension" && cursor && !pending?.b) || (linear && cursor) ? findSnap(snaps, cursor!, tolerance()) : tool === "holeCallout" && cursor ? holeHover(cursor) : null;
  const firstMark = (() => {
    if (linear && run) {
      const at = viewAt(run.view);
      return at ? { point: at(run.datum) } : null;
    }
    if (tool !== "dimension" || !pending || pending.b) return null;
    const at = viewAt(pending.view);
    const f = pending.first;
    if (!at) return null;
    if (f.kind === "line") return { line: [at(f.a), at(f.b)] as [P2, P2] };
    return { point: at(f.kind === "point" ? f.at : f.centre) };
  })();
  const cutHover =
    (tool === "section" || tool === "auxiliary" || (tool === "detail" && !detailStart) || (tool === "breakout" && !breakStart) || tool === "shorten") && cursor ? (cutStart ? cutEnd(cursor) : cutPoint(cursor, shortStart?.view)) : null;
  const breakRect = (() => {
    if (tool !== "breakout" || !breakStart || !cursor) return null;
    const at = viewAt(breakStart.view);
    const end = cutPoint(cursor, breakStart.view);
    return at && end ? { a: at(breakStart.at), b: end.sheet } : null;
  })();
  const detailCircle = (() => {
    if (tool !== "detail" || !detailStart || !cursor || !layout) return null;
    const at = viewAt(detailStart.view);
    const r = detailRadius(cursor);
    return at && r ? { c: at(detailStart.at), r: r * layout.scale } : null;
  })();
  function holeHover(at: P2) {
    const snap = findSnap(snaps, at, tolerance());
    const p = snap?.kind === "circle" ? projections?.[snap.view] : null;
    return snap?.kind === "circle" && p && holeOfCircle(p, snap.centre, snap.r) ? snap : null;
  }
  const cutFrom = cutStart ? viewAt(cutStart.view)?.(cutStart.at) : null;
  const preview = previewDim();
  const previewPrims = (() => {
    if (symbolStart && cursor && (tool === "datum" || tool === "fcf" || tool === "finish")) return symbolPrims({ at: cursor, leader: symbolStart }, newSymbol()).prims;
    if (linear && projections) {
      const at = run && viewAt(run.view);
      const p = run && projections[run.view];
      if (!at || !p) return [];
      return linearNext(cursor).flatMap((d) => {
        const r = resolveDim(d, p);
        return drawDimension(d, r, at, measureDim(d, r), null, dimStyle(drawing)).prims;
      });
    }
    if (!preview || !projections) return [];
    const at = viewAt(preview.view);
    const p = projections[preview.view];
    if (!at || !p) return [];
    const r = resolveDim(preview, p);
    return drawDimension(preview, r, at, measureDim(preview, r), null, dimStyle(drawing)).prims;
  })();
  const selectedPlaced = layout?.dims.filter((d) => isSelected(d.id)) ?? [];
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
    if (isSelected(d.id)) return "#1f6fd1";
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
              <title>{`${v.kind === "section" ? (() => { const c = drawing.sections?.find((x) => `section:${x.id}` === v.key); return c?.aux ? `Auxiliary ${c.letter}` : `Section ${c?.letter ?? ""}`; })() : v.kind === "detail" ? `Detail ${drawing.details?.find((c) => `detail:${c.id}` === v.key)?.letter ?? ""}` : VIEW_LABELS[v.kind]} view — drag to move`}</title>
            </rect>
          ))}
        {tool === "select" &&
          layout?.notes.map((n) => (
            <rect
              key={n.id}
              className={`drawing-note-handle${isSelected(n.id) ? " selected" : ""}`}
              x={n.box[0] - 1}
              y={H - n.box[3] - 1}
              width={n.box[2] - n.box[0] + 2}
              height={n.box[3] - n.box[1] + 2}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const st = useStore.getState();
                if (e.ctrlKey || e.metaKey) return st.selectDims(toggled(st.selectedDims, n.id));
                st.selectDim(n.id);
                (e.target as Element).setPointerCapture(e.pointerId);
                const note = drawing.notes?.find((x) => x.id === n.id);
                if (note) setNoteDrag({ id: n.id, start: toSheet(e), from: note.at, at: note.at });
              }}
            >
              <title>Drag to move this note; edit its text in the panel; Delete removes it</title>
            </rect>
          ))}
        {tool === "select" &&
          layout?.dims.map((d) => (
            <circle
              key={d.id}
              className={`drawing-dim-handle${isSelected(d.id) ? " selected" : ""}`}
              cx={d.label[0]}
              cy={H - d.label[1] - 1.5}
              r={4}
              data-dim={d.id}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const st = useStore.getState();
                if (e.ctrlKey || e.metaKey) return st.selectDims(toggled(st.selectedDims, d.id));
                st.selectDim(d.id);
                (e.target as Element).setPointerCapture(e.pointerId);
                const dim = drawing.dimensions?.find((x) => x.id === d.id);
                if (dim) setDimDrag({ id: d.id, patch: { offset: dim.offset, ...(dim.angle !== undefined ? { angle: dim.angle } : {}) } });
              }}
            >
              <title>{d.found ? "Drag to move this dimension; Delete removes it" : "What this dimension measured has changed too much — delete it and add it again"}</title>
            </circle>
          ))}
        {previewPrims.map((p, i) => renderPrim(p, -1 - i, "#1f6fd1"))}
        {firstMark?.point && <circle cx={firstMark.point[0]} cy={H - firstMark.point[1]} r={1.2} className="drawing-snap picked" />}
        {firstMark?.line && (
          <line x1={firstMark.line[0][0]} y1={H - firstMark.line[0][1]} x2={firstMark.line[1][0]} y2={H - firstMark.line[1][1]} className="drawing-snap-line picked" />
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
        {selectedPlaced.map((d) => (
          <circle key={d.id} cx={d.label[0]} cy={H - d.label[1] - 1.5} r={4.5} className="drawing-dim-selected" />
        ))}
        {selBox && (
          <rect
            x={Math.min(selBox.from[0], selBox.to[0])}
            y={H - Math.max(selBox.from[1], selBox.to[1])}
            width={Math.abs(selBox.to[0] - selBox.from[0])}
            height={Math.abs(selBox.to[1] - selBox.from[1])}
            className={`drawing-select-box${selBox.to[0] < selBox.from[0] ? " crossing" : ""}`}
          />
        )}
        {cutFrom && <circle cx={cutFrom[0]} cy={H - cutFrom[1]} r={1.2} className="drawing-snap picked" />}
        {cutFrom && cutHover && <line x1={cutFrom[0]} y1={H - cutFrom[1]} x2={cutHover.sheet[0]} y2={H - cutHover.sheet[1]} className="drawing-cut-preview" />}
        {cutHover && <circle cx={cutHover.sheet[0]} cy={H - cutHover.sheet[1]} r={1.2} className="drawing-snap point" />}
        {detailCircle && <circle cx={detailCircle.c[0]} cy={H - detailCircle.c[1]} r={detailCircle.r} className="drawing-cut-preview" fill="none" />}
        {breakRect && (
          <rect
            x={Math.min(breakRect.a[0], breakRect.b[0])}
            y={H - Math.max(breakRect.a[1], breakRect.b[1])}
            width={Math.abs(breakRect.b[0] - breakRect.a[0])}
            height={Math.abs(breakRect.b[1] - breakRect.a[1])}
            className="drawing-cut-preview"
            fill="none"
          />
        )}
      </svg>
      {message && <div className="drawing-message">{message}</div>}
      {layout?.tooBig && <div className="drawing-message warn">The part is too big for this sheet even at {scaleLabel(layout.scale)}. Try a bigger sheet.</div>}
      {busy && layout && <div className="drawing-busy">Updating views…</div>}
    </div>
  );
}
