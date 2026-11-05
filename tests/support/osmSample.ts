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
