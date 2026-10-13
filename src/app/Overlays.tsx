import { useEffect, useRef, useState } from "react";

import { activeAssembly, useStore } from "../model/store";
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

/** Friendly hint in an empty Part Studio or assembly. */
export function EmptyHint() {
  const asm = useStore(activeAssembly);
  const insertOpen = useStore((s) => s.dialog === "insert");
  const empty = useStore((s) => s.history.present.features.length === 0 && !s.editing && s.kernelStatus === "ready");
  if (asm) {
    if (asm.instances.length > 0 || insertOpen) return null;
    return (
      <div className="empty-hint">
        Click <strong>Insert</strong> to bring in parts from the Part Studio.
        <br />
        <span className="muted">Then place them by typing positions, and fix the one everything else is placed against.</span>
      </div>
    );
  }
  if (!empty) return null;
  return (
    <div className="empty-hint">
      Click <strong>Sketch</strong>, pick <strong>Top</strong>, <strong>Front</strong> or <strong>Right</strong>, draw a shape, then{" "}
      <strong>Extrude</strong> it.
      <br />
      <span className="muted">Or add a Box, Cylinder or Sphere · right-drag to orbit · middle-drag to pan · scroll to zoom</span>
    </div>
  );
}

/** Bottom-right summary of what's selected in the viewport. */
export function SelectionInfo() {
  const selection = useStore((s) => s.selection);
  const parts = useStore((s) => s.parts);
  const busy = useStore((s) => s.rebuildBusy);
  const ms = useStore((s) => s.lastRebuildMs);
  const plane = useStore((s) => s.selectedPlane);
  const asm = useStore(activeAssembly);
  const asmSelection = useStore((s) => s.asmSelection);

  let text = "";
  if (asm) {
    const names = asm.instances.filter((i) => asmSelection.includes(i.id)).map((i) => i.name);
    text = names.length === 1 ? `${names[0]} selected` : names.length > 1 ? `${names.length} parts selected` : "";
  } else if (plane) {
    text = `${plane} plane selected — press N to look straight at it`;
  } else if (selection.length === 1) {
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

/** One tab: click to show it, double-click to rename, right-click (or ⋯) for more. */
function AssemblyTab({ id, name, active }: { id: string; name: string; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const finish = (keep: boolean) => {
    if (keep) useStore.getState().renameAssembly(id, text);
    setRenaming(false);
  };
  if (renaming) {
    return (
      <span className="tab active">
        <Icons.Assembly size={16} />
        <input
          ref={input}
          className="tab-rename"
          value={text}
          aria-label="Assembly name"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true);
            if (e.key === "Escape") finish(false);
          }}
        />
      </span>
    );
  }
  return (
    <button
      className={`tab${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => useStore.getState().setActiveTab(id)}
      onDoubleClick={() => {
        setText(name);
        setRenaming(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (window.confirm(`Delete ${name}? (Undo brings it back.)`)) useStore.getState().removeAssembly(id);
      }}
      title={`${name} — double-click to rename, right-click to delete`}
    >
      <Icons.Assembly size={16} /> {name}
    </button>
  );
}

/** Onshape-style tabs along the bottom: the Part Studio, then any assemblies. */
export function BottomTabs() {
  const assemblies = useStore((s) => s.history.present.assemblies);
  const asm = useStore(activeAssembly);
  const editing = useStore((s) => s.editing !== null);
  return (
    <nav className="bottom-tabs" aria-label="Document tabs">
      <button
        className={`tab${asm ? "" : " active"}`}
        aria-current={asm ? undefined : "page"}
        onClick={() => useStore.getState().setActiveTab(null)}
        disabled={editing}
      >
        <Icons.Part size={16} /> Part Studio 1
      </button>
      {(assemblies ?? []).map((a) => (
        <AssemblyTab key={a.id} id={a.id} name={a.name} active={asm?.id === a.id} />
      ))}
      <button
        className="tab add"
        onClick={() => useStore.getState().addAssembly()}
        disabled={editing}
        title={editing ? "Finish or cancel the open feature first" : "Add an assembly — put parts together"}
        aria-label="Add an assembly"
      >
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
