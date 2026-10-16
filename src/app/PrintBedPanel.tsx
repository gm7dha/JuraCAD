import { useMemo } from "react";

import { bedFit, bedSize, CUSTOM_PRINTER, PRINTERS } from "../model/printBed";
import { useLengthUnit, useStore } from "../model/store";
import { fromUnit, lengthNumber } from "../model/units";
import { viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";

const PRINTER_KEY = "partsmith.printer";

/** Turn the print bed preview on, with the printer chosen last time. */
export function startPrintBed() {
  let saved: { printer: string; custom?: [number, number, number] } | null = null;
  try {
    const raw = globalThis.localStorage?.getItem(PRINTER_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  useStore.getState().setPrintBed(saved && typeof saved.printer === "string" ? saved : { printer: PRINTERS[0].id });
}

function remember(bed: { printer: string; custom?: [number, number, number] }) {
  try {
    globalThis.localStorage?.setItem(PRINTER_KEY, JSON.stringify(bed));
  } catch {
    // Not remembered next time; fine.
  }
}

const AXES = ["X (width)", "Y (depth)", "Z (height)"];

/** Floating panel: which printer, and whether what's shown fits on its bed. */
export function PrintBedPanel() {
  const bed = useStore((s) => s.printBed);
  const parts = useStore((s) => s.parts);
  const hidden = useStore((s) => s.hiddenParts);
  const setPrintBed = useStore((s) => s.setPrintBed);
  const unit = useLengthUnit();
  const bounds = useMemo(
    () => (bed ? viewportApi.current?.visibleBounds() ?? null : null),
    // Recalculate when the model or what's shown changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bed, parts, hidden],
  );
  if (!bed) return null;
  const size = bedSize(bed.printer, bed.custom);
  const choose = (next: { printer: string; custom?: [number, number, number] }) => {
    setPrintBed(next);
    remember(next);
  };
  const partSize = bounds ? ([0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]) as [number, number, number]) : null;
  const fit = partSize ? bedFit(partSize, size) : null;
  const len = (mm: number) => `${lengthNumber(Math.round(mm * 10) / 10, unit)} ${unit}`;
  const tooBig = fit ? fit.over.map((v, i) => (v > 0 ? `${len(v)} too ${["wide", "deep", "tall"][i]}` : null)).filter(Boolean) : [];

  return (
    <div className="section-panel print-bed-panel" role="region" aria-label="Print bed">
      <div className="section-header">
        <strong>Print bed</strong>
        <button className="icon-button small" onClick={() => setPrintBed(null)} title="Hide the print bed" aria-label="Close print bed">
          <Icons.Cross size={14} />
        </button>
      </div>
      <label className="field-label" htmlFor="print-bed-printer">
        Printer
      </label>
      <select
        id="print-bed-printer"
        className="full-select"
        value={bed.printer}
        onChange={(e) => choose(e.target.value === CUSTOM_PRINTER ? { printer: CUSTOM_PRINTER, custom: size } : { printer: e.target.value })}
      >
        {PRINTERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {p.size.join(" × ")}
          </option>
        ))}
        <option value={CUSTOM_PRINTER}>Another printer (type its size)…</option>
      </select>
      {bed.printer === CUSTOM_PRINTER && (
        <div className="print-bed-sizes">
          {AXES.map((label, i) => (
            <label key={label}>
              <span className="muted small">{label}</span>
              <input
                type="number"
                min={1}
                aria-label={`Bed ${label}`}
                value={Number(lengthNumber(size[i], unit))}
                onChange={(e) => {
                  const v = fromUnit(Number(e.target.value), unit);
                  if (!(v > 0)) return;
                  const custom = [...size] as [number, number, number];
                  custom[i] = v;
                  choose({ printer: CUSTOM_PRINTER, custom });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {!partSize ? (
        <p className="muted small">Nothing shown to check.</p>
      ) : (
        <>
          <p className="small">
            What's shown: {partSize.map((v) => lengthNumber(Math.round(v * 10) / 10, unit)).join(" × ")} {unit}
          </p>
          {fit?.fits ? (
            <p className="print-bed-ok">✓ Fits on the bed.</p>
          ) : (
            <p className="print-bed-bad">
              Too big: {tooBig.join(", ")}.{fit?.fitsTurned ? " It fits if you turn it a quarter turn on the bed." : ""}
            </p>
          )}
          <p className="muted small">The bed is drawn under the lowest point, centred beneath what's shown, with a 10 mm grid. Hide parts to check them one at a time.</p>
        </>
      )}
    </div>
  );
}
