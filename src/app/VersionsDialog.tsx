import { useMemo, useState } from "react";

import { activeDrawing, useStore } from "../model/store";
import type { DesignVersion } from "../model/types";
import type { DesignChanges } from "../model/versionCompare";
import { newestFirst, nextVersionName, sizeText, storageNote, versionDate, versionNameProblem, versionsOf, versionsSize, versionsToTidy } from "../model/versions";
import { Icons } from "./icons";
import { Modal } from "./Modal";
import {
  comparedChanges,
  currentDesign,
  deleteVersions,
  newDesignFromVersion,
  NOW,
  openVersion,
  renameVersion,
  restoreVersion,
  saveVersion,
  startCompare,
  stopCompare,
} from "./versionActions";

/**
 * Versions, as in Onshape: save the whole design as a named version, look at
 * an old one (read-only), restore it, start a new design from it, or compare
 * two of them. Versions are saved in the .juracad file and in this browser.
 */
export function VersionsDialog() {
  const design = useStore((s) => currentDesign(s));
  const viewing = useStore((s) => s.versionView);
  const comparing = useStore((s) => s.versionCompare);
  const list = useMemo(() => newestFirst(versionsOf(design)), [design]);
  const [name, setName] = useState(() => nextVersionName(design));
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [keepCurrent, setKeepCurrent] = useState(true);
  const [older, setOlder] = useState<string>(() => list[0]?.id ?? "");
  const [newer, setNewer] = useState<string>(NOW);
  const close = () => {
    // Comparing keeps going only while its see-through overlay is on show.
    if (!useStore.getState().versionCompare?.ghost) stopCompare();
    useStore.getState().openDialog(null);
  };
  const note_ = storageNote(design);
  const tidy = note_ ? versionsToTidy(design) : [];

  const save = async () => {
    setBusy(true);
    const p = await saveVersion(name, note);
    setBusy(false);
    setProblem(p);
    if (!p) {
      setNote("");
      setName(nextVersionName(currentDesign(useStore.getState())));
    }
  };

  if (comparing && !comparing.ghost) return <CompareView onClose={close} />;

  const options = [
    { id: NOW, label: "Now (the current design)" },
    ...list.map((v) => ({ id: v.id, label: `${v.name} — ${versionDate(v.createdAt)}` })),
  ];

  return (
    <Modal
      title="Versions"
      onClose={close}
      width={720}
      footer={
        <button className="primary-button" onClick={close}>
          Done
        </button>
      }
    >
      <p className="small">
        A version is a snapshot of the whole design — every Part Studio, assembly and drawing — that you can look back at, compare
        with, or go back to. Versions are kept in your <strong>.juracad</strong> file when you save, and in this browser.
      </p>
      {viewing ? (
        <p className="version-note small">
          You're looking at the old version <strong>{viewing.name}</strong>. Go back to the current design (the button at the top of the
          3D view) to save new versions or rename and remove them.
        </p>
      ) : (
        <div className="version-save">
          <label className="field-label" htmlFor="version-name">
            Save what you have now as a version
          </label>
          <div className="version-save-row">
            <input
              id="version-name"
              aria-label="Version name"
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && !busy && void save()}
            />
            <button className="primary-button" disabled={busy} onClick={() => void save()}>
              <Icons.Versions size={16} /> Save version
            </button>
          </div>
          <textarea aria-label="Version note" placeholder="Note (optional) — what's in this version, e.g. “sent to the printer”" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          {problem && <p className="danger-text small">{problem}</p>}
        </div>
      )}

      {note_ && (
        <div className="version-note small" role="status">
          {note_}
          {!viewing && tidy.length > 0 && (
            <button
              className="text-button"
              onClick={() => {
                if (window.confirm(`Remove ${tidy.length} old version${tidy.length === 1 ? "" : "s"} (automatic ones first, then the oldest)? Your newest versions are kept. This can't be undone.`)) deleteVersions(tidy);
              }}
            >
              Remove {tidy.length} old version{tidy.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}

      {list.length === 0 ? (
        <p className="muted small">No versions yet. Save one before a big change, so you can always go back to it.</p>
      ) : (
        <>
          <table className="variables-table versions-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <VersionRow
                  key={v.id}
                  v={v}
                  open={viewing?.id === v.id}
                  locked={!!viewing}
                  onRestore={() => {
                    setRestoring(v.id);
                    setKeepCurrent(true);
                  }}
                />
              ))}
            </tbody>
          </table>
          <p className="muted small">
            {list.length} version{list.length === 1 ? "" : "s"}, {sizeText(versionsSize(design))} in all.
          </p>
          {restoring && (
            <div className="version-confirm" role="group" aria-label="Restore a version">
              <p>
                Make the design a copy of <strong>{list.find((v) => v.id === restoring)?.name}</strong>? Undo brings back what you have now.
              </p>
              <label className="check-row">
                <input type="checkbox" checked={keepCurrent} onChange={(e) => setKeepCurrent(e.target.checked)} /> Save what I have now as a version first
              </label>
              <div className="version-actions">
                <button className="primary-button" onClick={() => void restoreVersion(restoring, keepCurrent).then(() => setRestoring(null))}>
                  Restore
                </button>
                <button className="text-button" onClick={() => setRestoring(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="version-compare">
            <span className="field-label">Compare</span>
            <select aria-label="Compare from" value={older} onChange={(e) => setOlder(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <span>with</span>
            <select aria-label="Compare with" value={newer} onChange={(e) => setNewer(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              className="text-button"
              disabled={older === newer || !older}
              title={older === newer ? "Pick two different versions" : "See what changed between them"}
              onClick={() => {
                // The older one first (Now is always the newest).
                const at = (id: string) => (id === NOW ? Infinity : Date.parse(list.find((v) => v.id === id)?.createdAt ?? ""));
                const [a, b] = at(older) <= at(newer) ? [older, newer] : [newer, older];
                void startCompare(a, b);
              }}
            >
              Compare
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function VersionRow({ v, open, locked, onRestore }: { v: DesignVersion; open: boolean; locked: boolean; onRestore: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.name);
  const [note, setNote] = useState(v.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const design = useStore((s) => currentDesign(s));
  if (editing)
    return (
      <tr className="active">
        <td colSpan={3}>
          <div className="version-save-row">
            <input aria-label="New name" value={name} maxLength={80} onChange={(e) => (setName(e.target.value), setProblem(versionNameProblem(design, e.target.value, v.id)))} />
            <button
              className="primary-button"
              disabled={!!problem}
              onClick={() => {
                const p = renameVersion(v.id, name, note);
                setProblem(p);
                if (!p) setEditing(false);
              }}
            >
              Save
            </button>
            <button className="text-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <textarea aria-label="New note" value={note} rows={2} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
          {problem && <p className="danger-text small">{problem}</p>}
        </td>
      </tr>
    );
  return (
    <tr className={open ? "active" : ""} data-version={v.name}>
      <td>
        <strong>{v.name}</strong>
        {v.auto && <span className="version-tag" title="Saved by JuraCAD, not by you">automatic</span>}
        {open && <span className="version-tag">open now</span>}
        {v.note && <div className="muted small">{v.note}</div>}
      </td>
      <td className="small">
        {versionDate(v.createdAt)}
        <div className="muted">{sizeText(v.packed.length)}</div>
      </td>
      <td>
        <div className="version-actions">
          <button className="text-button" onClick={() => void openVersion(v.id)} title="Look at this version (it can't be changed)">
            Open
          </button>
          <button className="text-button" onClick={() => void startCompare(v.id, NOW)} title="What has changed since this version?">
            Compare with now
          </button>
          <button className="text-button" onClick={onRestore} title="Make the design a copy of this version">
            Restore…
          </button>
          <button className="text-button" onClick={() => void newDesignFromVersion(v.id)} title="Start a new, separate design from this version (like New; Undo goes back)">
            New design
          </button>
          <button className="text-button" disabled={locked} onClick={() => setEditing(true)} title="Rename it or change its note">
            Rename
          </button>
          <button
            className="text-button"
            disabled={locked}
            aria-label={`Delete ${v.name}`}
            title="Remove this version"
            onClick={() => window.confirm(`Remove version "${v.name}"? This can't be undone (unless it's in a .juracad file you saved).`) && deleteVersions([v.id])}
          >
            <Icons.Cross size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** The two sides' names: "V1 (3 Nov 2026, 14:05)" or "now". */
function sideName(id: string, list: DesignVersion[]): string {
  if (id === NOW) return "now";
  const v = list.find((x) => x.id === id);
  return v ? `${v.name} (${versionDate(v.createdAt)})` : "a removed version";
}

/** What changed between two versions (or a version and now). */
function CompareView({ onClose }: { onClose: () => void }) {
  const c = useStore((s) => s.versionCompare)!;
  const design = useStore((s) => currentDesign(s));
  const changes = useStore(comparedChangesStable);
  const list = versionsOf(design);
  const back = () => stopCompare();
  return (
    <Modal
      title="Compare versions"
      onClose={onClose}
      width={720}
      footer={
        <>
          {c.newer === NOW && (
            <button
              className="text-button"
              onClick={() => {
                useStore.getState().setVersionCompare({ ...c, ghost: true });
                useStore.getState().openDialog(null);
              }}
              title="Draw the old version see-through over your design in the 3D view"
            >
              Show the old one in 3D
            </button>
          )}
          <button className="text-button" onClick={back}>
            Back to the list
          </button>
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="small">
        From <strong>{sideName(c.older, list)}</strong> to <strong>{sideName(c.newer, list)}</strong>:
      </p>
      {changes ? <ChangesList changes={changes} /> : <p className="muted small">Working it out…</p>}
    </Modal>
  );
}

/** The comparison, worked out again only when what it depends on changes (selector-safe). */
let lastInput: unknown[] = [];
let lastOutput: DesignChanges | null = null;
function comparedChangesStable(s: ReturnType<typeof useStore.getState>): DesignChanges | null {
  const input = [s.versionCompare, s.history.present, s.versionView, s.parts, s.rebuildBusy, s.kernelStatus];
  if (input.every((x, i) => x === lastInput[i])) return lastOutput;
  lastInput = input;
  lastOutput = comparedChanges(s);
  return lastOutput;
}

const CHANGE_WORD = { added: "Added", removed: "Removed", changed: "Changed" } as const;

export function ChangesList({ changes }: { changes: DesignChanges }) {
  if (changes.same) return <p className="small">Nothing has changed — they're the same.</p>;
  const nothingListed = !changes.features.length && !changes.variables.length && !changes.parts?.length && !changes.other.length;
  return (
    <div className="version-changes" aria-label="Changes">
      <h3>Features</h3>
      {changes.features.length === 0 ? (
        <p className="muted small">No features added, removed or changed.</p>
      ) : (
        <ul>
          {changes.features.map((f) => (
            <li key={f.id} className={`change-${f.change}`} data-feature={f.name}>
              <span className="change-word">{CHANGE_WORD[f.change]}</span> <strong>{f.name}</strong> <span className="muted">({f.kind}{f.studio !== "Part Studio 1" ? `, ${f.studio}` : ""})</span>
              {f.settings.length > 0 && (
                <ul className="change-settings">
                  {f.settings.map((x, i) => (
                    <li key={i}>
                      {x.what}
                      {x.from || x.to ? (
                        <>
                          : <span className="change-old">{x.from}</span> → <span className="change-new">{x.to}</span>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Variables</h3>
      {changes.variables.length === 0 ? (
        <p className="muted small">No variables changed.</p>
      ) : (
        <ul>
          {changes.variables.map((v, i) => (
            <li key={i} className={`change-${v.change}`}>
              <span className="change-word">{CHANGE_WORD[v.change]}</span> <strong>{v.name}</strong>
              {v.change === "changed" ? (
                <>
                  : <span className="change-old">{v.from}</span> → <span className="change-new">{v.to}</span>
                </>
              ) : (
                <> = {v.change === "added" ? v.to : v.from}</>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Parts</h3>
      {changes.parts === null ? (
        <p className="muted small">Building the old version to see its parts…</p>
      ) : changes.parts.length === 0 ? (
        <p className="muted small">The same parts.</p>
      ) : (
        <ul>
          {changes.parts.map((p) => (
            <li key={p.id + p.change} className={`change-${p.change}`}>
              <span className="change-word">{CHANGE_WORD[p.change]}</span> <strong>{p.name}</strong>
            </li>
          ))}
        </ul>
      )}
      {changes.other.length > 0 && (
        <>
          <h3>Also</h3>
          <ul>
            {changes.other.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {nothingListed && <p className="muted small">Only how things are shown changed (folders, or what's hidden in the 3D view).</p>}
    </div>
  );
}

/** Across the top of the 3D view while an old version is open: it's read-only, and the ways out. */
export function VersionBanner() {
  const v = useStore((s) => s.versionView);
  // On a drawing the top middle has the sheet's own messages and view bar, so the banner sits bottom right there.
  const inDrawing = useStore((s) => activeDrawing(s) !== null);
  if (!v) return null;
  return (
    <div className={`version-banner${inDrawing ? " in-drawing" : ""}`} role="status" aria-label="Old version">
      <Icons.Versions size={18} />
      <span>
        <strong>Old version: {v.name}</strong> <span className="version-banner-date">saved {versionDate(v.createdAt)}</span> — you can look, but not change it.
      </span>
      <button
        className="text-button"
        onClick={() => window.confirm(`Make the design a copy of "${v.name}"? What you have now is kept as an automatic version, and Undo brings it back.`) && void restoreVersion(v.id, true)}
      >
        Restore this version
      </button>
      <button className="text-button" onClick={() => void newDesignFromVersion(v.id)} title="Start a new, separate design from this version">
        New design from it
      </button>
      <button className="primary-button" onClick={() => useStore.getState().leaveVersionView()}>
        Back to the current design
      </button>
    </div>
  );
}

/** While the old version is drawn see-through over the design. */
export function ComparePanel() {
  const c = useStore((s) => s.versionCompare);
  const list = useStore((s) => versionsOf(currentDesign(s)));
  if (!c?.ghost) return null;
  return (
    <div className="section-panel compare-panel" role="region" aria-label="Comparing versions">
      <div className="section-header">
        <strong>Comparing with {sideName(c.older, list)}</strong>
        <button className="icon-button small" onClick={stopCompare} title="Stop comparing" aria-label="Stop comparing">
          <Icons.Cross size={14} />
        </button>
      </div>
      <p>
        The old version's parts are drawn <span className="ghost-swatch" /> see-through in orange over your design.
      </p>
      <div className="version-actions">
        <button
          className="text-button"
          onClick={() => {
            useStore.getState().setVersionCompare({ ...c, ghost: false });
            useStore.getState().openDialog("versions");
          }}
        >
          List the changes
        </button>
        <button className="text-button" onClick={stopCompare}>
          Stop comparing
        </button>
      </div>
    </div>
  );
}
