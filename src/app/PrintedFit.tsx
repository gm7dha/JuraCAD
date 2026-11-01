import { useState } from "react";

import { newId } from "../model/document";
import { evaluate } from "../model/expr";
import { SCREW_SIZES } from "../model/holes";
import { FIT_LABELS, FIT_NAMES, fitExpression, fitVariableName, parseFitExpression, withFitVariables, type FitName } from "../model/printSettings";
import { useLengthUnit, useStore } from "../model/store";
import { formatLength, showLength, storeLength } from "../model/units";
import { loadPrinter } from "./printerSetting";

/**
 * Hole dialog: "Printed fit" — make the hole a little bigger than what goes in
 * it (a pin, a bearing, a screw), by the clearance for a press, snug, sliding
 * or loose fit on a 3D printer. The hole's size becomes e.g. "5 mm + fit_sliding",
 * so changing the design's fit_sliding variable resizes every such hole.
 */
export function PrintedFit() {
  const draft = useStore((s) => s.editing?.draft);
  const variables = useStore((s) => s.history.present.variables);
  const setDraftParam = useStore((s) => s.setDraftParam);
  const setDraftField = useStore((s) => s.setDraftField);
  const unit = useLengthUnit();
  const [typed, setTyped] = useState<string | null>(null);
  if (!draft || draft.type !== "hole" || !draft.hole) return null;
  const h = draft.hole;
  const diameter = draft.params.diameter ?? "";
  const current = parseFitExpression(diameter);

  const nominalGuess = () => {
    if (current) return current.nominal;
    const screw = SCREW_SIZES.find((s) => s.name === h.standard);
    if (screw) return `${screw.name.slice(1)} mm`;
    const r = evaluate(diameter);
    return r.ok ? `${Math.round(r.value * 1000) / 1000} mm` : "5 mm";
  };

  const choose = (fit: FitName | "", nominal = nominalGuess()) => {
    if (!fit) {
      // Back to a plain size: the hole keeps the size it has now.
      const r = evaluate(diameter);
      if (r.ok) setDraftParam("diameter", `${Math.round(r.value * 1e6) / 1e6}`);
      return;
    }
    // The design needs the fit variables (added once, with the sizes from the printer setting).
    const s = useStore.getState();
    const withFits = withFitVariables(s.history.present.variables, loadPrinter().print.fits, () => newId("v"));
    if (withFits.added.length) {
      s.setVariables(withFits.variables);
      s.showToast(`Added the printed-fit variables (${withFits.added.join(", ")}) to this design. Change them in Variables to resize every printed-fit hole.`, "info");
    }
    // A printed-fit hole is a plain round size (no standard screw size, no modelled thread).
    if (h.standard !== "Custom" || h.modelThread) setDraftField({ hole: { ...h, standard: "Custom", fit: "clearance", modelThread: undefined } });
    setDraftParam("diameter", fitExpression(nominal, fit));
  };

  const clearance = current ? variables?.find((v) => v.name === fitVariableName(current.fit)) : undefined;
  const total = current ? evaluate(diameter) : null;
  const nominalValue = current ? evaluate(current.nominal) : null;

  return (
    <div className="printed-fit">
      <label className="field-label" htmlFor="hole-printed-fit">
        Printed fit (for 3D printing)
      </label>
      <select id="hole-printed-fit" className="full-select" value={current?.fit ?? ""} onChange={(e) => choose(e.target.value as FitName | "")}>
        <option value="">None — use the size as typed</option>
        {FIT_NAMES.map((f) => (
          <option key={f} value={f} title={FIT_LABELS[f].hint}>
            {FIT_LABELS[f].label} — {FIT_LABELS[f].hint.split(" — ")[0].toLowerCase()}
          </option>
        ))}
      </select>
      {current && (
        <>
          <label className="field-label" htmlFor="hole-fit-size">
            Size of what goes in (pin, bearing, screw…)
          </label>
          <input
            id="hole-fit-size"
            className="full-select"
            value={typed ?? showLength(current.nominal)}
            onChange={(e) => {
              setTyped(e.target.value);
              const stored = storeLength(e.target.value);
              if (evaluate(stored).ok) choose(current.fit, stored);
            }}
            onBlur={() => setTyped(null)}
          />
          <p className="dialog-hint field-hint">
            {total?.ok && nominalValue?.ok
              ? `Hole ${formatLength(total.value, unit)} across: ${formatLength(nominalValue.value, unit)} plus the ${FIT_LABELS[current.fit].label.toLowerCase()} clearance (${clearance ? `${fitVariableName(current.fit)} = ${clearance.value}` : fitVariableName(current.fit)}).`
              : `The hole is ${current.nominal} plus ${fitVariableName(current.fit)}.`}{" "}
            Tune the clearances for your printer under 3D print › Printer settings, then “Put these fits in the design as variables”.
          </p>
        </>
      )}
    </div>
  );
}
