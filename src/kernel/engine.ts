/**
 * The geometry engine: turns the feature list into solid parts using
 * OpenCascade (through replicad). Runs inside the Web Worker, and directly in
 * Node for the automated tests.
 */
import { getOC, makeBox, makeCylinder, makeSphere, measureVolume, type Shape3D } from "replicad";

import { analyzeMesh, withoutDegenerateTriangles } from "../geometry/meshCheck";
import { writeBinaryStl } from "../geometry/stl";
import { FEATURE_DEFS, resolveParams } from "../model/features";
import { MESH_TOLERANCES, type Feature, type MeshQuality } from "../model/types";
import type { CheckResult, ExportResult, PartMesh, RebuildResult } from "./protocol";

interface BuiltPart {
  id: string;
  name: string;
  featureIds: string[];
  shape: Shape3D;
}

/** Turn whatever OpenCascade threw into a readable sentence. */
export function describeError(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  // OpenCascade C++ exceptions arrive as WebAssembly exceptions; ask the
  // engine for the original message where it can give one.
  try {
    const WasmException = (globalThis as { WebAssembly?: { Exception?: new (...a: never[]) => unknown } })
      .WebAssembly?.Exception;
    if (WasmException && e instanceof WasmException) {
      type WasmEx = Parameters<ReturnType<typeof getOC>["getExceptionMessage"]>[0];
      const [type, message] = getOC().getExceptionMessage(e as WasmEx);
      if (message || type) return `${fallback} (${[type, message].filter(Boolean).join(": ")})`;
    }
  } catch {
    // fall through to the generic message
  }
  return fallback;
}

function buildSolid(feature: Feature, v: Record<string, number>): Shape3D {
  switch (feature.type) {
    case "box":
      return makeBox([v.x, v.y, v.z], [v.x + v.width, v.y + v.depth, v.z + v.height]);
    case "cylinder":
      return makeCylinder(v.diameter / 2, v.height, [v.x, v.y, v.z], [0, 0, 1]);
    case "sphere":
      return makeSphere(v.diameter / 2).translate([v.x, v.y, v.z]);
  }
}

export class GeometryEngine {
  private parts: BuiltPart[] = [];

  /** Replays the whole feature list from scratch. */
  rebuild(features: Feature[]): RebuildResult {
    const started = performance.now();
    this.disposeParts();
    const featureErrors: Record<string, string> = {};
    let partCounter = 0;

    for (const feature of features) {
      if (feature.suppressed) continue;
      const def = FEATURE_DEFS[feature.type];
      if (!def) {
        featureErrors[feature.id] = "PartSmith doesn't know this kind of feature.";
        continue;
      }

      const { values, errors } = resolveParams(feature);
      const badParam = def.params.find((p) => errors[p.key]);
      if (badParam) {
        featureErrors[feature.id] = `${badParam.label}: ${errors[badParam.key]}`;
        continue;
      }

      const target = this.parts[this.parts.length - 1];
      if (feature.operation !== "new" && !target) {
        featureErrors[feature.id] =
          feature.operation === "add"
            ? "There's no part to add to yet. Use New for the first solid."
            : "There's no part to remove from yet. Use New for the first solid.";
        continue;
      }

      let tool: Shape3D;
      try {
        tool = buildSolid(feature, values);
      } catch (e) {
        featureErrors[feature.id] = describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
        continue;
      }

      if (feature.operation === "new") {
        partCounter++;
        this.parts.push({ id: feature.id, name: `Part ${partCounter}`, featureIds: [feature.id], shape: tool });
        continue;
      }

      try {
        const result = feature.operation === "add" ? target.shape.fuse(tool) : target.shape.cut(tool);
        if (result.solids.length === 0) {
          result.delete();
          throw new Error("This would remove the whole part.");
        }
        target.shape.delete();
        target.shape = result;
        target.featureIds.push(feature.id);
      } catch (e) {
        featureErrors[feature.id] = describeError(
          e,
          feature.operation === "add" ? "Couldn't merge this into the part." : "Couldn't cut this from the part.",
        );
      } finally {
        tool.delete();
      }
    }

    const parts = this.parts.map((p) => this.meshPart(p));
    return { parts, featureErrors, durationMs: Math.round(performance.now() - started) };
  }

  /** Checks every part for printability. */
  check(quality: MeshQuality): CheckResult {
    const oc = getOC();
    const tol = MESH_TOLERANCES[quality];
    return {
      parts: this.parts.map((p) => {
        let geometryValid: boolean | null = null;
        try {
          const analyzer = new oc.BRepCheck_Analyzer(p.shape.wrapped, true, false, false);
          geometryValid = analyzer.IsValid();
          analyzer.delete();
        } catch {
          geometryValid = null;
        }
        let exactVolume: number | null = null;
        try {
          exactVolume = measureVolume(p.shape);
        } catch {
          exactVolume = null;
        }
        const m = p.shape.mesh(tol);
        return { partId: p.id, name: p.name, geometryValid, exactVolume, mesh: analyzeMesh(m.vertices, m.triangles) };
      }),
    };
  }

  /** One binary STL containing the chosen parts (all parts when the list is empty). */
  exportStl(partIds: string[], quality: MeshQuality): ExportResult {
    const tol = MESH_TOLERANCES[quality];
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts;
    if (chosen.length === 0) throw new Error("There's nothing to export yet.");
    const meshes = chosen.map((p) => {
      const m = p.shape.mesh(tol);
      return { vertices: m.vertices, triangles: withoutDegenerateTriangles(m.vertices, m.triangles) };
    });
    const triangleCount = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
    const names = chosen.map((p) => p.name).join(", ");
    return { stl: writeBinaryStl(meshes, `PartSmith export: ${names}`), triangleCount };
  }

  get partCount(): number {
    return this.parts.length;
  }

  dispose(): void {
    this.disposeParts();
  }

  private meshPart(p: BuiltPart): PartMesh {
    const faces = p.shape.mesh(MESH_TOLERANCES.display);
    const edges = p.shape.meshEdges(MESH_TOLERANCES.display);
    return {
      id: p.id,
      name: p.name,
      featureIds: [...p.featureIds],
      vertices: Float32Array.from(faces.vertices),
      normals: Float32Array.from(faces.normals),
      triangles: Uint32Array.from(faces.triangles),
      faceGroups: faces.faceGroups,
      lines: Float32Array.from(edges.lines),
      edgeGroups: edges.edgeGroups,
    };
  }

  private disposeParts(): void {
    for (const p of this.parts) {
      try {
        p.shape.delete();
      } catch {
        // already freed
      }
    }
    this.parts = [];
  }
}
