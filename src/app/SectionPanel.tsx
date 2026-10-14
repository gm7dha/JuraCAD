import { useMemo } from "react";

import { useLengthUnit, useStore, type PlaneName } from "../model/store";
import { fromUnit, lengthNumber } from "../model/units";
import { SECTION_AXIS } from "../viewport/section";
import { viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";

const PLANES: PlaneName[] = ["Top", "Front", "Right"];
const AXIS_NAME: Record<PlaneName, string> = { Top: "height (Z)", Front: "depth (Y)", Right: "across (X)" };

/** Start a section view through the middle of the model, looking along the given plane. */
export function startSection(plane: PlaneName = "Front") {
  const extent = viewportApi.current?.extentAlong(SECTION_AXIS[plane]);
  const offset = extent ? Math.round(((extent[0] + extent[1]) / 2) * 100) / 100 : 0;
  useStore.getState().setSection({ plane, offset, flip: false });
}

/** Floating panel to move the section cut, choose its plane or turn it off. */
export function SectionPanel() {
  const section = useStore((s) => s.section);
  const parts = useStore((s) => s.parts);
  const setSection = useStore((s) => s.setSection);
  const unit = useLengthUnit();
  const extent = useMemo(
    () => (section ? viewportApi.current?.extentAlong(SECTION_AXIS[section.plane]) ?? null : null),
    // Recalculate when the model or the plane changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section?.plane, parts],
  );
  if (!section) return null;
  const [lo, hi] = extent ?? [section.offset - 50, section.offset + 50];
  const margin = Math.max(1, (hi - lo) * 0.05);
  const step = Math.max(0.01, Math.round(((hi - lo) / 400) * 100) / 100);

  return (
    <div className="section-panel" role="region" aria-label="Section view">
      <div className="section-header">
        <strong>Section view</strong>
        <button className="icon-button small" onClick={() => setSection(null)} title="Turn the section view off" aria-label="Close section view">
          <Icons.Cross size={14} />
        </button>
      </div>
      <div className="segmented three" role="radiogroup" aria-label="Cut along">
        {PLANES.map((p) => (
          <button
            type="button"
            key={p}
            role="radio"
            aria-checked={section.plane === p}
            className={section.plane === p ? "selected" : ""}
            onClick={() => {
              startSection(p);
              viewportApi.current?.viewNormalToPlane(p);
            }}
            title={`Cut along the ${p} plane`}
          >
            {p}
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor="section-offset">
        Cut position — {AXIS_NAME[section.plane]}
      </label>
      <input
        id="section-offset"
        type="range"
        min={lo - margin}
        max={hi + margin}
        step={step}
        value={section.offset}
        onChange={(e) => setSection({ ...section, offset: Number(e.target.value) })}
      />
      <div className="section-row">
        <input
          className="section-number"
          type="number"
          aria-label="Cut position (mm)"
          step={step}
          value={Number(lengthNumber(section.offset, unit))}
          onChange={(e) => Number.isFinite(Number(e.target.value)) && setSection({ ...section, offset: fromUnit(Number(e.target.value), unit) })}
        />
        <span className="muted">{unit}</span>
        <label className="check-row section-flip">
          <input type="checkbox" checked={section.flip} onChange={(e) => setSection({ ...section, flip: e.target.checked })} />
          Flip
        </label>
      </div>
      <p className="muted small">Display only — the part isn't changed. Measure and selection work on what you can see.</p>
    </div>
  );
}
