import { useEffect, useMemo, useState } from "react";

import { getKernel } from "../kernel/connect";
import { densityFor, massIn, materialKeyFor, massRows, massSummary, rowsText, type DensityChoice, type PartMassProps } from "../model/massProps";
import { formatMass, MATERIALS } from "../model/materials";
import { activeAssembly, studioParts, useLengthUnit, useStore } from "../model/store";
import { copiesToWeigh, materialPartOf } from "../assembly/asmMeasure";
import { useAssemblyInputs } from "./asmReadouts";
import { formatArea, formatLength, formatVolume } from "../model/units";
import { viewportApi } from "../viewport/Viewport";
import { setMassState, useMassState } from "./massState";

const NO_MATERIALS: Record<string, string> = {};

/** Copy text to the clipboard, saying so (or that it couldn't). */
export function copyText(text: string, what: string): void {
  const done = () => useStore.getState().showToast(`${what} copied.`);
  const failed = () => useStore.getState().showToast(`${what} couldn't be copied here — select the numbers and copy them instead.`);
  try {
    const p = navigator.clipboard?.writeText(text);
    if (p) p.then(done, failed);
    else failed();
  } catch {
    failed();
  }
}

/** The bottom-right button that opens Mass properties (Onshape keeps it beside Measure). */
export function MassButton() {
  const { open } = useMassState();
  const hasParts = useStore((s) => {
    const asm = activeAssembly(s);
    return asm ? asm.instances.length > 0 : studioParts(s).length > 0;
  });
  const editing = useStore((s) => s.editing !== null);
  if (!hasParts || editing) return null;
  return (
    <button
      type="button"
      className={`readout-button${open ? " active" : ""}`}
      aria-pressed={open}
      onClick={() => setMassState({ open: !open })}
      title="Mass properties — what the parts (or an assembly's copies) weigh, their volume, surface area, centre of mass and size (for the parts selected, else all of them)"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
        <path d="M8 2v12M3 14h10M3 5h10M3 5l-2 5h4zM13 5l-2 5h4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      Mass
    </button>
  );
}

/**
 * Onshape-style Mass properties for the parts selected (whole parts, or the parts of picked faces and edges), else
 * every part on show: exact numbers from the engine, the weight from each part's material or one density chosen here,
 * and the centre of mass marked in the view.
 */
