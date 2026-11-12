/**
 * The drawing panel's newer parts: the drawing standard (ISO / ANSI) and how
 * numbers read, the title block's own entries, templates kept in this
 * browser, cropped views, and putting a table from a CSV file on the sheet.
 * The logic is pure in src/drawing (crop.ts, templates.ts, tables.ts).
 */
import { useEffect, useState } from "react";
import { setStandard, usualThird, withoutFit } from "../drawing/drawing";
import { changePage } from "../drawing/pages";
import { isRectCrop, withoutCrop } from "../drawing/crop";
import { CsvError, MAX_CSV_CHARS, parseCsv } from "../drawing/tables";
import { applyTemplate, putTemplate, templateFrom, type DrawingTemplate } from "../drawing/templates";
import { defaultTemplateId, loadTemplates, saveTemplates, setDefaultTemplateId } from "../drawing/templateStorage";
import { MAX_TITLE_FIELDS, SHEETS } from "../drawing/sheet";
import { viewKey } from "../drawing/sections";
import { newId } from "../model/document";
import { useStore } from "../model/store";
import type { Drawing, TitleField, ViewKind } from "../model/types";
import { Icons } from "./icons";
import { pickFile } from "./sketchActions";

type Change = (fn: (d: Drawing) => Drawing) => void;

