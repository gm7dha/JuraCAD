/**
 * Pick a colour for a puzzle's filament from Bambu Lab's real PLA colours (src/terrain/bambuColours.ts), as swatches with
 * their names — PLA Basic, then PLA Matte, then PLA Silk+ — or any colour of your own.
 */
import { useRef, useState } from "react";

import { BAMBU_COLOURS, BAMBU_LINES, spoolFor } from "../terrain/bambuColours";
import { boxOf, PlacedPopup } from "./PlacedPopup";

export function SpoolPick({ value, chosen, onPick, label }: { value: string; chosen?: string; onPick: (hex: string, code?: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const spool = spoolFor(value, chosen);
  const hex = value.toLowerCase();
  return (
    <>
      <button
        ref={button}
        type="button"
        className="spool-button"
        onClick={() => setOpen(!open)}
        aria-label={`${label}: ${spool ? `${spool.name}, ${spool.line}` : "your own colour"} — change it`}
        title={spool ? `${spool.name} (${spool.line}) — click to change` : "Your own colour — click to change"}
        aria-expanded={open}
      >
        <span className="colour-swatch" style={{ background: value }} />
      </button>
      {open && (
        <PlacedPopup className="spool-popover" role="dialog" label={`Choose a filament colour for ${label}`} anchor={() => boxOf(button.current)} owner={button} onClose={() => setOpen(false)} focusFirst>
          {/* While it's open, Esc closes it and not the puzzle window. */}
          <div data-keeps-escape="">
            {BAMBU_LINES.map((line) => (
              <div key={line} className="spool-line">
                <div className="spool-line-name">Bambu Lab {line}</div>
                <div className="spool-grid">
                  {BAMBU_COLOURS.filter((c) => c.line === line).map((c) => {
                    const on = spool?.code === c.code;
                    return (
                      <button
                        type="button"
                        key={c.code}
                        className={`spool-choice${on ? " selected" : ""}`}
                        title={`${c.name} (${line}, ${c.hex})`}
                        aria-pressed={on}
                        onClick={() => {
                          onPick(c.hex, c.code);
                          setOpen(false);
                        }}
                      >
                        <span className="colour-swatch" style={{ background: c.hex }} />
                        <span className="spool-name">{c.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <label className="spool-custom">
              <input type="color" value={hex} onChange={(e) => onPick(e.target.value)} aria-label={`Your own colour for ${label}`} /> Your own colour
              {!spool && <span className="muted small"> (chosen now)</span>}
            </label>
          </div>
        </PlacedPopup>
      )}
    </>
  );
}
