import { useEffect, useState } from "react";

import { useDocument, useStore } from "../model/store";
import { Icons } from "./icons";

export function TopBar() {
  const doc = useDocument();
  const renameDocument = useStore((s) => s.renameDocument);
  const openDialog = useStore((s) => s.openDialog);
  const newDocument = useStore((s) => s.newDocument);
  const hasParts = useStore((s) => s.parts.length > 0);
  const [name, setName] = useState(doc.name);

  useEffect(() => setName(doc.name), [doc.name]);

  return (
    <header className="topbar">
      <div className="brand" title="PartSmith">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={24} />
        <span>PartSmith</span>
      </div>
      <input
        className="doc-name"
        value={name}
        aria-label="Document name"
        title="Click to rename"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => (name.trim() ? renameDocument(name) : setName(doc.name))}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setName(doc.name);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="phase-badge" title="This is an early version. More tools arrive in each phase.">
        Phase 1 preview
      </span>
      <div className="topbar-spacer" />
      <button
        className="text-button"
        onClick={() => {
          if (doc.features.length === 0 || window.confirm("Start a new, empty part? (You can undo this.)")) newDocument();
        }}
        title="Start a new empty part"
      >
        <Icons.New size={18} /> New
      </button>
      <button className="text-button" onClick={() => openDialog("check")} disabled={!hasParts} title="Check the model is ready to print">
        <Icons.Check size={18} /> Check model
      </button>
      <button className="primary-button" onClick={() => openDialog("export")} disabled={!hasParts} title="Download an STL file for your slicer">
        <Icons.Export size={18} /> Export STL
      </button>
      <button className="icon-button" onClick={() => openDialog("help")} aria-label="Help and shortcuts" title="Help and shortcuts (?)">
        <Icons.Help />
      </button>
    </header>
  );
}