export function MassPanel() {
  const state = useMassState();
  const parts = useStore(studioParts);
  const hidden = useStore((s) => s.hiddenParts);
  const selectedParts = useStore((s) => s.selectedParts);
  const selection = useStore((s) => s.selection);
  const editing = useStore((s) => s.editing !== null);
  const materials = useStore((s) => s.history.present.materials ?? NO_MATERIALS);
  const unit = useLengthUnit();
  const [measured, setMeasured] = useState<PartMassProps[] | null>(null);
  // In an assembly: its copies (cut, mirrored and placed as put together), the picked ones or all those shown.
  const asm = useStore(activeAssembly);
  const asmSelection = useStore((s) => s.asmSelection);
  const hiddenCopies = useStore((s) => s.hiddenInstances);
  const exploded = asm?.explode !== undefined;
  const inputs = useAssemblyInputs(state.open && !editing);

  // Which parts: picked ones, the parts of picked faces/edges, else everything shown.
  const chosen = useMemo(() => {
    if (asm) {
      const c = copiesToWeigh(inputs ?? [], asmSelection, hiddenCopies);
      return { ids: c.instances.map((i) => i.id), all: c.all, copies: c.instances };
    }
    const ids = parts.map((p) => p.id);
    const picked = selectedParts.length ? selectedParts : [...new Set(selection.map((s) => s.partId))];
    const some = picked.filter((id) => ids.includes(id));
    return { ids: some.length ? some : ids.filter((id) => !hidden.includes(id)), all: !some.length, copies: null };
  }, [asm, inputs, asmSelection, hiddenCopies, parts, selectedParts, selection, hidden]);
  const key = chosen.ids.join("|");

  useEffect(() => {
    if (!state.open || editing) return;
    setMeasured(null);
    if (!chosen.ids.length) return;
    let live = true;
    (chosen.copies ? getKernel().massProperties([], chosen.copies) : getKernel().massProperties(chosen.ids))
      .then((r) => live && setMeasured(r))
      .catch(() => live && setMeasured([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, editing, key, parts, chosen.copies]);

  // A copy is weighed as its part's material.
  const partOf = (id: string) => {
    const c = chosen.copies?.find((i) => i.id === id);
    return c ? materialPartOf(c.partId, materials) : id;
  };
  const choice: DensityChoice =
    state.choice === "own" ? { kind: "own", materials } : { kind: "all", density: state.choice === "custom" ? state.density : MATERIALS.find((m) => m.key === state.choice)?.density ?? 1 };
  const keyOf = (id: string) => (state.choice === "own" ? materialKeyFor(choice, partOf(id)) : state.choice === "custom" ? undefined : state.choice);
  const summary = useMemo(
    () => (measured ? massSummary(measured, (id) => densityFor(choice, partOf(id)), keyOf) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measured, state.choice, state.density, materials, chosen.copies],
  );

  const shown = state.open && !editing;
  // (An exploded view is weighed put together, so the dot isn't drawn where the parts are shown apart.)
  const centre = shown && !exploded ? summary?.centre ?? null : null;
  useEffect(() => {
    viewportApi.current?.setCentreMark(centre);
    return () => viewportApi.current?.setCentreMark(null);
  }, [centre?.[0], centre?.[1], centre?.[2]]);

  if (!shown) return null;
  const inches = unit === "in";
  const rows = summary
    ? massRows(summary, { length: (v) => formatLength(v), area: (v) => formatArea(v), volume: (v) => formatVolume(v), mass: (g) => massIn(g, inches, formatMass) })
    : [];
  const names = measured?.map((p) => p.name) ?? [];
  const what = asm ? (chosen.ids.length === 1 ? "copy" : "copies") : chosen.ids.length === 1 ? "part" : "parts";
  const title = chosen.all
    ? asm
      ? `${asm.name} (${chosen.ids.length} ${what})`
      : `All parts (${chosen.ids.length})`
    : chosen.ids.length === 1
      ? names[0] ?? `1 ${what}`
      : `${chosen.ids.length} ${what}`;

  return (
    <div className="measure-panel mass-panel" aria-label="Mass properties" role="status">
      <div className="measure-title readout-head">
        <span>Mass properties — {title}</span>
        <span className="readout-actions">
          {rows.length > 0 && (
            <button type="button" className="icon-button small" onClick={() => copyText(rowsText(`Mass properties — ${title}`, rows), "Mass properties")} title="Copy these numbers">
              Copy
            </button>
          )}
          <button type="button" className="icon-button small" onClick={() => setMassState({ open: false })} aria-label="Close mass properties" title="Close">
            ×
          </button>
        </span>
      </div>
      <label className="mass-density">
        <span>Weigh as</span>
        <select aria-label="Material for the weight" value={state.choice} onChange={(e) => setMassState({ choice: e.target.value })}>
          <option value="own">Each part's own material</option>
          {MATERIALS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} ({m.density} g/cm³)
            </option>
          ))}
          <option value="custom">Another density…</option>
        </select>
        {state.choice === "custom" && (
          <input
            type="number"
            aria-label="Density in grams per cubic centimetre"
            min={0.01}
            step={0.01}
            value={state.density}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setMassState({ density: v });
            }}
            title="Grams per cubic centimetre (water is 1)"
          />
        )}
      </label>
      {!measured ? (
        <p className="muted small">{chosen.ids.length ? "Measuring…" : asm ? "Nothing to weigh — every copy is hidden or suppressed." : "Nothing to measure — every part is hidden."}</p>
      ) : (
        <table>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        {chosen.all ? (asm ? "Select copies to weigh just those. " : "Select parts (or a face of one) to weigh just those. ") : ""}
        Weights are solid; for plastics, "printed" guesses 2 walls and 15% infill.{" "}
        {exploded ? "Weighed as put together, not exploded (so the centre of mass isn't marked)." : "The dot in the view is the centre of mass."}
      </p>
    </div>
  );
}
