import { useMemo } from "react";

import { deletePlan, deleteQuestion, listNames, outsideLines } from "../model/dependents";
import { activeFeatures, activeStudioId, useStore } from "../model/store";
import { firstStudioId } from "../model/studios";
import { Modal } from "./Modal";

/**
 * The Delete question (as Onshape's Delete dialog): what else uses the picked
 * features, and whether to delete those too. Opened by "Delete with
 * dependents…" in the feature list's right-click menu, or by the Delete key on
 * a feature other features use.
 */
export function DeleteDialog() {
  const ask = useStore((s) => s.deleteAsk);
  const doc = useStore((s) => s.history.present);
  const studio = useStore((s) => activeStudioId(s)) ?? firstStudioId(doc);
  const features = useStore(activeFeatures);
  const plan = useMemo(() => (ask ? deletePlan(doc, studio, ask.ids) : null), [ask, doc, studio]);
  if (!ask || !plan) return null;
  const close = () => useStore.getState().askDelete(null);
  const run = (justThese: boolean) => {
    const n = useStore.getState().deleteFeatures(ask.ids, justThese);
    if (n > 1) useStore.getState().showToast(`Deleted ${n} features. Undo brings them back.`);
  };
  const n = plan.dependents.length;
  const these = plan.picked.length === 1 ? "this" : "these";
  const outside = outsideLines(plan.outside);
  const name = (id: string) => features.find((f) => f.id === id)?.name ?? id;
  return (
    <Modal
      title="Delete"
      onClose={close}
      footer={
        <>
          <button className="text-button" onClick={close}>
            Cancel
          </button>
          {n > 0 && (
            <button className="text-button" autoFocus={ask.from === "key"} onClick={() => run(true)} title="The features that use it are kept, and show what they've lost (as now)">
              Delete just {these}
            </button>
          )}
          <button className="primary-button" autoFocus={ask.from !== "key" || n === 0} onClick={() => run(false)}>
            {n > 0 ? `Delete with the ${n === 1 ? "feature" : `${n} features`} that ${n === 1 ? "uses" : "use"} ${plan.picked.length === 1 ? "it" : "them"}` : "Delete"}
          </button>
        </>
      }
    >
      <p className="delete-question">{deleteQuestion(features, plan)}</p>
      {plan.partial.length > 0 && (
        <>
          <p className="small">These stay, without what they used from it:</p>
          <ul className="small delete-list">
            {plan.partial.map((p) => (
              <li key={p.id}>
                {name(p.id)} will lose {listNames(p.loses)}.
              </li>
            ))}
          </ul>
        </>
      )}
      {outside.length > 0 && (
        <>
          <p className="small">Parts that will go are used elsewhere (nothing there is removed):</p>
          <ul className="small delete-list">
            {outside.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <p className="small">Undo brings it all back.</p>
    </Modal>
  );
}
