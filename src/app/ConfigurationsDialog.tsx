import { useState } from "react";

import { activeConfiguration, nextConfigurationName } from "../model/configurations";
import { useDocument, useStore } from "../model/store";
import { allFeatures } from "../model/studios";
import { Icons } from "./icons";
import { Modal } from "./Modal";

/**
 * Configurations: versions of the design (say Small and Large) kept side by
 * side. Each remembers the variables' values and which features are
 * suppressed; picking one shows it. Changes happen straight away (Undo works).
 */
export function ConfigurationsDialog() {
  const doc = useDocument();
  const st = useStore.getState();
  const list = doc.configurations ?? [];
  const active = activeConfiguration(doc);
  const [name, setName] = useState(() => (list.length ? nextConfigurationName(doc) : "Configuration 2"));
  const variables = doc.variables ?? [];
  const features = allFeatures(doc);
  const close = () => st.openDialog(null);
  const add = () => {
    st.addConfiguration(name);
    setName(nextConfigurationName(useStore.getState().history.present));
  };

  return (
    <Modal
      title="Configurations"
      onClose={close}
      width={620}
      footer={
        <button className="primary-button" onClick={close}>
          Done
        </button>
      }
    >
      <p className="small">
        Keep different versions of this design side by side — for example a <strong>Small</strong> and a <strong>Large</strong> one. Each
        configuration remembers the values of your <strong>variables</strong> and which features are <strong>suppressed</strong>. Pick one to
        show it; change the variables or suppress features while it's showing and it remembers that.
      </p>
      {list.length === 0 ? (
        <p className="muted small">
          No configurations yet. Adding one keeps what you have now as <strong>Default</strong> and starts the new one as a copy of it.
        </p>
      ) : (
        <table className="variables-table configurations-table">
          <thead>
            <tr>
              <th>Showing</th>
              <th>Name</th>
              <th>What's different</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const showing = c.id === active?.id;
              // Compare with the one showing (using the live document for it).
              const values = showing ? Object.fromEntries(variables.map((v) => [v.id, v.value])) : c.values;
              const off = new Set(showing ? features.filter((f) => f.suppressed).map((f) => f.id) : c.suppressed);
              const summary = [
                ...variables.filter((v) => values[v.id] !== undefined).map((v) => `${v.name} = ${values[v.id]}`),
                ...features.filter((f) => off.has(f.id)).map((f) => `${f.name} off`),
              ].join(", ");
              return (
                <tr key={c.id} className={showing ? "active" : ""}>
                  <td>
                    <input type="radio" name="configuration" checked={showing} onChange={() => st.switchConfiguration(c.id)} aria-label={`Show ${c.name}`} />
                  </td>
                  <td>
                    <input
                      defaultValue={c.name}
                      aria-label="Configuration name"
                      spellCheck={false}
                      onBlur={(e) => e.target.value.trim() !== c.name && st.renameConfiguration(c.id, e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </td>
                  <td className="variable-result small">{summary || <span className="muted">—</span>}</td>
                  <td className="variable-actions">
                    <button className="icon-button small" onClick={() => st.removeConfiguration(c.id)} aria-label={`Delete ${c.name}`} title="Delete this configuration (the design stays as it is now)">
                      <Icons.Trash size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="configuration-add">
        <input value={name} aria-label="New configuration name" spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="text-button" onClick={add}>
          + Add configuration
        </button>
      </div>
      {variables.length === 0 && <p className="muted small">Tip: make some Variables first (sizes with names) — configurations are most useful for changing them.</p>}
    </Modal>
  );
}
