/**
 * Parts in a chosen configuration: an assembly instance can show its part in
 * a configuration other than the one on show in the Part Studio (a Small and
 * a Large bracket side by side). Those parts are built separately and named
 * "<part id>@<configuration id>"; when an instance's configuration is the one
 * on show, the ordinary part is used.
 */
import { activeConfiguration } from "../model/configurations";
import { studioOfFeature } from "../model/studios";
import type { Instance, PartSmithDocument } from "../model/types";

/** The id of the part (as built) an instance shows. */
export const meshIdOf = (i: Pick<Instance, "partId" | "configuration">): string => (i.configuration ? `${i.partId}@${i.configuration}` : i.partId);

/** A built part by id — a configured one, or (when that configuration is the one on show) the ordinary part. */
export function findMesh<T extends { id: string }>(parts: readonly T[], id: string): T | undefined {
  const exact = parts.find((p) => p.id === id);
  if (exact) return exact;
  const at = id.indexOf("@");
  return at > 0 ? parts.find((p) => p.id === id.slice(0, at)) : undefined;
}

/** The Part Studios to build in other configurations: (studio, configuration) pairs used by instances, other than the one on show. */
export function configurationsInUse(doc: PartSmithDocument): { studioId: string; configurationId: string }[] {
  const shown = activeConfiguration(doc)?.id;
  const known = new Set((doc.configurations ?? []).map((c) => c.id));
  const out: { studioId: string; configurationId: string }[] = [];
  for (const a of doc.assemblies ?? []) {
    for (const i of a.instances) {
      const cfg = i.configuration;
      if (!cfg || cfg === shown || !known.has(cfg)) continue;
      const studioId = studioOfFeature(doc, i.partId);
      if (studioId && !out.some((o) => o.studioId === studioId && o.configurationId === cfg)) out.push({ studioId, configurationId: cfg });
    }
  }
  return out;
}

/** "Bracket (Large)" — a part's name with its configuration, when it has one. */
export function configuredName(doc: PartSmithDocument, name: string, configuration?: string): string {
  const c = configuration ? doc.configurations?.find((x) => x.id === configuration) : undefined;
  return c ? `${name} (${c.name})` : name;
}
