/**
 * The Loft dialog's sections and further choices (as Onshape's Loft): sketches (one area of each), flat faces
 * clicked in the view, a point at either end, how the ends are shaped, a guide curve or path, lining up corners,
 * a closed ring. Pure logic in src/model/loft.ts.
 */
import { AreaPicker } from "./AreaPicker";
import { followedSketch } from "../sketch/areaClicks";
import { findRegions } from "../sketch/regions";
import { activeFeatures, useStore } from "../model/store";
import { END_LABELS, endChoices, lonePoints, loftProfiles, moveProfile, profileLabel, tidyEnds, withEndPoint, withLoftDef, withProfiles } from "../model/loft";
import type { Feature, LoftCurve, LoftDef, LoftEnd, LoftProfile } from "../model/types";

type Picking = NonNullable<LoftDef["picking"]>;

export function LoftOptions({ sketches }: { sketches: Feature[] }) {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  const sketchLinks = useStore((s) => s.sketchLinks);
  if (!draft || draft.type !== "loft") return null;
  const def: LoftDef = draft.loft ?? {};
  const profiles = loftProfiles(draft);
  const name = (id: string) => features.find((f) => f.id === id)?.name;
  const picking: Picking = def.picking ?? "profile";
  const setProfiles = (next: LoftProfile[]) => {
    const patch = withProfiles(draft, next);
    setDraftField({ ...patch, ...withLoftDef({ loft: patch.loft ?? undefined }, tidyEnds(patch.loft ?? undefined, next)) });
  };
  const setDef = (patch: Partial<LoftDef>) => setDraftField(withLoftDef(draft, patch));
  const pickButton = (mode: Picking, label: string) => (
    <button type="button" className={picking === mode ? "small-button selected" : "small-button"} aria-pressed={picking === mode} onClick={() => setDef({ picking: picking === mode ? undefined : mode })}>
      {label}
    </button>
  );
  const unused = sketches.filter((f) => !profiles.some((p) => "sketch" in p && p.sketch === f.id));
  const pointChoices = sketches.flatMap((f) => (f.sketch ? lonePoints(f.sketch.data).map((p, i) => ({ value: `${f.id}|${p.id}`, label: `${f.name}: point ${i + 1}` })) : []));
  const endPointOf = (which: "start" | "end") => {
    const p = which === "start" ? profiles[0] : profiles[profiles.length - 1];
    return p && "point" in p ? p.point : undefined;
  };
  const pointSelect = (which: "start" | "end") => {
    const pt = endPointOf(which);
    const value = pt?.sketchPoint ? `${pt.sketchPoint.sketch}|${pt.sketchPoint.point}` : pt ? "clicked" : "";
    return (
      <label className="field-label">
        {which === "start" ? "Start at a point" : "End at a point"}
        <select
          className="full-select"
          aria-label={which === "start" ? "Start at a point" : "End at a point"}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "click") {
              setDef({ picking: which });
              return;
            }
            if (!v) {
              setProfiles(withEndPoint(profiles, which, null));
              return;
            }
            const [sk, pid] = v.split("|");
            const f = sketches.find((x) => x.id === sk);
            const p = f?.sketch?.data.points.find((q) => q.id === pid);
            if (!f || !p) return;
            setProfiles(withEndPoint(profiles, which, { p: [0, 0, 0], sketchPoint: { sketch: sk, point: pid } }));
          }}
        >
          <option value="">No point</option>
          {pt && !pt.sketchPoint && <option value="clicked">A corner of a part</option>}
          {pointChoices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
          <option value="click">Click a corner of a part…</option>
        </select>
      </label>
    );
  };
  const endSelect = (which: "start" | "end") => {
    const p = which === "start" ? profiles[0] : profiles[profiles.length - 1];
    const choices = endChoices(p);
    const cond = def[which];
    const set = (c: LoftEnd | undefined) => setDef(which === "start" ? { start: c } : { end: c });
    return (
      <div className="loft-end">
        <label className="field-label">
          {which === "start" ? "How it leaves the first shape" : "How it reaches the last shape"}
          <select className="full-select" value={cond?.kind ?? ""} onChange={(e) => set(e.target.value ? { kind: e.target.value as LoftEnd["kind"], ...(cond?.magnitude ? { magnitude: cond.magnitude } : {}) } : undefined)}>
            <option value="">Free (as it comes)</option>
            {choices.map((k) => (
              <option key={k} value={k}>
                {END_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {cond && cond.kind !== "tangent" && (
          <label className="field-label">
            How far it reaches (1 = usual)
            <input
              type="number"
              min={0.1}
              max={4}
              step={0.1}
              value={cond.magnitude ?? 1}
              onChange={(e) => {
                const m = Number(e.target.value);
                if (Number.isFinite(m) && m > 0) set({ ...cond, magnitude: m === 1 ? undefined : Math.min(4, m) });
              }}
            />
          </label>
        )}
      </div>
    );
  };
  const curveSelect = (which: "guide" | "path", label: string) => {
    const c: LoftCurve | undefined = def[which];
    const value = c && "sketch" in c ? c.sketch : c ? "edges" : "";
    return (
      <>
        <label className="field-label">
          {label}
          <select className="full-select" aria-label={label} value={value} onChange={(e) => {
              const v = e.target.value;
              const next: LoftCurve | undefined = v === "edges" ? (c && "edges" in c ? c : undefined) : v ? { sketch: v } : undefined;
              setDef({ ...(which === "guide" ? { guide: next } : { path: next }), picking: v === "edges" ? which : undefined });
            }}>
            <option value="">None</option>
            {sketches.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="edges">Edges of a part (click them)</option>
          </select>
        </label>
        {value === "edges" && (
          <p className="dialog-hint field-hint">
            {c && "edges" in c ? `${c.edges.length} edge${c.edges.length === 1 ? "" : "s"} picked. ` : ""}
            {pickButton(which, picking === which ? "Done picking edges" : "Click edges…")}
          </p>
        )}
      </>
    );
  };
  return (
    <fieldset className="param-group">
      <legend>Shapes to join, in order</legend>
      <ol className="loft-sections">
        {profiles.map((p, i) => {
          const sk = "sketch" in p ? sketches.find((f) => f.id === p.sketch) : undefined;
          const data = sk ? followedSketch(sk, sketchLinks)?.data ?? sk.sketch?.data : undefined;
          const several = !!data && !draft.surface && findRegions(data).regions.length > 1;
          return (
            <li key={i}>
              <span>{profileLabel(p, name)}</span>{" "}
              <button type="button" className="icon-button" title="Earlier" aria-label="Move earlier" disabled={i === 0} onClick={() => setProfiles(moveProfile(profiles, i, -1))}>
                ▲
              </button>
              <button type="button" className="icon-button" title="Later" aria-label="Move later" disabled={i === profiles.length - 1} onClick={() => setProfiles(moveProfile(profiles, i, 1))}>
                ▼
              </button>
              <button type="button" className="icon-button" title="Take out" aria-label="Take out" onClick={() => setProfiles(profiles.filter((_, j) => j !== i))}>
                ✕
              </button>
              {def.matchCorners && !("point" in p) && (
                <label className="inline-field">
                  {" "}Turn by corners{" "}
                  <input type="number" step={1} value={p.turn ?? 0} style={{ width: "4em" }} onChange={(e) => setProfiles(profiles.map((q, j) => (j === i && !("point" in q) ? { ...q, turn: Math.round(Number(e.target.value)) || 0 } : q)))} />
                </label>
              )}
              {several && "sketch" in p && (
                <AreaPicker
                  data={data!}
                  areas={p.areas}
                  verb="loft through"
                  onChange={(areas) => setProfiles(profiles.map((q, j) => (j === i && "sketch" in q ? { sketch: q.sketch, ...(areas?.length ? { areas: areas.slice(-1) } : {}), ...(q.turn !== undefined ? { turn: q.turn } : {}) } : q)))}
                />
              )}
            </li>
          );
        })}
      </ol>
      {unused.length > 0 && (
        <label className="field-label">
          Add a sketch
          <select
            className="full-select"
            aria-label="Add a sketch"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const end = profiles.length > 1 && "point" in profiles[profiles.length - 1];
              const next = [...profiles];
              next.splice(end ? next.length - 1 : next.length, 0, { sketch: e.target.value });
              setProfiles(next);
            }}
          >
            <option value="">Choose a sketch…</option>
            {unused.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="dialog-hint field-hint">
        Each sketch needs one closed shape (or pick one of its areas). Click flat faces of parts in the view to use them too. {pickButton("profile", "Click faces")}
      </p>
      {pointSelect("start")}
      {pointSelect("end")}
      {(picking === "start" || picking === "end") && <p className="dialog-hint field-hint">Click near the corner of a part you want the loft to come to a point at.</p>}
      {!def.periodic && endSelect("start")}
      {!def.periodic && endSelect("end")}
      {curveSelect("guide", "Guide curve (the shapes' outlines touch it)")}
      {curveSelect("path", "Path to follow")}
      <label className="check-row" title="Choose which corner of each shape joins which, if the loft comes out twisted">
        <input type="checkbox" checked={!!def.matchCorners} onChange={(e) => setDef({ matchCorners: e.target.checked || undefined })} />
        Line up the corners myself (if it twists)
      </label>
      <label className="check-row" title="Carry on from the last shape back round to the first, making a closed ring">
        <input type="checkbox" checked={!!def.periodic} onChange={(e) => setDef({ periodic: e.target.checked || undefined, ...(e.target.checked ? { start: undefined, end: undefined } : {}) })} />
        Close the loop (back to the first shape)
      </label>
      {!draft.surface && (
        <label className="check-row" title="Straight sides from each shape to the next, so the steps stay sharp, instead of one smooth curve through them all">
          <input type="checkbox" aria-label="Straight between shapes" checked={!!draft.loftRuled} onChange={(e) => setDraftField({ loftRuled: e.target.checked || undefined })} />
          Straight between shapes (sharp steps)
        </label>
      )}
    </fieldset>
  );
}
