import { useEffect } from "react";

import { useStore } from "../model/store";
import { Icons } from "./icons";

/** Shown over the viewport while the geometry engine loads, or if it fails. */
export function EngineStatus() {
  const status = useStore((s) => s.kernelStatus);
  const error = useStore((s) => s.kernelError);
  if (status === "ready") return null;
  return (
    <div className="engine-status" role="status">
      {status === "loading" ? (
        <>
          <div className="spinner" aria-hidden="true" />
          <div>
            <strong>Loading the geometry engine…</strong>
            <p className="muted small">The first visit downloads the engine (several MB). It's quicker after that.</p>
          </div>
        </>
      ) : (
        <>
          <Icons.Warning size={22} />
          <div>
            <strong>The geometry engine couldn't start.</strong>
            <p className="muted small">{error ?? "Unknown error."} Try reloading the page, or use Chrome or Edge.</p>
          </div>
        </>
      )}
    </div>
  );
}

/** Friendly hint in an empty Part Studio. */
export function EmptyHint() {
  const empty = useStore((s) => s.history.present.features.length === 0 && !s.editing && s.kernelStatus === "ready");
  if (!empty) return null;
  return (
    <div className="empty-hint">
      Add a <strong>Box</strong>, <strong>Cylinder</strong> or <strong>Sphere</strong> from the toolbar to get started.
      <br />
      <span className="muted">Right-drag to orbit · middle-drag to pan · scroll to zoom</span>
    </div>
  );
}

/** Bottom-right summary of what's selected in the viewport. */
export function SelectionInfo() {
  const selection = useStore((s) => s.selection);
  const parts = useStore((s) => s.parts);
  const busy = useStore((s) => s.rebuildBusy);
  const ms = useStore((s) => s.lastRebuildMs);

  let text = "";
  if (selection.length === 1) {
    const s = selection[0];
    const part = parts.find((p) => p.id === s.partId);
    text = `${s.kind === "face" ? "Face" : "Edge"} ${s.index + 1} of ${part?.name ?? "part"}`;
  } else if (selection.length > 1) {
    const faces = selection.filter((s) => s.kind === "face").length;
    const edges = selection.length - faces;
    text = [faces && `${faces} face${faces > 1 ? "s" : ""}`, edges && `${edges} edge${edges > 1 ? "s" : ""}`]
      .filter(Boolean)
      .join(", ") + " selected";
  }

  return (
    <div className="status-strip" aria-live="polite">
      {text && <span>{text}</span>}
      <span className="muted">{busy ? "Rebuilding…" : ms !== null ? `Rebuilt in ${ms} ms` : ""}</span>
    </div>
  );
}

/** Onshape-style tabs along the bottom. Only one Part Studio for now. */
export function BottomTabs() {
  return (
    <nav className="bottom-tabs" aria-label="Document tabs">
      <button className="tab active" aria-current="page">
        <Icons.Part size={16} /> Part Studio 1
      </button>
      <button className="tab add" disabled title="Assemblies (Phase 5) and drawings (Phase 6) will be added here">
        <Icons.Plus size={16} />
      </button>
    </nav>
  );
}

/** A short message that fades away. */
export function ToastView() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      if (useStore.getState().toast?.id === toast.id) useStore.setState({ toast: null });
    }, toast.tone === "error" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.text}
      <button className="icon-button small" onClick={() => useStore.setState({ toast: null })} aria-label="Dismiss">
        <Icons.Cross size={14} />
      </button>
    </div>
  );
}
