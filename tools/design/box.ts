// Parametric enclosure: an open box (base) and a lid with a locating lip, as two binary STLs.
// No CSG: each part is ONE closed surface built from axis-aligned rectangles (outer walls, inner
// walls, rings and caps) that share exact vertices, so it is watertight by construction.
//
//   deno run --allow-write tools/design/box.ts --inner 60x40x25 [--wall 2] [--lip-height 4] \
//     [--lip-wall 1.6] [--clearance 0.25] [--posts] [--post-size 6] [--post-hole 2.5] \
//     [--post-height 5] --out data/designs/sensor-box
//   → data/designs/sensor-box-base.stl and data/designs/sensor-box-lid.stl
//
// Both parts print flat side down: the base on its floor, the lid on its top plate, lip up.
// Optional screw posts (PCB standoffs) are separate closed tubes that overlap the floor and walls
// by 0.5mm, which slicers merge; validate_stl reports them as extra shells, and Slant 3D may add
// a multi-body charge (its `bodyCount` metric).
import { DEFAULT_BED_MM, type Triangle, validate, type Vec3, writeBinaryStl } from "./stl.ts";

export const MIN_WALL_MM = 1.2; // two FDM perimeters at 0.4mm nozzle, plus margin
const POST_OVERLAP_MM = 0.5;

export interface BoxParams {
  /** Inner cavity width (x), depth (y) and height (z), mm. */
  innerW: number;
  innerD: number;
  innerH: number;
  /** Wall, floor and lid-plate thickness, mm. */
  wall: number;
  /** How far the lid's lip reaches into the base, mm. */
  lipHeight: number;
  /** Lip wall thickness, mm. */
  lipWall: number;
  /** Gap between the lip and the base's inner wall, per side, mm. */
  clearance: number;
  posts: boolean;
  /** Square post outer side, pilot-hole side and height above the floor, mm. */
  postSize: number;
  postHole: number;
  postHeight: number;
}

export const DEFAULT_BOX: Omit<BoxParams, "innerW" | "innerD" | "innerH"> = {
  wall: 2,
  lipHeight: 4,
  lipWall: 1.6,
  clearance: 0.25,
  posts: false,
  postSize: 6,
  postHole: 2.5,
  postHeight: 5,
};

export interface BoxResult {
  params: BoxParams;
  base: Triangle[];
  lid: Triangle[];
  /** Analytic volumes (mm³). With posts, the base figure counts the overlaps twice, like the mesh. */
  expected: { baseMm3: number; lidMm3: number };
  outer: { w: number; d: number; h: number };
}

type Rect = [Vec3, Vec3, Vec3, Vec3]; // counter-clockwise seen from +z

function rect(x0: number, y0: number, x1: number, y1: number, z: number): Rect {
  return [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
}
const at = (r: Rect, z: number): Rect => r.map(([x, y]) => [x, y, z] as Vec3) as Rect;

class Builder {
  readonly tris: Triangle[] = [];
  /** a→b→c→d counter-clockwise seen from outside the solid. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
    this.tris.push([a, b, c], [a, c, d]);
  }
  faceUp(r: Rect) {
    this.quad(r[0], r[1], r[2], r[3]);
  }
  faceDown(r: Rect) {
    this.quad(r[3], r[2], r[1], r[0]);
  }
  /** Walls between two stacked copies of a rectangle, facing away from its centre. */
  wallsOut(lo: Rect, hi: Rect) {
    for (let i = 0; i < 4; i++) this.quad(lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i]);
  }
  /** Walls facing the centre (the inside of a cavity or hole). */
  wallsIn(lo: Rect, hi: Rect) {
    for (let i = 0; i < 4; i++) this.quad(lo[(i + 1) % 4], lo[i], hi[i], hi[(i + 1) % 4]);
  }
  /** Flat ring between an outer and an inner rectangle at the same z. */
  ringUp(o: Rect, inn: Rect) {
    for (let i = 0; i < 4; i++) this.quad(o[i], o[(i + 1) % 4], inn[(i + 1) % 4], inn[i]);
  }
  ringDown(o: Rect, inn: Rect) {
    for (let i = 0; i < 4; i++) this.quad(inn[i], inn[(i + 1) % 4], o[(i + 1) % 4], o[i]);
  }
  /** A closed square tube from z0 to z1 (outer rect o, through-hole rect h). */
  tube(o: Rect, h: Rect, z0: number, z1: number) {
    const o0 = at(o, z0), o1 = at(o, z1), h0 = at(h, z0), h1 = at(h, z1);
    this.wallsOut(o0, o1);
    this.wallsIn(h0, h1);
    this.ringUp(o1, h1);
    this.ringDown(o0, h0);
  }
}

