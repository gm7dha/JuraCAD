import { activeFeatures, useStore } from "../model/store";
import { finalChoice } from "../model/finalPreview";

/**
 * Onshape's "Final" tick in a feature dialog's header: while an existing
 * feature is edited, the Part Studio is shown as it was just after it; ticked,
 * the whole finished design is shown with the change in place. Remembered for
 * this session only (see store.showFinal).
 */
export function FinalToggle() {
  const offered = useStore((s) => finalChoice(activeFeatures(s), s.editing, s.rollbackTo));
  const on = useStore((s) => s.showFinal);
  const setShowFinal = useStore((s) => s.setShowFinal);
  if (!offered) return null;
  return (
    <label
      className="final-toggle"
      title={on ? "Showing the finished design, with every feature after this one. Untick to see the part as it was when this feature was made." : "Showing the part as it was when this feature was made. Tick to see the finished design, with every feature after this one."}
    >
      <input type="checkbox" checked={on} onChange={(e) => setShowFinal(e.target.checked)} aria-label="Final: show the finished design" />
      Final
    </label>
  );
}
