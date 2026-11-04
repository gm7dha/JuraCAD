import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { activeAssembly, activeDrawing, activeFeatures, activeStudioId, useStore } from "../model/store";
import { Icons } from "./icons";
import { studioIndex, studiosOf } from "../model/studios";
import { deleteStudioQuestion } from "../model/studioUse";
import { PlacedPopup } from "./PlacedPopup";
import { DRAG_START, dropIndex } from "./tabDrag";

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

/** A Part Studio tab being dragged along the bar: where it would go. */
interface TabDrag {
  id: string;
  pointerId: number;
  startX: number;
  /** Middles of the other Part Studio tabs (in tab order) when the drag began. */
  middles: number[];
  /** Past the few pixels a click may wobble. */
  moving: boolean;
  /** Where it would end up (0 = first). */
  to: number;
}

/** Until when a click on a tab is the end of a drag (performance.now() time). */
let droppedUntil = 0;

/** One tab: click to show it, double-click to rename, right-click for its menu (Part Studios can be dragged along the bar). */
function DocTab({
  id,
  name,
  kind,
  active,
  disabled,
  canDelete,
  studioMenu,
  dragging,
  onDragStart,
}: {
  id: string;
  name: string;
  kind: "studio" | "assembly" | "drawing";
  active: boolean;
  disabled: boolean;
  canDelete: boolean;
  /** Part Studios: open the tab's menu (Rename, Move left/right, Delete) at this point. */
  studioMenu?: (at: { x: number; y: number }, rename: () => void) => void;
  dragging?: boolean;
  /** Part Studios: a press that may become a drag along the bar. */
  onDragStart?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
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
      if (kind === "assembly") st.renameAssembly(id, text);
      else if (kind === "drawing") st.renameDrawing(id, text);
      else st.renamePartStudio(id, text);
    }
    setRenaming(false);
  };
  const rename = () => {
    if (disabled) return;
    setText(name);
    setRenaming(true);
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
      className={`tab${active ? " active" : ""}${dragging ? " dragging" : ""}`}
      aria-current={active ? "page" : undefined}
      disabled={disabled && !active}
      data-studio-tab={kind === "studio" ? id : undefined}
      onPointerDown={onDragStart}
      onClick={() => {
        // The click that ends a drag is the drop, not a click on the tab.
        if (performance.now() < droppedUntil) return;
        useStore.getState().setActiveTab(id);
      }}
      onDoubleClick={rename}
      onContextMenu={(e) => {
        e.preventDefault();
        if (studioMenu) {
          studioMenu({ x: e.clientX, y: e.clientY }, rename);
          return;
        }
        if (!canDelete || disabled) return;
        if (!window.confirm(`Delete ${name}? (Undo brings it back.)`)) return;
        if (kind === "assembly") useStore.getState().removeAssembly(id);
        else if (kind === "drawing") useStore.getState().removeDrawing(id);
      }}
      title={
        kind === "studio"
          ? `${name} — double-click to rename, drag to move, right-click for more`
          : `${name} — double-click to rename${canDelete ? ", right-click to delete" : ""}`
      }
    >
      <Icon size={16} /> {name}
    </button>
  );
}

