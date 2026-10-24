/**
 * Sketch panel sections for Text, Intersect, Insert DXF and pictures: the
 * settings for new text or the selected text, Intersect's "whole part"
 * choice, Insert DXF's scale and file button, and the selected picture's size
 * and see-through-ness.
 */
import { useEffect, useRef, useState } from "react";

import { evaluate } from "../model/expr";
import { useLengthUnit, useStore } from "../model/store";
import { lengthNumber, storeLength } from "../model/units";
import { FONT_LABELS, type FontName } from "../geometry/fonts";
import { changeImage, changeText, imageById, textById } from "../sketch/sketchText";
import type { SketchData, SketchText } from "../sketch/types";
import { insertDxfFile, pickFile } from "./sketchActions";

const NO_SELECTION: string[] = [];

/** A number typed in a box (a sum or variable too); lengths in the design's units. */
function readNumber(text: string, length: boolean, unit: ReturnType<typeof useLengthUnit>): number | null {
  const r = evaluate(length ? storeLength(text, unit) : text);
  return r.ok && Number.isFinite(r.value) ? r.value : null;
}

export function SketchExtrasPanel({ data }: { data: SketchData }) {
  const tool = useStore((s) => s.sketch?.tool ?? "select");
  const selection = useStore((s) => s.sketch?.selection ?? NO_SELECTION);
  const intersectWhole = useStore((s) => s.sketch?.intersectWhole ?? false);
  const dxfOpen = useStore((s) => s.sketch?.dxfOpen ?? false);
  const dxfScale = useStore((s) => s.sketch?.dxfScale ?? "1");
  const setSketchOptions = useStore((s) => s.setSketchOptions);
  const unit = useLengthUnit();

  const picked = selection.length === 1 ? textById(data, selection[0]) : undefined;
  const picture = selection.length === 1 ? imageById(data, selection[0]) : undefined;

  return (
    <>
      {(tool === "text" || picked) && <TextOptions data={data} text={picked} />}
      {tool === "intersect" && (
        <div className="pattern-options">
          <p className="dialog-hint">Click a face the sketch passes through (turn the view to see it from the side). Where the sketch cuts it comes in as dashed lines you can snap and dimension to; they follow the part if it changes.</p>
          <label className="check-row">
            <input type="checkbox" checked={intersectWhole} onChange={(e) => setSketchOptions({ intersectWhole: e.target.checked })} />
            Take the whole part, not just the face clicked
          </label>
        </div>
      )}
      {dxfOpen && (
        <div className="pattern-options">
          <strong>Insert DXF</strong>
          <label className="tool-option" title="1 = full size. The file's own units (inches, metres…) are taken into account when it says what they are.">
            Scale
            <input value={dxfScale} spellCheck={false} aria-label="DXF scale" onChange={(e) => setSketchOptions({ dxfScale: e.target.value })} />
            <span className="muted">×</span>
          </label>
          <p className="dialog-hint">Lines, arcs, circles, polylines, splines and ellipses come in as sketch shapes, with the drawing's origin on the sketch's.</p>
          <div className="tool-option">
            <button type="button" className="primary-button" onClick={() => pickFile(".dxf", (f) => void insertDxfFile(f).then(() => setSketchOptions({ dxfOpen: false })))}>
              Choose a DXF file…
            </button>
            <button type="button" className="text-button" onClick={() => setSketchOptions({ dxfOpen: false })}>
              Close
            </button>
          </div>
        </div>
      )}
      {picture && <PictureOptions data={data} id={picture.id} width={picture.width} opacity={picture.opacity} unit={unit} />}
    </>
  );
}

