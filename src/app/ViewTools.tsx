/**
 * Everyday Onshape helpers next to Fit in the toolbar and over the 3D view: the selection filter, named views,
 * Select other's list, and the question asked before pasting features that use missing variables.
 */
import { useMemo, useRef, useState } from "react";

import { viewNameProblem, type NamedView } from "../model/namedViews";
import { useStore, viewOwner } from "../model/store";
import { FILTER_OPTIONS, filtering, filterSummary, NO_FILTER, toggleFilter } from "../viewport/selectionFilter";
import { setSelectOther, useSelectOther } from "../viewport/selectOtherState";
import { pickChoice, previewChoice, viewportApi } from "../viewport/Viewport";
import { additive } from "../viewport/touchKeys";
import { finishPaste } from "./featureClipboardApp";
import { Icons } from "./icons";
import { Modal } from "./Modal";
import { PlacedPopup } from "./PlacedPopup";

const boxOf = (el: HTMLElement | null) => {
  const r = el?.getBoundingClientRect();
  return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
};

const NO_VIEWS: NamedView[] = [];

/** The named views of the Part Studio or assembly on show (a new array only when they change). */
function useOwnViews(): NamedView[] {
  const all = useStore((s) => s.history.present.namedViews);
  const owner = useStore(viewOwner);
  return useMemo(() => (all?.length ? all.filter((v) => v.owner === owner) : NO_VIEWS), [all, owner]);
}

function FilterIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

