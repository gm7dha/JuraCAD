import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { addHeld } from "../viewport/touchKeys";

import { DEFAULT_PART_COLOUR, PART_COLOURS } from "../model/colours";
import { describeParamErrors, FEATURE_DEFS, isPatternFeature, isPickFeature, isSolidFeature, OPERATION_LABELS } from "../model/features";
import { activeFeatures, activeHiddenDatums, activeStudioId, pickedFeatures, studioParts, useStore, type DatumName, type PlaneName } from "../model/store";
import { featureVisible, hasEye } from "../model/visibility";
import { nextFolderName } from "../model/document";
import { insertOfFeature } from "../library/insert";
import type { Feature, FeatureType } from "../model/types";
import { viewNormalToPlaneFeature, viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";
import { boxOf, PlacedPopup } from "./PlacedPopup";
import { clickRow, dragRows } from "../model/listSelection";
import { featuresOfParts, groupByPart, partsOfFeature } from "../model/partLinks";
import { framesOf, planeAsSketchPlane } from "../sketch/planeFeature";
import { DEFAULT_FINISH, FINISHES } from "../model/finishes";
import { copyFromMenu, pasteFromMenu } from "./featureClipboardApp";
import { matchingFeatures, rollbackBarAfter } from "../model/featureSearch";
import { setHoveredFeature } from "../viewport/featureFaces";
import { clickFeatureRow, setRenaming, setShownOrder, useRenaming } from "./featureListState";
import { failingFeatures, firstNew, nextOf, rollbackDrop } from "../model/featureList";

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
  mateConnector: Icons.MateConnector,
  curve: Icons.Curve,
  boolean: Icons.Boolean,
  deletePart: Icons.Trash,
  simplify: Icons.Simplify,
  composite: Icons.Composite,
  fastener: Icons.Bolt,
  derived: Icons.Derived,
  split: Icons.Split,
  thicken: Icons.Thicken,
  rib: Icons.Rib,
  draft: Icons.Draft,
  moveFace: Icons.MoveFace,
  replaceFace: Icons.ReplaceFace,
  sheetMetal: Icons.SheetMetal,
  flange: Icons.Flange,
  hem: Icons.Hem,
  cornerBreak: Icons.CornerBreak,
  fullRound: Icons.FullRound,
  wrap: Icons.Wrap,
  fill: Icons.Fill,
  boundary: Icons.Fill,
  faceBlend: Icons.Fillet,
  enclose: Icons.Enclose,
  offsetSurface: Icons.OffsetSurface,
  extendSurface: Icons.ExtendSurface,
  ruled: Icons.Ruled,
  tab: Icons.Tab,
  bend: Icons.Bend,
  jog: Icons.Jog,
  deleteFace: Icons.DeleteFace,
  modifyFillet: Icons.ModifyFillet,
  frame: Icons.Frame,
  trimFrame: Icons.TrimFrame,
  gusset: Icons.Gusset,
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

  // Kept inside the window: a menu opened low down (or far right) is moved up (or left) until it fits.
  const [at, setAt] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4));
    setAt((was) => (was.left === left && was.top === top ? was : { left, top }));
  }, [menu.x, menu.y, menu.entries.length]);

  return (
    <div className="context-menu" ref={ref} style={{ left: at.left, top: at.top, maxHeight: "calc(100vh - 8px)", overflowY: "auto" }} role="menu">
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

function EyeButton({ hidden, name, onToggle, disabled, title }: { hidden: boolean; name: string; onToggle: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      className={`icon-button small eye${hidden ? " is-hidden" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      disabled={disabled}
      aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
      title={title ?? (hidden ? "Show" : "Hide")}
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
  const hidden = useStore((s) => activeHiddenDatums(s).includes(name));
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
    "divider",
    ...VISIBILITY_MENU,
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

/** A part's colour and finish: click to choose others. */
function ColourSwatch({ partId, name }: { partId: string; name: string }) {
  const colour = useStore((s) => s.history.present.appearance?.[partId] ?? DEFAULT_PART_COLOUR);
  const setPartColour = useStore((s) => s.setPartColour);
  const finish = useStore((s) => s.history.present.finishes?.[partId] ?? DEFAULT_FINISH);
  const setPartsFinish = useStore((s) => s.setPartsFinish);
  // With several parts picked, colouring one of them colours them all.
  const group = useStore((s) => (s.selectedParts.length > 1 && s.selectedParts.includes(partId) ? s.selectedParts : null));
  const colourAll = (c: string | null) => (group ?? [partId]).forEach((id) => setPartColour(id, c));
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span className="swatch-wrap">
      <button
        ref={button}
        type="button"
        className="colour-swatch"
        style={{ background: colour }}
        onClick={() => setOpen((o) => !o)}
        title={group ? `Colour of the ${group.length} selected parts — click to change` : `Colour of ${name} — click to change`}
        aria-label={`Colour of ${name}`}
        aria-expanded={open}
      />
      {open && (
        // Drawn over everything and kept inside the window (above the swatch when the list is low down), so every colour and finish shows.
        <PlacedPopup className="colour-popover" role="dialog" label={`Choose a colour for ${name}`} anchor={() => boxOf(button.current)} owner={button} onClose={() => setOpen(false)} focusFirst>
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
          <div className="finish-heading">Finish</div>
          <div className="finish-list" role="radiogroup" aria-label={`Finish of ${name}`}>
            {FINISHES.map((f) => (
              <button
                type="button"
                role="radio"
                aria-checked={f.id === finish}
                key={f.id}
                className={`finish-choice${f.id === finish ? " selected" : ""}`}
                title={f.hint}
                onClick={() => setPartsFinish(group ?? [partId], f.id === DEFAULT_FINISH ? null : f.id)}
              >
                <span className={`finish-ball finish-${f.id}`} style={{ background: colour }} aria-hidden="true" />
                {f.label}
              </button>
            ))}
          </div>
        </PlacedPopup>
      )}
    </span>
  );
}

/** Drag-and-drop data type for moving features up and down the list. */
const FEATURE_DRAG = "application/x-juracad-feature";

/** A finger-first screen (iPad, Android tablet): a held row would start an iPad's drag and drop instead of its menu. */
const TOUCH_SCREEN = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

function FeatureRow({ feature, onMenu, linked, draggable }: { feature: Feature; onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void; linked: boolean; draggable?: boolean }) {
  const kernelError = useStore((s) => s.featureErrors[feature.id]);
  // Built, but with something to tell (shown in amber, not as a failure).
  const warning = useStore((s) => s.featureWarnings[feature.id]);
  // Plain information (what Simplify did), shown when hovering.
  const note = useStore((s) => s.featureNotes[feature.id]);
  const selected = useStore((s) => pickedFeatures(s).includes(feature.id));
  // Several features picked, this among them: its menu acts on them all.
  const group = useStore((s) => {
    const picked = pickedFeatures(s);
    return picked.length > 1 && picked.includes(feature.id) ? picked : null;
  });
  const rolledAt = useStore((s) => s.rollbackTo);
  const renaming = useRenaming() === feature.id;
  const editing = useStore((s) => s.editing?.draft.id === feature.id);
  const startEdit = useStore((s) => s.startEdit);
  const toggleSuppressed = useStore((s) => s.toggleSuppressed);
  const deleteFeature = useStore((s) => s.deleteFeature);
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
  // Sketches and planes have an eye. Used sketches hide by themselves (as in Onshape); one being edited is always shown.
  const eye = hasEye(feature);
  const shown = useStore((s) => !eye || featureVisible(feature, activeFeatures(s)));
  const setVisible = (visible: boolean) => useStore.getState().setFeaturesVisible([feature.id], visible);
  const op =
    feature.operation === "new" || feature.type === "sketch" || isPickFeature(feature.type) || isPatternFeature(feature.type) || feature.type === "hole" || feature.type === "transform" ? "" : ` (${OPERATION_LABELS[feature.operation]})`;

  const entries: MenuEntry[] = [
    { label: "Edit…", action: () => startEdit(feature.id) },
    { label: "Rename (F2)", action: () => setRenaming(feature.id) },
    { label: feature.suppressed ? "Unsuppress" : "Suppress", action: () => toggleSuppressed(feature.id) },
    ...(feature.type === "plane" ? [{ label: "View normal to", action: () => viewNormalToPlaneFeature(feature.id) }] : []),
    ...(eye && !editing ? [{ label: shown ? "Hide" : "Show", action: () => setVisible(!shown) }] : []),
    ...(feature.type === "sketch" || feature.type === "plane" ? VISIBILITY_MENU : []),
    { label: "Roll back to here", action: () => useStore.getState().setRollback(feature.id) },
    ...(rolledAt ? [{ label: "Roll to end", action: () => useStore.getState().setRollback(null) }] : []),
    // On a touch screen rows can't be dragged to reorder them, so the menu does it.
    ...(TOUCH_SCREEN
      ? [
          {
            label: "Move up",
            action: () => {
              const list = activeFeatures(useStore.getState());
              const at = list.findIndex((f) => f.id === feature.id);
              if (at > 0) useStore.getState().moveFeature(feature.id, list[at - 1].id);
            },
          },
          {
            label: "Move down",
            action: () => {
              const list = activeFeatures(useStore.getState());
              const at = list.findIndex((f) => f.id === feature.id);
              if (at >= 0 && at < list.length - 1) useStore.getState().moveFeature(feature.id, list[at + 2]?.id ?? null);
            },
          },
        ]
      : []),
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
    { label: "Copy (Ctrl+C)", action: () => copyFromMenu([feature.id]) },
    { label: "Paste features (Ctrl+V)", action: pasteFromMenu },
    "divider",
    { label: "Delete", action: () => deleteFeature(feature.id), danger: true },
    { label: "Delete with dependents…", action: () => useStore.getState().askDelete({ ids: [feature.id], from: "menu" }), danger: true },
  ];
  const menu = group ? groupMenu(group) : entries;

  return (
    <li
      className={[
        "feature-row",
        selected && "selected",
        !selected && linked && "linked",
        editing && "editing",
        error && !feature.suppressed && "failed",
        !error && warning && !feature.suppressed && "warned",
        feature.suppressed && "suppressed",
        isSource && "source",
        rolledBack && "rolled-back",
        !shown && !editing && "geometry-hidden",
      ]
        .filter(Boolean)
        .join(" ")}
      data-feature-id={feature.id}
      aria-selected={selected}
      onClick={(e) => {
        if (renaming) return;
        // While a mirror or pattern is open, clicking a feature adds it to (or removes it from) what's repeated.
        const st = useStore.getState();
        const d = st.editing?.draft;
        // A Plane feature clicked while something needs a plane: use it.
        if ((feature.type === "plane" || feature.type === "mateConnector") && d && d.id !== feature.id) {
          const frame = framesOf(activeFeatures(st), undefined, st.builtFrames).get(feature.id);
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
        // Ctrl/⌘ + click adds or takes off one, Shift + click picks a run (not while a feature is open).
        const several = !d && (addHeld(e) || e.shiftKey);
        clickFeatureRow(feature.id, { add: several && addHeld(e), range: several && e.shiftKey });
      }}
      onDoubleClick={() => !renaming && startEdit(feature.id)}
      onContextMenu={(e) => {
        // A right-click on a row that isn't picked picks it alone first, as in Onshape.
        if (!selected && !useStore.getState().editing) clickFeatureRow(feature.id, { add: false, range: false });
        onMenu(e, selected ? menu : entries);
      }}
      // Under the pointer: the faces it made light up in the view.
      onMouseEnter={() => setHoveredFeature(feature.id)}
      onMouseLeave={() => setHoveredFeature(null)}
      // Drag a feature up or down the list to move it (it's dropped above the row it's let go on).
      // (Not on a touch screen: there a long press is the right-click menu, and Move up / Move down are in it.)
      draggable={draggable && !TOUCH_SCREEN && !useStore.getState().editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(FEATURE_DRAG, feature.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!draggable || !(e.dataTransfer.types.includes(FEATURE_DRAG) || e.dataTransfer.types.includes(ROLLBACK_DRAG))) return;
        e.preventDefault();
        e.currentTarget.classList.add("drop-before");
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
      onDrop={(e) => {
        e.currentTarget.classList.remove("drop-before");
        // The rollback bar dragged here: the model is rolled back to just above this row.
        if (e.dataTransfer.types.includes(ROLLBACK_DRAG)) return dropRollbackAbove(feature.id);
        const id = e.dataTransfer.getData(FEATURE_DRAG);
        if (id && id !== feature.id) useStore.getState().moveFeature(id, feature.id);
      }}
      title={
        feature.suppressed
          ? "Suppressed — skipped when building"
          : error
            ? `Couldn't build: ${error}`
            : warning
              ? `Built, but: ${warning}`
              : note
                ? `${FEATURE_DEFS[feature.type].label}${op}: ${note}`
                : `${FEATURE_DEFS[feature.type].label}${op}. Double-click to edit, right-click for more.`
      }
    >
      <span className="feature-icon">
        <Icon size={18} />
      </span>
      {renaming ? (
        <RenameBox feature={feature} />
      ) : (
        <span className="feature-name">
          {feature.name}
          {op && <span className="feature-op">{op}</span>}
        </span>
      )}
      {error && !feature.suppressed && (
        <span className="feature-error-icon" aria-label="Error">
          <Icons.Warning size={16} />
        </span>
      )}
      {!error && warning && !feature.suppressed && (
        <span className="feature-warning-icon" aria-label="Note">
          <Icons.Warning size={16} />
        </span>
      )}
      {eye &&
        (editing ? (
          <EyeButton hidden={false} name={feature.name} onToggle={() => {}} disabled title="Always shown while you're editing it" />
        ) : (
          <EyeButton hidden={!shown} name={feature.name} onToggle={() => setVisible(!shown)} />
        ))}
    </li>
  );
}

/** A feature's name being changed in place (F2, or Rename in its menu): Enter keeps it, Esc puts it back. */
function RenameBox({ feature }: { feature: Feature }) {
  const [text, setText] = useState(feature.name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => input.current?.select(), []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = text.trim();
    if (keep && name && name !== feature.name) useStore.getState().renameFeature(feature.id, name);
    setRenaming(null);
  };
  return (
    <input
      ref={input}
      className="part-rename feature-rename"
      value={text}
      aria-label={`New name for ${feature.name}`}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
    />
  );
}

/** The right-click menu for several picked features: what can be done to them all at once. */
function groupMenu(ids: string[]): MenuEntry[] {
  const st = useStore.getState;
  const n = ids.length;
  const list = activeFeatures(st());
  const picked = list.filter((f) => ids.includes(f.id));
  const folders = new Set(picked.map((f) => f.folder ?? null));
  const inFolder = folders.size === 1 && !folders.has(null);
  return [
    ...(picked.some((f) => !f.suppressed) ? [{ label: `Suppress these ${n}`, action: () => st().setFeaturesSuppressed(ids, true) }] : []),
    ...(picked.some((f) => f.suppressed) ? [{ label: `Unsuppress these ${n}`, action: () => st().setFeaturesSuppressed(ids, false) }] : []),
    inFolder
      ? { label: `Take these ${n} out of "${picked[0].folder}"`, action: () => st().setFeatureFolder(ids, null) }
      : {
          label: `Put these ${n} in a new folder…`,
          action: () => {
            const name = window.prompt("Folder name (features next to each other with the same folder name are shown together)", nextFolderName(list));
            if (name !== null && name.trim()) st().setFeatureFolder(ids, name);
          },
        },
    { label: `Copy these ${n} (Ctrl+C)`, action: () => copyFromMenu(ids) },
    { label: "Clear selection (Esc)", action: () => st().selectFeature(null) },
    "divider",
    { label: `Delete these ${n}`, action: () => st().deleteFeatures(ids, true), danger: true },
    { label: `Delete these ${n} with dependents…`, action: () => st().askDelete({ ids, from: "menu" }), danger: true },
  ];
}

/** Drag-and-drop data type for the rollback bar. */
const ROLLBACK_DRAG = "application/x-juracad-rollback";

/** The rollback bar let go just above a row (null: past the last one, which rolls to the end). */
function dropRollbackAbove(id: string | null) {
  const st = useStore.getState();
  const r = rollbackDrop(activeFeatures(st), id);
  if ("refused" in r) st.showToast(r.refused, "info");
  else st.setRollback(r.to);
}

/** Right-click menu entries that show or hide every sketch, or every plane (P), of the Part Studio on show. */
const VISIBILITY_MENU: MenuEntry[] = [
  { label: "Show all sketches", action: () => useStore.getState().setAllSketchesVisible(true) },
  { label: "Hide all sketches", action: () => useStore.getState().setAllSketchesVisible(false) },
  { label: "Show all planes (P)", action: () => useStore.getState().setAllPlanesVisible(true) },
  { label: "Hide all planes (P)", action: () => useStore.getState().setAllPlanesVisible(false) },
];

const LIST_MENU: MenuEntry[] = [...VISIBILITY_MENU, "divider", { label: "Paste features (Ctrl+V)", action: pasteFromMenu }];

/** Onshape's rollback bar: the model is shown as it was at this point; new features go in here. */
function RollbackBar() {
  const setRollback = useStore((s) => s.setRollback);
  return (
    <li
      className="rollback-bar"
      role="separator"
      aria-label="Rolled back here"
      // Drag the bar up or down the list to roll back to another point (as in Onshape).
      draggable={!TOUCH_SCREEN}
      onDragStart={(e) => {
        e.dataTransfer.setData(ROLLBACK_DRAG, "bar");
        e.dataTransfer.effectAllowed = "move";
      }}
      title="Drag up or down the list to roll back to another point"
    >
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
  surface,
}: {
  id: string;
  name: string;
  hidden: boolean;
  /** A surface (a skin with no inside). */
  surface?: boolean;
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
          {
            label: "Simplify (tidy into real faces)…",
            action: () => {
              useStore.getState().setSelectedParts([id]);
              useStore.getState().startCreate("simplify");
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
      {surface && (
        <span className="muted small part-tag" title="A surface: a thin skin with no inside. Thicken it, or Enclose several, to make a solid.">
          surface
        </span>
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
  parts: { id: string; name: string; flat?: unknown; surface?: boolean; members?: { id: string; name: string }[] }[];
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
    // A Composite part or a part pattern open: the part is added to it (or taken off).
    const open = st().editing?.draft;
    if (open && (open.type === "composite" || open.pattern?.of === "part")) {
      st().toggleDraftPart(id);
      return;
    }
    e.preventDefault(); // no text highlighting while dragging
    const add = addHeld(e);
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
      { label: `Make a composite part of these ${n}…`, action: () => st().startCreate("composite") },
      { label: `Delete these ${n} parts…`, action: () => st().startCreate("deletePart") },
      { label: `Simplify these ${n} parts…`, action: () => st().startCreate("simplify") },
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
        {parts.map((p) => [
          <PartRow
            key={p.id}
            id={p.id}
            name={p.name}
            hidden={hiddenParts.includes(p.id)}
            surface={p.surface}
            selected={selected.includes(p.id)}
            linked={linked.includes(p.id)}
            onToggle={() => toggleHidden(p.id)}
            onMenu={(e, entries) => onMenu(e, menuFor(p.id, entries))}
            onPress={(e) => press(e, p.id)}
            onPassOver={(e) => passOver(e, p.id)}
          />,
          // A composite part's parts, listed under it (it's picked, coloured and exported as one).
          ...(p.members ?? []).map((m) => (
            <li key={`${p.id}/${m.id}`} className="part-member muted small" title={`Part of the composite part ${p.name}`}>
              {m.name}
            </li>
          )),
        ])}
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
  // No row stays "hovered" once the list goes (a tab change, an assembly).
  useEffect(() => () => setHoveredFeature(null), []);

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
  // "partsmith.groupFeatures" is a browser-storage key from the app's old name, kept so the setting is remembered.
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
  // The search box: only matching features are listed (folders opened as needed).
  const [query, setQuery] = useState("");
  const matches = useMemo(() => matchingFeatures(features, query, (f) => FEATURE_DEFS[f.type]?.label ?? f.type), [features, query]);
  const shownIf = (id: string) => !matches || matches.has(id);
  // The rollback bar goes after the last feature shown at or above it (searching may hide the one it's on); "" = at the top.
  const barAfter = useMemo(() => rollbackBarAfter(features, rollbackTo, matches), [rollbackTo, matches, features]);
  const groups = useMemo(() => (grouped ? groupByPart(parts, features) : { planes: [], groups: [], other: [] }), [grouped, parts, features]);
  const linkedParts = useMemo(() => (selectedFeatureId ? partsOfFeature(parts, selectedFeatureId, features) : []), [parts, selectedFeatureId, features]);

  // The rows as listed (shut folders and a search leave some out): what Shift + click and the arrow keys walk.
  const shownOrder = useMemo(() => {
    if (grouped) {
      const inGroups = groups.groups.flatMap((g) => (matches || !collapsed.includes(g.partId) ? g.featureIds : []));
      const other = matches || !collapsed.includes("other") ? groups.other : [];
      return [...groups.planes, ...inGroups, ...other].filter(shownIf);
    }
    return folderRuns(features).flatMap((run) => {
      const shut = !matches && !!run.folder && collapsed.includes(`folder:${run.folder}:${run.features[0].id}`);
      return shut ? [] : run.features.map((f) => f.id).filter(shownIf);
    });
    // shownIf reads `matches` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, groups, features, matches, collapsed]);
  setShownOrder(shownOrder);

  // Onshape's error count at the top of the list: features that failed (red) or built with a warning (amber).
  const featureErrors = useStore((s) => s.featureErrors);
  const featureWarnings = useStore((s) => s.featureWarnings);
  const failing = useMemo(() => failingFeatures(features, (f) => !!(featureErrors[f.id] ?? describeParamErrors(f))), [features, featureErrors]);
  const warned = useMemo(() => failingFeatures(features, (f) => !failing.includes(f.id) && !!featureWarnings[f.id]), [features, featureWarnings, failing]);
  const listRef = useRef<HTMLUListElement>(null);
  /** Bring a feature's row into view (opening its folder, or clearing a search that hides it). */
  const reveal = (id: string, pick: boolean) => {
    const f = features.find((x) => x.id === id);
    if (!f) return;
    if (matches && !matches.has(id)) setQuery("");
    // Its folder, or (grouped by part) the groups it's listed under, are opened.
    const groupKeys = new Set([...groups.groups.filter((g) => g.featureIds.includes(id)).map((g) => g.partId), ...(groups.other.includes(id) ? ["other"] : [])]);
    setCollapsed((c) => {
      const open = c.filter((k) => !(f.folder && k.startsWith(`folder:${f.folder}:`)) && !groupKeys.has(k));
      return open.length === c.length ? c : open;
    });
    if (pick) useStore.getState().selectFeature(id);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-feature-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const cycle = (ids: string[], e: ReactMouseEvent) => {
    const next = nextOf(features.map((f) => f.id), ids, useStore.getState().selectedFeatureId, e.shiftKey ? -1 : 1);
    if (next) reveal(next, true);
  };
  // A rebuild that makes another feature fail: its row is scrolled into view (not picked), as Onshape does.
  // (Not on changing to another Part Studio: its failures aren't new.)
  const studio = useStore(activeStudioId);
  const failedBefore = useRef<{ studio: string | null; ids: string[] }>({ studio, ids: failing });
  useEffect(() => {
    const was = failedBefore.current;
    failedBefore.current = { studio, ids: failing };
    const fresh = was.studio === studio ? firstNew(was.ids, failing) : null;
    if (fresh && !useStore.getState().editing) reveal(fresh, false);
    // Only when the failures change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failing, studio]);
  // F2 on a feature in a shut folder (or hidden by a search): show its row first, so it can be renamed.
  const renamingId = useRenaming();
  useEffect(() => {
    if (renamingId) reveal(renamingId, false);
    // Only when renaming starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingId]);

  return (
    <aside className="side-panel" aria-label="Feature list">
      <ConfigurationPicker />
      <section
        className="panel-section features"
        // Right-click on the list (not on a row, whose own menu comes first): show or hide all sketches or planes.
        onContextMenu={(e) => {
          if (!e.defaultPrevented) onMenu(e, LIST_MENU);
        }}
      >
        <h3 className="panel-heading-row">
          <span>
            Features <span className="count">({features.length})</span>
          </span>
          {failing.length > 0 && (
            <button
              type="button"
              className="feature-count-chip failed"
              onClick={(e) => cycle(failing, e)}
              title="Features that couldn't be built. Click to go to each in turn (Shift + click goes back)."
            >
              <Icons.Warning size={13} /> {failing.length === 1 ? "1 failed" : `${failing.length} failed`}
            </button>
          )}
          {warned.length > 0 && (
            <button
              type="button"
              className="feature-count-chip warned"
              onClick={(e) => cycle(warned, e)}
              title="Features that were built but have something to tell you. Click to go to each in turn."
            >
              <Icons.Warning size={13} /> {warned.length === 1 ? "1 note" : `${warned.length} notes`}
            </button>
          )}
          <label className="group-toggle" title="Show the features under each part they made (the build order is unchanged)">
            <input type="checkbox" checked={grouped} onChange={(e) => setGroupedPref(e.target.checked)} />
            Group by part
          </label>
        </h3>
        {features.length > 0 && (
          <div className="feature-search">
            <input
              type="search"
              value={query}
              placeholder="Search features"
              aria-label="Search features"
              title="Type part of a feature's name or kind (e.g. fillet) to list only those. Esc clears it."
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
            />
            {matches && (
              <span className="count" aria-live="polite">
                {matches.size} of {features.length}
              </span>
            )}
          </div>
        )}
        <ul className="feature-list" ref={listRef} aria-multiselectable="true" onMouseLeave={() => setHoveredFeature(null)}>
          {!matches && DATUMS.map((d) => <DatumRow key={d} name={d} onMenu={onMenu} />)}
          {!grouped && barAfter === "" && <RollbackBar key="rollback-top" />}
          {!grouped &&
            folderRuns(features).map((whole) => {
              const run = matches ? { ...whole, features: whole.features.filter((f) => matches.has(f.id)) } : whole;
              if (!run.features.length) return [];
              const rows = run.features.flatMap((f) => [
                <FeatureRow key={f.id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(f.id)} draggable />,
                ...(f.id === barAfter ? [<RollbackBar key="rollback" />] : []),
              ]);
              if (!run.folder) return rows;
              const key = `folder:${whole.folder}:${whole.features[0].id}`;
              // While searching, folders holding a match are opened.
              const shut = !matches && collapsed.includes(key);
              const folder = run.folder;
              const ids = whole.features.map((f) => f.id);
              const placed = insertOfFeature(useStore.getState().history.present, ids[0]);
              const menu: MenuEntry[] = [
                ...(placed ? [{ label: "Edit design sizes…", action: () => useStore.getState().openLibrary({ mode: "edit", insertId: placed.id }) }, "divider" as const] : []),
                {
                  label: "Rename folder…",
                  action: () => {
                    const name = window.prompt("Rename folder", folder);
                    if (name !== null) useStore.getState().renameFeatureFolder(folder, name);
                  },
                },
                { label: "Suppress all", action: () => ids.forEach((id) => features.find((f) => f.id === id && !f.suppressed) && useStore.getState().toggleSuppressed(id)) },
                { label: "Unsuppress all", action: () => ids.forEach((id) => features.find((f) => f.id === id && f.suppressed) && useStore.getState().toggleSuppressed(id)) },
                { label: "Copy the folder's features", action: () => copyFromMenu(ids) },
                "divider",
                { label: "Remove the folder (keep its features)", action: () => useStore.getState().setFeatureFolder(ids, null) },
                { label: "Delete the folder's features with dependents…", action: () => useStore.getState().askDelete({ ids, from: "menu" }), danger: true },
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
          {!grouped && !matches && features.length > 1 && (
            <li
              className="feature-drop-end"
              aria-hidden
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(FEATURE_DRAG) && !e.dataTransfer.types.includes(ROLLBACK_DRAG)) return;
                e.preventDefault();
                e.currentTarget.classList.add("drop-before");
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove("drop-before")}
              onDrop={(e) => {
                e.currentTarget.classList.remove("drop-before");
                if (e.dataTransfer.types.includes(ROLLBACK_DRAG)) return dropRollbackAbove(null);
                const id = e.dataTransfer.getData(FEATURE_DRAG);
                if (id) useStore.getState().moveFeature(id, null);
              }}
            />
          )}
          {grouped &&
            groups.planes.filter(shownIf).map((id) => {
              const f = features.find((x) => x.id === id);
              return f ? <FeatureRow key={id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(id)} /> : null;
            })}
          {grouped &&
            groups.groups.filter((g) => g.featureIds.some(shownIf)).map((g) => (
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
                {(matches || !collapsed.includes(g.partId)) && (
                  <ul className="feature-list nested" role="group">
                    {g.featureIds.filter(shownIf).map((id) => {
                      const f = features.find((x) => x.id === id);
                      return f ? <FeatureRow key={id} feature={f} onMenu={onMenu} linked={linkedFeatures.includes(id)} /> : null;
                    })}
                  </ul>
                )}
              </li>
            ))}
          {grouped && groups.other.some(shownIf) && (
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
              {(matches || !collapsed.includes("other")) && (
                <ul className="feature-list nested" role="group">
                  {groups.other.filter(shownIf).map((id) => {
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
        {matches && matches.size === 0 && <p className="panel-hint">No features match "{query.trim()}". Press Esc to show them all.</p>}
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
