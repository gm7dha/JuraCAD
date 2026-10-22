import { useEffect, useState } from "react";

import { liveClient, useLiveState } from "./liveLink";
import { Modal } from "./Modal";

/**
 * Live with Claude (top bar): "Connect to Claude" connects this tab to the
 * JuraCAD extension in the Claude desktop app, only when clicked. While
 * connected, a "Live with Claude" badge shows; click it for details or to
 * disconnect.
 */
export function LiveButton() {
  const state = useLiveState();
  const [open, setOpen] = useState(false);

  // Show what went wrong as soon as an attempt fails, and why the link closed.
  useEffect(() => {
    if (state.kind === "failed" || (state.kind === "off" && state.notice)) setOpen(true);
  }, [state]);

  const connect = () => {
    setOpen(false);
    void liveClient.connect();
  };

  return (
    <>
      {state.kind === "connected" ? (
        <button type="button" className="live-badge" aria-label="Live with Claude" onClick={() => setOpen(true)} title="JuraCAD is connected to Claude: Claude's changes appear here as it works. Click for details or to disconnect.">
          <span className="live-dot" aria-hidden="true" />
          <span className="button-label">
            <span className="live-long">Live with </span>Claude
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="text-button live-connect"
          aria-label={state.kind === "connecting" ? "Connecting to Claude" : "Connect to Claude"}
          onClick={connect}
          disabled={state.kind === "connecting"}
          title="Let Claude (the desktop app, with the JuraCAD extension) work on this design while you watch. Nothing connects until you click."
        >
          <span className="live-dot off" aria-hidden="true" />
          <span className="button-label">
            {state.kind === "connecting" ? (
              "Connecting…"
            ) : (
              <>
                <span className="live-long">Connect to </span>Claude
              </>
            )}
          </span>
        </button>
      )}
      {state.kind === "connecting" && state.message !== "Looking for Claude on this computer…" && (
        <span className="live-hint" role="status">
          {state.message}
        </span>
      )}
      {open && state.kind !== "connecting" && (
        <Modal title={state.kind === "connected" ? "Live with Claude" : state.kind === "failed" ? state.title : "Connect to Claude"} onClose={() => setOpen(false)} width={500}>
          {state.kind === "connected" && (
            <>
              <p className="live-status ok" role="status">
                Connected to Claude (JuraCAD extension {state.extension}).
              </p>
              <p className="small">
                Ask Claude in the Claude app to change this design — say, "add four M3 holes to the lid". Its sketches and
                features appear in the feature list and the 3D view as it works, on the Part Studio on show. Each change
                is one step you can undo. You can keep working too; if you both change something at the same moment,
                Claude's change is turned back and it tries again — nothing is lost.
              </p>
              {state.last && <p className="small muted">Last change from Claude: {state.last.replace(/^Claude: /, "")}</p>}
            </>
          )}
          {state.kind === "failed" && (
            <>
              <p className="live-status bad" role="status">
                Not connected.
              </p>
              <ul className="small help-steps">
                {state.help.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </>
          )}
          {state.kind === "off" && (
            <>
              <p className="live-status bad" role="status">
                Not connected.
              </p>
              {state.notice && <p className="small">{state.notice}</p>}
            </>
          )}
          <div className="live-actions">
            {state.kind === "connected" ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  liveClient.disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={connect}>
                Try again
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
