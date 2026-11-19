/**
 * Onshape's "Merge with all" / Merge scope, under the operation choice of
 * features that add, remove or intersect (src/model/mergeScope.ts).
 */
import { scopeHeading, scopeVerb, setMergeWithAll, takesMergeScope } from "../model/mergeScope";
import { studioParts, useStore } from "../model/store";
import { Icons } from "./icons";

export function MergeScopeField() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (!draft || !takesMergeScope(draft)) return null;
  const all = draft.mergeScope === undefined;
  const verb = scopeVerb(draft);
  const ids = draft.mergeScope ?? [];
  const active = !!draft.mergeScopePicking;
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(a part no longer there)";
  const tick = (on: boolean) => {
    const next = setMergeWithAll(draft, on);
    setDraftField({ mergeScope: next.mergeScope, mergeScopePicking: next.mergeScopePicking });
  };
  return (
    <>
      <label className="check-row" title={`Ticked: every part it reaches is changed (the usual). Untick to choose the only parts it may ${verb}; the others are left alone.`}>
        <input type="checkbox" checked={all} onChange={(e) => tick(e.target.checked)} />
        {verb === "merge with" ? "Merge with all" : verb === "change" ? "Change every part it reaches" : `${verb[0].toUpperCase()}${verb.slice(1)} every part it reaches`}
      </label>
      {!all && (
        <fieldset
          className={`param-group pick-slot reference-box${active ? " active" : ""}`}
          aria-label={scopeHeading(draft)}
          onClick={() => !active && setDraftField({ mergeScopePicking: true })}
        >
          <legend>{scopeHeading(draft)}</legend>
          {ids.length ? (
            <ul className="pick-list" aria-label={scopeHeading(draft)}>
              {ids.map((id) => (
                <li key={id}>
                  <span>{nameOf(id)}</span>
                  <button
                    type="button"
                    className="icon-button small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraftField({ mergeScope: ids.filter((x) => x !== id) });
                    }}
                    title="Leave this part out"
                    aria-label={`Leave out ${nameOf(id)}`}
                  >
                    <Icons.Cross size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {active ? (
            <>
              <p className="dialog-hint pick-hint">
                Click the parts to {verb}, in the 3D view or the Parts list (click one again to leave it out). Other parts are left as they are
                {verb === "merge with" ? "; a piece touching none of these becomes a part of its own" : ""}.
              </p>
              <button
                type="button"
                className="text-button small-text"
                onClick={(e) => {
                  e.stopPropagation();
                  setDraftField({ mergeScopePicking: undefined });
                }}
                title="Stop picking parts and show the result"
              >
                Done — show the result
              </button>
            </>
          ) : (
            <p className="muted small field-note">Click this box to pick more (the parts are shown as they were before this feature while you pick).</p>
          )}
        </fieldset>
      )}
    </>
  );
}
