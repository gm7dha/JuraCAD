/**
 * The Design library for Claude: list the ready-made designs and insert one
 * into the Part Studio on show, as the app's Design library does (ordinary
 * features driven by prefixed variables).
 */
import { firstStudioId } from "../model/studios";
import type { JuraCADDocument } from "../model/types";
import { categoryFrom, categoryLabel, completeValues, designsIn, findDesign, insertDesign, LIBRARY, LIBRARY_CATEGORIES, valueProblems } from "../library/insert";
import type { DesignInput } from "../library/types";
import { InputError, noExtras, object, type Obj } from "./args";
import type { Session } from "./session";
import { say, type ToolDef } from "./toolKit";

type TryChange = (s: Session, next: JuraCADDocument, featureId: string | null, verb: string) => Promise<string[]>;

function describeInput(i: DesignInput): string {
  const what =
    i.kind === "text"
      ? `words${i.multiline ? ', several lines split by "\\n"' : ", one line"}, up to ${i.maxLength ?? 60} letters${i.optional ? ", may be empty" : ""}, default ${JSON.stringify(i.default)}`
      : i.kind === "toggle"
      ? `true/false, default ${i.default}`
      : i.kind === "choice"
        ? `one of ${i.choices!.map((c) => `"${c.value}" (${c.label})`).join(", ")}, default "${i.default}"`
        : `${i.kind === "count" ? "a whole number" : "mm"}, default ${i.default}${i.min !== undefined ? `, ${i.min}–${i.max}` : ""}`;
  return `  - ${i.key}: ${i.label} (${what})${i.variable ? " [a variable afterwards]" : ""}${i.help ? ` — ${i.help}` : ""}`;
}

function findByName(ref: unknown) {
  if (typeof ref !== "string" || !ref.trim()) throw new InputError(`"design" is missing: give one of ${LIBRARY.map((d) => `"${d.id}"`).join(", ")} (see list_library_designs).`);
  const want = ref.trim().toLowerCase();
  const d = findDesign(want) ?? LIBRARY.find((x) => x.name.toLowerCase() === want);
  if (!d) throw new InputError(`There's no library design "${ref}". The designs are: ${LIBRARY.map((x) => `${x.id} (${x.name})`).join(", ")}.`);
  return d;
}

export function libraryTools(tryChange: TryChange): ToolDef[] {
  return [
    {
      name: "list_library_designs",
      title: "List the Design library",
      description:
        `List JuraCAD's Design library: ready-made designs in two sections — ${LIBRARY_CATEGORIES.map((c) => `"${c.id}" (${c.label}: ${designsIn(c.id).map((d) => d.name.toLowerCase()).join(", ")})`).join(" and ")} — with the sizes and choices each takes. Give "category" to list one section only. Insert one with insert_library_design.`,
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { category: { type: "string", enum: LIBRARY_CATEGORIES.map((c) => c.id), description: 'Only this section: "laser" (Laser cutting) or "print" (3D printing). Leave out for both.' } },
      },
      run: (_s, a) => {
        noExtras(a, ["category"], "list_library_designs");
        const only = a.category === undefined || a.category === null ? null : categoryFrom(a.category);
        if (a.category !== undefined && a.category !== null && !only) throw new InputError(`category: give "laser" (Laser cutting) or "print" (3D printing), or leave it out for both.`);
        const sections = LIBRARY_CATEGORIES.filter((c) => !only || c.id === only);
        return say(
          ...sections.flatMap((c) => [
            `${c.label} (category "${c.id}"):`,
            ...LIBRARY.filter((d) => d.category === c.id).flatMap((d) => [`${d.id} — ${d.name} [${categoryLabel(d.category)}${d.group ? ` › ${d.group}` : ""}]: ${d.description}`, ...d.inputs.map(describeInput)]),
          ]),
          "Sizes marked [a variable afterwards] become variables named <prefix>_<key> (e.g. box_width), so set_variables changes them later and the design follows.",
        );
      },
    },
    {
      name: "insert_library_design",
      title: "Insert a library design",
      description:
        'Insert a ready-made design from the Design library into the Part Studio on show, as ordinary editable features (sketches with dimensions, extrudes…) driven by new variables named <prefix>_<size>, e.g. {"design":"finger-box","sizes":{"width":150,"depth":100,"height":60,"thickness":3,"lid":false}} or {"design":"stencil","sizes":{"words":"HELLO","height":40}} (words are text: "\\n" starts a new line where the design allows it). Sizes left out take their defaults (see list_library_designs). A second copy gets its own variables (box2_…). If the sizes don\'t work, nothing is added and the reason is given.',
      inputSchema: {
        type: "object",
        properties: {
          design: { type: "string", enum: LIBRARY.map((d) => d.id), description: "Which design (see list_library_designs)." },
          sizes: { type: "object", description: "The design's sizes and choices by key, e.g. {\"width\": 150}." },
        },
        required: ["design"],
      },
      run: async (s, a: Obj) => {
        noExtras(a, ["design", "sizes"], "insert_library_design");
        const design = findByName(a.design);
        const given = a.sizes === undefined || a.sizes === null ? {} : object(a.sizes, "sizes");
        const unknown = Object.keys(given).filter((k) => !design.inputs.some((i) => i.key === k));
        if (unknown.length) throw new InputError(`sizes: ${design.name} has no ${unknown.map((k) => `"${k}"`).join(", ")}. Its sizes are: ${design.inputs.map((i) => i.key).join(", ")}.`);
        const values = completeValues(design, given);
        const problems = valueProblems(design, values);
        if (problems.length) throw new InputError(`Couldn't insert the ${design.name.toLowerCase()}: ${problems.join(" ")} Nothing was changed.`);
        // The session's design is the Part Studio on show (its features are `features`).
        const made = insertDesign(s.doc, design, values, { into: firstStudioId(s.doc) });
        const report = await tryChange(s, made.doc, null, `insert the ${design.name.toLowerCase()}`);
        const vars = (made.doc.variables ?? []).filter((v) => v.name.startsWith(`${made.insert.prefix}_`));
        return say(
          `Inserted ${made.insert.name}: ${made.insert.features.length} features in the folder "${made.insert.name}".`,
          `Its variables: ${vars.map((v) => `${v.name} = ${v.value}`).join(", ")} — change them with set_variables and the design follows.`,
          design.summary?.(values) ?? null,
          ...report,
        );
      },
    },
  ];
}
