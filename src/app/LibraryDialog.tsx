import { useMemo, useState } from "react";

import { useDocument, useStore } from "../model/store";
import { currentValues, defaultValues, designGroups, findDesign, type DesignGroup, findInsert, LIBRARY_CATEGORIES, liveInserts, valueProblems } from "../library/insert";
import { rememberedTab, rememberTab } from "../library/tabMemory";
import { searchDesigns } from "../library/browse";
import { previewPicture } from "../library/preview";
import type { DesignCategory, DesignInput, DesignValues, LibraryDesign } from "../library/types";
import { Modal } from "./Modal";

/** A design's small drawing (the icons are fixed drawings written in the code, never user data). */
function DesignIcon({ design, size = 44 }: { design: LibraryDesign; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: design.icon }}
    />
  );
}

function Preview({ design, values, ok }: { design: LibraryDesign; values: DesignValues; ok: boolean }) {
  const pic = useMemo(() => (ok ? previewPicture(design.preview(values)) : null), [design, values, ok]);
  if (!pic) return <div className="library-preview empty muted small">The preview shows once the sizes work.</div>;
  return (
    <svg className="library-preview" viewBox={pic.viewBox} role="img" aria-label={`Preview of the ${design.name.toLowerCase()}`}>
      {pic.shapes.map((s, i) =>
        s.kind === "poly" ? (
          s.closed ? (
            <polygon key={i} points={s.points.map((p) => p.join(",")).join(" ")} className={s.faint ? "faint" : ""} strokeWidth={pic.stroke} />
          ) : (
            <polyline key={i} points={s.points.map((p) => p.join(",")).join(" ")} className={s.faint ? "faint" : ""} strokeWidth={pic.stroke} />
          )
        ) : s.kind === "circle" ? (
          <circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.r} className={s.faint ? "faint" : ""} strokeWidth={pic.stroke} />
        ) : (
          <text key={i} x={s.at[0]} y={s.at[1]} fontSize={pic.font} textAnchor="middle" dominantBaseline="middle">
            {s.text}
          </text>
        ),
      )}
    </svg>
  );
}

/** One design's card in the library window. */
function DesignCard({ design, onPick }: { design: LibraryDesign; onPick: (id: string) => void }) {
  return (
    <button className="library-card" onClick={() => onPick(design.id)} aria-label={`${design.name}: ${design.description}`}>
      <DesignIcon design={design} />
      <span className="library-card-text">
        <b>{design.name}</b>
        <span className="muted small">{design.description}</span>
      </span>
    </button>
  );
}

