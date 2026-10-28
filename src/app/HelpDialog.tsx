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
        JuraCAD works like Onshape. Sketch a shape and extrude or revolve it, or add simple solids from the toolbar,
        then edit them any time by double-clicking them in the feature list. Any box accepts maths, units and
        variables (set them up with Variables in the toolbar), e.g. <kbd>wall * 2</kbd> or <kbd>1/4 in</kbd>.
        Import brings in STEP or STL files from other programs (or drag one onto the window).
        Your latest work is kept in this browser automatically; use Save to keep a .juracad file on your computer.
        Install (top bar) makes JuraCAD a desktop app with its own window that works offline; in Safari on a Mac,
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
      <h3 className="help-heading">Use JuraCAD with Claude</h3>
      <p className="small">
        Describe a part in plain English — say, "a 60 × 40 mm mounting bracket, 3 mm thick, with four M4 holes 5 mm in
        from the corners" — and Claude builds it step by step with JuraCAD's own geometry engine, checks it, and saves a
        .juracad file. Open that file here with Open: every feature and dimension can still be changed. Claude can also
        put parts together in an assembly (with mates, a clash check and an exploded view) and make 2D drawings with
        dimensions and a title block, saved as PDF, SVG or DXF.
      </p>
      <ol className="small help-steps">
        <li>
          <a href={`${import.meta.env.BASE_URL}juracad-claude.mcpb`} download="juracad-claude.mcpb">
            Download the JuraCAD extension for Claude
          </a>{" "}
          (one file).
        </li>
        <li>
          Double-click the downloaded file (or drag it onto the Claude desktop app's window). Claude shows the install
          screen: click Install.
        </li>
        <li>
          Start a new chat in Claude and ask for a part. Your designs are saved in Documents › JuraCAD (you can choose
          another folder in the extension's settings).
        </li>
      </ol>
      <h3 className="help-heading">Live with Claude</h3>
      <p className="small">
        Let Claude work on the design you have open here, while you watch. With the extension installed and the Claude
        app open, click <b>Connect to Claude</b> in the top bar (nothing connects until you do). The first time, your
        browser may ask whether JuraCAD can reach apps on this device: click Allow. A green <b>Live with Claude</b> badge
        shows while you're connected; click it to disconnect.
      </p>
      <ul className="small help-steps">
        <li>It works with every Claude chat that has JuraCAD — Claude runs the extension once per chat, and JuraCAD links them all, including chats you start after connecting (within a few seconds).</li>
        <li>Ask Claude for changes in the Claude app, e.g. "add four M3 holes to the lid". Its sketches and features appear in the feature list and the 3D view as it works, on the Part Studio on show; assemblies and drawings it makes appear as new tabs.</li>
        <li>Each of Claude's changes is one step you can undo (Ctrl+Z / ⌘Z). You can keep editing too: if you both change something at the same moment, Claude's change is turned back and it tries again, so nothing is lost. Finish any open dialog (✓ or ✗) so Claude can carry on.</li>
        <li>Works in Chrome, Edge and Firefox. Safari doesn't let websites talk to apps on your computer directly, so there Connect to Claude opens a small <b>JuraCAD ↔ Claude</b> window from the extension that passes messages along: allow the pop-up if Safari asks, and keep that window open while you work (closing it disconnects). If connecting doesn't work, ask Claude to save the design and open the .juracad file with Open.</li>
        <li>The link stays on this computer: only the JuraCAD website can use it, and Claude still only saves files in your JuraCAD folder.</li>
      </ul>
      <p className="muted small">
        JuraCAD {SHORT_VERSION} ({APP_VERSION}) —{" "}
        <button type="button" className="text-button small-text inline-link" onClick={() => openDialog("whatsNew")}>
          what's new
        </button>
        . JuraCAD is free and open source (MIT). It uses the OpenCascade geometry kernel (LGPL 2.1) via replicad.{" "}
        <a href="https://github.com/Gm7dha/JuraCAD" target="_blank" rel="noreferrer">
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
