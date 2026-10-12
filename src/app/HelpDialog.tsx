import { useStore } from "../model/store";
import { Modal } from "./Modal";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

const MOUSE: [string, string][] = [
  ["Orbit", "Right-drag"],
  ["Pan", "Middle-drag, or Ctrl + right-drag"],
  ["Zoom (towards the cursor)", "Scroll wheel"],
  ["Select a face, edge or plane", "Left-click"],
  ["Add to selection", "Shift-click or Ctrl-click"],
  ["Jump to a standard view", "Click a face of the view cube"],
  ["Look straight at a plane", "Double-click Top, Front or Right in the feature list"],
];

const KEYS: [string, string][] = [
  ["F", "Zoom to fit"],
  ["N", "View normal to the selected face or plane"],
  ["Shift + 1 / 2", "Front / back view"],
  ["Shift + 3 / 4", "Left / right view"],
  ["Shift + 5 / 6", "Top / bottom view"],
  ["Shift + 7", "Isometric view"],
  [`${mod} + Z`, "Undo"],
  [`${mod} + Y  or  ${mod} + Shift + Z`, "Redo"],
  ["Enter", "Accept the open feature dialog"],
  ["Esc", "Cancel the feature dialog / clear the selection"],
  ["Delete", "Delete the highlighted feature"],
  ["?", "Show this help"],
  ["Shift + S", "Start a sketch on the selected plane or flat face"],
  ["Shift + E", "Extrude a sketch"],
  ["Shift + F", "Fillet (round) the selected edges"],
];

const SKETCH_KEYS: [string, string][] = [
  ["L", "Line (keep clicking to chain lines)"],
  ["R", "Rectangle"],
  ["C", "Circle"],
  ["A", "Arc through three points"],
  ["P", "Point"],
  ["D", "Dimension: click a line or circle (or two things), then where the number goes"],
  ["Q", "Construction: dashed helper lines that aren't extruded"],
  ["H / V", "Make the selected lines horizontal / vertical"],
  ["Esc", "Stop the current tool, then clear the selection"],
  ["Delete", "Delete the selected sketch items"],
  [`${mod} + Z / ${mod} + Y`, "Undo / redo inside the sketch"],
  ["Double-click a dimension", "Change its value"],
];

export function HelpDialog() {
  const openDialog = useStore((s) => s.openDialog);
  return (
    <Modal title="Help and shortcuts" onClose={() => openDialog(null)} width={560}>
      <p>
        PartSmith works like Onshape. Sketch a shape and extrude it, or add simple solids from the toolbar, then edit them any time by double-clicking them in the
        feature list. Everything is saved in this browser automatically.
      </p>
      <h3 className="help-heading">Mouse</h3>
      <table className="shortcut-table">
        <tbody>
          {MOUSE.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>
                <kbd>{b}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="help-heading">Keyboard</h3>
      <table className="shortcut-table">
        <tbody>
          {KEYS.map(([a, b]) => (
            <tr key={a}>
              <td>
                <kbd>{a}</kbd>
              </td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="help-heading">While sketching</h3>
      <p className="small">
        Blue lines can still move; black lines are fully fixed by dimensions and constraints. Drag points or lines to
        reshape. Click ✓ to finish, then use Extrude to turn the closed shapes into a solid.
      </p>
      <table className="shortcut-table">
        <tbody>
          {SKETCH_KEYS.map(([a, b]) => (
            <tr key={a}>
              <td>
                <kbd>{a}</kbd>
              </td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        PartSmith is free and open source (MIT). It uses the OpenCascade geometry kernel (LGPL 2.1) via replicad.{" "}
        <a href="https://github.com/Gm7dha/partsmith" target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        .
      </p>
    </Modal>
  );
}
