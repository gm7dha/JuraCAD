import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { additive } from "../viewport/touchKeys";

import { evaluate } from "../model/expr";
import { lengthNumber, showLength, storeLength, type LengthUnit } from "../model/units";
import { nextOffered, useLengthUnit, useStore } from "../model/store";
import { badgeAnchors, dimensionLayout, RELATION_SYMBOLS } from "../sketch/layout";
import { measure, moveDimensionLabel, setDimensionValue } from "../sketch/ops";
import { linkedPoints } from "../sketch/links";
import { isAngleDimension, isDimension, type SketchConstraint, type SketchData } from "../sketch/types";
import { sketchStatus, viewportApi } from "../viewport/Viewport";
import { resolveVariables, type Variable } from "../model/variables";
import { completeWith, suggestionsAt } from "../model/varComplete";
import { expressionText, tiedIds } from "../sketch/sketchView";
import { canSwitchRound } from "../sketch/dimensionKinds";
import { setSketchLit, useSketchView } from "./sketchViewState";
import { openSketchMenuOn, switchSketchRoundDimension } from "./sketchMenuActions";
import { sketchEscape } from "./sketchActions";
import { noteTyped, offeredBoxKey } from "../sketch/offeredBox";

const RELATION_NAMES: Partial<Record<SketchConstraint["type"], string>> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  tangent: "Tangent",
  concentric: "Concentric",
  midpoint: "Midpoint",
  pointOnLine: "Point on line",
  pointOnCircle: "Point on circle",
  pointOnCurve: "Point on curve",
  fix: "Fixed",
  patternCopy: "Pattern copy",
  patternMove: "Pattern copy",
  normal: "Normal",
  curvature: "Curvature",
};

/** Text shown on a dimension label. A reference (driven) dimension shows the size as it is now, in brackets. */
function dimensionText(c: SketchConstraint, unit: LengthUnit, data?: SketchData, expressions = false): string {
  // Show expressions: what was typed (a variable or a sum) rather than its number.
  const typed = expressions ? expressionText(c) : null;
  if (typed !== null) {
    const shown = c.type === "diameter" || (c.doubled && c.type !== "offset") ? `⌀${typed}` : c.type === "radius" ? `R${typed}` : isAngleDimension(c) ? `${typed}°` : c.type === "arcLength" ? `⌒${typed}` : typed;
    return shown;
  }
  let value: number | null = null;
  if (c.driven && data) {
    try {
      value = measure(data, c);
    } catch {
      value = null;
    }
  } else {
    const r = evaluate(c.value ?? "");
    if (r.ok) value = r.value;
  }
  const shown = value === null ? c.value ?? "?" : isAngleDimension(c) ? String(Math.round(value * 100) / 100) : lengthNumber(value, unit);
  // An arc's length gets the arc sign (⌒) in front, like a drawing.
  const text = c.type === "diameter" || (c.doubled && c.type !== "offset") ? `⌀${shown}` : c.type === "radius" ? `R${shown}` : isAngleDimension(c) ? `${shown}°` : c.type === "arcLength" ? `⌒${shown}` : shown;
  return c.driven ? `(${text})` : text;
}

/** Shared empty list: a selector must not return a new array each time, or React re-renders forever. */
const NO_SELECTION: string[] = [];
const NO_VARIABLES: Variable[] = [];

interface Placement {
  id: string;
  /** Sketch position the element sits at. */
  at: [number, number];
  /** Extra screen-pixel nudge (to spread badges sharing a spot). */
  dx: number;
  dy: number;
}

/**
 * Dimension values and constraint badges drawn over the 3D view while a
 * sketch is open. Their positions follow the camera every frame.
 */