/** Designs under their headings (none for designs without a group, which come first). */
function GroupedCards({ groups, onPick }: { groups: DesignGroup[]; onPick: (id: string) => void }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.group ?? ""}>
          {g.group && <h4 className="library-group">{g.group}</h4>}
          <div className="library-grid">
            {g.designs.map((d) => (
              <DesignCard key={d.id} design={d} onPick={onPick} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Numbers are kept as typed (so "1." or "" can be on the way to something) and read when used. */
type Typed = Record<string, string | boolean>;

const typedFrom = (design: LibraryDesign, values: DesignValues): Typed =>
  Object.fromEntries(design.inputs.map((i) => [i.key, typeof values[i.key] === "boolean" ? (values[i.key] as boolean) : String(values[i.key])]));

function valuesFrom(design: LibraryDesign, typed: Typed): DesignValues {
  return Object.fromEntries(
    design.inputs.map((i) => {
      const t = typed[i.key];
      if (i.kind === "toggle") return [i.key, t === true];
      if (i.kind === "choice" || i.kind === "text") return [i.key, String(t)];
      const n = typeof t === "string" && t.trim() ? Number(t) : NaN;
      return [i.key, n];
    }),
  );
}

function InputRow({ input, value, onChange }: { input: DesignInput; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const id = `lib-${input.key}`;
  return (
    <div className="library-input">
      {input.kind === "toggle" ? (
        <label className="library-toggle">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {input.label}
        </label>
      ) : (
        <>
          <label htmlFor={id}>{input.label}</label>
          {input.kind === "text" ? (
            input.multiline ? (
              <textarea id={id} className="library-words" rows={Math.min(4, Math.max(2, String(value).split("\n").length))} value={String(value)} maxLength={input.maxLength ?? 60} onChange={(e) => onChange(e.target.value)} />
            ) : (
              <input id={id} className="library-words" value={String(value)} maxLength={input.maxLength ?? 60} onChange={(e) => onChange(e.target.value)} />
            )
          ) : input.kind === "choice" ? (
            <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
              {input.choices?.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="library-number">
              <input id={id} inputMode="decimal" value={String(value)} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
              {input.kind === "length" && <span className="muted">mm</span>}
            </span>
          )}
        </>
      )}
      {input.help && <p className="muted small">{input.help}</p>}
    </div>
  );
}

/** The form for one design: its sizes and choices, a live preview, and what's wrong (if anything). */
function DesignForm({ design, typed, setTyped }: { design: LibraryDesign; typed: Typed; setTyped: (t: Typed) => void }) {
  const values = useMemo(() => valuesFrom(design, typed), [design, typed]);
  const problems = useMemo(() => valueProblems(design, values), [design, values]);
  const summary = problems.length === 0 ? design.summary?.(values) : null;
  return (
    <div className="library-form">
      <div className="library-inputs">
        {design.inputs.map((i) => (
          <InputRow key={i.key} input={i} value={typed[i.key]} onChange={(v) => setTyped({ ...typed, [i.key]: v })} />
        ))}
      </div>
      <div className="library-side">
        <Preview design={design} values={values} ok={problems.length === 0} />
        {summary && <p className="small">{summary}</p>}
        {problems.map((p) => (
          <p key={p} className="error-text small">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Design library: pick a ready-made design, set its sizes, and insert it as ordinary, editable features. */
export function LibraryDialog() {
  const view = useStore((s) => s.library);
  const openLibrary = useStore((s) => s.openLibrary);
  const insertDesign = useStore((s) => s.insertLibraryDesign);
  const editDesign = useStore((s) => s.editLibraryDesign);
  const doc = useDocument();
  const [search, setSearch] = useState("");
  const close = () => {
    setSearch("");
    openLibrary(null);
  };

  const insert = view?.mode === "edit" ? findInsert(doc, view.insertId) : undefined;
  const design = view?.mode === "edit" ? (insert ? findDesign(insert.design) : undefined) : view?.design ? findDesign(view.design) : undefined;
  const [typed, setTyped] = useState<Typed | null>(null);
  const [into, setInto] = useState<"new" | "current">("new");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DesignCategory>(() => rememberedTab());
  const found = useMemo(() => searchDesigns(search), [search]);
  const chooseTab = (t: DesignCategory) => {
    setTab(t);
    rememberTab(t);
  };
  const shown: Typed | null = design ? typed ?? typedFrom(design, insert ? currentValues(doc, insert) : defaultValues(design)) : null;
  const values = design && shown ? valuesFrom(design, shown) : null;
  const ok = !!design && !!values && valueProblems(design, values).length === 0;

  const pick = (id: string) => {
    setTyped(null);
    setError(null);
    openLibrary({ mode: "browse", design: id });
  };
  const apply = () => {
    if (!design || !values) return;
    const problem = insert ? editDesign(insert.id, values) : insertDesign(design.id, values, into);
    if (problem) setError(problem);
    else close();
  };

  if (!view) return null;
  if (!design || !shown) {
    const placed = liveInserts(doc);
    return (
      <Modal title="Design library" onClose={close} width={720}>
        <p className="small">
          Ready-made designs you can size to suit. Each is added as ordinary features — sketches with dimensions and extrudes — driven by a few named sizes, so you can change it later in{" "}
          <b>Variables</b>, or edit any feature just as if you'd drawn it yourself.
        </p>
        <input
          className="library-search"
          type="search"
          placeholder="Search the library (bolt, hinge, box…)"
          aria-label="Search the library"
          value={search}
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search.trim() ? (
          <section aria-live="polite">
            <h3 className="library-heading">{found.length === 0 ? "Nothing found" : `Found ${found.length} design${found.length > 1 ? "s" : ""}`}</h3>
            {found.length === 0 ? (
              <p className="muted small">Try another word, or clear the search to see every design.</p>
            ) : (
              LIBRARY_CATEGORIES.filter((c) => found.some((d) => d.category === c.id)).map((c) => (
                <div key={c.id}>
                  <h4 className="library-group">{c.label}</h4>
                  <div className="library-grid">
                    {found
                      .filter((d) => d.category === c.id)
                      .map((d) => (
                        <DesignCard key={d.id} design={d} onPick={pick} />
                      ))}
                  </div>
                </div>
              ))
            )}
          </section>
        ) : (
          <>
            <div className="library-tabs" role="tablist" aria-label="Kinds of design">
              {LIBRARY_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  id={`library-tab-${c.id}`}
                  role="tab"
                  aria-selected={tab === c.id}
                  tabIndex={tab === c.id ? 0 : -1}
                  aria-controls="library-section"
                  className={tab === c.id ? "selected" : ""}
                  onClick={() => chooseTab(c.id)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    const i = LIBRARY_CATEGORIES.findIndex((x) => x.id === tab);
                    const next = LIBRARY_CATEGORIES[(i + (e.key === "ArrowRight" ? 1 : LIBRARY_CATEGORIES.length - 1)) % LIBRARY_CATEGORIES.length];
                    chooseTab(next.id);
                    document.getElementById(`library-tab-${next.id}`)?.focus();
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {LIBRARY_CATEGORIES.filter((c) => c.id === tab).map((c) => (
              <section key={c.id} id="library-section" role="tabpanel" aria-labelledby={`library-tab-${c.id}`}>
                <h3 className="library-heading">{c.label}</h3>
                <p className="muted small">{c.blurb}</p>
                <GroupedCards groups={designGroups(c.id)} onPick={pick} />
              </section>
            ))}
          </>
        )}
        {placed.length > 0 && (
          <>
            <h3 className="library-heading">In this design</h3>
            <ul className="library-placed">
              {placed.map((x) => (
                <li key={x.id}>
                  <span>{x.name}</span>
                  <button className="text-button" onClick={() => (setTyped(null), setError(null), openLibrary({ mode: "edit", insertId: x.id }))}>
                    Edit design sizes…
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={insert ? `Edit design sizes — ${insert.name}` : design.name}
      onClose={close}
      width={760}
      footer={
        <>
          {!insert && (
            <div className="library-where" role="radiogroup" aria-label="Where it goes">
              <label>
                <input type="radio" name="lib-into" checked={into === "new"} onChange={() => setInto("new")} /> New Part Studio
              </label>
              <label>
                <input type="radio" name="lib-into" checked={into === "current"} onChange={() => setInto("current")} /> This Part Studio
              </label>
            </div>
          )}
          <button className="text-button" onClick={() => (insert ? close() : (setTyped(null), setError(null), openLibrary({ mode: "browse" })))}>
            {insert ? "Cancel" : "Back"}
          </button>
          <button className="primary-button" onClick={apply} disabled={!ok} title={ok ? undefined : "Fix the sizes shown in red first"}>
            {insert ? "Update" : "Insert"}
          </button>
        </>
      }
    >
      <p className="small">{design.description}</p>
      <DesignForm design={design} typed={shown} setTyped={(t) => (setTyped(t), setError(null))} />
      <p className="muted small">
        {insert
          ? `The sizes are also in Variables (${insert.prefix}_…), for a quick change. Updating here makes the design's features again, so changes you made to them by hand are replaced.`
          : "These sizes go into Variables, so you can change them any time. Choices like the lid or the finger width are changed with Edit design sizes (right-click the design's folder in the feature list)."}
      </p>
      {error && <p className="error-text small">{error}</p>}
    </Modal>
  );
}