export function checkParams(p: BoxParams): string[] {
  const errs: string[] = [];
  for (const k of ["innerW", "innerD", "innerH", "wall", "lipHeight", "lipWall"] as const) {
    if (!(Number.isFinite(p[k]) && p[k] > 0)) errs.push(`${k} must be > 0`);
  }
  if (!(p.clearance >= 0 && p.clearance <= 2)) errs.push("clearance must be 0-2mm");
  if (p.wall < MIN_WALL_MM) errs.push(`wall must be >= ${MIN_WALL_MM}mm for FDM`);
  if (p.lipWall < MIN_WALL_MM) errs.push(`lipWall must be >= ${MIN_WALL_MM}mm for FDM`);
  if (p.lipHeight >= p.innerH) errs.push("lipHeight must be less than innerH");
  const lipInnerW = p.innerW - 2 * p.clearance - 2 * p.lipWall;
  const lipInnerD = p.innerD - 2 * p.clearance - 2 * p.lipWall;
  if (!(lipInnerW > 0 && lipInnerD > 0)) errs.push("inner size too small for clearance + lip wall");
  if (p.posts) {
    if (!(p.postSize > 0 && p.postHole > 0 && p.postHeight > 0)) errs.push("post sizes must be > 0");
    if (p.postSize - p.postHole < 2 * 0.8) errs.push("post wall (postSize - postHole)/2 must be >= 0.8mm");
    if (p.postHeight + p.lipHeight > p.innerH) errs.push("posts would hit the lid's lip: postHeight + lipHeight > innerH");
    if (2 * (p.postSize - POST_OVERLAP_MM) >= Math.min(p.innerW, p.innerD)) errs.push("posts too big for the cavity");
  }
  return errs;
}

export function makeBox(input: Partial<BoxParams> & Pick<BoxParams, "innerW" | "innerD" | "innerH">): BoxResult {
  const p: BoxParams = { ...DEFAULT_BOX, ...input };
  const errs = checkParams(p);
  if (errs.length) throw new Error(`bad box parameters: ${errs.join("; ")}`);
  const t = p.wall;
  const OW = p.innerW + 2 * t, OD = p.innerD + 2 * t, OH = p.innerH + t;

  // Base: an open-topped cup.
  const b = new Builder();
  const o0 = rect(0, 0, OW, OD, 0), o1 = at(o0, OH);
  const c0 = rect(t, t, t + p.innerW, t + p.innerD, t), c1 = at(c0, OH);
  b.faceDown(o0);
  b.wallsOut(o0, o1);
  b.ringUp(o1, c1);
  b.wallsIn(c0, c1);
  b.faceUp(c0);
  let postsMm3 = 0;
  if (p.posts) {
    const s = p.postSize, h = p.postHole;
    const z0 = t - POST_OVERLAP_MM, z1 = t + p.postHeight;
    const lo = t - POST_OVERLAP_MM; // overlaps the walls too, so the slicer merges it
    const xs = [lo, t + p.innerW + POST_OVERLAP_MM - s], ys = [lo, t + p.innerD + POST_OVERLAP_MM - s];
    for (const x of xs) {
      for (const y of ys) {
        const hx = x + (s - h) / 2, hy = y + (s - h) / 2;
        b.tube(rect(x, y, x + s, y + s, 0), rect(hx, hy, hx + h, hy + h, 0), z0, z1);
        postsMm3 += (s * s - h * h) * (z1 - z0);
      }
    }
  }

  // Lid: a plate with a rectangular lip ring on top (printed this way up, flipped to fit).
  const l = new Builder();
  const lc = t + p.clearance, li = lc + p.lipWall;
  const p0 = rect(0, 0, OW, OD, 0), p1 = at(p0, t);
  const lip1 = rect(lc, lc, OW - lc, OD - lc, t), lip2 = at(lip1, t + p.lipHeight);
  const in1 = rect(li, li, OW - li, OD - li, t), in2 = at(in1, t + p.lipHeight);
  l.faceDown(p0);
  l.wallsOut(p0, p1);
  l.ringUp(p1, lip1);
  l.wallsOut(lip1, lip2);
  l.ringUp(lip2, in2);
  l.wallsIn(in1, in2);
  l.faceUp(in1);

  const lipOuter = (p.innerW - 2 * p.clearance) * (p.innerD - 2 * p.clearance);
  const lipInner = (OW - 2 * li) * (OD - 2 * li);
  return {
    params: p,
    base: b.tris,
    lid: l.tris,
    expected: {
      baseMm3: OW * OD * OH - p.innerW * p.innerD * p.innerH + postsMm3,
      lidMm3: OW * OD * t + (lipOuter - lipInner) * p.lipHeight,
    },
    outer: { w: OW, d: OD, h: OH },
  };
}

