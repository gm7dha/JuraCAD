import { useRef, useState } from "react";

import { useStore } from "../model/store";
import { Modal } from "./Modal";
import { APP_VERSION, SHORT_VERSION } from "../version";
import { detectPlatform, helpRows, type Platform } from "./platform";
import { eggClick } from "./easterEgg";

function KeyTable({ rows, keysFirst }: { rows: [string, string][]; keysFirst: boolean }) {
  return (
    <table className="shortcut-table">
      <tbody>
        {rows.map(([a, b]) =>
          keysFirst ? (
            <tr key={a}>
              <td>
                <kbd>{a}</kbd>
              </td>
              <td>{b}</td>
            </tr>
          ) : (
            <tr key={a}>
              <td>{a}</td>
              <td>
                <kbd>{b}</kbd>
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

export function HelpDialog() {
  const openDialog = useStore((s) => s.openDialog);
  const [platform, setPlatform] = useState<Platform>(() => detectPlatform());
  const rows = helpRows(platform);
  const clicks = useRef<number[]>([]);
  const [egg, setEgg] = useState(false);
  const choose = (p: Platform) => {
    setPlatform(p);
    const r = eggClick(clicks.current, performance.now());
    clicks.current = r.recent;
    if (r.found) setEgg(true);
  };

  return (
    <Modal title="Help and shortcuts" onClose={() => openDialog(null)} width={560}>
      <p>
        PartSmith works like Onshape. Sketch a shape and extrude or revolve it, or add simple solids from the toolbar,
        then edit them any time by double-clicking them in the feature list. Any box accepts maths, units and
        variables (set them up with Variables in the toolbar), e.g. <kbd>wall * 2</kbd> or <kbd>1/4 in</kbd>.
        Import brings in STEP or STL files from other programs (or drag one onto the window).
        Your latest work is kept in this browser automatically; use Save to keep a .partsmith file on your computer.
        Install (top bar) makes PartSmith a desktop app with its own window that works offline; in Safari on a Mac,
        use File › Add to Dock.
      </p>
      <h3 className="help-heading">Finding tools</h3>
      <p className="small">
        Similar tools share one toolbar button. Click the small <kbd>▾</kbd> beside a button to see the others in its
        group (for example Centre rectangle under Rectangle, or Chamfer under Fillet); the button then remembers the one
        you picked last. Hover over any button to see its name. Right-click a feature in the list for more options.
      </p>
      <div className="platform-row">
        <span className="muted small">Shortcuts shown for</span>
        <div className="segmented two" role="radiogroup" aria-label="Keyboard type">
          {(["windows", "mac"] as const).map((p) => (
            <button
              type="button"
              key={p}
              role="radio"
              aria-checked={platform === p}
              className={platform === p ? "selected" : ""}
              onClick={() => choose(p)}
            >
              {p === "mac" ? "Mac" : "Windows"}
            </button>
          ))}
        </div>
      </div>
      <h3 className="help-heading">Mouse</h3>
      <KeyTable rows={rows.mouse} keysFirst={false} />
      <h3 className="help-heading">Keyboard</h3>
      <KeyTable rows={rows.keys} keysFirst />
      <h3 className="help-heading">While sketching</h3>
      <p className="small">
        Blue lines can still move; black lines are fully fixed by dimensions and constraints. Drag points or lines to
        reshape. Click ✓ to finish, then use Extrude or Revolve to turn the closed shapes into a solid.
      </p>
      <KeyTable rows={rows.sketch} keysFirst />
      <p className="muted small">
        PartSmith {SHORT_VERSION} ({APP_VERSION}). PartSmith is free and open source (MIT). It uses the OpenCascade geometry kernel (LGPL 2.1) via replicad.{" "}
        <a href="https://github.com/Gm7dha/partsmith" target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        .
      </p>
      {egg && (
        <div className="easter-egg" role="dialog" aria-label="Surprise!" onClick={() => setEgg(false)} title="Click to close">
          <img src={`${import.meta.env.BASE_URL}easter-egg.jpg`} alt="A happy spaniel in a teal harness, standing on a carved log" />
        </div>
      )}
    </Modal>
  );
}
