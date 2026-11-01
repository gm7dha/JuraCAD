import { useState } from "react";

import { evaluate } from "../model/expr";
import { SCREW_SIZES } from "../model/holes";
import { FIT_LABELS, FIT_NAMES, fitExpression, fitVariableName, parseFitExpression, type FitName } from "../model/printSettings";
import { useLengthUnit, useStore } from "../model/store";
import { formatLength, showLength, storeLength } from "../model/units";
import { loadPrinter } from "./printerSetting";

/**
 * Hole dialog: "Printed fit" — make the hole a little bigger than what goes in
 * it (a pin, a bearing, a screw), by the clearance for a press, snug, sliding
 * or loose fit on a 3D printer. The hole's size becomes e.g. "5 mm + fit_sliding",
 * so changing the design's fit_sliding variable resizes every such hole. If the
 * design has no fit variables yet, the dialog uses the number meanwhile and they're
 * added on Accept (store.commitDraft → settlePrintedFit), in the same undo step.
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
  if (h.fit === "tapped" && h.standard !== "Custom") {
    return (
      <p className="dialog-hint field-hint printed-fit">
        Printed fits are for plain holes that a pin, rod or bearing goes into. This is a tapped hole for a screw thread — choose Clearance (or Custom
        sizes) to give it a printed fit.
      </p>
    );
  }
  const diameter = draft.params.diameter ?? "";
  const current = h.printedFit ? { fit: h.printedFit.fit, nominal: h.printedFit.nominal } : parseFitExpression(diameter);
  const hasVariable = (fit: FitName) => !!variables?.some((v) => v.name === fitVariableName(fit));

  const nominalGuess = () => {
    if (current) return current.nominal;
    const screw = SCREW_SIZES.find((s) => s.name === h.standard);
    if (screw) return `${screw.name.slice(1)} mm`;
    const r = evaluate(diameter);
    return r.ok ? `${Math.round(r.value * 1000) / 1000} mm` : "5 mm";
  };

  const choose = (fit: FitName | "", nominal = nominalGuess()) => {
    const { printedFit: _, ...plain } = h;
    void _;
    if (!fit) {
      // Back to a plain size: the hole keeps the size it has now.
      const r = evaluate(diameter);
      setDraftField({ hole: plain });
      if (r.ok) setDraftParam("diameter", `${Math.round(r.value * 1e6) / 1e6}`);
      return;
    }
    // A printed-fit hole is a plain round size of its own (not a standard screw size).
    const base = { ...plain, standard: "Custom", fit: "clearance" as const };
    if (hasVariable(fit)) {
      setDraftField({ hole: base });
      setDraftParam("diameter", fitExpression(nominal, fit));
    } else {
      // The design has no fit variables yet: they're added when the hole is accepted (the same undo step).
      const fits = loadPrinter().print.fits;
      setDraftField({ hole: { ...base, printedFit: { fit, nominal, fits } } });
      setDraftParam("diameter", `${nominal.trim()} + ${fits[fit]} mm`);
    }
  };

  const clearance = current
    ? (variables?.find((v) => v.name === fitVariableName(current.fit))?.value ?? (h.printedFit ? `${h.printedFit.fits[current.fit]} mm` : undefined))
    : undefined;
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
              ? `Hole ${formatLength(total.value, unit)} across: ${formatLength(nominalValue.value, unit)} plus the ${FIT_LABELS[current.fit].label.toLowerCase()} clearance (${fitVariableName(current.fit)}${clearance ? ` = ${clearance}` : ""}).`
              : `The hole is ${current.nominal} plus ${fitVariableName(current.fit)}.`}{" "}
            {h.printedFit
              ? `Accepting adds the variables fit_press, fit_snug, fit_sliding and fit_loose to the design, so changing ${fitVariableName(current.fit)} later resizes every such hole.`
              : `Change ${fitVariableName(current.fit)} in Variables to resize every hole that uses it.`}{" "}
            Tune the clearances for your printer under 3D print › Printer settings.
          </p>
        </>
      )}
    </div>
  );
}
