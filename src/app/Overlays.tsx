import { useEffect, useRef, useState } from "react";

import { activeAssembly, activeDrawing, activeFeatures, activeStudioId, useStore } from "../model/store";
import { Icons } from "./icons";
import { MAIN_STUDIO, MAIN_STUDIO_NAME } from "../model/studios";

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
  const empty = useStore((s) => activeFeatures(s).length === 0 && !s.editing && s.kernelStatus === "ready");
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

/** One tab: click to show it, double-click to rename, right-click to delete. */
function DocTab({
  id,
  name,
  kind,
  active,
  disabled,
  canDelete,
}: {
  id: string | null;
  name: string;
  kind: "studio" | "assembly" | "drawing";
  active: boolean;
  disabled: boolean;
  canDelete: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const Icon = kind === "studio" ? Icons.Part : kind === "assembly" ? Icons.Assembly : Icons.Drawing;
  const finish = (keep: boolean) => {
    const st = useStore.getState();
    if (keep) {
      if (kind === "assembly" && id) st.renameAssembly(id, text);
      else if (kind === "drawing" && id) st.renameDrawing(id, text);
      else st.renamePartStudio(id ?? MAIN_STUDIO, text);
    }
    setRenaming(false);
  };
  if (renaming) {
    return (
      <span className="tab active">
        <Icon size={16} />
        <input
          ref={input}
          className="tab-rename"
          value={text}
          aria-label={kind === "studio" ? "Part Studio name" : kind === "assembly" ? "Assembly name" : "Drawing name"}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
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
      disabled={disabled && !active}
      onClick={() => useStore.getState().setActiveTab(id)}
      onDoubleClick={() => {
        if (disabled) return;
        setText(name);
        setRenaming(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!canDelete || disabled) return;
        if (!window.confirm(`Delete ${name}? (Undo brings it back.)`)) return;
        if (kind === "assembly" && id) useStore.getState().removeAssembly(id);
        else if (kind === "drawing" && id) useStore.getState().removeDrawing(id);
        else if (id) useStore.getState().removePartStudio(id);
      }}
      title={`${name} — double-click to rename${canDelete ? ", right-click to delete" : ""}`}
    >
      <Icon size={16} /> {name}
    </button>
  );
}

/** The + menu: add a Part Studio or an assembly. */
function AddTabMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const pick = (what: "studio" | "assembly" | "drawing") => {
    setOpen(false);
    if (what === "studio") useStore.getState().addPartStudio();
    else if (what === "assembly") useStore.getState().addAssembly();
    else useStore.getState().addDrawing();
  };
  return (
    <div className="add-tab" ref={ref}>
      <button
        className="tab add"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? "Finish or cancel the open feature first" : "Add a Part Studio, an assembly or a drawing"}
        aria-label="Add a tab"
        aria-expanded={open}
      >
        <Icons.Plus size={16} />
      </button>
      {open && (
        <div className="add-tab-menu" role="menu">
          <button role="menuitem" className="menu-item" onClick={() => pick("studio")}>
            <Icons.Part size={16} /> Part Studio
          </button>
          <button role="menuitem" className="menu-item" onClick={() => pick("assembly")}>
            <Icons.Assembly size={16} /> Assembly
          </button>
          <button role="menuitem" className="menu-item" onClick={() => pick("drawing")}>
            <Icons.Drawing size={16} /> Drawing
          </button>
        </div>
      )}
    </div>
  );
}

/** Onshape-style tabs along the bottom: Part Studios, then assemblies, then +. */
export function BottomTabs() {
  const doc = useStore((s) => s.history.present);
  const studio = useStore(activeStudioId);
  const asm = useStore(activeAssembly);
  const drawingId = useStore((s) => activeDrawing(s)?.id ?? null);
  const editing = useStore((s) => s.editing !== null);
  return (
    <nav className="bottom-tabs" aria-label="Document tabs">
      <DocTab id={null} name={doc.studioName ?? MAIN_STUDIO_NAME} kind="studio" active={studio === MAIN_STUDIO} disabled={editing} canDelete={false} />
      {(doc.partStudios ?? []).map((p) => (
        <DocTab key={p.id} id={p.id} name={p.name} kind="studio" active={studio === p.id} disabled={editing} canDelete />
      ))}
      {(doc.assemblies ?? []).map((a) => (
        <DocTab key={a.id} id={a.id} name={a.name} kind="assembly" active={asm?.id === a.id} disabled={editing} canDelete />
      ))}
      {(doc.drawings ?? []).map((d) => (
        <DocTab key={d.id} id={d.id} name={d.name} kind="drawing" active={drawingId === d.id} disabled={editing} canDelete />
      ))}
      <AddTabMenu disabled={editing} />
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