/** The settings for new text (Text tool), or the selected text's own. */
function TextOptions({ data, text }: { data: SketchData; text: SketchText | undefined }) {
  const unit = useLengthUnit();
  const session = useStore((s) => s.sketch);
  const focus = useStore((s) => s.sketch?.textFocus ?? 0);
  const setSketchOptions = useStore((s) => s.setSketchOptions);
  const valueBox = useRef<HTMLTextAreaElement>(null);
  /** The sketch before typing began in the words box (so the typing is one undo step). */
  const before = useRef<SketchData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = text
    ? { value: text.value, size: lengthNumber(text.size, unit), angle: String(text.angle), font: text.font, anchorAt: text.anchorAt ?? "start" }
    : { value: session?.textValue ?? "Text", size: session?.textSize ?? "10", angle: session?.textAngle ?? "0", font: session?.textFont ?? "regular", anchorAt: session?.textAnchorAt ?? "start" };
  const [size, setSize] = useState(shown.size);
  const [angle, setAngle] = useState(shown.angle);
  useEffect(() => setSize(shown.size), [shown.size]);
  useEffect(() => setAngle(shown.angle), [shown.angle]);
  useEffect(() => setError(null), [text?.id]);
  useEffect(() => {
    if (!focus || !valueBox.current) return;
    valueBox.current.focus();
    valueBox.current.select();
  }, [focus]);

  /** Change the selected text (one undo step), or the settings for new text. */
  const apply = (patch: Parameters<typeof changeText>[2], record = true) => {
    const st = useStore.getState();
    const current = st.editing?.draft.sketch?.data;
    if (!text || !current) return;
    const r = changeText(current, text.id, patch);
    if (r.error) {
      setError(r.error);
      return;
    }
    setError(null);
    st.updateSketch(r.sketch, { record });
  };
  const takeSize = () => {
    const v = readNumber(size, true, unit);
    if (v === null || !(v > 0)) return setError("The text size must be a number more than 0.");
    if (text) apply({ size: v });
    else setSketchOptions({ textSize: storeLength(size, unit) });
    setError(null);
  };
  const takeAngle = () => {
    const v = readNumber(angle, false, unit);
    if (v === null) return setError("The turn must be a number of degrees.");
    if (text) apply({ angle: v });
    else setSketchOptions({ textAngle: angle });
    setError(null);
  };

  return (
    <div className="pattern-options">
      <strong>{text ? "Text" : "New text"}</strong>
      <label className="tool-option" style={{ alignItems: "flex-start" }}>
        Words
        <textarea
          ref={valueBox}
          rows={2}
          value={shown.value}
          aria-label="Text words"
          spellCheck={false}
          onKeyDown={(e) => e.stopPropagation()}
          onFocus={() => (before.current = data)}
          onChange={(e) => {
            if (text) {
              // Blank text isn't kept; the box shows it until something is typed.
              if (!e.target.value.trim()) return setError("Type some text (or press Delete to take the text away).");
              apply({ value: e.target.value }, false);
            } else setSketchOptions({ textValue: e.target.value });
          }}
          onBlur={() => {
            if (before.current) useStore.getState().recordSketchStep(before.current);
            before.current = null;
          }}
        />
      </label>
      <label className="tool-option">
        Size
        <input value={size} spellCheck={false} aria-label="Text size" onChange={(e) => setSize(e.target.value)} onBlur={takeSize} onKeyDown={(e) => e.key === "Enter" && takeSize()} />
        <span className="muted">{unit}</span>
      </label>
      <label className="tool-option">
        Turn
        <input value={angle} spellCheck={false} aria-label="Text turn" onChange={(e) => setAngle(e.target.value)} onBlur={takeAngle} onKeyDown={(e) => e.key === "Enter" && takeAngle()} />
        <span className="muted">°</span>
      </label>
      <div className="tool-option">
        Font
        <div className="segmented two" role="group" aria-label="Font">
          {(Object.keys(FONT_LABELS) as FontName[]).map((f) => (
            <button key={f} type="button" className={shown.font === f ? "selected" : ""} aria-pressed={shown.font === f} onClick={() => (text ? apply({ font: f }) : setSketchOptions({ textFont: f }))}>
              {FONT_LABELS[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="tool-option">
        Its point
        <div className="segmented two" role="group" aria-label="Where the text's point is">
          {(
            [
              ["start", "Start", "The point is where the first line of text starts (bottom left)"],
              ["centre", "Middle", "The point is in the middle of the text"],
            ] as const
          ).map(([k, label, title]) => (
            <button key={k} type="button" title={title} className={shown.anchorAt === k ? "selected" : ""} aria-pressed={shown.anchorAt === k} onClick={() => (text ? apply({ anchorAt: k }) : setSketchOptions({ textAnchorAt: k }))}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="dialog-hint">
        {text
          ? "Drag the text to move it, or dimension and constrain its point like any point. Its letters are shapes to extrude, cut or emboss."
          : "Click in the sketch where the text goes (it snaps like a point). Press Enter in the box for a new line."}
      </p>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The selected picture's width and how solid it looks. */
function PictureOptions({ data, id, width, opacity, unit }: { data: SketchData; id: string; width: number; opacity: number; unit: ReturnType<typeof useLengthUnit> }) {
  const [text, setText] = useState(lengthNumber(width, unit));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(lengthNumber(width, unit)), [width, unit]);
  const change = (patch: Parameters<typeof changeImage>[2], record = true) => {
    const r = changeImage(useStore.getState().editing?.draft.sketch?.data ?? data, id, patch);
    if (r.error) return setError(r.error);
    setError(null);
    useStore.getState().updateSketch(r.sketch, { record });
  };
  const takeWidth = () => {
    const v = readNumber(text, true, unit);
    if (v === null || !(v > 0)) return setError("The width must be a number more than 0.");
    change({ width: v });
  };
  return (
    <div className="pattern-options">
      <strong>Picture</strong>
      <label className="tool-option">
        Width
        <input value={text} spellCheck={false} aria-label="Picture width" onChange={(e) => setText(e.target.value)} onBlur={takeWidth} onKeyDown={(e) => e.key === "Enter" && takeWidth()} />
        <span className="muted">{unit}</span>
      </label>
      <label className="tool-option">
        Solid
        <input type="range" min={0.05} max={1} step={0.05} value={opacity} aria-label="How solid the picture looks" onChange={(e) => change({ opacity: Number(e.target.value) }, false)} />
        <span className="muted">{Math.round(opacity * 100)}%</span>
      </label>
      <p className="dialog-hint">Drag the picture to move it. To trace it, draw over it with Line, Arc and Spline. Delete takes it away.</p>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
