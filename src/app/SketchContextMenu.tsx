import { useStore } from "../model/store";
import { additive } from "../viewport/touchKeys";
import { useEffect } from "react";

import { closeSketchMenu, pickSketchOther, runSketchMenu, sketchMenuNow, useSketchMenu } from "./sketchMenuActions";
import { PlacedPopup } from "./PlacedPopup";
import { setSketchLit } from "./sketchViewState";

/**
 * The open sketch's right-click menu (or long press on a touch screen), like Onshape's: the relations that fit what's
 * picked, construction, copy / paste / delete, show or hide constraints and dimensions, Finish, and Select other.
 */
export function SketchContextMenu() {
  const open = useSketchMenu();
  const sketchOpen = useStore((s) => !!s.sketch);
  // The sketch closed with the menu open: it goes (it mustn't come back with the next sketch).
  useEffect(() => {
    if (!sketchOpen && sketchMenuNow()) closeSketchMenu();
  }, [sketchOpen]);
  if (!open || !sketchOpen) return null;
  const anchor = () => ({ left: open.at.x, right: open.at.x, top: open.at.y, bottom: open.at.y });
  if (open.other) {
    return (
      <PlacedPopup className="context-menu select-other sketch-menu" role="menu" label="Select other" anchor={anchor} onClose={closeSketchMenu} focusFirst>
        <div className="select-other-title">Select other</div>
        {open.other.ids.map((id, i) => (
          <button
            key={id}
            className="menu-item"
            role="menuitem"
            onPointerEnter={() => setSketchLit([id])}
            onFocus={() => setSketchLit([id])}
            onPointerLeave={() => setSketchLit(null)}
            onClick={(e) => pickSketchOther(id, additive(e.nativeEvent))}
          >
            {open.other!.labels[i]}
          </button>
        ))}
      </PlacedPopup>
    );
  }
  return (
    <PlacedPopup className="context-menu sketch-menu" role="menu" label="Sketch" anchor={anchor} onClose={closeSketchMenu} focusFirst>
      {open.items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="sketch-menu-row">
          {item.divider && <div className="menu-divider" role="separator" />}
          <button className="menu-item" role="menuitem" onClick={() => runSketchMenu(item.action)}>
            <span>{item.label}</span>
            {item.key && <span className="menu-key">{item.key}</span>}
          </button>
        </div>
      ))}
    </PlacedPopup>
  );
}
