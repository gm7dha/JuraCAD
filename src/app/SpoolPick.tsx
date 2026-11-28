/**
 * Pick a colour from Bambu Lab's real filaments (src/terrain/bambuColours.ts): first the material (PLA, PETG, ABS, ASA,
 * TPU…), then the colour, as swatches with their names under each line (PLA Basic, PLA Matte… / PETG HF, PETG Basic…) —
 * or any colour of your own. `SpoolPick` is the swatch button the puzzles use; `SpoolChoices` is the list itself, also
 * used by the part and face colour popovers.
 */
import { useRef, useState } from "react";

import { BAMBU_MATERIALS, coloursOfMaterial, materialOfLine, spoolFor } from "../terrain/bambuColours";
import { boxOf, PlacedPopup } from "./PlacedPopup";

/** The material tabs and the colours of the one chosen; `onPick(hex, code)` (code missing = your own colour). */
export function SpoolChoices({
  value,
  chosen,
  onPick,
  label,
  custom = true,
  opensOn,
}: {
  value: string;
  chosen?: string;
  onPick: (hex: string, code?: string) => void;
  label: string;
  custom?: boolean;
  /** The material tab to open on (the puzzle's material), else the colour's own. */
  opensOn?: string;
}) {
  const spool = spoolFor(value, chosen);
  const [material, setMaterial] = useState(() => opensOn ?? (spool ? materialOfLine(spool.line) : "PLA"));
  const hex = value.toLowerCase();
  return (
    <div className="spool-choices">
      <div className="spool-materials" role="tablist" aria-label={`Filament material for ${label}`}>
        {BAMBU_MATERIALS.map((m) => (
          <button
            type="button"
            role="tab"
            key={m.material}
            aria-selected={m.material === material}
            className={`spool-material${m.material === material ? " selected" : ""}`}
            onClick={() => setMaterial(m.material)}
          >
            {m.material}
          </button>
        ))}
      </div>
      <div className="spool-lines">
        {coloursOfMaterial(material).map(({ line, colours }) => (
          <div key={line} className="spool-line">
            <div className="spool-line-name">Bambu Lab {line}</div>
            <div className="spool-grid">
              {colours.map((c) => {
                const on = spool?.code === c.code;
                return (
                  <button
                    type="button"
                    key={c.code}
                    className={`spool-choice${on ? " selected" : ""}`}
                    title={`${c.name} (${line}, ${c.hex})`}
                    aria-pressed={on}
                    onClick={() => onPick(c.hex, c.code)}
                  >
                    <span className="colour-swatch" style={{ background: c.hex }} />
                    <span className="spool-name">{c.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {custom && (
        <label className="spool-custom">
          <input type="color" value={/^#[0-9a-f]{6}$/.test(hex) ? hex : "#a8b4c0"} onChange={(e) => onPick(e.target.value)} aria-label={`Your own colour for ${label}`} /> Your own colour
          {!spool && <span className="muted small"> (chosen now)</span>}
        </label>
      )}
    </div>
  );
}

export function SpoolPick({ value, chosen, onPick, label, opensOn }: { value: string; chosen?: string; onPick: (hex: string, code?: string) => void; label: string; opensOn?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const spool = spoolFor(value, chosen);
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
            <SpoolChoices
              value={value}
              chosen={chosen}
              label={label}
              opensOn={opensOn}
              onPick={(h, code) => {
                onPick(h, code);
                if (code) setOpen(false);
              }}
            />
          </div>
        </PlacedPopup>
      )}
    </>
  );
}
