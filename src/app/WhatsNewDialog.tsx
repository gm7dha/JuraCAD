import { useMemo } from "react";

import changelogText from "../../CHANGELOG.md?raw";
import { boldPieces, changesFor, parseChangelog, type ChangelogVersion } from "../model/changelog";
import { useStore } from "../model/store";
import { APP_VERSION, SHORT_VERSION } from "../version";
import { Modal } from "./Modal";

const SEEN_KEY = "partsmith.seenVersion";

/** True when this version's changes haven't been looked at yet in this browser. */
export function versionIsNew(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== APP_VERSION;
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, APP_VERSION);
  } catch {
    // Private browsing: nothing to remember.
  }
}

function Changes({ entry }: { entry: ChangelogVersion }) {
  return (
    <ul className="whats-new-list">
      {entry.changes.map((c, i) => (
        <li key={i}>
          {boldPieces(c).map((p, k) => (p.bold ? <strong key={k}>{p.text}</strong> : <span key={k}>{p.text}</span>))}
        </li>
      ))}
    </ul>
  );
}

/** What changed in this version, with the earlier versions below. */
export function WhatsNewDialog() {
  const openDialog = useStore((s) => s.openDialog);
  const versions = useMemo(() => parseChangelog(changelogText), []);
  const current = changesFor(versions, APP_VERSION);
  const earlier = versions.filter((v) => v !== current);
  markSeen();

  return (
    <Modal title={`What's new in PartSmith ${SHORT_VERSION}`} onClose={() => openDialog(null)} width={600}>
      {current ? (
        <>
          {current.title && <p className="whats-new-title">{current.title}</p>}
          <Changes entry={current} />
        </>
      ) : (
        <p className="muted">This is a development version, so there are no release notes for it yet.</p>
      )}
      {earlier.length > 0 && (
        <>
          <h3 className="help-heading">Earlier versions</h3>
          {earlier.map((v) => (
            <details key={v.version} className="whats-new-earlier">
              <summary>
                <strong>v{v.version}</strong> {v.title && <span className="muted">— {v.title}</span>}
              </summary>
              <Changes entry={v} />
            </details>
          ))}
        </>
      )}
      <p className="muted small">
        Each version is a safe point to go back to: ask for “go back to v0.14”, for example. The full history is on{" "}
        <a href="https://github.com/Gm7dha/partsmith/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </p>
    </Modal>
  );
}
