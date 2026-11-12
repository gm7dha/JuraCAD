import { useDocument, useStore, studioParts } from "../model/store";
import { cutListCsv, frameCutList } from "../model/frame";
import { formatMass, materialOf } from "../model/materials";
import { downloadFile } from "./download";
import { Modal } from "./Modal";

/**
 * Cut list (Onshape's): the frame members of the Part Studio on show, identical ones grouped — profile, cut length,
 * end cuts, how many and what they weigh — and the total length of each profile to buy. Saved as a CSV file for a
 * spreadsheet.
 */
export function CutListDialog() {
  const doc = useDocument();
  const parts = useStore(studioParts);
  const close = () => useStore.getState().openDialog(null);
  const list = frameCutList(parts, doc.materials);
  const assumed = parts.some((p) => p.frame && !doc.materials?.[p.id]);
  const usual = [...new Set(parts.filter((p) => p.frame && !doc.materials?.[p.id]).map((p) => materialOf(p.frame!.usual).label.toLowerCase()))];
  const save = () => downloadFile(new Blob([cutListCsv(list)], { type: "text/csv" }), `${doc.name || "Design"} cut list.csv`, "text/csv");
  return (
    <Modal
      title="Cut list"
      onClose={close}
      width={720}
      footer={
        <>
          <button className="text-button" onClick={save} disabled={!list.rows.length}>
            Save as CSV
          </button>
          <button className="primary-button" onClick={close}>
            Done
          </button>
        </>
      }
    >
      {list.rows.length === 0 ? (
        <p className="muted small">There are no frame members here yet. Make a frame with the Frame tool (sketch the lines first), then its lengths show up here.</p>
      ) : (
        <>
          <p className="small">Each line is a length to cut. Lengths go from the longest point at one end to the longest point at the other; end cuts are how far from square each end is cut.</p>
          <table className="variables-table cut-list-table">
            <thead>
              <tr>
                <th>#</th>
                <th>How many</th>
                <th>Profile</th>
                <th>Length</th>
                <th>Ends</th>
                <th>Each weighs</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r, i) => (
                <tr key={i} title={r.parts.join(", ")}>
                  <td>{i + 1}</td>
                  <td>{r.quantity}</td>
                  <td>{r.profile}</td>
                  <td>
                    {r.length.toFixed(1)} mm{r.curved ? " (along the curve)" : ""}
                  </td>
                  <td>{r.ends}</td>
                  <td>{r.massEach !== undefined ? formatMass(r.massEach) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>To buy</h4>
          <ul className="small">
            {list.totals.map((t) => (
              <li key={t.profile}>
                {t.profile}: {t.quantity} piece{t.quantity === 1 ? "" : "s"}, {(t.length / 1000).toFixed(3)} m in all{t.mass !== undefined ? `, ${formatMass(t.mass)}` : ""}
              </li>
            ))}
          </ul>
          {assumed && (
            <p className="muted small field-note">
              Weights for members with no material set are worked out as {usual.join(" and ")}. Set a part&apos;s material in the Parts list to change it. Add some extra length for the saw cut.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
