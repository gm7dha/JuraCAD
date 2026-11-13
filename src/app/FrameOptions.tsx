import { activeFeatures, studioParts, useStore } from "../model/store";
import { sketchesOffered } from "../sketch/areaClicks";
import { ANCHORS, PROFILE_KINDS } from "../model/frameProfiles";
import { endCurveId, frameCornersFor, sketchPathSegments, type PathSeg } from "../model/frame";
import type { FrameCornerChoice, FrameCornerType, FrameDef, FrameProfileKind } from "../model/frameTypes";
import type { Feature } from "../model/types";
import { planeLabel } from "../sketch/planes";
import { lengthNumber } from "../model/units";
import { Icons } from "./icons";

const CORNER_LABELS: Record<FrameCornerType, string> = {
  mitre: "Mitre (each cut at the halfway angle to the others)",
  butt: "Butt (one runs through, the other stops at its side)",
  coped: "Coped (cut to the other's shape — for tubes)",
  none: "None (both left square)",
};

/** The path's curves, as the dialog sees the sketches (as saved). */
function draftSegments(def: FrameDef, features: Feature[]): PathSeg[] {
  const out: PathSeg[] = [];
  for (const p of def.paths) {
    const sk = features.find((f) => f.id === p.sketch);
    if (sk?.sketch?.plane) out.push(...sketchPathSegments(sk.id, sk.sketch.plane, sk.sketch.data, p.items).segs);
  }
  return out;
}

