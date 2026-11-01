/**
 * Versions in the store: they stay put whatever is undone (as in Onshape),
 * stay with their own design across New/Open, and Claude's changes keep them
 * only when they're changes to this design.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import type { DesignVersion, JuraCADDocument } from "../src/model/types";
import { addVersion, removeVersions } from "../src/model/versions";

const s = () => useStore.getState();
const ids = () => (s().history.present.versions ?? []).map((v) => v.id);
const version = (id: string): DesignVersion => ({ id, name: id.toUpperCase(), createdAt: "2026-11-01T10:00:00.000Z", packed: "json:{}" });

function addBox(): string {
  s().startCreate("box");
  expect(s().commitDraft()).toBe(true);
  return s().history.present.features.at(-1)!.id;
}

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, versionView: null, versionCompare: null, selection: [], selectedFeatureId: null });
});

describe("versions aren't undone", () => {
  it("keeps a saved version through undo, redo and a later change", () => {
    addBox();
    s().changeVersions((d) => addVersion(d, version("v1")));
    // Saving a version isn't an undo step.
    expect(s().history.past).toHaveLength(1);
    addBox();
    s().undo();
    s().undo();
    expect(s().history.present.features).toHaveLength(0);
    expect(ids()).toEqual(["v1"]);
    // A new change after undoing (which drops the redo list) still keeps it.
    addBox();
    expect(ids()).toEqual(["v1"]);
    s().redo();
    expect(ids()).toEqual(["v1"]);
  });

  it("a removed version stays removed when undoing", () => {
    addBox();
    s().changeVersions((d) => addVersion(d, version("v1")));
    addBox();
    s().changeVersions((d) => removeVersions(d, ["v1"]));
    s().undo();
    expect(ids()).toEqual([]);
  });

  it("undoing back past Open gives the design before it its own versions, not the opened file's", () => {
    addBox();
    s().changeVersions((d) => addVersion(d, version("mine")));
    const opened: JuraCADDocument = addVersion(emptyDocument("From a file"), version("theirs"));
    s().openDocument(opened, "Other.juracad");
    expect(ids()).toEqual(["theirs"]);
    s().undo();
    expect(s().history.present.name).toBe("Untitled part");
    expect(ids()).toEqual(["mine"]);
    s().redo();
    expect(ids()).toEqual(["theirs"]);
  });

  it("New starts without versions, and Undo brings back the design with its own", () => {
    addBox();
    s().changeVersions((d) => addVersion(d, version("mine")));
    s().newDocument();
    expect(ids()).toEqual([]);
    s().undo();
    expect(ids()).toEqual(["mine"]);
  });
});

describe("Claude's changes and versions", () => {
  it("a change to this design keeps its versions", () => {
    addBox();
    s().changeVersions((d) => addVersion(d, version("mine")));
    const fromClaude = { ...s().history.present, name: "Renamed by Claude" };
    delete (fromClaude as { versions?: unknown }).versions;
    expect(s().applyClaudeChange(fromClaude, "main", "Claude renamed it", false)).toBeNull();
    expect(s().history.present.name).toBe("Renamed by Claude");
    expect(ids()).toEqual(["mine"]);
  });

  it("a new or opened design (replace) doesn't get this design's versions", () => {
    addBox();
    s().changeVersions((d) => addVersion(d, version("mine")));
    expect(s().applyClaudeChange(emptyDocument("Claude's new design"), "main", "New design", true)).toBeNull();
    expect(s().history.present.name).toBe("Claude's new design");
    expect(ids()).toEqual([]);
    // Undo goes back to the design with its versions.
    s().undo();
    expect(ids()).toEqual(["mine"]);
  });

  it("refuses a change while an old version is open", () => {
    addBox();
    s().enterVersionView({ id: "v1", name: "V1", createdAt: "2026-11-01T10:00:00.000Z" }, emptyDocument("Old"));
    const r = s().applyClaudeChange(emptyDocument("x"), "main", "x", false);
    expect(r).toMatch(/old version/);
    s().leaveVersionView();
    expect(s().history.present.features).toHaveLength(1);
  });
});

describe("an old version open to look at", () => {
  it("can't be changed, but its planes can be shown or hidden", () => {
    addBox();
    s().enterVersionView({ id: "v1", name: "V1", createdAt: "2026-11-01T10:00:00.000Z" }, emptyDocument("Old"));
    expect(s().refuseReadOnly()).toBe(true);
    s().startCreate("box");
    expect(s().editing).toBeNull();
    s().toggleDatum("Top");
    expect(s().history.present.hiddenDatums).toEqual(["Top"]);
    s().leaveVersionView();
    expect(s().refuseReadOnly()).toBe(false);
    expect(s().history.present.hiddenDatums).toBeUndefined();
    expect(s().history.present.features).toHaveLength(1);
  });

  it("New and Open stop a comparison", () => {
    s().setVersionCompare({ older: "v1", newer: "now", docs: {}, ghost: true });
    s().newDocument();
    expect(s().versionCompare).toBeNull();
    s().setVersionCompare({ older: "v1", newer: "now", docs: {}, ghost: false });
    s().openDocument(emptyDocument("F"), "F.juracad");
    expect(s().versionCompare).toBeNull();
  });
});
