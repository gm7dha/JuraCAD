import { useEffect, useMemo, useRef, useState } from "react";

import { getKernel } from "../kernel/connect";
import { LASER_LAYERS, LAYER_ORDER, layerCounts, layoutPieces, type LaserPiece } from "../laser/laser";
import { laserDxf, laserSvg } from "../laser/laserFiles";
import { outlinePiece, sketchPiece, type LaserOutline, type LaserSource } from "../laser/sources";
import { followedSketch } from "../sketch/areaClicks";
import { activeAssembly, activeDrawing, activeFeatures, pickFor, studioParts, useDocument, useLengthUnit, useStore } from "../model/store";
import { lengthNumber } from "../model/units";
import type { PartMesh } from "../kernel/protocol";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { useLaserPanel, type LaserChoice } from "./laserState";

/** What the engine is asked for, for a choice (none for a sketch, which is read here). */
export function laserSources(choice: LaserChoice, parts: PartMesh[], selection: ReturnType<typeof useStore.getState>["selection"], selectedParts: string[], hidden: string[]): LaserSource[] {
  const whole = (p: PartMesh): LaserSource => (p.flat ? { kind: "flat", partId: p.id } : { kind: "part", partId: p.id });
  if (choice === "all") return parts.filter((p) => !hidden.includes(p.id) && !p.surface).map(whole);
  if (choice.startsWith("flat:")) return [{ kind: "flat", partId: choice.slice(5) }];
  if (choice !== "selection") return [];
  const faces = selection
    .filter((i) => i.kind === "face")
    .map((i) => pickFor(parts, i))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((pick): LaserSource => ({ kind: "face", pick }));
  const wholeParts = selectedParts.map((id) => parts.find((p) => p.id === id)).filter((p): p is PartMesh => !!p).map(whole);
  return [...faces, ...wholeParts];
}

/** Shared empty list (a selector must not return a new array each time). */
const NONE: LaserOutline[] = [];

/**
 * Export for laser: true-size outlines to cut, score and engrave, saved as SVG
 * (for Bambu Studio's laser mode and other laser programs) or DXF. A side panel,
 * so faces can be clicked in the 3D view while it's open.
 */
export function LaserPanel() {
  const open = useLaserPanel((s) => s.open);
  const inAssembly = useStore((s) => activeAssembly(s) !== null);
  const inDrawing = useStore((s) => activeDrawing(s) !== null);
  if (!open || inAssembly || inDrawing) return null;
  return <LaserPanelBody />;
}

