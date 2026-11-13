/**
 * Claude's Edit in context (Onshape's): make or update a context for a copy in
 * an assembly — the copy's Part Studio then shows the assembly's other parts
 * round it, where they sit next to that copy, to sketch on, snap to and use
 * edges from — and remove one. The rules are the app's (src/assembly/inContext.ts).
 */
import { removeContext, setContextHidden, takeContext, contextsOf, contextGone } from "../assembly/inContext";
import { studioName } from "../model/studios";
import type { EditContext } from "../model/types";
import { bool, InputError, noExtras } from "./args";
import { ASSEMBLY_REF, assembliesOf, builtParts, findAssembly, findTarget, placementText, solve } from "./assemblyTools";
import type { Session } from "./session";
import { say, type ToolDef } from "./toolKit";

/** One line per other part: where it sits from the edited copy's own origin. */
function partLines(c: EditContext): string[] {
  return c.parts.map((p) => `- ${p.name}: ${placementText(p.placement)} from its origin${p.mirrored ? " (mirrored)" : ""}`);
}

/** A context by its name, or by the copy it's for ("Bracket <1>"). */
function findContext(s: Session, ref: unknown, assembly: unknown): EditContext {
  const list = contextsOf(s.doc);
  if (!list.length) throw new InputError("There are no contexts in this design. Make one with edit_in_context.");
  if (ref === undefined && list.length === 1) return list[0];
  if (typeof ref !== "string" || !ref.trim()) throw new InputError(`context: say which one — ${list.map((c) => `"${c.name}"`).join(", ")}.`);
  const want = ref.trim().toLowerCase();
  const named = list.filter((c) => c.name.toLowerCase() === want || c.id.toLowerCase() === want);
  if (named.length === 1) return named[0];
  // By the copy's name, in the assembly given (or any).
  const asm = assembly !== undefined ? findAssembly(s, assembly) : null;
  const byCopy = list.filter((c) => {
    if (asm && c.assemblyId !== asm.id) return false;
    const a = assembliesOf(s.doc).find((x) => x.id === c.assemblyId);
    const top = a?.instances.find((i) => i.id === c.instance.split("/")[0]);
    return c.name.toLowerCase().endsWith(`(${want})`) || top?.name.toLowerCase() === want;
  });
  if (byCopy.length === 1) return byCopy[0];
  throw new InputError(`context: there's no context called "${ref}"${byCopy.length > 1 ? " (more than one matches: give its full name)" : ""}. The contexts are ${list.map((c) => `"${c.name}"`).join(", ")}.`);
}

export const CONTEXT_TOOLS: ToolDef[] = [
  {
    name: "edit_in_context",
    title: "Edit a part in the context of its assembly",
    description:
      'Onshape\'s Edit in context: make (or update) a context for a copy in an assembly. The copy\'s Part Studio then shows the assembly\'s other parts round it, where they sit next to that copy (faint, for reference), so a sketch there can be drawn on them, snap to them and use their edges in the JuraCAD app — e.g. a bracket\'s holes lined up with the plate it bolts to. It\'s a snapshot: after moving parts in the assembly, call it again (same copy) to update it. Says where each other part sits from the edited part\'s own origin. "instance": the copy ("Bracket <1>", or "Sub <1> / Part <1>" inside a sub-assembly). "hidden": true keeps it but hides its parts (sketches already using them still work). Parts from the copy\'s own Part Studio aren\'t added (they\'re there already). Remove it with remove_context.',
    inputSchema: { type: "object", properties: { assembly: ASSEMBLY_REF, instance: { type: "string" }, hidden: { type: "boolean" } }, required: ["instance"] },
    run: async (s, a) => {
      noExtras(a, ["assembly", "instance", "hidden"], "edit_in_context");
      await s.checkpoint();
      await s.buildAllAsync();
      const asm = findAssembly(s, a.assembly);
      const solved = solve(s, asm);
      const t = findTarget(s, asm, a.instance, "instance", solved);
      const before = contextsOf(s.doc).find((c) => c.assemblyId === asm.id && c.instance === t.leaf.key);
      const r = takeContext(s.doc, asm.id, t.leaf.key, builtParts(s), solved.placements);
      if ("error" in r) throw new InputError(r.error);
      let doc = r.doc;
      let context = r.context;
      if (a.hidden !== undefined && bool(a.hidden, "hidden") !== !!context.hidden) {
        doc = setContextHidden(doc, context.id, bool(a.hidden, "hidden"));
        context = contextsOf(doc).find((c) => c.id === context.id)!;
      }
      s.throwIfCancelled();
      const what = !before ? "Made" : doc === s.doc ? "Nothing had moved since, so kept" : "Updated";
      if (doc !== s.doc) s.commit(doc);
      const studio = studioName(s.wholeDoc(), context.studioId);
      return say(
        `${what} the context "${context.name}": ${t.leaf.name}'s Part Studio "${studio}" shows ${context.parts.length ? `the assembly's other ${context.parts.length === 1 ? "part" : `${context.parts.length} parts`} round it` : "nothing more (the other parts are all in that Part Studio already)"}${context.hidden ? " — hidden for now" : ""}.`,
        ...partLines(context),
      );
    },
  },
  {
    name: "remove_context",
    title: "Remove an Edit in context context",
    description: 'Remove a context made by edit_in_context (or in the app), by its name ("Assembly 1 (Bracket <1>)") or the copy it\'s for ("Bracket <1>"). Its parts stop showing in the Part Studio; sketches that used their edges then say those references are lost.',
    inputSchema: { type: "object", properties: { context: { type: "string" }, assembly: ASSEMBLY_REF }, required: [] },
    run: (s, a) => {
      noExtras(a, ["context", "assembly"], "remove_context");
      const c = findContext(s, a.context, a.assembly);
      const gone = contextGone(s.doc, c);
      s.commit(removeContext(s.doc, c.id));
      return say(`Removed the context "${c.name}"${gone ? " (it showed nothing any more: its assembly or part had gone)" : ""}. Its parts aren't shown in that Part Studio now.`);
    },
  },
];