function parseArgs(args: string[]): { params: Partial<BoxParams>; out?: string; bed: number } {
  const params: Partial<BoxParams> = {};
  let out: string | undefined;
  let bed = DEFAULT_BED_MM;
  const num = (v: string | undefined, flag: string) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`${flag} needs a number`);
    return n;
  };
  const keys: Record<string, keyof BoxParams> = {
    "--wall": "wall",
    "--lip-height": "lipHeight",
    "--lip-wall": "lipWall",
    "--clearance": "clearance",
    "--post-size": "postSize",
    "--post-hole": "postHole",
    "--post-height": "postHeight",
    "--w": "innerW",
    "--d": "innerD",
    "--h": "innerH",
  };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split("=", 2) as [string, string | undefined];
    const val = () => inline ?? args[++i];
    if (flag === "--inner") {
      const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(val() ?? "");
      if (!m) throw new Error("--inner takes WxDxH in mm, e.g. 60x40x25");
      [params.innerW, params.innerD, params.innerH] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if (flag === "--posts") params.posts = true;
    else if (flag === "--out") out = val();
    else if (flag === "--bed") bed = num(val(), flag);
    else if (Object.hasOwn(keys, flag)) (params as Record<string, number>)[keys[flag]] = num(val(), flag);
    else throw new Error(`unknown flag ${flag}`);
  }
  return { params, out, bed };
}

export async function main(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 2;
  }
  const { params, out, bed } = parsed;
  if (!out || params.innerW === undefined || params.innerD === undefined || params.innerH === undefined) {
    console.error("usage: box.ts --inner WxDxH --out <path-prefix> [--wall 2] [--lip-height 4] [--lip-wall 1.6]");
    console.error("       [--clearance 0.25] [--posts] [--post-size 6] [--post-hole 2.5] [--post-height 5] [--bed 250]");
    return 2;
  }
  let box: BoxResult;
  try {
    box = makeBox(params as BoxParams);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 2;
  }
  const parts = { base: box.base, lid: box.lid };
  let ok = true;
  for (const [name, tris] of Object.entries(parts)) {
    const v = validate({ triangles: tris, format: "binary" }, { bedMm: bed });
    if (!v.ok) {
      ok = false;
      console.error(`${name}: ${v.problems.join("; ")}`);
      continue;
    }
    const path = `${out}-${name}.stl`;
    await Deno.writeFile(path, writeBinaryStl(tris, `errand-joy-bot box ${name}`));
    const s = v.report.bbox.size.map((n) => n.toFixed(1)).join(" x ");
    console.log(`${path}  ${s} mm  ${(v.report.volumeMm3 / 1000).toFixed(2)} cm3  ${v.report.shells} shell(s)`);
  }
  return ok ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