function LaserPanelBody() {
  const st = useLaserPanel();
  const doc = useDocument();
  const unit = useLengthUnit();
  const parts = useStore(studioParts);
  const features = useStore(activeFeatures);
  const selection = useStore((s) => s.selection);
  const selectedParts = useStore((s) => s.selectedParts);
  const hidden = useStore((s) => s.hiddenParts);
  const links = useStore((s) => s.sketchLinks);
  const showToast = useStore((s) => s.showToast);
  const sketches = useMemo(() => features.filter((f) => f.type === "sketch" && !f.suppressed && f.sketch), [features]);
  const sheets = parts.filter((p) => p.flat);
  const set = (patch: Partial<typeof st>) => useLaserPanel.setState(patch);

  // Clicking a face or picking a part while the panel is open uses it.
  const picked = selection.filter((i) => i.kind === "face").length + selectedParts.length;
  const lastPicked = useRef(picked);
  useEffect(() => {
    if (picked > 0 && picked !== lastPicked.current && st.source !== "selection") set({ source: "selection" });
    lastPicked.current = picked;
  }, [picked, st.source]);

  const sources = useMemo(() => laserSources(st.source, parts, selection, selectedParts, hidden), [st.source, parts, selection, selectedParts, hidden]);
  const [outlines, setOutlines] = useState<LaserOutline[]>(NONE);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    if (!sources.length) {
      setOutlines(NONE);
      setBusy(false);
      return;
    }
    setBusy(true);
    getKernel()
      .laserOutlines(sources)
      .then((r) => n === asked.current && setOutlines(r))
      .catch((e) => n === asked.current && setOutlines([{ ok: false, error: e instanceof Error ? e.message : String(e) }]))
      .finally(() => n === asked.current && setBusy(false));
  }, [sources]);

  const sketchFeature = st.source.startsWith("sketch:") ? sketches.find((f) => f.id === st.source.slice(7)) : undefined;
  const pieces: LaserPiece[] = useMemo(() => {
    if (sketchFeature) {
      const data = followedSketch(sketchFeature, links)?.data ?? sketchFeature.sketch!.data;
      return [sketchPiece(sketchFeature.name, data, { text: st.text, shapes: st.shapes, open: st.open_ })];
    }
    return outlines.flatMap((o) => (o.ok ? [outlinePiece(o, { bends: st.bends })] : []));
  }, [sketchFeature, links, outlines, st.text, st.shapes, st.open_, st.bends]);
  const problems = sketchFeature ? [] : outlines.flatMap((o) => (o.ok ? [] : [o.error]));
  const sheet = useMemo(() => layoutPieces(pieces, { gap: st.gap, width: st.width, mirror: st.mirror }), [pieces, st.gap, st.width, st.mirror]);
  const counts = layerCounts(sheet);
  const empty = sheet.paths.length === 0;
  const preview = useMemo(() => (empty ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(laserSvg(sheet, { preview: true }))}`), [sheet, empty]);

  const names = [...new Set(pieces.map((p) => p.name))];
  const base = safeFileName(names.length === 1 ? names[0] : `${doc.name} laser`, "laser");
  const save = (kind: "svg" | "dxf") => {
    const name = `${base}${st.mirror ? " mirrored" : ""}.${kind}`;
    const text = kind === "svg" ? laserSvg(sheet, { title: names.join(", ") || doc.name }) : laserDxf(sheet);
    downloadFile(new Blob([text], { type: kind === "svg" ? "image/svg+xml" : "application/dxf" }), name);
    showToast(`Saved ${name}`, "success");
  };
  const mm = (v: number) => lengthNumber(v, unit);
  const close = () => set({ open: false });

  return (
    <div className="section-panel print-panel laser-panel" role="region" aria-label="Export for laser">
      <div className="section-header">
        <strong>Export for laser</strong>
        <button className="icon-button small" onClick={close} title="Close the laser panel" aria-label="Close export for laser">
          <Icons.Cross size={14} />
        </button>
      </div>
      <label className="field-label" htmlFor="laser-source">
        What to cut
      </label>
      <select id="laser-source" className="full-select" value={st.source} onChange={(e) => set({ source: e.target.value })}>
        <option value="selection">Faces and parts you select{picked ? ` (${picked})` : ""}</option>
        <option value="all">Every part shown, side by side</option>
        {sketches.map((f) => (
          <option key={f.id} value={`sketch:${f.id}`}>
            Sketch: {f.name}
          </option>
        ))}
        {sheets.map((p) => (
          <option key={p.id} value={`flat:${p.id}`}>
            Flat pattern: {p.name}
          </option>
        ))}
      </select>
      {st.source === "selection" && !picked && (
        <p className="small print-picking">Click a flat face in the 3D view (Ctrl or ⌘ + click for more), or pick parts in the Parts list: a part gives its biggest flat face.</p>
      )}

      {sketchFeature && (
        <div className="laser-options">
          <label className="laser-option">
            Closed shapes
            <select value={st.shapes} onChange={(e) => set({ shapes: e.target.value as "cut" | "engrave" })}>
              <option value="cut">Cut out</option>
              <option value="engrave">Engrave</option>
            </select>
          </label>
          <label className="laser-option">
            Text
            <select value={st.text} onChange={(e) => set({ text: e.target.value as "cut" | "engrave" })}>
              <option value="engrave">Engrave</option>
              <option value="cut">Cut out</option>
            </select>
          </label>
          <label className="laser-option">
            Lines that don't close
            <select value={st.open_} onChange={(e) => set({ open_: e.target.value as "cut" | "score" })}>
              <option value="cut">Cut</option>
              <option value="score">Score</option>
            </select>
          </label>
        </div>
      )}
      {sources.some((q) => q.kind === "flat") && (
        <label className="laser-check">
          <input type="checkbox" checked={st.bends} onChange={(e) => set({ bends: e.target.checked })} /> Bend lines as scores (green)
        </label>
      )}
      <label className="laser-check">
        <input type="checkbox" checked={st.mirror} onChange={(e) => set({ mirror: e.target.checked })} /> Mirror (flip left to right, to engrave the back)
      </label>
      {pieces.length > 1 && (
        <div className="laser-options">
          <label className="laser-option">
            Gap between pieces
            <span className="laser-number">
              <input type="number" min={0} step={1} value={st.gap} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ gap: Math.max(0, e.target.valueAsNumber) })} aria-label="Gap between pieces (mm)" /> mm
            </span>
          </label>
          <label className="laser-option">
            Rows up to
            <span className="laser-number">
              <input type="number" min={10} step={10} value={st.width} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set({ width: Math.max(10, e.target.valueAsNumber) })} aria-label="Row width (mm)" /> mm wide
            </span>
          </label>
        </div>
      )}

      <div className="flat-pattern-view laser-preview">{preview ? <img src={preview} alt="The outlines to cut" /> : <span className="muted small">{busy ? "Reading the outlines…" : "Nothing to cut yet."}</span>}</div>
      {!empty && (
        <p className="small laser-size">
          <strong>
            {mm(sheet.size[0])} × {mm(sheet.size[1])} {unit}
          </strong>{" "}
          overall{pieces.length > 1 ? `, ${pieces.length} pieces` : ""} — saved at true size.
        </p>
      )}
      {problems.map((p, i) => (
        <p key={i} className="dialog-error small">
          {p}
        </p>
      ))}
      <ul className="laser-key small">
        {LAYER_ORDER.filter((l) => counts[l] > 0 || l === "outer" || l === "inner").map((l) => (
          <li key={l}>
            <span className="laser-swatch" style={{ background: LASER_LAYERS[l].colour }} /> <strong>{LASER_LAYERS[l].label}</strong>
            {counts[l] ? ` (${counts[l]})` : ""}: {LASER_LAYERS[l].hint}
          </li>
        ))}
      </ul>
      <p className="muted small">In Bambu Studio's laser mode, import the SVG and give each colour its own setting. Lines are hairlines, so the laser follows them exactly.</p>
      <div className="laser-buttons">
        <button className="text-button" onClick={() => save("dxf")} disabled={empty} title="DXF with layers CUT_OUTER, CUT_INNER, SCORE and ENGRAVE, in millimetres">
          Save DXF
        </button>
        <button className="primary-button" onClick={() => save("svg")} disabled={empty} title="SVG at true size in millimetres, coloured by layer — for Bambu Studio">
          <Icons.Export size={16} /> Save SVG
        </button>
      </div>
    </div>
  );
}
