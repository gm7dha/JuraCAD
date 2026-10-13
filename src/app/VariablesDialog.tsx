import { useMemo, useState } from "react";

import { newId } from "../model/document";
import { formatMm } from "../model/expr";
import { useDocument, useStore } from "../model/store";
import { resolveVariables, usageCount, type Variable } from "../model/variables";
import { Icons } from "./icons";
import { Modal } from "./Modal";

/** A free name like "size1", "size2"… */
function freeName(rows: Variable[]): string {
  let n = rows.length + 1;
  while (rows.some((r) => r.name === `size${n}`)) n++;
  return `size${n}`;
}

/**
 * The variable table (like Onshape's): named sizes you can type into any box,
 * dimension or other variable. Changes are kept only when you click Done.
 */
export function VariablesDialog() {
  const doc = useDocument();
  const openDialog = useStore((s) => s.openDialog);
  const setVariables = useStore((s) => s.setVariables);
  const [rows, setRows] = useState<Variable[]>(() => doc.variables ?? []);
  const { values, errors } = useMemo(() => resolveVariables(rows), [rows]);
  const hasErrors = Object.keys(errors).length > 0;
  const changed = JSON.stringify(rows) !== JSON.stringify(doc.variables ?? []);

  const close = () => openDialog(null);
  const update = (id: string, patch: Partial<Variable>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) =>
    setRows((rs) => {
      const j = i + by;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const done = () => {
    if (changed) setVariables(rows);
    close();
  };

  return (
    <Modal
      title="Variables"
      onClose={close}
      width={620}
      footer={
        <>
          <button className="text-button" onClick={close}>
            Cancel
          </button>
          <button className="primary-button" onClick={done} disabled={hasErrors} title={hasErrors ? "Fix the highlighted rows first" : undefined}>
            Done
          </button>
        </>
      }
    >
      <p className="small">
        Give a size a name, then type the name into any box or sketch dimension — for example <kbd>wall</kbd> or{" "}
        <kbd>wall * 2 + 1</kbd>. Change the value here and everything that uses it updates. A variable can use the ones
        above it.
      </p>
      {rows.length === 0 ? (
        <p className="muted small">No variables yet.</p>
      ) : (
        <table className="variables-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Works out as</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((v, i) => {
              const original = doc.variables?.find((o) => o.id === v.id);
              const used = original ? usageCount(doc, original.name) : 0;
              const error = errors[v.id];
              return (
                <tr key={v.id} className={error ? "invalid" : ""}>
                  <td>
                    <input value={v.name} aria-label="Variable name" spellCheck={false} onChange={(e) => update(v.id, { name: e.target.value.trim() })} />
                  </td>
                  <td>
                    <input value={v.value} aria-label={`Value of ${v.name}`} spellCheck={false} onChange={(e) => update(v.id, { value: e.target.value })} />
                  </td>
                  <td className="variable-result">
                    {error ? (
                      <span className="error-text">{error}</span>
                    ) : (
                      <>
                        {formatMm(values[v.name])}
                        {used > 0 && <span className="muted"> · used {used}×</span>}
                      </>
                    )}
                  </td>
                  <td className="variable-actions">
                    <button className="icon-button small" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" title="Move up">
                      ↑
                    </button>
                    <button className="icon-button small" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down" title="Move down">
                      ↓
                    </button>
                    <button
                      className="icon-button small"
                      onClick={() => setRows((rs) => rs.filter((r) => r.id !== v.id))}
                      aria-label={`Delete ${v.name}`}
                      title={used > 0 ? `Delete — ${used} box${used > 1 ? "es use" : " uses"} it and will show an error` : "Delete"}
                    >
                      <Icons.Trash size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button className="text-button add-variable" onClick={() => setRows((rs) => [...rs, { id: newId("v"), name: freeName(rs), value: "10" }])}>
        + Add variable
      </button>
      <p className="muted small">Renaming a variable updates every box that uses it. Values are in millimetres unless you add a unit, e.g. 1/4 in.</p>
    </Modal>
  );
}