/** Frame: the path's sketches, the profile, where the path runs through it, and each corner. */
export function FrameOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  const rollbackTo = useStore((s) => s.rollbackTo);
  const builtPieces = useStore((s) => (s.editing?.draft.type === "frame" ? s.framePaths[s.editing.draft.id] : undefined));
  if (draft?.type !== "frame" || !draft.frame) return null;
  const def = draft.frame;
  const set = (patch: Partial<FrameDef>) => setDraftField({ frame: { ...def, ...patch } });
  const sketches = sketchesOffered(features, draft.id, mode === "edit", rollbackTo);
  const onPath = (id: string) => def.paths.find((p) => p.sketch === id);
  const togglePath = (id: string, on: boolean) => set({ paths: on ? [...def.paths, { sketch: id }] : def.paths.filter((p) => p.sketch !== id) });
  const kind = def.profile.kind;
  const info = kind === "sketch" ? null : PROFILE_KINDS.find((k) => k.kind === kind)!;
  const setKind = (k: string) => {
    if (k === "sketch") {
      const other = sketches.find((s) => !onPath(s.id));
      set({ profile: { kind: "sketch", sketch: other?.id ?? "" } });
    } else set({ profile: { kind: k as FrameProfileKind, size: PROFILE_KINDS.find((x) => x.kind === k)!.sizes[0].key } });
  };
  // Part edges and curves: their pieces as last built (the engine finds them).
  const more = def.edges?.length || def.curves?.length ? builtPieces ?? [] : [];
  const { corners, members } = frameCornersFor([...draftSegments(def, features), ...more], def);
  const here = features.findIndex((f) => f.id === draft.id);
  const curvesOffered = features.filter((f, i) => f.type === "curve" && !f.suppressed && (here < 0 || i < here));
  const toggleCurve = (id: string, on: boolean) => {
    const list = (def.curves ?? []).filter((c) => c !== id);
    set({ curves: on ? [...list, id] : list.length ? list : undefined });
  };
  const setCorner = (key: string, patch: Partial<FrameCornerChoice> | null) => {
    const rest = (def.corners ?? []).filter((c) => c.key !== key);
    const cur = (def.corners ?? []).find((c) => c.key === key);
    const next = patch ? [...rest, { ...(cur ?? { key, type: "mitre" as const }), ...patch }] : rest;
    set({ corners: next.length ? next : undefined });
  };
  const fmt = (v: number) => lengthNumber(Math.round(v * 100) / 100);

  return (
    <>
      <fieldset className="param-group">
        <legend>Path</legend>
        {sketches.length === 0 ? (
          <p className="dialog-hint">There are no sketches yet: click part edges or curves in the 3D view, or cancel and sketch the frame&apos;s lines first.</p>
        ) : (
          <ul className="pick-list" aria-label="Sketches the frame follows">
            {sketches
              .filter((s) => !(def.profile.kind === "sketch" && def.profile.sketch === s.id))
              .map((s) => {
                const p = onPath(s.id);
                return (
                  <li key={s.id}>
                    <label className="check-row">
                      <input type="checkbox" checked={!!p} onChange={(e) => togglePath(s.id, e.target.checked)} />
                      {s.name}
                      {p?.items ? ` (${p.items.length} line${p.items.length === 1 ? "" : "s"})` : ""}
                      {s.sketch?.plane ? <span className="muted small"> — on {planeLabel(s.sketch.plane)}</span> : null}
                    </label>
                  </li>
                );
              })}
          </ul>
        )}
        {curvesOffered.length > 0 && (
          <ul className="pick-list" aria-label="Curves the frame follows">
            {curvesOffered.map((c) => (
              <li key={c.id}>
                <label className="check-row">
                  <input type="checkbox" checked={!!def.curves?.includes(c.id)} onChange={(e) => toggleCurve(c.id, e.target.checked)} />
                  {c.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="small">
          Part edges: {def.edges?.length ? `${def.edges.length} picked` : "none"}
          {def.edges?.length ? (
            <button type="button" className="link-button" onClick={() => set({ edges: undefined })}>
              Clear
            </button>
          ) : null}
        </p>
        <p className="dialog-hint field-hint">Each line or arc becomes a length of its own. Click a sketch line in the 3D view to leave it out (or put it back); click part edges or curves (a helix…) to follow them too.</p>
        <label className="check-row" title="Lines and arcs that carry on smoothly into each other (a rounded corner) make one bent length">
          <input type="checkbox" checked={!def.noMerge} onChange={(e) => set({ noMerge: e.target.checked ? undefined : true })} />
          Join lines and arcs that carry on smoothly
        </label>
      </fieldset>
      <fieldset className="param-group">
        <legend>Profile</legend>
        <label className="field-label">Kind</label>
        <select className="full-select" aria-label="Profile kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {PROFILE_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
          <option value="sketch">My own (a sketch)</option>
        </select>
        {info && def.profile.kind !== "sketch" && (
          <>
            <label className="field-label">Size</label>
            <select className="full-select" aria-label="Profile size" value={def.profile.size} onChange={(e) => set({ profile: { kind: info.kind, size: e.target.value } })}>
              {info.sizes.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
              {info.custom && <option value="custom">Other size… ({info.custom.toLowerCase()})</option>}
            </select>
          </>
        )}
        {def.profile.kind === "sketch" && (
          <>
            <label className="field-label">Sketch with the cross-section</label>
            <select className="full-select" aria-label="Profile sketch" value={def.profile.sketch} onChange={(e) => set({ profile: { kind: "sketch", sketch: e.target.value }, paths: def.paths.filter((p) => p.sketch !== e.target.value) })}>
              <option value="">Choose a sketch…</option>
              {sketches.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="dialog-hint field-hint">Its closed shapes are the cross-section, wherever they were drawn.</p>
          </>
        )}
        <label className="field-label">Point on the path</label>
        <select className="full-select" aria-label="Point of the profile on the path" value={def.anchor ?? "centre"} onChange={(e) => set({ anchor: e.target.value === "centre" ? undefined : (e.target.value as FrameDef["anchor"]) })}>
          {ANCHORS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
        <label className="check-row">
          <input type="checkbox" checked={!!def.mirror} onChange={(e) => set({ mirror: e.target.checked || undefined })} />
          Mirror the profile (flip it left to right)
        </label>
      </fieldset>
      {corners.length > 0 && (
        <fieldset className="param-group">
          <legend>Corners</legend>
          <ul className="pick-list frame-corners" aria-label="Corners">
            {corners.map((c) => {
              const nums = [...new Set([...c.ends.map((e) => e.member + 1), ...(c.on !== undefined ? [c.on + 1] : [])])].sort((a, b) => a - b);
              const chosen = (def.corners ?? []).find((x) => x.key === c.key);
              const ends = c.ends;
              const swap = () => {
                if (c.on !== undefined || c.run || ends.length < 2) return;
                const at = ends.findIndex((e) => e.member === c.through);
                const next = ends[(at + 1) % ends.length];
                setCorner(c.key, { type: c.type, through: endCurveId(members[next.member], next.end) });
              };
              return (
                <li key={c.key}>
                  <span className="small">
                    ({fmt(c.at[0])}, {fmt(c.at[1])}, {fmt(c.at[2])}) — members {nums.join(", ")}
                    {c.on !== undefined ? " (ending on a side)" : c.run ? " (meeting a straight run)" : ""}
                  </span>
                  <select
                    className="full-select"
                    aria-label={`Corner of members ${nums.join(", ")}`}
                    value={c.type}
                    onChange={(e) => setCorner(c.key, { type: e.target.value as FrameCornerType })}
                  >
                    {c.choices.map((t) => (
                      <option key={t} value={t}>
                        {CORNER_LABELS[t]}
                      </option>
                    ))}
                  </select>
                  {(c.type === "butt" || c.type === "coped") && c.through !== undefined && (
                    <span className="small">
                      {c.run ? `Members ${c.run[0] + 1} and ${c.run[1] + 1} run on through.` : `Member ${c.through + 1} runs through.`}
                      {c.on === undefined && !c.run && (
                        <button type="button" className="link-button" onClick={swap}>
                          Swap
                        </button>
                      )}
                    </span>
                  )}
                  {chosen && (
                    <button type="button" className="icon-button small" title="Back to the usual corner" aria-label="Back to the usual corner" onClick={() => setCorner(c.key, null)}>
                      <Icons.Cross size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <p className="muted small field-note">Each length is its own part, named &ldquo;{draft.name} member 1&rdquo;, &ldquo;member 2&rdquo;… The Cut list (in the toolbar, beside Frame) gives their lengths to cut.</p>
    </>
  );
}

/** Trim frame: the members to cut, and what to cut them to. */
export function TrimFrameOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (draft?.type !== "trimFrame" || !draft.trimFrame) return null;
  const def = draft.trimFrame;
  const picking = def.picking ?? "members";
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  return (
    <fieldset className="param-group">
      <legend>Trim</legend>
      <div className="segmented" role="radiogroup" aria-label="What a click picks">
        {(["members", "target", "targetPart"] as const).map((k) => (
          <button type="button" key={k} role="radio" aria-checked={picking === k} className={picking === k ? "selected" : ""} onClick={() => setDraftField({ trimFrame: { ...def, picking: k } })}>
            {k === "members" ? "Members" : k === "target" ? "To a plane or face" : "To a part"}
          </button>
        ))}
      </div>
      {def.parts.length ? (
        <ul className="pick-list" aria-label="Members to trim">
          {def.parts.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              <button type="button" className="icon-button small" onClick={() => setDraftField({ trimFrame: { ...def, parts: def.parts.filter((x) => x !== id) } })} aria-label={`Leave out ${nameOf(id)}`}>
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="small">Trim to: {def.to ? nameOf(def.to) : def.plane ? planeLabel(def.plane) : <span className="muted">nothing yet</span>}</p>
      <p className="dialog-hint pick-hint">
        {picking === "members" ? "Click the frame members to trim (click one again to leave it out)." : picking === "target" ? "Click a plane or a flat face to trim them to." : "Click the part to trim them to: each member is cut where it meets it."}
      </p>
      {def.plane && (
        <label className="check-row" title="Usually the side with more of each member is kept">
          <input type="checkbox" checked={!!def.flip} onChange={(e) => setDraftField({ trimFrame: { ...def, flip: e.target.checked || undefined } })} />
          Keep the other side
        </label>
      )}
    </fieldset>
  );
}

/** Gusset: the two members whose corner it fills, and whether its inside corner is cut off. */
export function GussetOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (draft?.type !== "gusset" || !draft.gusset) return null;
  const def = draft.gusset;
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  return (
    <fieldset className="param-group">
      <legend>Corner</legend>
      {def.parts.length ? (
        <ul className="pick-list" aria-label="Members">
          {def.parts.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              <button type="button" className="icon-button small" onClick={() => setDraftField({ gusset: { ...def, parts: def.parts.filter((x) => x !== id) } })} aria-label={`Leave out ${nameOf(id)}`}>
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="dialog-hint pick-hint">Click the two frame members that meet at the corner.</p>
      <label className="check-row" title="Cut the plate's inside corner off, to clear a weld or the members' rounded edges">
        <input type="checkbox" checked={!!def.chamfer} onChange={(e) => setDraftField({ gusset: { ...def, chamfer: e.target.checked || undefined } })} />
        Cut the inside corner off
      </label>
      <label className="check-row" title="Where one member ends on the side of the other, the plate can go either way along it">
        <input type="checkbox" checked={!!def.flip} onChange={(e) => setDraftField({ gusset: { ...def, flip: e.target.checked || undefined } })} />
        Other side (where one ends on the other&apos;s side)
      </label>
    </fieldset>
  );
}
