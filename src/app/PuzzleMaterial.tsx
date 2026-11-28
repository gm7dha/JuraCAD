/**
 * The filament the Island and Mountain puzzles are printed in (the windows' "Material" box): remembered for the session,
 * shared by both windows, never saved. "PLA" = the usual (Bambu Lab PLA Basic and Matte colours).
 */
import { useEffect, useRef, useState } from "react";
import { BAMBU_COLOURS } from "../terrain/bambuColours";
import { PATH_RED, ROAD_BLACK, USUAL_SPOOLS, type ColourBand, type ColourSpec } from "../terrain/colour";
import { changeMaterial, MATERIAL_CHOICES, materialName, USUAL_MATERIAL, inMaterial, type PuzzleMaterial } from "../terrain/puzzleMaterial";

let chosen: PuzzleMaterial = USUAL_MATERIAL;

/** The material chosen and its setter (kept for the session). */
export function usePuzzleMaterial(): [PuzzleMaterial, (m: PuzzleMaterial) => void] {
  const [m, setM] = useState(chosen);
  return [
    m,
    (next) => {
      chosen = next;
      setM(next);
    },
  ];
}

/** Bands with their colours in the material (the usual PLA: as they are). */
export const bandsIn = (bands: ColourBand[], m: PuzzleMaterial): ColourBand[] =>
  m === USUAL_MATERIAL ? bands : bands.map((b) => ({ ...b, colour: inMaterial(b.colour, m).hex }));

/**
 * When the material changes, colours still the usual ones (for the material before) become the new material's usual
 * ones; colours picked by hand stay.
 */
export function useMaterialFollow(spec: ColourSpec, setSpec: (s: ColourSpec) => void, m: PuzzleMaterial, usual: { bands: ColourBand[]; base: string | null; water: string }) {
  // The window's colours start as the usual PLA ones, so a material chosen earlier in the session is applied at once.
  const before = useRef<PuzzleMaterial>(USUAL_MATERIAL);
  const now = useRef(spec);
  now.current = spec;
  useEffect(() => {
    const from = before.current;
    before.current = m;
    if (from === m) return;
    const next = changeMaterial(now.current, { bands: usual.bands.map((b) => b.colour), base: usual.base, water: usual.water, paths: PATH_RED, roads: ROAD_BLACK }, from, m, USUAL_SPOOLS);
    if (next !== now.current) setSpec(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m]);
}

/** The Material box: the usual PLA, then each line Bambu Lab makes colours in (PLA, PETG, ABS, ASA). */
export function MaterialSelect({ value, onChange }: { value: PuzzleMaterial; onChange: (m: PuzzleMaterial) => void }) {
  return (
    <label className="mountain-row">
      <span>Material</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Material" title="Bambu Lab filament the puzzle is printed in">
        <option value={USUAL_MATERIAL}>{materialName(USUAL_MATERIAL)} — the usual</option>
        {MATERIAL_CHOICES.map((g) => (
          <optgroup key={g.material} label={`Bambu Lab ${g.material}`}>
            {g.lines
              .filter((l) => BAMBU_COLOURS.some((c) => c.line === l))
              .map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