/** Drawing standard (part "standard") or the decimal comma and inspection balloons (part "numbers"). */
export function DrawingStyleFields({ drawing, change, part }: { drawing: Drawing; change: Change; part: "standard" | "numbers" }) {
  if (part === "standard") {
    const ansi = drawing.standard === "ansi";
    return (
      <div className="drawing-field">
        <span className="field-label">Drawing standard</span>
        <div className="segmented two" role="radiogroup" aria-label="Drawing standard">
          {(
            [
              ["iso", "ISO", "ISO (UK, Europe, most of the world): first-angle views, dimension numbers along their lines"],
              ["ansi", "ANSI (US)", "ANSI (US): third-angle views, dimension numbers always read across the sheet"],
            ] as const
          ).map(([key, label, tip]) => (
            <button
              type="button"
              key={key}
              role="radio"
              title={tip}
              aria-checked={ansi === (key === "ansi")}
              className={ansi === (key === "ansi") ? "selected" : ""}
              onClick={() => {
                if (ansi !== (key === "ansi")) change((d) => setStandard(d, key));
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {usualThird(drawing.standard) !== (drawing.projection === "third") && (
          <p className="panel-hint">{ansi ? "ANSI drawings usually have their views arranged third angle" : "ISO drawings usually have their views arranged first angle"} — you can change that under "Views arranged".</p>
        )}
      </div>
    );
  }
  const flag = (key: "decimalComma" | "inspection", on: boolean) =>
    change((d) => {
      const { [key]: _old, ...rest } = d;
      return on ? { ...rest, [key]: true } : (rest as Drawing);
    });
  return (
    <>
      <label className="check-row" title="Write 12,5 instead of 12.5, as much of Europe does">
        <input type="checkbox" checked={!!drawing.decimalComma} onChange={(e) => flag("decimalComma", e.target.checked)} />
        Decimal comma (12,5)
      </label>
      <label className="check-row" title="Number every dimension in a small balloon, so a checking report can list what was measured">
        <input type="checkbox" checked={!!drawing.inspection} onChange={(e) => flag("inspection", e.target.checked)} />
        Inspection balloons (number each dimension)
      </label>
    </>
  );
}

const SUGGESTED = ["Finish", "Checked by", "Approved by", "Tolerance", "Weight", "Customer", "Project"];

/** The user's own title block entries: a label and a value each, in a row on top of the title block. */
export function TitleFieldsEditor({ drawing, change }: { drawing: Drawing; change: Change }) {
  const fields = drawing.fields ?? [];
  const put = (list: TitleField[]) =>
    change((d) => {
      const { fields: _old, ...rest } = d;
      return list.length ? { ...rest, fields: list } : rest;
    });
  const unused = SUGGESTED.filter((l) => !fields.some((f) => f.label.toLowerCase() === l.toLowerCase()));
  return (
    <div className="drawing-fields">
      <span className="field-label">Your own entries</span>
      {fields.length === 0 && <p className="panel-hint">Add entries such as Finish or Checked by: they go in a row on top of the title block.</p>}
      <ul className="revision-list">
        {fields.map((f, i) => (
          <FieldRow key={i} field={f} onChange={(next) => put(fields.map((x, j) => (j === i ? next : x)))} onRemove={() => put(fields.filter((_, j) => j !== i))} />
        ))}
      </ul>
      {fields.length < MAX_TITLE_FIELDS && (
        <select
          aria-label="Add a title block entry"
          value=""
          onChange={(e) => {
            const label = e.target.value === "other" ? "Entry" : e.target.value;
            if (label) put([...fields, { label, value: "" }]);
          }}
        >
          <option value="">+ Add an entry…</option>
          {unused.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
          <option value="other">Something else</option>
        </select>
      )}
    </div>
  );
}

function FieldRow({ field, onChange, onRemove }: { field: TitleField; onChange: (f: TitleField) => void; onRemove: () => void }) {
  const [label, setLabel] = useState(field.label);
  const [value, setValue] = useState(field.value);
  useEffect(() => setLabel(field.label), [field.label]);
  useEffect(() => setValue(field.value), [field.value]);
  const commit = () => {
    const l = label.trim().slice(0, 30);
    if (!l) return setLabel(field.label);
    if (l !== field.label || value !== field.value) onChange({ label: l, value: value.slice(0, 80) });
  };
  return (
    <li className="revision-row">
      <input className="revision-date" value={label} aria-label="Entry name" onChange={(e) => setLabel(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <input value={value} aria-label={`${field.label}`} placeholder="Value" onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <button type="button" className="icon-button small" onClick={onRemove} aria-label={`Remove ${field.label}`} title="Remove">
        <Icons.Cross size={14} />
      </button>
    </li>
  );
}

/** Templates kept in this browser: save this drawing's sheet and title block as one, use one, choose one for new drawings. */
export function TemplatesSection({ drawing, pageId }: { drawing: Drawing; pageId: string }) {
  const [list, setList] = useState<DrawingTemplate[]>(() => loadTemplates());
  const [chosen, setChosen] = useState<string | null>(() => defaultTemplateId());
  const [name, setName] = useState("");
  const toast = (text: string, kind: "success" | "error" | "info" = "success") => useStore.getState().showToast(text, kind);
  const keep = (next: DrawingTemplate[]) => {
    setList(next);
    if (!saveTemplates(next)) toast("This browser won't keep templates (a private window?), so it's only here until you close the page.", "info");
  };
  const save = () => {
    const t = templateFrom(drawing, newId("tp"), name);
    keep(putTemplate(list, t));
    setName("");
    toast(`Saved the template "${t.name}": the paper, standard and title block entries (not the title or part number).`);
  };
  return (
    <section className="panel-section">
      <h3>Templates</h3>
      <p className="panel-hint">Keep this drawing's paper size, standard and title block (company, drawn by, your own entries) to use again. Templates are kept in this browser.</p>
      <div className="revision-row">
        <input value={name} placeholder="Template name" aria-label="Template name" onChange={(e) => setName(e.target.value.slice(0, 60))} onKeyDown={(e) => e.key === "Enter" && save()} />
        <button type="button" className="text-button small-text" onClick={save}>
          Save as template
        </button>
      </div>
      {list.length > 0 && (
        <ul className="revision-list">
          {list.map((t) => (
            <li key={t.id} className="revision-row">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={`${t.name}: ${t.sheet}${t.standard === "ansi" ? ", ANSI" : ", ISO"}`}>
                {t.name}
              </span>
              <button type="button" className="text-button small-text" onClick={() =>
                  // (The paper size goes on the sheet on show; the rest is the whole drawing's, every sheet's views re-placed if the projection changes.)
                  useStore.getState().changeDrawing((w) => changePage({ ...applyTemplate(w, t), sheet: w.sheet }, pageId, (p) => (p.sheet === t.sheet ? p : withoutFit({ ...p, sheet: t.sheet }))))
                } title="Put this template's paper, standard and title block on this drawing">
                Use
              </button>
              <label className="check-row" title="New drawings start from this template">
                <input
                  type="checkbox"
                  checked={chosen === t.id}
                  onChange={(e) => {
                    const id = e.target.checked ? t.id : null;
                    setDefaultTemplateId(id);
                    setChosen(id);
                  }}
                />
                New drawings
              </label>
              <button
                type="button"
                className="icon-button small"
                aria-label={`Delete template ${t.name}`}
                title="Delete"
                onClick={() => {
                  keep(list.filter((x) => x.id !== t.id));
                  if (chosen === t.id) {
                    setDefaultTemplateId(null);
                    setChosen(null);
                  }
                }}
              >
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The cropped views: smooth a clicked outline, or take a crop off. */
export function CropsList({ drawing, change, name }: { drawing: Drawing; change: Change; name: (key: string, kind: ViewKind) => string }) {
  const cropped = drawing.views.filter((v) => v.crop);
  if (!cropped.length) return null;
  const edit = (id: string, fn: (v: Drawing["views"][number]) => Drawing["views"][number]) => change((d) => ({ ...d, views: d.views.map((v) => (v.id === id ? fn(v) : v)) }));
  return (
    <section className="panel-section">
      <h3>Cropped views</h3>
      <ul className="revision-list">
        {cropped.map((v) => {
          const c = v.crop!;
          return (
            <li key={v.id} className="revision-row">
              <span style={{ flex: 1 }}>
                {name(viewKey(v), v.kind)} — {isRectCrop(c) ? "rectangle" : "shape"}
              </span>
              {!isRectCrop(c) && (
                <label className="check-row" title="A smooth curve through the clicked points">
                  <input type="checkbox" checked={!!c.smooth} onChange={(e) => edit(v.id, (x) => ({ ...x, crop: e.target.checked ? { points: c.points, smooth: true } : { points: c.points } }))} />
                  Smooth
                </label>
              )}
              <button type="button" className="text-button small-text" onClick={() => edit(v.id, withoutCrop)} title="Show the whole view again">
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Table from CSV: pick a file and put it near the sheet's top-left corner (one undo step). */
export function pickCsvTable(changeShownPage: (fn: (d: Drawing) => Drawing) => void) {
  pickFile(".csv,text/csv,text/plain", (file) => {
    // (Checked before reading, so a huge file isn't loaded at all.)
    if (file.size > MAX_CSV_CHARS * 4) {
      useStore.getState().showToast("That file is too big for a drawing table.", "error");
      return;
    }
    void file.text().then(
      (text) => {
        const s = useStore.getState();
        let rows: string[][];
        try {
          rows = parseCsv(text);
        } catch (e) {
          s.showToast(e instanceof CsvError ? e.message : "That file couldn't be read as a table.", "error");
          return;
        }
        changeShownPage((d) => {
          const [, H] = SHEETS[d.sheet];
          return { ...d, notes: [...(d.notes ?? []), { id: newId("nt"), at: [20, H - 20] as [number, number], text: "", table: rows }] };
        });
        s.showToast(`Put a table of ${rows.length} row${rows.length === 1 ? "" : "s"} on the sheet. Drag it to move it; Delete removes it.`, "success");
      },
      () => useStore.getState().showToast("That file couldn't be read.", "error"),
    );
  });
}
