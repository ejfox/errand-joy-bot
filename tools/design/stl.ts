// STL read / write / analysis. Pure, no network, no dependencies.
// Used by validate_stl.ts and box.ts. The gate does NOT import this (its Docker image ships only
// gate/); the slant3d adapter keeps its own cheap shape check.

export type Vec3 = [number, number, number];
export type Triangle = [Vec3, Vec3, Vec3];

export interface Mesh {
  triangles: Triangle[];
  format: "binary" | "ascii";
}

/** Binary when the size matches the triangle count exactly; otherwise ASCII ("solid … facet …"). */
export function parseStl(bytes: Uint8Array): Mesh {
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + 50 * n === bytes.length) {
      const triangles: Triangle[] = [];
      for (let i = 0; i < n; i++) {
        const o = 84 + 50 * i + 12; // skip the stored normal; winding is what counts
        const v = (k: number): Vec3 => [
          dv.getFloat32(o + 12 * k, true),
          dv.getFloat32(o + 12 * k + 4, true),
          dv.getFloat32(o + 12 * k + 8, true),
        ];
        triangles.push([v(0), v(1), v(2)]);
      }
      return { triangles, format: "binary" };
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid\b/i.test(text)) throw new Error("not an STL: wrong binary size and no ASCII 'solid' header");
  const nums = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const verts: Vec3[] = [];
  for (const m of text.matchAll(nums)) {
    const v = [Number(m[1]), Number(m[2]), Number(m[3])] as Vec3;
    if (!v.every(Number.isFinite)) throw new Error(`bad vertex: ${m[0]}`);
    verts.push(v);
  }
  if (verts.length % 3 !== 0) throw new Error("ASCII STL: vertex count is not a multiple of 3");
  const triangles: Triangle[] = [];
  for (let i = 0; i < verts.length; i += 3) triangles.push([verts[i], verts[i + 1], verts[i + 2]]);
  return { triangles, format: "ascii" };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function normalOf(t: Triangle): Vec3 {
  const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
  const len = Math.hypot(n[0], n[1], n[2]);
  return len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 0];
}

/** Binary STL. The header never starts with "solid" (some readers then mis-detect ASCII). */
export function writeBinaryStl(triangles: Triangle[], header = "errand-joy-bot tools/design"): Uint8Array {
  const buf = new ArrayBuffer(84 + 50 * triangles.length);
  const dv = new DataView(buf);
  const h = new TextEncoder().encode(header.replace(/^solid/i, "_solid")).subarray(0, 80);
  new Uint8Array(buf).set(h, 0);
  dv.setUint32(80, triangles.length, true);
  triangles.forEach((t, i) => {
    const o = 84 + 50 * i;
    const n = normalOf(t);
    [n, ...t].forEach((v, k) => v.forEach((x, j) => dv.setFloat32(o + 12 * k + 4 * j, x, true)));
  });
  return new Uint8Array(buf);
}

export interface MeshReport {
  format: "binary" | "ascii";
  triangles: number;
  vertices: number;
  degenerateTriangles: number;
  bbox: { min: Vec3; max: Vec3; size: Vec3 };
  /** Signed volume in mm³ (divergence theorem). Positive when facets wind outward. */
  volumeMm3: number;
  /** Edges used by exactly one triangle (holes). */
  boundaryEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles traverse them in the same direction (flipped facets). */
  misorientedEdges: number;
  /** Connected pieces (Slant may surcharge multi-body files). */
  shells: number;
  watertight: boolean;
}

/**
 * Vertices are welded by exact float32 coordinate, which is what a binary STL stores. A mesh is
 * watertight when every edge has exactly two facets that traverse it in opposite directions.
 */
export function analyze(mesh: Mesh): MeshReport {
  const f32 = new Float32Array(1);
  const r = (x: number) => (f32[0] = x, f32[0]);
  const ids = new Map<string, number>();
  const id = (v: Vec3) => {
    const k = `${r(v[0])},${r(v[1])},${r(v[2])}`;
    let i = ids.get(k);
    if (i === undefined) ids.set(k, i = ids.size);
    return i;
  };

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let vol6 = 0;
  let degenerate = 0;
  // undirected edge → [count, net direction]; net is ±1 per traversal, 0 when the pair is opposed
  const edges = new Map<string, { count: number; net: number; a: number; b: number }>();
  const tris: number[][] = [];
  for (const t of mesh.triangles) {
    for (const v of t) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
    vol6 += dot(t[0], cross(t[1], t[2]));
    const vi = t.map(id);
    if (vi[0] === vi[1] || vi[1] === vi[2] || vi[0] === vi[2]) {
      degenerate++;
      continue;
    }
    tris.push(vi);
    for (let k = 0; k < 3; k++) {
      const a = vi[k], b = vi[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const e = edges.get(key) ?? { count: 0, net: 0, a: Math.min(a, b), b: Math.max(a, b) };
      e.count++;
      e.net += a < b ? 1 : -1;
      edges.set(key, e);
    }
  }
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (const e of edges.values()) {
    if (e.count === 1) boundary++;
    else if (e.count > 2) nonManifold++;
    else if (e.net !== 0) misoriented++;
  }

  // Shells: union-find over welded vertices of non-degenerate triangles.
  const parent = Array.from({ length: ids.size }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b, c] of tris) {
    parent[find(b)] = find(a);
    parent[find(c)] = find(a);
  }
  const roots = new Set<number>();
  for (const [a] of tris) roots.add(find(a));

  const empty = mesh.triangles.length === 0;
  const volumeMm3 = vol6 / 6;
  return {
    format: mesh.format,
    triangles: mesh.triangles.length,
    vertices: ids.size,
    degenerateTriangles: degenerate,
    bbox: empty
      ? { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }
      : { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    volumeMm3,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    misorientedEdges: misoriented,
    shells: roots.size,
    watertight: !empty && boundary === 0 && nonManifold === 0 && misoriented === 0,
  };
}

export interface ValidateOptions {
  /** Largest allowed extent on any axis, mm. Default 250. */
  bedMm?: number;
}

export interface Validation {
  ok: boolean;
  problems: string[];
  report: MeshReport;
  maxDimensionMm: number;
  bedMm: number;
}

export const DEFAULT_BED_MM = 250;

/** Fail closed: anything that would make a print fail or a quote meaningless is a problem. */
export function validate(mesh: Mesh, opts: ValidateOptions = {}): Validation {
  const bedMm = opts.bedMm ?? DEFAULT_BED_MM;
  const report = analyze(mesh);
  const maxDimensionMm = Math.max(...report.bbox.size);
  const problems: string[] = [];
  if (report.triangles === 0) problems.push("no triangles");
  if (report.boundaryEdges) problems.push(`${report.boundaryEdges} boundary edges (holes)`);
  if (report.nonManifoldEdges) problems.push(`${report.nonManifoldEdges} non-manifold edges`);
  if (report.misorientedEdges) problems.push(`${report.misorientedEdges} edges with flipped facets`);
  if (report.triangles && !(report.volumeMm3 > 0)) problems.push("volume is not positive (inside-out or open mesh)");
  if (maxDimensionMm > bedMm) problems.push(`max dimension ${maxDimensionMm.toFixed(1)}mm exceeds bed ${bedMm}mm`);
  if (report.bbox.min.some((v) => !Number.isFinite(v))) problems.push("non-finite coordinates");
  return { ok: problems.length === 0, problems, report, maxDimensionMm, bedMm };
}
