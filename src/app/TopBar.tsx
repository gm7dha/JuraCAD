import { useEffect, useState } from "react";

import { useDocument, useStore } from "../model/store";
import { Icons } from "./icons";
import { forgetFile, openFromFile, saveToFile } from "./fileActions";
import { installApp, useCanInstall } from "./install";
import { detectPlatform, shortcut } from "./platform";

export function TopBar() {
  const doc = useDocument();
  const renameDocument = useStore((s) => s.renameDocument);
  const openDialog = useStore((s) => s.openDialog);
  const newDocument = useStore((s) => s.newDocument);
  const hasParts = useStore((s) => s.parts.length > 0);
  const fileName = useStore((s) => s.fileName);
  const unsaved = useStore((s) => s.savedDoc !== s.history.present && s.history.present.features.length > 0);
  const platform = detectPlatform();
  const canInstall = useCanInstall();
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
      <span
        className={`save-state${unsaved ? " unsaved" : ""}`}
        title={
          unsaved
            ? "Your work is kept in this browser, but has changes not yet saved to a file. Click Save to keep a copy on your computer."
            : `Saved to ${fileName}`
        }
      >
        {unsaved ? (fileName ? "Unsaved changes" : "Not saved to a file") : fileName ? `Saved · ${fileName}` : ""}
      </span>
      <span className="phase-badge" title="This is an early version. More tools arrive in each phase.">
        Phase 4 preview
      </span>
      <div className="topbar-spacer" />
      {canInstall && (
        <button className="text-button" onClick={() => void installApp()} title="Install PartSmith as an app on this computer — it then opens in its own window and works offline">
          <Icons.Export size={18} style={{ transform: "rotate(180deg)" }} /> Install app
        </button>
      )}
      <button
        className="text-button"
        onClick={() => {
          if (doc.features.length === 0 || window.confirm("Start a new, empty part? (You can undo this.)")) {
            newDocument();
            forgetFile();
          }
        }}
        title="Start a new empty part"
      >
        <Icons.New size={18} /> New
      </button>
      <button className="text-button" onClick={() => void openFromFile()} title={`Open a .partsmith file (${shortcut(platform, "O")})`}>
        <Icons.Open size={18} /> Open
      </button>
      <button
        className="text-button"
        onClick={() => void saveToFile()}
        title={`Save to a .partsmith file on your computer (${shortcut(platform, "S")}). ${shortcut(platform, "S", { shift: true })} saves a copy under a new name.`}
      >
        <Icons.Save size={18} /> Save
      </button>
      <button className="text-button" onClick={() => openDialog("check")} disabled={!hasParts} title="Check the model is a sound, closed solid before you export it">
        <Icons.Check size={18} /> Check model
      </button>
      <button className="primary-button" onClick={() => openDialog("export")} disabled={!hasParts} title="Download a STEP or STL file to send to a manufacturer or 3D printer">
        <Icons.Export size={18} /> Export
      </button>
      <button className="icon-button" onClick={() => openDialog("help")} aria-label="Help and shortcuts" title="Help and shortcuts (?)">
        <Icons.Help />
      </button>
    </header>
  );
}