/** A Part Studio tab's right-click menu: Rename, Move left, Move right (also for touch), Delete. */
function StudioTabMenu({ menu, count, disabled, onClose }: { menu: { id: string; name: string; x: number; y: number; rename: () => void }; count: number; disabled: boolean; onClose: () => void }) {
  const doc = useStore((s) => s.history.present);
  const at = studioIndex(doc, menu.id);
  if (at < 0) return null;
  const item = (label: string, action: () => void, off: boolean, danger = false) => (
    <button
      role="menuitem"
      className={`menu-item${danger ? " danger" : ""}`}
      disabled={off}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
    </button>
  );
  const st = useStore.getState();
  return (
    <PlacedPopup className="context-menu tab-menu" role="menu" label={`${menu.name} menu`} anchor={() => ({ left: menu.x, right: menu.x, top: menu.y, bottom: menu.y })} onClose={onClose} focusFirst>
      {item("Rename…", menu.rename, disabled)}
      {item("Move left", () => st.movePartStudio(menu.id, at - 1), disabled || at === 0)}
      {item("Move right", () => st.movePartStudio(menu.id, at + 1), disabled || at === count - 1)}
      <div className="menu-divider" />
      {item(
        "Delete",
        () => {
          const now = useStore.getState().history.present;
          if (window.confirm(deleteStudioQuestion(now, menu.id))) useStore.getState().removePartStudio(menu.id);
        },
        disabled || count < 2,
        true,
      )}
    </PlacedPopup>
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

/** Onshape-style tabs along the bottom: Part Studios, then assemblies, then +. Part Studio tabs can be dragged into another order. */
export function BottomTabs() {
  const doc = useStore((s) => s.history.present);
  const studio = useStore(activeStudioId);
  const asm = useStore(activeAssembly);
  const drawingId = useStore((s) => activeDrawing(s)?.id ?? null);
  const editing = useStore((s) => s.editing !== null);
  const nav = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const dragRef = useRef<TabDrag | null>(null);
  const [menu, setMenu] = useState<{ id: string; name: string; x: number; y: number; rename: () => void } | null>(null);
  const studios = studiosOf(doc);
  const setBoth = (d: TabDrag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  /**
   * A press on a Part Studio tab: mouse and pen drag it along the bar (fingers use its menu — a held finger opens it).
   * Followed on the window, so tabs moving under the pointer while it's dragged don't lose it.
   */
  const dragStart = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (editing || e.button !== 0 || e.pointerType === "touch" || studios.length < 2 || dragRef.current) return;
    const middles = [...(nav.current?.querySelectorAll<HTMLElement>("[data-studio-tab]") ?? [])]
      .filter((el) => el.dataset.studioTab !== id)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return (r.left + r.right) / 2;
      });
    const pointerId = e.pointerId;
    setBoth({ id, pointerId, startX: e.clientX, middles, moving: false, to: studioIndex(doc, id) });
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
    };
    // Esc, losing the window, or the button let go somewhere the page never heard about: put the tab back.
    const cancel = () => {
      stop();
      if (dragRef.current?.moving) droppedUntil = performance.now() + 400;
      setBoth(null);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !dragRef.current?.moving) return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== pointerId) return;
      if (ev.buttons === 0) return cancel();
      if (!d.moving && Math.abs(ev.clientX - d.startX) < DRAG_START) return;
      ev.preventDefault();
      const to = dropIndex(d.middles, ev.clientX);
      if (!d.moving || to !== d.to) setBoth({ ...d, moving: true, to });
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop();
      const d = dragRef.current;
      setBoth(null);
      if (!d?.moving) return;
      droppedUntil = performance.now() + 400;
      if (ev.type === "pointerup") useStore.getState().movePartStudio(id, d.to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
  };

  // While dragging, the tabs are shown in the order they'd have if dropped now.
  let shown = studios;
  if (drag?.moving) {
    const moving = studios.find((s) => s.id === drag.id);
    if (moving) {
      shown = studios.filter((s) => s !== moving);
      shown.splice(drag.to, 0, moving);
    }
  }
  return (
    <nav className={`bottom-tabs${drag?.moving ? " reordering" : ""}`} aria-label="Document tabs" ref={nav}>
      {shown.map((p) => (
        <DocTab
          key={p.id}
          id={p.id}
          name={p.name}
          kind="studio"
          active={studio === p.id}
          disabled={editing}
          canDelete={studios.length > 1}
          dragging={drag?.moving && drag.id === p.id}
          onDragStart={dragStart(p.id)}
          studioMenu={(at, rename) => setMenu({ id: p.id, name: p.name, ...at, rename })}
        />
      ))}
      {(doc.assemblies ?? []).map((a) => (
        <DocTab key={a.id} id={a.id} name={a.name} kind="assembly" active={asm?.id === a.id} disabled={editing} canDelete />
      ))}
      {(doc.drawings ?? []).map((d) => (
        <DocTab key={d.id} id={d.id} name={d.name} kind="drawing" active={drawingId === d.id} disabled={editing} canDelete />
      ))}
      <AddTabMenu disabled={editing} />
      {menu && <StudioTabMenu menu={menu} count={studios.length} disabled={editing} onClose={() => setMenu(null)} />}
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