export function SketchOverlay() {
  const data = useStore((s) => (s.editing?.draft.type === "sketch" && s.editing.draft.sketch?.plane ? s.editing.draft.sketch.data : null));
  const selection = useStore((s) => s.sketch?.selection ?? NO_SELECTION);
  const editingDimension = useStore((s) => s.sketch?.editingDimension ?? null);
  // Move / copy's handles are drawn on the picked shapes: the labels let presses through to them (the ring runs
  // right past a small shape's size labels).
  const handlesOn = useStore((s) => s.sketch?.tool === "sketchTransform" && (s.sketch?.selection.length ?? 0) > 0);
  const view = useSketchView();
  // Nothing stays lit once the sketch closes.
  useEffect(() => () => setSketchLit(null), []);
  const elements = useRef(new Map<string, HTMLElement>());
  const placements = useRef<Placement[]>([]);
  // What's being inferred while drawing (H, V, ∥, ⊥, T…), shown by the pointer: read from the sketch tools each frame.
  const inferenceEl = useRef<HTMLSpanElement | null>(null);

  const layout = useMemo(() => (data ? computePlacements(data) : { dims: [], badges: [] }), [data]);
  placements.current = [...layout.dims.map((d) => d.placement), ...layout.badges.map((b) => b.placement)];

  // Reposition every frame (camera may be moving).
  useEffect(() => {
    let off: (() => void) | undefined;
    let raf = 0;
    const attach = () => {
      const manager = viewportApi.current;
      if (!manager) {
        raf = requestAnimationFrame(attach);
        return;
      }
      off = manager.addFrameListener(() => {
        for (const p of placements.current) {
          const el = elements.current.get(p.id);
          if (!el) continue;
          const s = manager.projectSketchPoint(p.at[0], p.at[1]);
          if (!s) continue;
          el.style.transform = `translate(${Math.round(s.x + p.dx)}px, ${Math.round(s.y + p.dy)}px) translate(-50%, -50%)`;
        }
        const badge = inferenceEl.current;
        if (badge) {
          const inf = viewportApi.sketch?.current.inference ?? null;
          const at = inf ? manager.projectSketchPoint(inf.at[0], inf.at[1]) : null;
          if (!inf || !at) badge.style.display = "none";
          else {
            if (badge.textContent !== inf.text) badge.textContent = inf.text;
            badge.style.display = "";
            badge.style.transform = `translate(${Math.round(at.x + 16)}px, ${Math.round(at.y + 16)}px) translate(-50%, -50%)`;
          }
        }
      });
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
  }, []);

  if (!data) return null;
  const failing = sketchStatus(data).failing;
  const ref = (id: string) => (el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  };

  return (
    <div className={`sketch-overlay${handlesOn ? " handles-on" : ""}`} aria-label="Sketch dimensions and constraints">
      {layout.dims.map(({ constraint: c, placement }) =>
        // Show dimensions off: hidden, except one that's picked or being typed into.
        !view.dimensions && !selection.includes(c.id) && editingDimension !== c.id ? null : (
        <DimensionLabel
          key={c.id}
          c={c}
          refCb={ref(placement.id)}
          selected={selection.includes(c.id)}
          failing={failing.has(c.id)}
          editing={editingDimension === c.id}
          expressions={view.expressions}
          data={data}
        />
      ))}
      {layout.badges.map(({ constraint: c, placement }) =>
        !view.constraints && !selection.includes(c.id) ? null : (
        <button
          key={placement.id}
          ref={ref(placement.id)}
          className={`constraint-badge${selection.includes(c.id) ? " selected" : ""}${failing.has(c.id) ? " failing" : ""}`}
          title={`${RELATION_NAMES[c.type] ?? c.type} — click to select, then Delete to remove`}
          aria-label={RELATION_NAMES[c.type] ?? c.type}
          onPointerDown={(e) => {
            e.stopPropagation();
            pressedOn(e);
          }}
          onContextMenu={(e) => menuOn(e, c.id)}
          onPointerEnter={() => setSketchLit(tiedIds(data, c.id))}
          onPointerLeave={() => setSketchLit(null)}
          onClick={(e) => toggleSelect(c.id, additive(e))}
        >
          {RELATION_SYMBOLS[c.type]}
        </button>
      ))}
      <span ref={inferenceEl} className="constraint-badge inference-badge" style={{ display: "none" }} aria-hidden="true" />
    </div>
  );
}

/** The last press on a badge or a dimension's number (where, and on which), so a right-click there can be told from a drag. */
let pressed: { on: EventTarget; x: number; y: number } | null = null;
/** How far (px) the pointer may move between a right button's press and its menu (as in the 3D view). */
const MENU_SLOP = 5;

function pressedOn(e: { currentTarget: EventTarget; clientX: number; clientY: number }) {
  pressed = { on: e.currentTarget, x: e.clientX, y: e.clientY };
}

/**
 * Right-click (or a long press) on a badge or a dimension's number: the sketch's menu, with it picked. Not after a
 * drag (the view turned with the right button, or a press that started somewhere else and let go here). A long press's
 * made-up right-click (touchCompat) always counts. False = no menu.
 */
function menuOn(e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number; currentTarget: EventTarget; nativeEvent: Event }, id: string): boolean {
  e.preventDefault();
  e.stopPropagation();
  const still = !e.nativeEvent.isTrusted || (!!pressed && pressed.on === e.currentTarget && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) <= MENU_SLOP);
  pressed = null;
  if (!still) return false;
  return openSketchMenuOn(id, { x: e.clientX, y: e.clientY });
}

