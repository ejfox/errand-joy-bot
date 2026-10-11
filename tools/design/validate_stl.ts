// Validate an STL before any money call: parse (binary or ASCII), measure, check it is watertight
// (every edge shared by exactly two facets, opposite directions) and that it fits the bed.
//
//   deno run --allow-read tools/design/validate_stl.ts part.stl [more.stl] [--bed 250] [--json]
//
// Exit 0 when every file passes, 1 when any fails, 2 on bad usage.
import { DEFAULT_BED_MM, parseStl, validate, type Validation } from "./stl.ts";

export function formatValidation(path: string, v: Validation): string {
  const r = v.report;
  const mm = (n: number) => n.toFixed(2);
  return [
    `${v.ok ? "PASS" : "FAIL"} ${path}`,
    `  format       ${r.format}, ${r.triangles} triangles, ${r.vertices} vertices, ${r.shells} shell(s)`,
    `  bbox (mm)    ${mm(r.bbox.size[0])} x ${mm(r.bbox.size[1])} x ${mm(r.bbox.size[2])}` +
    `  (min ${r.bbox.min.map(mm).join(", ")})`,
    `  volume       ${(r.volumeMm3 / 1000).toFixed(3)} cm3 (${mm(r.volumeMm3)} mm3, approximate)`,
    `  watertight   ${r.watertight ? "yes" : "no"} (boundary ${r.boundaryEdges}, non-manifold ${r.nonManifoldEdges}, ` +
    `flipped ${r.misorientedEdges}, degenerate tris ${r.degenerateTriangles})`,
    `  max dim      ${mm(v.maxDimensionMm)} mm vs bed ${v.bedMm} mm`,
    ...v.problems.map((p) => `  problem      ${p}`),
  ].join("\n");
}

export async function main(args: string[]): Promise<number> {
  const files: string[] = [];
  let bedMm = DEFAULT_BED_MM;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--bed" || a.startsWith("--bed=")) {
      const v = Number(a.includes("=") ? a.split("=")[1] : args[++i]);
      if (!(v > 0)) {
        console.error("--bed needs a positive number of mm");
        return 2;
      }
      bedMm = v;
    } else if (a === "-h" || a === "--help") {
      console.log("usage: validate_stl.ts <file.stl>... [--bed 250] [--json]");
      return 0;
    } else files.push(a);
  }
  if (!files.length) {
    console.error("usage: validate_stl.ts <file.stl>... [--bed 250] [--json]");
    return 2;
  }
  let failed = 0;
  const out: unknown[] = [];
  for (const f of files) {
    let v: Validation;
    try {
      v = validate(parseStl(await Deno.readFile(f)), { bedMm });
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      if (json) out.push({ file: f, ok: false, problems: [msg] });
      else console.log(`FAIL ${f}\n  problem      ${msg}`);
      continue;
    }
    if (!v.ok) failed++;
    if (json) out.push({ file: f, ...v });
    else console.log(formatValidation(f, v));
  }
  if (json) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
  return failed ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
