/**
 * Colour faces (Onshape's Appearance on a face): opened from the 3D view's right-click menu on a face — "Colour this
 * face…", or for the faces picked when the face under the pointer is one of them. The usual colours, Bambu Lab's
 * filaments by material, your own colour, or back to the part's colour. One undo step per choice.
 */
import { useSyncExternalStore } from "react";

import { PART_COLOURS } from "../model/colours";
import { facesColoured } from "../model/faceColours";
import { studioParts, useStore } from "../model/store";
import { SpoolChoices } from "./SpoolPick";
import { PlacedPopup } from "./PlacedPopup";

/** Which faces are being coloured (part id → face indices of its mesh as shown) and where the popover opens. */
export interface FaceColourOpen {
  at: { x: number; y: number };
  faces: Record<string, number[]>;
}

let current: FaceColourOpen | null = null;
const listeners = new Set<() => void>();

export function openFaceColour(next: FaceColourOpen | null): void {
  current = next;
  for (const l of listeners) l();
}

function useFaceColour(): FaceColourOpen | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

/**
 * The faces a right-click on (partId, index) colours: the faces picked, when it's one of them; else just it.
 * (Faces of several parts may be picked: each part's own.)
 */
export function facesToColour(partId: string, index: number): Record<string, number[]> {
  const picked = useStore.getState().selection.filter((s) => s.kind === "face");
  if (!picked.some((s) => s.partId === partId && s.index === index)) return { [partId]: [index] };
  const out: Record<string, number[]> = {};
  for (const s of picked) (out[s.partId] ??= []).push(s.index);
  return out;
}

export function FaceColourMenu() {
  const open = useFaceColour();
  // Drawn again when the design changes, so the colour shown follows what was just chosen.
  useStore((s) => s.history.present);
  if (!open) return null;
  const close = () => openFaceColour(null);
  const count = Object.values(open.faces).reduce((n, l) => n + l.length, 0);
  const s = useStore.getState();
  const firstPart = Object.keys(open.faces)[0];
  const shown = s.history.present.faceAppearance?.[firstPart];
  const parts = studioParts(s);
  // What the first face shows now, for the picker's tick.
  const firstIndex = open.faces[firstPart]?.[0];
  const mesh = parts.find((p) => p.id === firstPart);
  const nowEntry = mesh && firstIndex !== undefined ? facesColoured(shown, mesh).colours.get(firstIndex) : undefined;
  const value = nowEntry?.colour ?? s.history.present.appearance?.[firstPart] ?? PART_COLOURS[0].hex;
  const apply = (colour: string | null, spool?: string) => {
    for (const [partId, faces] of Object.entries(open.faces)) useStore.getState().setFaceColours(partId, faces, colour, spool);
  };
  const label = count === 1 ? "this face" : `these ${count} faces`;
  return (
    <PlacedPopup
      className="face-colour-popover"
      role="dialog"
      label={`Colour ${label}`}
      anchor={() => ({ left: open.at.x, right: open.at.x, top: open.at.y, bottom: open.at.y })}
      onClose={close}
      focusFirst
    >
      <div className="face-colour-title">Colour {label}</div>
      <div className="colour-grid">
        {PART_COLOURS.slice(1).map((c) => (
          <button
            type="button"
            key={c.hex}
            className={`colour-choice${c.hex === value ? " selected" : ""}`}
            style={{ background: c.hex }}
            title={c.name}
            aria-label={c.name}
            onClick={() => {
              apply(c.hex);
              close();
            }}
          />
        ))}
      </div>
      <SpoolChoices
        value={value}
        chosen={nowEntry?.spool}
        label={label}
        onPick={(hex, code) => {
          apply(hex, code);
          if (code) close();
        }}
      />
      <div className="face-colour-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => {
            apply(null);
            close();
          }}
        >
          Back to the part's colour
        </button>
        {Object.keys(open.faces).some((id) => s.history.present.faceAppearance?.[id]?.length) && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              for (const id of Object.keys(open.faces)) useStore.getState().clearFaceColours(id);
              close();
            }}
          >
            Clear all face colours on {Object.keys(open.faces).length === 1 ? "this part" : "these parts"}
          </button>
        )}
      </div>
    </PlacedPopup>
  );
}
