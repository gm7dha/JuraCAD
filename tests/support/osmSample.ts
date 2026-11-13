/** A small made-up OpenStreetMap file for the tests (osm.test.ts). */
import { gridToLatLon } from "../../src/terrain/osGrid";

export /** A little .osm file round a point on the grid: a path, a stream, a road, a loch with an island, a hut, a peak. */
function sampleOsm(): string {
  const base = { e: 201000, n: 770500 };
  const ll = (de: number, dn: number) => gridToLatLon({ e: base.e + de, n: base.n + dn });
  const nodes: string[] = [];
  let id = 0;
  const node = (de: number, dn: number, tags: Record<string, string> = {}) => {
    const p = ll(de, dn);
    id++;
    const t = Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`);
    nodes.push(t.length ? `<node id="${id}" lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${t.join("")}</node>` : `<node id="${id}" lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"/>`);
    return id;
  };
  const way = (wid: number, refs: number[], tags: Record<string, string>) =>
    `<way id="${wid}">${refs.map((r) => `<nd ref="${r}"/>`).join("")}${Object.entries(tags)
      .map(([k, v]) => `<tag k="${k}" v="${v}"/>`)
      .join("")}</way>`;
  const path = [node(200, 500), node(1500, 1500), node(2600, 1700)];
  const stream = [node(300, 2500), node(1800, 2300), node(3800, 2400)];
  const road = [node(0, 100), node(4000, 150)];
  const lochA = [node(2800, 600), node(3500, 600), node(3500, 1100)];
  const lochB = [lochA[2], node(2800, 1100), lochA[0]];
  const isle = [node(3100, 800), node(3200, 800), node(3200, 900), node(3100, 900)];
  const hut = [node(500, 1000), node(540, 1000), node(540, 1030), node(500, 1030)];
  node(1800, 1000, { natural: "peak", name: "Sgùrr &amp; Beinn", ele: "1044" });
  node(520, 1050, { tourism: "wilderness_hut", name: "CIC Hut" });
  const lo = ll(0, 0);
  const hi = ll(4000, 3000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="openstreetmap-cgimap">
 <bounds minlat="${lo.lat.toFixed(7)}" minlon="${lo.lon.toFixed(7)}" maxlat="${hi.lat.toFixed(7)}" maxlon="${hi.lon.toFixed(7)}"/>
 ${nodes.join("\n ")}
 ${way(1, path, { highway: "footway" })}
 ${way(2, stream, { waterway: "stream" })}
 ${way(3, road, { highway: "unclassified" })}
 ${way(4, lochA, {})}
 ${way(5, lochB, {})}
 ${way(6, [...isle, isle[0]], {})}
 ${way(7, [...hut, hut[0]], { building: "hut" })}
 ${way(8, [path[0], path[1]], { highway: "proposed" })}
 <relation id="1"><member type="way" ref="4" role="outer"/><member type="way" ref="5" role="outer"/><member type="way" ref="6" role="inner"/><tag k="type" v="multipolygon"/><tag k="natural" v="water"/><tag k="name" v="Lochan Meall"/></relation>
</osm>`;
}

/**
 * A bigger made-up map round the same hill (mapMarks.test.ts): what a tidy puzzle keeps — a reservoir, a trunk road, an A road, a long
 * path up the hill in three pieces (with a side path at a junction), a public footpath (a footway) up the other side, a
 * path climbing through a park on the hill (like Arthur's Seat), a flat signed walking route — and what it leaves out: a
 * river, a canal, a riverbank, a tiny pond, a minor road and a slip road, a pavement up the hill, a path in a housing
 * estate, and a long flat farm track.
 */
export function hillOsm(): string {
  const base = { e: 201000, n: 770500 };
  const ll = (de: number, dn: number) => gridToLatLon({ e: base.e + de, n: base.n + dn });
  const nodes: string[] = [];
  const ways: string[] = [];
  let id = 0;
  let wid = 0;
  const node = (de: number, dn: number) => {
    const p = ll(de, dn);
    nodes.push(`<node id="${++id}" lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"/>`);
    return id;
  };
  const way = (refs: number[], tags: Record<string, string>) => {
    ways.push(
      `<way id="${++wid}">${refs.map((r) => `<nd ref="${r}"/>`).join("")}${Object.entries(tags)
        .map(([k, v]) => `<tag k="${k}" v="${v}"/>`)
        .join("")}</way>`,
    );
    return wid;
  };
  const line = (pts: [number, number][], tags: Record<string, string>) => way(pts.map(([e, n]) => node(e, n)), tags);
  const ring = (pts: [number, number][], tags: Record<string, string>) => {
    const refs = pts.map(([e, n]) => node(e, n));
    return way([...refs, refs[0]], tags);
  };
  const box = (e0: number, n0: number, e1: number, n1: number): [number, number][] => [
    [e0, n0],
    [e1, n0],
    [e1, n1],
    [e0, n1],
  ];
  // Kept.
  ring(box(300, 1800, 900, 2200), { landuse: "reservoir", name: "Big Reservoir" });
  line([[0, 100], [2000, 120], [4000, 150]], { highway: "trunk", ref: "A82" });
  line([[0, 1500], [4000, 1550]], { highway: "primary", ref: "A841" });
  // The hill path in three pieces, joined at shared nodes; a side path leaves at the second join.
  const a = node(200, 500);
  const b = node(800, 700);
  const c = node(1300, 850);
  const d = node(1800, 1000);
  way([a, node(500, 600), b], { highway: "path" });
  way([b, c], { highway: "path" });
  way([c, node(1550, 920), d], { highway: "path" });
  way([c, node(1330, 1000)], { highway: "path" });
  const route = line([[100, 2800], [2000, 2820], [3900, 2800]], { highway: "path" });
  // Left out.
  line([[0, 2400], [4000, 2450]], { waterway: "river", name: "River Flow" });
  line([[0, 2300], [4000, 2320]], { waterway: "canal" });
  ring(box(1000, 2380, 1600, 2470), { waterway: "riverbank" });
  ring(box(3000, 2000, 3010, 2010), { natural: "water", water: "pond" });
  line([[0, 300], [4000, 320]], { highway: "unclassified" });
  line([[2000, 120], [2100, 300]], { highway: "trunk_link" });
  line([[1800, 1000], [1800, 2000]], { highway: "footway", footway: "sidewalk" });
  line([[2600, 600], [2300, 850], [2000, 1100]], { highway: "footway", designation: "public_footpath" });
  ring(box(1950, 1250, 2650, 1750), { leisure: "park" });
  line([[2000, 1300], [2300, 1500], [2600, 1700]], { highway: "path" });
  ring(box(3400, 200, 3900, 700), { landuse: "residential" });
  line([[3500, 300], [3800, 600]], { highway: "path" });
  line([[0, 2900], [4000, 2900]], { highway: "track" });
  const lo = ll(0, 0);
  const hi = ll(4000, 3000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
 <bounds minlat="${lo.lat.toFixed(7)}" minlon="${lo.lon.toFixed(7)}" maxlat="${hi.lat.toFixed(7)}" maxlon="${hi.lon.toFixed(7)}"/>
 ${nodes.join("\n ")}
 ${ways.join("\n ")}
 <relation id="1"><member type="way" ref="${route}" role=""/><tag k="type" v="route"/><tag k="route" v="hiking"/><tag k="network" v="lwn"/><tag k="name" v="Loch Walk"/></relation>
</osm>`;
}
