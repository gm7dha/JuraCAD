import { useEffect, useState } from "react";

import { getKernel } from "../kernel/connect";
import type { DeleteFaceBlockers } from "../kernel/protocol";
import { featuresWithDraft } from "../model/document";
import { activeFeatures, useStore } from "../model/store";
import { resolveVariables } from "../model/variables";
import { Modal } from "./Modal";

/** The engine's message when a face can't be deleted because it isn't in a loop of its own. */
export const BLENDED_FACE_ERROR = /Only holes and bosses|The face around these is curved/;

const nameList = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Delete face can't close a gap next to rounded (filleted) or bevelled
 * (chamfered) edges. When that's what's stopping it, ask whether to turn
 * those features off — or, if the picked face is a fillet's own rounded face,
 * offer to turn that fillet off instead.
 */
export function DeleteFaceHelp({ error }: { error: string }) {
  const draft = useStore((s) => s.editing?.draft ?? null);
  const suppressThenFinish = useStore((s) => s.suppressThenFinish);
  const [answer, setAnswer] = useState<{ key: string; result: DeleteFaceBlockers | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = JSON.stringify([draft?.picks, error]);

  useEffect(() => {
    if (!draft || draft.type !== "deleteFace" || !BLENDED_FACE_ERROR.test(error)) return;
    let live = true;
    const s = useStore.getState();
    const features = featuresWithDraft(activeFeatures(s), draft);
    getKernel()
      .deleteFaceBlockers(features, draft.id, resolveVariables(s.history.present.variables).values)
      .then((result) => live && setAnswer({ key, result }))
      .catch(() => live && setAnswer({ key, result: null }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!draft || dismissed === key || answer?.key !== key || !answer.result) return null;
  const { blockers, makers } = answer.result;
  const names = (ids: string[]) => ids.map((id) => activeFeatures(useStore.getState()).find((f) => f.id === id)?.name ?? "a feature");
  const close = () => setDismissed(key);

  if (makers.length) {
    const made = nameList(names(makers));
    return (
      <Modal
        title="This is a rounded face"
        onClose={close}
        width={460}
        footer={
          <>
            <button type="button" className="text-button" onClick={close}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={() => suppressThenFinish(makers, false)}>
              Turn off {made}
            </button>
          </>
        }
      >
        <p>
          The face you picked was made by <strong>{made}</strong>. Delete face can't remove it, but turning {made} off takes the rounding away (you can turn it back
          on later from the feature list).
        </p>
      </Modal>
    );
  }
  if (blockers.length) {
    const inWay = nameList(names(blockers));
    const plural = blockers.length > 1;
    return (
      <Modal
        title="Fillets or chamfers are in the way"
        onClose={close}
        width={460}
        footer={
          <>
            <button type="button" className="text-button" onClick={close}>
              Cancel
            </button>
            <button type="button" className="primary-button" onClick={() => suppressThenFinish(blockers, true)}>
              Turn off and delete
            </button>
          </>
        }
      >
        <p>
          This face touches rounded or bevelled edges made by <strong>{inWay}</strong>, so the gap can't be closed up.
        </p>
        <p>
          Turn {plural ? "them" : "it"} off and delete the face? {plural ? "They stay" : "It stays"} in the feature list, switched off, so you can turn{" "}
          {plural ? "them" : "it"} back on later.
        </p>
      </Modal>
    );
  }
  return null;
}
