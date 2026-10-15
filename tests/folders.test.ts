import { describe, expect, it } from "vitest";

import { emptyDocument, nextFolderName, parseDocument, renameFolder, setFolder } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import type { Feature, PartSmithDocument } from "../src/model/types";

const box = (id: string): Feature => ({ id, name: id, type: "box", operation: "new", suppressed: false, params: defaultParams("box") });
const doc = (): PartSmithDocument => ({ ...emptyDocument(), features: [box("a"), box("b"), box("c")] });

describe("feature list folders", () => {
  it("puts features in a folder, renames it and takes them out", () => {
    let d = setFolder(doc(), ["a", "b"], "  Base  ");
    expect(d.features.map((f) => f.folder)).toEqual(["Base", "Base", undefined]);
    d = renameFolder(d, "Base", "Mounting");
    expect(d.features.map((f) => f.folder)).toEqual(["Mounting", "Mounting", undefined]);
    expect(nextFolderName(d.features)).toBe("Folder 1");
    d = setFolder(d, ["a"], null);
    expect("folder" in d.features[0]).toBe(false);
    // Saved and opened again.
    expect(parseDocument(JSON.parse(JSON.stringify(d)))!.features.map((f) => f.folder)).toEqual([undefined, "Mounting", undefined]);
  });
});