function toggleSelect(id: string, additive: boolean) {
  const s = useStore.getState();
  const sel = s.sketch?.selection ?? [];
  if (additive) s.setSketchSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  else s.setSketchSelection(sel.length === 1 && sel[0] === id ? [] : [id]);
}

function computePlacements(data: SketchData) {
  const dims: { constraint: SketchConstraint; placement: Placement }[] = [];
  const badges: { constraint: SketchConstraint; placement: Placement }[] = [];
  const spots = new Map<string, number>();
  // Part edges in the sketch are held where their edge is: that's not shown as anchors on each of their points.
  const linked = linkedPoints(data);
  for (const c of data.constraints) {
    if (isDimension(c)) {
      const l = dimensionLayout(data, c);
      if (l) dims.push({ constraint: c, placement: { id: c.id, at: l.label, dx: 0, dy: 0 } });
      continue;
    }
    if (c.type === "coincident" || c.type === "pointOnLine" || c.type === "pointOnCircle" || c.type === "pointOnCurve") continue; // too cluttered; shown as joined points
    if (c.type === "patternCopy" || c.type === "patternMove" || (c.type === "fix" && linked.has(c.refs[0]))) continue;
    badgeAnchors(data, c).forEach((at, i) => {
      const key = `${Math.round(at[0] * 100)},${Math.round(at[1] * 100)}`;
      const n = spots.get(key) ?? 0;
      spots.set(key, n + 1);
      badges.push({ constraint: c, placement: { id: `${c.id}:${i}`, at, dx: 14 + n * 18, dy: -14 } });
    });
  }
  return { dims, badges };
}

