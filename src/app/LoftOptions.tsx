/**
 * The Loft dialog's sections and further choices (as Onshape's Loft): sketches (one area of each), flat faces
 * clicked in the view, a point at either end, how the ends are shaped, a guide curve or path, lining up corners,
 * a closed ring. Pure logic in src/model/loft.ts.
 */
import { AreaPicker } from "./AreaPicker";
import { followedSketch } from "../sketch/areaClicks";
import { findRegions } from "../sketch/regions";
import { activeFeatures, useStore } from "../model/store";
import { END_LABELS, cornerPoints, endChoices, lonePoints, loftGuides, loftProfiles, moveProfile, pickingIndex, profileLabel, setConnectionSketchPoint, tidyEnds, withEndPoint, withGuide, withLoftDef, withoutConnection, withProfiles } from "../model/loft";
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
  // A sketch drawn on a part's face may carry on from the faces round that face.
  const onFace = (id: string) => {
    const pl = features.find((f) => f.id === id)?.sketch?.plane;
    return !!pl && pl.kind === "face" && !!pl.face;
  };
  const setProfiles = (next: LoftProfile[]) => {
    const patch = withProfiles(draft, next);
    setDraftField({ ...patch, ...withLoftDef({ loft: patch.loft ?? undefined }, tidyEnds(patch.loft ?? undefined, next, onFace)) });
  };
  const setDef = (patch: Partial<LoftDef>) => setDraftField(withLoftDef(draft, patch));
  const pickButton = (mode: Picking, label: string) => (
    <button type="button" className="link-button" aria-pressed={picking === mode} onClick={() => setDef({ picking: picking === mode ? undefined : mode })}>
      {label}
    </button>
  );
  const edgePicking = picking === "newSectionEdges" || picking === "sectionEdges";
  // Curve features (Helix, Fit spline…) above the loft can be its guide or path.
  const at = features.findIndex((f) => f.id === draft.id);
  const curves = features.filter((f, i) => f.type === "curve" && !f.suppressed && (at < 0 || i < at));
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
    const choices = endChoices(p, !!p && "sketch" in p && onFace(p.sketch));
    const cond = def[which];
    const set = (c: LoftEnd | undefined) => setDef(which === "start" ? { start: c } : { end: c });
    return (
      <div className="loft-end">
        <label className="field-label">
          {which === "start" ? "How it leaves the first shape" : "How it reaches the last shape"}
          <select className="full-select" value={cond?.kind ?? ""} onChange={(e) => {
              const kind = e.target.value as LoftEnd["kind"] | "";
              const next: LoftEnd | undefined = kind ? { kind, ...(cond?.magnitude ? { magnitude: cond.magnitude } : {}), ...(kind === "direction" && cond?.towards ? { towards: cond.towards } : {}) } : undefined;
              // A direction to pick: clicks in the view choose it straight away.
              const pick = kind === "direction" && !next?.towards ? { picking: (which === "start" ? "startDir" : "endDir") as Picking } : {};
              setDef({ ...(which === "start" ? { start: next } : { end: next }), ...pick });
            }}>
            <option value="">Free (as it comes)</option>
            {choices.map((k) => (
              <option key={k} value={k}>
                {END_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {cond?.kind === "direction" && (
          <label className="field-label">
            Direction
            <select
              className="full-select"
              aria-label={which === "start" ? "Start direction" : "End direction"}
              value={cond.towards?.axis ?? (cond.towards ? "picked" : "")}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "click") setDef({ picking: which === "start" ? "startDir" : "endDir" });
                else if (v === "x" || v === "y" || v === "z") set({ ...cond, towards: { p: [0, 0, 0], dir: v === "x" ? [1, 0, 0] : v === "y" ? [0, 1, 0] : [0, 0, 1], axis: v } });
              }}
            >
              {!cond.towards && <option value="">Choose…</option>}
              {cond.towards && !cond.towards.axis && <option value="picked">The line you clicked</option>}
              <option value="x">Along X</option>
              <option value="y">Along Y</option>
              <option value="z">Along Z</option>
              <option value="click">Click an edge, face, plane or mate connector…</option>
            </select>
          </label>
        )}
        {(picking === "startDir" || picking === "endDir") && picking === (which === "start" ? "startDir" : "endDir") && (
          <p className="dialog-hint field-hint">Click a straight edge, a flat face (its normal), a round edge or face (its axis), a plane, a sketch line or a mate connector.</p>
        )}
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
  const curveSelect = (which: "guide" | "path" | number, label: string) => {
    // A number: guide curve number which + 1 (0 = the first, `guide`).
    const guides = loftGuides(def);
    const c: LoftCurve | undefined = typeof which === "number" ? guides[which] : def[which];
    const mode: Picking = typeof which === "number" ? (which === 0 ? "guide" : `moreGuide:${which - 1}`) : which;
    const value = c && "sketch" in c ? c.sketch : c && "curve" in c ? `curve:${c.curve}` : c ? "edges" : "";
    return (
      <>
        <label className="field-label">
          {label}
          <select className="full-select" aria-label={label} value={value} onChange={(e) => {
              const v = e.target.value;
              const next: LoftCurve | undefined = v === "edges" ? (c && "edges" in c ? c : undefined) : v.startsWith("curve:") ? { curve: v.slice(6) } : v ? { sketch: v } : undefined;
              const set = typeof which === "number" ? withGuide(def, which, next) : which === "guide" ? { guide: next } : { path: next };
              setDef({ ...set, picking: v === "edges" ? mode : undefined });
            }}>
            <option value="">None</option>
            {sketches.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            {curves.map((f) => (
              <option key={f.id} value={`curve:${f.id}`}>
                {f.name}
              </option>
            ))}
            <option value="edges">Edges of a part (click them)</option>
          </select>
        </label>
        {value === "edges" && (
          <p className="dialog-hint field-hint">
            {c && "edges" in c ? `${c.edges.length} edge${c.edges.length === 1 ? "" : "s"} picked. ` : ""}
            {pickButton(mode, picking === mode ? "Done picking edges" : "Click edges…")}
          </p>
        )}
      </>
    );
  };
  const guideList = () => {
    const guides = loftGuides(def);
    // One more slot while the last guide is being picked from edges (it has none yet).
    const picked = pickingIndex(picking, "moreGuide");
    const count = Math.max(guides.length, picked !== null ? picked + 2 : 0, 1);
    return (
      <>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="loft-guide">
            {curveSelect(i, i === 0 ? (count > 1 ? "Guide curve 1 (the shapes' outlines touch it)" : "Guide curve (the shapes' outlines touch it)") : `Guide curve ${i + 1}`)}
            {i > 0 && guides[i] && (
              <button type="button" className="link-button" onClick={() => setDef({ ...withGuide(def, i, undefined), picking: undefined })}>
                Take guide curve {i + 1} out
              </button>
            )}
          </div>
        ))}
        {guides.length > 0 && guides.length === count && (
          <p className="dialog-hint field-hint">
            <button type="button" className="link-button" onClick={() => setDef({ picking: `moreGuide:${guides.length - 1}` })}>
              + Add another guide curve
            </button>{" "}
            (every shape's outline must touch each one)
          </p>
        )}
      </>
    );
  };
  const connectionList = () => {
    const list = def.connections ?? [];
    const pickingAt = pickingIndex(picking, "connection");
    const count = Math.max(list.length, pickingAt !== null ? pickingAt + 1 : 0);
    const shapes = profiles.flatMap((p) => ("sketch" in p ? [p.sketch] : []));
    return (
      <fieldset className="param-group loft-connections">
        <legend>Connections (which corners join)</legend>
        {Array.from({ length: count }, (_, j) => {
          const pts = list[j]?.points ?? [];
          const clicked = pts.filter((g) => !g.sketchPoint).length;
          return (
            <div key={j} className="loft-connection">
              <strong>Connection {j + 1}</strong>{" "}
              <button type="button" className="icon-button" title="Take out" aria-label={`Take connection ${j + 1} out`} onClick={() => setDef({ ...withoutConnection(def, j), picking: undefined })}>
                ✕
              </button>
              {shapes.map((id) => {
                const sk = sketches.find((f) => f.id === id);
                const data = sk ? followedSketch(sk, sketchLinks)?.data ?? sk.sketch?.data : undefined;
                const corners = data ? cornerPoints(data) : [];
                const cur = pts.find((g) => g.sketchPoint?.sketch === id)?.sketchPoint?.point ?? "";
                return (
                  <label key={id} className="field-label">
                    {name(id) ?? "A sketch"}
                    <select className="full-select" aria-label={`Connection ${j + 1} on ${name(id) ?? "a sketch"}`} value={cur} onChange={(e) => setDef(setConnectionSketchPoint(def, j, id, e.target.value || null))}>
                      <option value="">Choose a corner…</option>
                      {corners.map((c, k) => (
                        <option key={c.id} value={c.id}>
                          Corner {k + 1} ({Math.round(c.x * 100) / 100}, {Math.round(c.y * 100) / 100})
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
              <p className="dialog-hint field-hint">
                {clicked ? `${clicked} corner${clicked === 1 ? "" : "s"} of parts clicked. ` : ""}
                {pickButton(`connection:${j}`, picking === `connection:${j}` ? "Done clicking corners" : "Click corners of faces…")}
              </p>
            </div>
          );
        })}
        <p className="dialog-hint field-hint">
          Pick one corner on every shape for each connection; the loft joins them (for shapes with different numbers of sides, or when it comes out twisted).{" "}
          <button type="button" className="link-button" onClick={() => setDef({ picking: `connection:${count}`, matchCorners: undefined })}>
            + Add a connection
          </button>
        </p>
      </fieldset>
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
              {def.matchCorners && !("point" in p) && !("edges" in p) && (
                <label className="inline-field">
                  {" "}Turn by corners{" "}
                  <input type="number" step={1} value={p.turn ?? 0} style={{ width: "4em" }} onChange={(e) => setProfiles(profiles.map((q, j) => (j === i && !("point" in q) && !("edges" in q) ? { ...q, turn: Math.round(Number(e.target.value)) || 0 } : q)))} />
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
        Each sketch needs one closed shape (or pick one of its areas). Click faces of parts in the view to use them too (a curved face's outline works; its ends can't be shaped).{" "}
        <button type="button" className="link-button" aria-pressed={edgePicking} onClick={() => setDef({ picking: edgePicking ? undefined : "newSectionEdges" })}>
          {edgePicking ? "Done picking edges" : "Add a section from part edges…"}
        </button>{" "}
        {picking !== "profile" && (
          <button type="button" className="link-button" onClick={() => setDef({ picking: undefined })}>
            Back to clicking faces
          </button>
        )}
      </p>
      {pointSelect("start")}
      {pointSelect("end")}
      {(picking === "newSectionEdges" || picking === "sectionEdges") && (
        <p className="dialog-hint field-hint">
          Click edges of a part that join end to end{draft.surface ? "" : " all the way round"}.{" "}
          {picking === "sectionEdges" && pickButton("newSectionEdges", "Start another edge section")}
        </p>
      )}
      {(picking === "start" || picking === "end") && <p className="dialog-hint field-hint">Click near the corner of a part you want the loft to come to a point at.</p>}
      {!def.periodic && endSelect("start")}
      {!def.periodic && endSelect("end")}
      {guideList()}
      {curveSelect("path", "Path to follow")}
      {connectionList()}
      <label className="check-row" title="Choose which corner of each shape joins which, if the loft comes out twisted">
        <input type="checkbox" checked={!!def.matchCorners} onChange={(e) => setDef({ matchCorners: e.target.checked || undefined, ...(e.target.checked ? { connections: undefined } : {}) })} />
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