/** The selection filter: which kinds of thing a click in the 3D view picks (Part Studios). */
export function SelectFilterButton() {
  const filter = useStore((s) => s.selectFilter);
  const set = useStore((s) => s.setSelectFilter);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const on = filtering(filter);
  return (
    <>
      <button
        ref={button}
        className={`tool-button${on ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Selection filter"
        aria-expanded={open}
        title={`Selection filter — choose what a click in the 3D view picks (now: ${filterSummary(filter).toLowerCase()})`}
      >
        <FilterIcon />
        <span>{on ? filterSummary(filter) : "Pick"}</span>
      </button>
      {open && (
        <PlacedPopup className="colour-popover view-tools-popup" role="dialog" label="Selection filter" anchor={() => boxOf(button.current)} owner={button} onClose={() => setOpen(false)} focusFirst>
          <p className="view-tools-note">Clicks in the 3D view pick only what's ticked. Nothing ticked: everything, as usual.</p>
          {FILTER_OPTIONS.map((o) => (
            <label key={o.kind} className="view-tools-check" title={o.hint}>
              <input type="checkbox" checked={filter.includes(o.kind)} onChange={() => set(toggleFilter(filter, o.kind))} />
              <span>
                {o.label} <small>{o.hint}</small>
              </span>
            </label>
          ))}
          <button className="text-button" onClick={() => set(NO_FILTER)} disabled={!on}>
            Pick everything again
          </button>
        </PlacedPopup>
      )}
    </>
  );
}

/** Named views: save the camera under a name, and go back to it (Part Studios and assemblies). */
export function NamedViewsButton() {
  const views = useOwnViews();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} className="tool-button" onClick={() => setOpen((o) => !o)} aria-label="Named views" aria-expanded={open} title="Named views — save the way you're looking at the model under a name, and come back to it">
        <CameraIcon />
        <span>Views</span>
      </button>
      {open && (
        <PlacedPopup className="colour-popover view-tools-popup" role="dialog" label="Named views" anchor={() => boxOf(button.current)} owner={button} onClose={() => setOpen(false)} focusFirst>
          <NamedViewsList views={views} onGo={() => undefined} />
        </PlacedPopup>
      )}
    </>
  );
}

function NamedViewsList({ views, onGo }: { views: NamedView[]; onGo: (v: NamedView) => void }) {
  const doc = useStore((s) => s.history.present);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const save = () => {
    const api = viewportApi.current;
    if (!api) return;
    useStore.getState().saveNamedView(api.cameraState(), name);
    setName("");
  };
  const rename = () => {
    if (!renaming) return;
    if (!viewNameProblem(doc, renaming.id, renaming.text)) useStore.getState().renameNamedView(renaming.id, renaming.text);
    setRenaming(null);
  };
  const problem = renaming ? viewNameProblem(doc, renaming.id, renaming.text) : null;
  return (
    <div className="named-views">
      {views.length === 0 && <p className="view-tools-note">No views saved yet. Turn and zoom the model the way you like, then save it here.</p>}
      <ul className="named-view-list">
        {views.map((v) => (
          <li key={v.id}>
            {renaming?.id === v.id ? (
              <input
                autoFocus
                value={renaming.text}
                aria-label="New name"
                aria-invalid={!!problem}
                title={problem ?? "Enter to keep the new name, Esc to leave it"}
                onChange={(e) => setRenaming({ id: v.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                onBlur={rename}
              />
            ) : (
              <button
                className="menu-item"
                onClick={() => {
                  viewportApi.current?.goToCamera(v);
                  onGo(v);
                }}
                title="Look at the model this way"
              >
                {v.name}
              </button>
            )}
            <button className="icon-button" onClick={() => setRenaming({ id: v.id, text: v.name })} title={`Rename ${v.name}`} aria-label={`Rename ${v.name}`}>
              ✎
            </button>
            <button className="icon-button" onClick={() => useStore.getState().deleteNamedView(v.id)} title={`Delete ${v.name}`} aria-label={`Delete ${v.name}`}>
              <Icons.Trash size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div className="named-view-save">
        <input value={name} placeholder="Name (e.g. Front left)" aria-label="Name for this view" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <button className="primary-button" onClick={save} title="Save the way you're looking at the model now (a name already used is replaced)">
          Save this view
        </button>
      </div>
    </div>
  );
}

/** A choice of the named views for the Picture window: picking one turns the view to it. */
export function NamedViewChoice() {
  const views = useOwnViews();
  const [chosen, setChosen] = useState("");
  if (!views.length) return null;
  return (
    <>
      <span className="form-label">View</span>
      <select
        value={chosen}
        aria-label="View"
        onChange={(e) => {
          setChosen(e.target.value);
          const v = views.find((x) => x.id === e.target.value);
          if (v) viewportApi.current?.goToCamera(v, false);
        }}
      >
        <option value="">As it is now</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </>
  );
}

/** Select other: everything under the pointer; hovering a row lights it up, clicking picks it. */
export function SelectOtherMenu() {
  const open = useSelectOther();
  if (!open) return null;
  const close = () => {
    previewChoice(null);
    setSelectOther(null);
  };
  return (
    <PlacedPopup
      className="context-menu select-other"
      role="menu"
      label="Select other"
      anchor={() => ({ left: open.at.x, right: open.at.x, top: open.at.y, bottom: open.at.y })}
      onClose={close}
      focusFirst
    >
      <div className="select-other-title">Select other</div>
      {open.choices.map((c, i) => (
        <button
          key={i}
          className="menu-item"
          role="menuitem"
          onPointerEnter={() => previewChoice(c)}
          onFocus={() => previewChoice(c)}
          onPointerLeave={() => previewChoice(null)}
          onClick={(e) => {
            setSelectOther(null);
            pickChoice(c, additive(e.nativeEvent));
          }}
        >
          {open.labels[i]}
        </button>
      ))}
    </PlacedPopup>
  );
}

/** Before pasting features that use variables this design doesn't have: add them? */
export function PasteDialog() {
  const ask = useStore((s) => s.pasteAsk);
  if (!ask) return null;
  const close = () => useStore.getState().askPaste(null);
  const n = ask.missing.length;
  return (
    <Modal
      title="Paste features"
      onClose={close}
      footer={
        <>
          <button className="text-button" onClick={close}>
            Cancel
          </button>
          <button className="text-button" onClick={() => finishPaste(ask.clip, false)}>
            Paste without {n === 1 ? "it" : "them"}
          </button>
          <button className="primary-button" autoFocus onClick={() => finishPaste(ask.clip, true)}>
            Add {n === 1 ? "it" : "them"} and paste
          </button>
        </>
      }
    >
      <p>
        {n === 1 ? "These features use a variable" : "These features use variables"} this design doesn't have: <strong>{ask.missing.join(", ")}</strong>. Add{" "}
        {n === 1 ? "it" : "them"} with the {n === 1 ? "value it had" : "values they had"} where you copied from?
      </p>
    </Modal>
  );
}