function DimensionLabel({
  c,
  refCb,
  selected,
  failing,
  editing,
  expressions,
  data: sketch,
}: {
  c: SketchConstraint;
  refCb: (el: HTMLElement | null) => void;
  selected: boolean;
  failing: boolean;
  editing: boolean;
  /** Show what was typed (variables, sums) instead of the number. */
  expressions: boolean;
  /** The sketch it's in (for what it ties, to light up on hover). */
  data: SketchData;
}) {
  const unit = useLengthUnit();
  // A reference dimension shows the size the sketch has now.
  const data = useStore((s) => (c.driven ? s.editing?.draft.sketch?.data ?? null : null));
  // Lengths are shown and typed in the design's units (see units.ts); angles in degrees.
  const shownValue = isAngleDimension(c) ? c.value ?? "" : showLength(c.value ?? "", unit);
  const [text, setText] = useState(shownValue);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ startData: SketchData; moved: boolean; x: number; y: number } | null>(null);
  // Variable names offered while typing (Onshape's autocomplete): the design's variables matching the word at the cursor.
  const variables = useStore((s) => (editing ? s.history.present.variables ?? NO_VARIABLES : NO_VARIABLES));
  const values = useMemo(() => resolveVariables(variables).values, [variables]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  // Tab moved on to the next offered size: this box going away isn't the user leaving it (which drops what's offered).
  const tabbing = useRef(false);
  // (Nothing offered until something is typed.)
  const [hideHints, setHideHints] = useState(true);
  const input = useRef<HTMLInputElement | null>(null);
  const hints = useMemo(() => (editing && !hideHints ? suggestionsAt(text, caret, variables.map((v) => v.name)) : { word: null, names: [] as string[] }), [editing, hideHints, text, caret, variables]);
  const choose = (name: string) => {
    if (!hints.word) return;
    const next = completeWith(text, hints.word, name);
    setText(next.text);
    setCaret(next.caret);
    setPick(0);
    // Chosen: the list goes until something more is typed, so Enter then sets the size.
    setHideHints(true);
    setError(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  useEffect(() => {
    if (editing) {
      tabbing.current = false;
      typed.current = false;
      engaged.current = false;
      setText(shownValue);
      setError(null);
      setHideHints(true);
    }
  }, [editing, shownValue]);

  // A size offered just after drawing (Enter keeps it, Esc drops it).
  const offered = () => useStore.getState().sketch?.provisional.includes(c.id) ?? false;
  // Something typed since the box opened: Tab or Enter then keeps the size, even the one it already had.
  const typed = useRef(false);
  // Clicked or tapped since it opened: every key is then the box's own (no tool keys), so a function can be typed.
  const engaged = useRef(false);
  // What's typed, for drawing on to keep (offeredBox.ts noteTyped); forgotten when the box closes.
  useEffect(() => (editing ? () => noteTyped(c.id, null) : undefined), [editing, c.id]);
  /** `close`: Enter — the sizes offered but not kept go too (Onshape's Enter ends the offering). */
  const done = (close: boolean) => {
    const s = useStore.getState();
    if (offered()) s.keepOfferedDimension(c.id, close);
    else s.setEditingDimension(null);
  };
  /** Set the typed size (true when it was taken, or nothing changed). */
  const apply = (close: boolean): boolean => {
    const s = useStore.getState();
    const current = s.editing?.draft.sketch?.data;
    if (!current) return false;
    // (Read from the sketch as it is now: drawing on may have just set the typed size, or dropped the dimension.)
    const now = current.constraints.find((x) => x.id === c.id);
    if (!now) {
      done(close);
      return true;
    }
    const nowShown = isAngleDimension(now) ? now.value ?? "" : showLength(now.value ?? "", unit);
    if (text.trim() === nowShown.trim()) {
      done(close);
      return true;
    }
    const r = setDimensionValue(current, c.id, isAngleDimension(c) ? text.trim() : storeLength(text.trim(), unit));
    if (r.error) {
      setError(r.error);
      return false;
    }
    s.updateSketch(r.sketch, { record: true });
    done(close);
    return true;
  };

  if (editing && !c.driven) {
    return (
      <div ref={refCb} className="dimension-editor">
        <input
          ref={input}
          autoFocus
          value={text}
          aria-label="Dimension value"
          aria-invalid={!!error}
          aria-autocomplete="list"
          onChange={(e) => {
            typed.current = true;
            setText(e.target.value);
            if (offered()) noteTyped(c.id, isAngleDimension(c) ? e.target.value.trim() : storeLength(e.target.value.trim(), unit));
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setPick(0);
            setHideHints(false);
            setError(null);
          }}
          onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onFocus={(e) => {
            tabbing.current = false;
            e.target.select();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            const listed = hints.names;
            if (listed.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setPick((i) => (i + (e.key === "ArrowDown" ? 1 : listed.length - 1)) % listed.length);
              return;
            }
            const highlighted = listed[Math.min(pick, listed.length - 1)];
            // Enter on a name that's already typed in full (w, with width also offered) sets the size.
            if (listed.length && (e.key === "Tab" || (e.key === "Enter" && highlighted !== hints.word?.word))) {
              e.preventDefault();
              choose(highlighted);
              return;
            }
            if (listed.length && e.key === "Escape") {
              setHideHints(true);
              return;
            }
            // Tab / Shift+Tab, Enter, Esc and tool keys in an offered size's box: src/sketch/offeredBox.ts.
            const provisional = useStore.getState().sketch?.provisional ?? [];
            const target = offered() ? nextOffered(provisional, c.id, e.shiftKey) : null;
            const act = offeredBoxKey(
              { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
              { offered: offered(), typed: typed.current, hasNext: !!target, engaged: engaged.current },
              variables.map((v) => v.name),
            );
            if (act === "shortcut") {
              // Nothing typed yet: the letter is a tool's key (L, C, R…). Leaving the box drops the size offered.
              e.preventDefault();
              const { key, code, shiftKey } = e;
              input.current?.blur();
              document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, shiftKey, bubbles: true, cancelable: true }));
              return;
            }
            if (act === "stay") {
              e.preventDefault();
              return;
            }
            if (act === "skipNext") {
              e.preventDefault();
              tabbing.current = true;
              useStore.getState().nextOfferedDimension(c.id, e.shiftKey);
              return;
            }
            if (act === "keepNext") {
              e.preventDefault();
              tabbing.current = true;
              if (!apply(false)) {
                tabbing.current = false;
                return;
              }
              // Kept: go on to the one chosen (Shift+Tab: the one before), if it's still offered.
              if (target && useStore.getState().sketch?.provisional.includes(target)) useStore.getState().setEditingDimension(target);
              return;
            }
            if (act === "keepClose") {
              if (e.key === "Tab") e.preventDefault();
              apply(true);
              return;
            }
            // Esc in an offered size's box: as Esc anywhere else in the sketch — the sizes offered go, and so does a chain of lines.
            if (act === "escape") sketchEscape();
            if (act === "cancel") useStore.getState().setEditingDimension(null);
          }}
          onPointerDown={() => {
            engaged.current = true;
          }}
          onBlur={() => {
            if (tabbing.current) return;
            // Leaving an offered size without typing anything drops it.
            if (offered() && !typed.current) useStore.getState().discardOfferedDimensions();
            else if (!error) apply(false);
          }}
        />
        <span className="unit">{isAngleDimension(c) ? "°" : unit}</span>
        {canSwitchRound(sketch, c) && (
          <button
            type="button"
            className="dimension-switch"
            title={c.type === "diameter" ? "Show it as a radius instead (the circle stays the same size)" : "Show it as a diameter instead (the circle stays the same size)"}
            aria-label={c.type === "diameter" ? "Show as a radius" : "Show as a diameter"}
            // Keep the focus in the box (a blur would apply what's typed so far).
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => switchSketchRoundDimension(c.id)}
          >
            {c.type === "diameter" ? "R" : "⌀"}
          </button>
        )}
        {error && <div className="dimension-error">{error}</div>}
        {!error && hints.names.length > 0 && (
          <div className="dimension-suggest" role="listbox" aria-label="Variables">
            {hints.names.map((name, i) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={i === Math.min(pick, hints.names.length - 1)}
                className={i === Math.min(pick, hints.names.length - 1) ? "picked" : ""}
                // Keep the focus in the box (a blur would apply what's typed so far).
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(name)}
              >
                <span className="name">{name}</span>
                {name in values && <span className="value">{isAngleDimension(c) ? String(Math.round(values[name] * 1000) / 1000) : `${lengthNumber(values[name], unit)} ${unit}`}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Click: select. Double-click: edit. Drag: move the label.
  const onPointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    pressedOn(e);
    // (Only the main button picks or drags; a right-click opens the menu, below.)
    if (e.button !== 0) return;
    const s = useStore.getState();
    const start = s.editing?.draft.sketch?.data;
    if (!start) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startData: start, moved: false, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const manager = viewportApi.current;
    if (!d || !manager) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
    d.moved = true;
    const host = document.querySelector(".viewport")?.getBoundingClientRect();
    if (!host) return;
    const p = manager.unprojectToSketch(e.clientX - host.left, e.clientY - host.top);
    const layout = dimensionLayout(d.startData, { ...c, labelOffset: { x: 0, y: 0 } });
    if (!p || !layout) return;
    const next = moveDimensionLabel(d.startData, c.id, { x: p.x - layout.anchor[0], y: p.y - layout.anchor[1] });
    useStore.getState().updateSketch(next, { record: false });
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) useStore.getState().recordSketchStep(d.startData);
    else toggleSelect(c.id, additive(e));
  };

  return (
    <div
      ref={refCb}
      className={`dimension-label${selected ? " selected" : ""}${failing ? " failing" : ""}${c.driven ? " driven" : ""}`}
      title={c.driven ? "Just shows the size (it doesn't set it). Drag to move; select it and click \"Let it set the size\" in the sketch panel to change that" : "Double-click to change, drag to move"}
      role="button"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={() => setSketchLit(tiedIds(sketch, c.id))}
      onPointerLeave={() => setSketchLit(null)}
      onContextMenu={(e) => {
        // The menu takes over from this press: letting go mustn't then pick or unpick it (a long press, Ctrl+click on a Mac).
        const d = drag.current;
        if (!menuOn(e, c.id)) return;
        drag.current = null;
        if (d?.moved) useStore.getState().recordSketchStep(d.startData);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (c.driven) {
          useStore.getState().setSketchMessage("That dimension (in brackets) just shows the size. Select it and click \"Let it set the size\" in the sketch panel to type a new size.", "info");
          return;
        }
        useStore.getState().setEditingDimension(c.id);
      }}
    >
      {dimensionText(c, unit, data ?? undefined, expressions)}
    </div>
  );
}
