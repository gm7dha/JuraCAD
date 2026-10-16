import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { DEFAULT_PART_COLOUR, PART_COLOURS } from "../model/colours";
import { describeParamErrors, FEATURE_DEFS, isPatternFeature, isPickFeature, isSolidFeature, OPERATION_LABELS } from "../model/features";
import { activeFeatures, studioParts, useStore, type DatumName, type PlaneName } from "../model/store";
import { nextFolderName } from "../model/document";
import type { Feature, FeatureType } from "../model/types";
import { viewNormalToPlaneFeature, viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";
import { clickRow, dragRows } from "../model/listSelection";
import { featuresOfParts, groupByPart, partsOfFeature } from "../model/partLinks";
import { framesOf, planeAsSketchPlane } from "../sketch/planeFeature";

const TYPE_ICONS: Record<FeatureType, (p: { size?: number }) => ReactNode> = {
  box: Icons.Box,
  cylinder: Icons.Cylinder,
  sphere: Icons.Sphere,
  coil: Icons.Coil,
  sketch: Icons.Sketch,
  extrude: Icons.Extrude,
  revolve: Icons.Revolve,
  shell: Icons.Shell,
  fillet: Icons.Fillet,
  mirror: Icons.Mirror,
  hole: Icons.Hole,
  transform: Icons.Move,
  linearPattern: Icons.LinearPattern,
  circularPattern: Icons.CircularPattern,
  curvePattern: Icons.CurvePattern,
  chamfer: Icons.Chamfer,
  import: Icons.Import,
  sweep: Icons.Sweep,
  loft: Icons.Loft,
  text: Icons.Text,
  plane: Icons.Plane,
  boolean: Icons.Boolean,
  deletePart: Icons.Trash,
  fastener: Icons.Bolt,
  split: Icons.Split,
  thicken: Icons.Thicken,
  rib: Icons.Rib,
  draft: Icons.Draft,
  moveFace: Icons.MoveFace,
  replaceFace: Icons.ReplaceFace,
  sheetMetal: Icons.SheetMetal,
  flange: Icons.Flange,
  hem: Icons.Hem,
  fullRound: Icons.FullRound,
  tab: Icons.Tab,
  deleteFace: Icons.DeleteFace,
  thread: Icons.Thread,
};

type MenuEntry = { label: string; action: () => void; danger?: boolean } | "divider";

interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const blur = () => onCloseRef.current();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return (
    <div className="context-menu" ref={ref} style={{ left: menu.x, top: menu.y }} role="menu">
      {menu.entries.map((entry, i) =>
        entry === "divider" ? (
          <div className="menu-divider" key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${entry.danger ? " danger" : ""}`}
            onClick={() => {
              entry.action();
              onClose();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}

function EyeButton({ hidden, name, onToggle }: { hidden: boolean; name: string; onToggle: () => void }) {
  return (
    <button
      className={`icon-button small eye${hidden ? " is-hidden" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
      title={hidden ? "Show" : "Hide"}
    >
      {hidden ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
    </button>
  );
}

/** Origin and the Top / Front / Right planes, which every Part Studio starts with. */
function DatumRow({ name, onMenu }: { name: DatumName; onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void }) {
  const isPlane = name !== "Origin";
  const plane = isPlane ? (name as PlaneName) : null;
  const selected = useStore((s) => plane !== null && s.selectedPlane === plane);
  const hidden = useStore((s) => s.hiddenDatums.includes(name));
  const selectPlane = useStore((s) => s.selectPlane);
  const setListHoverPlane = useStore((s) => s.setListHoverPlane);
  const toggleDatum = useStore((s) => s.toggleDatum);

  const entries: MenuEntry[] = [
    ...(plane
      ? [
          { label: "View normal to", action: () => viewportApi.current?.viewNormalToPlane(plane) },
          {
            label: "New plane from this…",
            action: () => {
              // A copy of this plane, moved by a distance set in the Plane dialog.
              useStore.getState().selectPlane(plane);
              useStore.getState().startCreate("plane");
            },
          },
        ]
      : []),
    { label: hidden ? "Show" : "Hide", action: () => toggleDatum(name) },
  ];

  return (
    <li
      className={["feature-row", "datum", selected && "selected", hidden && "hidden"].filter(Boolean).join(" ")}
      onClick={() => {
        if (!plane || hidden) return;
        const st = useStore.getState();
        if (st.sketch && st.editing?.draft.sketch && !st.editing.draft.sketch.plane) st.setSketchPlane({ kind: "default", name: plane });
        else if (st.editing?.draft.type === "mirror") st.setDraftMirrorPlane({ kind: "default", name: plane });
        else if (st.editing?.draft.type === "text" && st.editing.draft.text)
          st.setDraftField({ text: { ...st.editing.draft.text, plane: { kind: "default", name: plane } } });
        else selectPlane(selected ? null : plane);
      }}
      onDoubleClick={() => plane && viewportApi.current?.viewNormalToPlane(plane)}
      onMouseEnter={() => plane && !hidden && setListHoverPlane(plane)}
      onMouseLeave={() => plane && setListHoverPlane(null)}
      onContextMenu={(e) => onMenu(e, entries)}
      title={
        plane
          ? `${name} plane. Click to select, double-click to look straight at it, right-click for more.`
          : "The origin (0, 0, 0). Right-click to hide or show it."
      }
    >
      <span className={`feature-icon${plane ? " plane" : ""}`}>{plane ? <Icons.Plane size={18} /> : <Icons.Origin size={18} />}</span>
      <span className="feature-name">{name}</span>
      <EyeButton hidden={hidden} name={name} onToggle={() => toggleDatum(name)} />
    </li>
  );
}

/** A part's colour: click to choose another. */
function ColourSwatch({ partId, name }: { partId: string; name: string }) {
  const colour = useStore((s) => s.history.present.appearance?.[partId] ?? DEFAULT_PART_COLOUR);
  const setPartColour = useStore((s) => s.setPartColour);
  // With several parts picked, colouring one of them colours them all.
  const group = useStore((s) => (s.selectedParts.length > 1 && s.selectedParts.includes(partId) ? s.selectedParts : null));
  const colourAll = (c: string | null) => (group ?? [partId]).forEach((id) => setPartColour(id, c));
  const [open, setOpen] = useState(false);
  return (
    <span className="swatch-wrap">
      <button
        type="button"
        className="colour-swatch"
        style={{ background: colour }}
        onClick={() => setOpen((o) => !o)}
        title={group ? `Colour of the ${group.length} selected parts — click to change` : `Colour of ${name} — click to change`}
        aria-label={`Colour of ${name}`}
        aria-expanded={open}
      />
      {open && (
        <div className="colour-popover" role="dialog" aria-label={`Choose a colour for ${name}`} onMouseLeave={() => setOpen(false)}>
          <div className="colour-grid">
            {PART_COLOURS.map((c) => (
              <button
                type="button"
                key={c.hex}
                className={`colour-choice${c.hex === colour ? " selected" : ""}`}
                style={{ background: c.hex }}
                title={c.name}
                aria-label={c.name}
                onClick={() => {
                  colourAll(c.hex === DEFAULT_PART_COLOUR ? null : c.hex);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <label className="colour-custom">
            Other…
            <input type="color" value={colour} onChange={(e) => colourAll(e.target.value)} />
          </label>
        </div>
      )}
    </span>
  );
}

/** Drag-and-drop data type for moving features up and down the list. */
const FEATURE_DRAG = "application/x-partsmith-feature";

function FeatureRow({ feature, onMenu, linked, draggable }: { feature: Feature; onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void; linked: boolean; draggable?: boolean }) {
  const kernelError = useStore((s) => s.featureErrors[feature.id]);
  const selected = useStore((s) => s.selectedFeatureId === feature.id);
  const editing = useStore((s) => s.editing?.draft.id === feature.id);
  const selectFeature = useStore((s) => s.selectFeature);
  const startEdit = useStore((s) => s.startEdit);
  const toggleSuppressed = useStore((s) => s.toggleSuppressed);
  const deleteFeature = useStore((s) => s.deleteFeature);
  const renameFeature = useStore((s) => s.renameFeature);
  const Icon = TYPE_ICONS[feature.type];
  const error = kernelError ?? describeParamErrors(feature);
  const isSource = useStore((s) => {
    const d = s.editing?.draft;
    return !!d && ((d.mirror?.sources ?? d.pattern?.sources ?? []) as string[]).includes(feature.id);
  });
  const rolledBack = useStore((s) => {
    if (!s.rollbackTo) return false;
    const list = activeFeatures(s);
    const at = list.findIndex((f) => f.id === s.rollbackTo);
    return at >= 0 && list.findIndex((f) => f.id === feature.id) > at;
  });
  const op =
    feature.operation === "new" || feature.type === "sketch" || isPickFeature(feature.type) || isPatternFeature(feature.type) || feature.type === "hole" || feature.type === "transform" ? "" : ` (${OPERATION_LABELS[feature.operation]})`;

  const entries: MenuEntry[] = [
    { label: "Edit…", action: () => startEdit(feature.id) },
    {
      label: "Rename…",
      action: () => {
        const name = window.prompt("Rename feature", feature.name);
        if (name !== null) renameFeature(feature.id, name);
      },
    },
    { label: feature.suppressed ? "Unsuppress" : "Suppress", action: () => toggleSuppressed(feature.id) },
    ...(feature.type === "plane" ? [{ label: "View normal to", action: () => viewNormalToPlaneFeature(feature.id) }] : []),
    { label: "Roll back to here", action: () => useStore.getState().setRollback(feature.id) },
    feature.folder
      ? { label: `Take out of "${feature.folder}"`, action: () => useStore.getState().setFeatureFolder([feature.id], null) }
      : {
          label: "Put in a folder…",
          action: () => {
            const list = activeFeatures(useStore.getState());
            const at = list.findIndex((f) => f.id === feature.id);
            // Next to a folder already: offer to join it.
            const near = list[at - 1]?.folder ?? list[at + 1]?.folder;
            const name = window.prompt("Folder name (features next to each other with the same folder name are shown together)", near ?? nextFolderName(list));
            if (name !== null && name.trim()) useStore.getState().setFeatureFolder([feature.id], name);
          },
        },
    "divider",
    { label: "Delete", action: () => deleteFeature(feature.id), danger: true },
  ];

  return (
    <li
      className={[
        "feature-row",
        selected && "selected",
        !selected && linked && "linked",
        editing && "editing",
        error && !feature.suppressed && "failed",
        feature.suppressed && "suppressed",
        isSource && "source",
        rolledBack && "rolled-back",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => {
        // While a mirror or pattern is open, clicking a feature adds it to (or removes it from) what's repeated.
        const st = useStore.getState();
        const d = st.editing?.draft;
        // A Plane feature clicked while something needs a plane: use it.
        if (feature.type === "plane" && d && d.id !== feature.id) {
          const frame = framesOf(activeFeatures(st)).get(feature.id);
          const plane = frame ? planeAsSketchPlane(feature, frame) : null;
          if (plane && st.sketch && d.sketch && !d.sketch.plane) return st.setSketchPlane(plane);
          if (plane && d.type === "text" && d.text) return st.setDraftField({ text: { ...d.text, plane } });
          if (plane && d.type === "mirror") return st.setDraftMirrorPlane(plane);
          if (plane && d.type === "plane" && d.planeDef) return st.setDraftField({ planeDef: { ...d.planeDef, ref: plane } });
        }
        if (d && isPatternFeature(d.type) && d.id !== feature.id) {
          if (isSolidFeature(feature.type)) st.toggleDraftSource(feature.id);
          else st.showToast(`${feature.name} doesn't add or cut a solid, so it can't be ${d.type === "mirror" ? "mirrored" : "patterned"}.`);
          return;
        }
        selectFeature(feature.id);
      }}
      onDoubleClick={() => startEdit(feature.id)}
      onContextMenu={(e) => onMenu(e, entries)}
      // Drag a feature up or down the list to move it (it's dropped above the row it's let go on).
      draggable={draggable && !useStore.getState().editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(FEATURE_DRAG, feature.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!draggable || !e.dataTransfer.types.includes(FEATURE_DRAG)) return;
        e.preventDefault();
        e.currentTarget.classList.add("drop-before");
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => {
        e.currentTarget.classList.remove("drop-before");
        const id = e.dataTransfer.getData(FEATURE_DRAG);
        if (id && id !== feature.id) useStore.getState().moveFeature(id, feature.id);
      }}
      title={
        feature.suppressed
          ? "Suppressed — skipped when building"
          : error
            ? `Couldn't build: ${error}`
            : `${FEATURE_DEFS[feature.type].label}${op}. Double-click to edit, right-click for more.`
      }
    >
      <span className="feature-icon">
        <Icon size={18} />
      </span>
      <span className="feature-name">
        {feature.name}
        {op && <span className="feature-op">{op}</span>}
      </span>
      {error && !feature.suppressed && (
        <span className="feature-error-icon" aria-label="Error">
          <Icons.Warning size={16} />
        </span>
      )}
    </li>
  );
}

/** Onshape's rollback bar: the model is shown as it was at this point; new features go in here. */
function RollbackBar() {
  const setRollback = useStore((s) => s.setRollback);
  return (
    <li className="rollback-bar" role="separator" aria-label="Rolled back here">
      <span>Rolled back — new features go here</span>
      <button type="button" className="text-button small-text" onClick={() => setRollback(null)} title="Show the whole model again">
        Roll to end
      </button>
    </li>
  );
}

/** A part in the Parts list: colour, name (double-click to rename) and show/hide. */
function PartRow({
  id,
  name,
  hidden,
  selected,
  linked,
  onToggle,
  onMenu,
  onPress,
  onPassOver,
}: {
  id: string;
  name: string;
  hidden: boolean;
  selected: boolean;
  linked: boolean;
  onToggle: () => void;
  onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void;
  onPress: (e: ReactPointerEvent) => void;
  onPassOver: (e: ReactPointerEvent) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const start = () => {
    setText(name);
    setRenaming(true);
  };
  const finish = (keep: boolean) => {
    if (keep) useStore.getState().renamePart(id, text);
    setRenaming(false);
  };
  return (
    <li
      className={`part-row${hidden ? " hidden" : ""}${selected ? " selected" : linked ? " linked" : ""}`}
      aria-selected={selected}
      onDoubleClick={start}
      onPointerDown={(e) => {
        // Not when using the colour, eye or rename boxes.
        if ((e.target as Element).closest("button, input, .colour-popover")) return;
        onPress(e);
      }}
      onPointerEnter={onPassOver}
      onContextMenu={(e) =>
        onMenu(e, [
          { label: "Rename…", action: start },
          { label: "Duplicate…", action: () => useStore.getState().duplicateParts([id]) },
          {
            label: "Delete part…",
            action: () => {
              useStore.getState().setSelectedParts([id]);
              useStore.getState().startCreate("deletePart");
            },
          },
          { label: hidden ? "Show" : "Hide", action: onToggle },
          { label: "Show only this part", action: () => isolate([id]) },
          { label: "Show all parts", action: () => isolate(null) },
          useStore.getState().transparentParts.includes(id)
            ? { label: "Make solid", action: () => useStore.getState().setPartsTransparent([id], false) }
            : { label: "Make see-through", action: () => useStore.getState().setPartsTransparent([id], true) },
        ])
      }
      title="Click to select (drag, Shift or Ctrl for several); double-click to rename; right-click for more"
    >
      <ColourSwatch partId={id} name={name} />
      {renaming ? (
        <input
          ref={input}
          className="part-rename"
          value={text}
          aria-label={`New name for ${name}`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") finish(true);
            if (e.key === "Escape") finish(false);
          }}
        />
      ) : (
        <span className="feature-name">{name}</span>
      )}
      <EyeButton hidden={hidden} name={name} onToggle={onToggle} />
    </li>
  );
}

/**
 * The Parts list. Click a part to select it; drag down or up the list, or
 * Shift + click, to select a run of parts; Ctrl (⌘) + click to add or remove
 * one. Selected parts light up in the 3D view, and can be hidden, coloured or
 * exported together.
 */
function PartsList({
  parts,
  hiddenParts,
  toggleHidden,
  onMenu,
  linked,
}: {
  linked: string[];
  parts: { id: string; name: string; flat?: unknown }[];
  hiddenParts: string[];
  toggleHidden: (id: string) => void;
  onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void;
}) {
  const selected = useStore((s) => s.selectedParts);
  const anchor = useRef<string | null>(null);
  const drag = useRef<{ base: string[] } | null>(null);
  const order = parts.map((p) => p.id);
  const st = useStore.getState;

  useEffect(() => {
    const end = () => (drag.current = null);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);
  // Esc clears the selection (unless something else is open and wants it).
  useEffect(() => {
    if (!selected.length) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Escape" || st().editing || (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      st().setSelectedParts([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.length, st]);

  const press = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    // With a Boolean open, clicking a part adds it to (or takes it off) the Boolean instead.
    if (st().editing?.draft.type === "boolean") {
      st().toggleBooleanPart(id);
      return;
    }
    e.preventDefault(); // no text highlighting while dragging
    const add = e.ctrlKey || e.metaKey;
    const r = clickRow(order, st().selectedParts, anchor.current, id, { add, range: e.shiftKey });
    st().setSelectedParts(r.selected);
    anchor.current = r.anchor;
    // Dragging on from here picks the rows passed over (keeping the rest when Ctrl is held).
    if (!e.shiftKey) drag.current = { base: add ? r.selected.filter((x) => x !== id) : [] };
  };
  const passOver = (e: ReactPointerEvent, id: string) => {
    if (!drag.current || !anchor.current || (e.buttons & 1) === 0) return;
    st().setSelectedParts(dragRows(order, drag.current.base, anchor.current, id));
  };

  const menuFor = (id: string, single: MenuEntry[]): MenuEntry[] => {
    const group = selected.length > 1 && selected.includes(id) ? selected : null;
    if (!group) return single;
    const n = group.length;
    return [
      { label: `Hide these ${n} parts`, action: () => st().setPartsHidden(group, true) },
      { label: `Show these ${n} parts`, action: () => st().setPartsHidden(group, false) },
      { label: "Show only these", action: () => isolate(group) },
      { label: "Show all parts", action: () => isolate(null) },
      group.every((x) => st().transparentParts.includes(x))
        ? { label: `Make these ${n} solid`, action: () => st().setPartsTransparent(group, false) }
        : { label: `Make these ${n} see-through`, action: () => st().setPartsTransparent(group, true) },
      "divider",
      { label: `Duplicate these ${n} parts`, action: () => st().duplicateParts(group) },
      { label: `Merge these ${n} parts into one`, action: () => st().mergeParts(group) },
      { label: `Delete these ${n} parts…`, action: () => st().startCreate("deletePart") },
      { label: `Export these ${n} parts…`, action: () => st().openDialog("export") },
      { label: "Clear selection", action: () => st().setSelectedParts([]) },
    ];
  };

  return (
    <>
      <ul
        className="part-list"
        aria-multiselectable="true"
        onPointerDown={(e) => {
          // A click on the empty part of the list clears the selection.
          if (e.target === e.currentTarget && e.button === 0) st().setSelectedParts([]);
        }}
      >
        {parts.map((p) => (
          <PartRow
            key={p.id}
            id={p.id}
            name={p.name}
            hidden={hiddenParts.includes(p.id)}
            selected={selected.includes(p.id)}
            linked={linked.includes(p.id)}
            onToggle={() => toggleHidden(p.id)}
            onMenu={(e, entries) => onMenu(e, menuFor(p.id, entries))}
            onPress={(e) => press(e, p.id)}
            onPassOver={(e) => passOver(e, p.id)}
          />
        ))}
      </ul>
      {selected.length > 0 && (
        <div className="parts-selection-bar" role="toolbar" aria-label="Selected parts">
          <span>{selected.length === 1 ? "1 part selected" : `${selected.length} parts selected`}</span>
          <button type="button" className="text-button small-text" onClick={() => st().setPartsHidden(selected, !selected.every((id) => hiddenParts.includes(id)))}>
            {selected.every((id) => hiddenParts.includes(id)) ? "Show" : "Hide"}
          </button>
          <button type="button" className="text-button small-text" onClick={() => st().duplicateParts(selected)}>
            Duplicate
          </button>
          {selected.length > 1 && (
            <button type="button" className="text-button small-text" onClick={() => st().mergeParts(selected)} title="Join the selected parts into one part">
              Merge
            </button>
          )}
          <button type="button" className="text-button small-text" onClick={() => st().openDialog("export")}>
            Export…
          </button>
          {selected.length === 1 && !!parts.find((p) => p.id === selected[0])?.flat && (
            <button type="button" className="text-button small-text" onClick={() => st().openDialog("flatPattern")} title="See this sheet metal part laid out flat, and save it for laser cutting">
              Flat pattern
            </button>
          )}
          <button type="button" className="icon-button small" onClick={() => st().setSelectedParts([])} aria-label="Clear selection" title="Clear selection (Esc)">
            <Icons.Cross size={14} />
          </button>
        </div>
      )}
    </>
  );
}

/** Show only these parts of the Part Studio on show (null: show them all again). */
function isolate(ids: string[] | null) {
  const s = useStore.getState();
  const all = studioParts(s).map((p) => p.id);
  s.setPartsHidden(all, false);
  if (ids) s.setPartsHidden(all.filter((x) => !ids.includes(x)), true);
}

const DATUMS: DatumName[] = ["Origin", "Top", "Front", "Right"];

export function FeaturePanel() {
  const parts = useStore(studioParts);
  const hiddenParts = useStore((s) => s.hiddenParts);
  const toggleHidden = useStore((s) => s.toggleHidden);
  const draftIsNew = useStore((s) => (s.editing?.mode === "create" ? s.editing.draft : null));
  const [menu, setMenu] = useState<MenuState | null>(null);

  const onMenu = (e: ReactMouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entries });
  };

  const features = useStore(activeFeatures);
  // Picked parts light up the features that made them, and a picked feature its parts.
  const selectedParts = useStore((s) => s.selectedParts);
  const selectedFeatureId = useStore((s) => s.selectedFeatureId);
  const linkedFeatures = useMemo(() => (selectedParts.length ? featuresOfParts(parts, selectedParts, features) : []), [parts, selectedParts, features]);
  // "Group by part": remembered on this computer.
  const rollbackTo = useStore((s) => s.rollbackTo);
  const [grouped, setGrouped] = useState(() => {
    try {
      return localStorage.getItem("partsmith.groupFeatures") === "1";
    } catch {
      return false;
    }
  });
  const setGroupedPref = (on: boolean) => {
    setGrouped(on);
    try {
      localStorage.setItem("partsmith.groupFeatures", on ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  };
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const groups = useMemo(() => (grouped ? groupByPart(parts, features) : { planes: [], groups: [], other: [] }), [grouped, parts, features]);
  const linkedParts = useMemo(() => (selectedFeatureId ? partsOfFeature(parts, selectedFeatureId, features) : []), [parts, selectedFeatureId, features]);

  return (
    <aside className="side-panel" aria-label="Feature list">
      <ConfigurationPicker />
      <section className="panel-section features">
        <h3 className="panel-heading-row">
          <span>
            Features <span className="count">({features.length})</span>
          </span>
          <label className="group-toggle" title="Show the features under each part they made (the build order is unchanged)">
            <input type="checkbox" checked={grouped} onChange={(e) => setGroupedPref(e.target.checked)} />
            Group by part
          </label>
        </h3>
        <ul className="feature-list">
          {DATUMS.map((d) => (
            <DatumRow key={d} name={d} onMenu={onMenu} />
          ))}
          {!grouped &&
            folderRuns(features).map((run) => {
              const rows = run.features.flatMap((f) => [
                <FeatureRow key={f.id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(f.id)} draggable />,
                ...(f.id === rollbackTo ? [<RollbackBar key="rollback" />] : []),
              ]);
              if (!run.folder) return rows;
              const key = `folder:${run.folder}:${run.features[0].id}`;
              const shut = collapsed.includes(key);
              const folder = run.folder;
              const ids = run.features.map((f) => f.id);
              const menu: MenuEntry[] = [
                {
                  label: "Rename folder…",
                  action: () => {
                    const name = window.prompt("Rename folder", folder);
                    if (name !== null) useStore.getState().renameFeatureFolder(folder, name);
                  },
                },
                { label: "Suppress all", action: () => ids.forEach((id) => features.find((f) => f.id === id && !f.suppressed) && useStore.getState().toggleSuppressed(id)) },
                { label: "Unsuppress all", action: () => ids.forEach((id) => features.find((f) => f.id === id && f.suppressed) && useStore.getState().toggleSuppressed(id)) },
                "divider",
                { label: "Remove the folder (keep its features)", action: () => useStore.getState().setFeatureFolder(ids, null) },
              ];
              return [
                <li key={key} className="feature-group feature-folder" role="treeitem" aria-expanded={!shut}>
                  <button
                    type="button"
                    className="feature-group-head"
                    onClick={() => setCollapsed((c) => (c.includes(key) ? c.filter((x) => x !== key) : [...c, key]))}
                    onDoubleClick={() => {
                      const name = window.prompt("Rename folder", folder);
                      if (name !== null) useStore.getState().renameFeatureFolder(folder, name);
                    }}
                    onContextMenu={(e) => onMenu(e, menu)}
                    aria-label={`Folder ${folder} — click to ${shut ? "open" : "close"}, double-click to rename`}
                    title="Click to open or close; double-click to rename; right-click for more"
                  >
                    <span className={`caret${shut ? "" : " open"}`}>▸</span>
                    <Icons.Folder size={15} />
                    <span className="feature-name">{folder}</span>
                    <span className="count">({run.features.length})</span>
                  </button>
                  {!shut && (
                    <ul className="feature-list nested" role="group">
                      {rows}
                    </ul>
                  )}
                </li>,
              ];
            })}
          {!grouped && features.length > 1 && (
            <li
              className="feature-drop-end"
              aria-hidden
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(FEATURE_DRAG)) return;
                e.preventDefault();
                e.currentTarget.classList.add("drop-before");
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
              onDrop={(e) => {
                e.currentTarget.classList.remove("drop-before");
                const id = e.dataTransfer.getData(FEATURE_DRAG);
                if (id) useStore.getState().moveFeature(id, null);
              }}
            />
          )}
          {grouped &&
            groups.planes.map((id) => {
              const f = features.find((x) => x.id === id);
              return f ? <FeatureRow key={id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(id)} /> : null;
            })}
          {grouped &&
            groups.groups.map((g) => (
              <li key={g.partId} className="feature-group" role="treeitem" aria-expanded={!collapsed.includes(g.partId)}>
                <button
                  type="button"
                  className="feature-group-head"
                  onClick={() => setCollapsed((c) => (c.includes(g.partId) ? c.filter((x) => x !== g.partId) : [...c, g.partId]))}
                  aria-label={`${collapsed.includes(g.partId) ? "Show" : "Hide"} the features of ${g.name}`}
                >
                  <span className={`caret${collapsed.includes(g.partId) ? "" : " open"}`}>▸</span>
                  <Icons.Part size={15} />
                  <span className="feature-name">{g.name}</span>
                  <span className="count">({g.featureIds.length})</span>
                </button>
                {!collapsed.includes(g.partId) && (
                  <ul className="feature-list nested" role="group">
                    {g.featureIds.map((id) => {
                      const f = features.find((x) => x.id === id);
                      return f ? <FeatureRow key={id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(id)} /> : null;
                    })}
                  </ul>
                )}
              </li>
            ))}
          {grouped && groups.other.length > 0 && (
            <li className="feature-group" role="treeitem" aria-expanded={!collapsed.includes("other")}>
              <button
                type="button"
                className="feature-group-head"
                onClick={() => setCollapsed((c) => (c.includes("other") ? c.filter((x) => x !== "other") : [...c, "other"]))}
              >
                <span className={`caret${collapsed.includes("other") ? "" : " open"}`}>▸</span>
                <span className="feature-name muted">Not part of a part yet</span>
                <span className="count">({groups.other.length})</span>
              </button>
              {!collapsed.includes("other") && (
                <ul className="feature-list nested" role="group">
                  {groups.other.map((id) => {
                    const f = features.find((x) => x.id === id);
                    return f ? <FeatureRow key={id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(id)} /> : null;
                  })}
                </ul>
              )}
            </li>
          )}
          {draftIsNew && (
            <li className="feature-row editing draft">
              <span className="feature-icon">{TYPE_ICONS[draftIsNew.type]({ size: 18 })}</span>
              <span className="feature-name">{draftIsNew.name}</span>
            </li>
          )}
        </ul>
        {features.length === 0 && !draftIsNew && (
          <p className="panel-hint">Start with a Sketch (then Extrude it), or add a Box, Cylinder, Sphere or Coil from the toolbar.</p>
        )}
      </section>

      <section className="panel-section parts">
        <h3>
          Parts <span className="count">({parts.length})</span>
        </h3>
        <PartsList parts={parts} hiddenParts={hiddenParts} toggleHidden={toggleHidden} onMenu={onMenu} linked={linkedParts} />
        {parts.length === 0 && <p className="panel-hint">No parts yet.</p>}
      </section>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/** Which configuration is on show (only when the design has some). */
function ConfigurationPicker() {
  const list = useStore((s) => s.history.present.configurations);
  const activeId = useStore((s) => s.history.present.activeConfiguration);
  const editing = useStore((s) => !!s.editing);
  if (!list?.length) return null;
  const shown = list.find((c) => c.id === activeId) ?? list[0];
  return (
    <div className="configuration-picker">
      <label htmlFor="configuration-select">Configuration</label>
      <select
        id="configuration-select"
        value={shown.id}
        disabled={editing}
        title={editing ? "Finish or cancel the open feature first" : "Show another version of the design"}
        onChange={(e) => useStore.getState().switchConfiguration(e.target.value)}
      >
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button className="icon-button small" onClick={() => useStore.getState().openDialog("configurations")} title="Edit configurations" aria-label="Edit configurations">
        <Icons.Configurations size={15} />
      </button>
    </div>
  );
}

/** The feature list in runs: features next to each other in the same folder go together. */
function folderRuns(features: Feature[]): { folder: string | null; features: Feature[] }[] {
  const runs: { folder: string | null; features: Feature[] }[] = [];
  for (const f of features) {
    const folder = f.folder ?? null;
    const last = runs[runs.length - 1];
    if (last && folder && last.folder === folder) last.features.push(f);
    else runs.push({ folder, features: [f] });
  }
  return runs;
}
