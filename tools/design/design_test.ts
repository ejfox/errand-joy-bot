// tools/design tests: STL parse / analyze / validate, and the box generator. No network.
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { checkParams, DEFAULT_BOX, main as boxMain, makeBox } from "./box.ts";
import { analyze, type Mesh, parseStl, type Triangle, validate, writeBinaryStl } from "./stl.ts";
import { main as validateMain } from "./validate_stl.ts";

/** An axis-aligned cube, facets wound outward. */
function cube(s = 10, o = 0): Triangle[] {
  const v = (x: number, y: number, z: number): [number, number, number] => [o + x * s, o + y * s, o + z * s];
  const q = [
    [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
    [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
    [v(1, 1, 0), v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)],
    [v(0, 1, 0), v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)],
  ];
  return q.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]] as Triangle[]);
}

function ascii(tris: Triangle[]): string {
  const f = tris.map((t) =>
    ` facet normal 0 0 0\n  outer loop\n${t.map((v) => `   vertex ${v.join(" ")}`).join("\n")}\n  endloop\n endfacet`
  );
  return `solid test\n${f.join("\n")}\nendsolid test\n`;
}

const mesh = (triangles: Triangle[]): Mesh => ({ triangles, format: "binary" });

Deno.test("stl: binary round trip; header never starts with 'solid'", () => {
  const bytes = writeBinaryStl(cube(), "solid-looking header");
  assertEquals(bytes.length, 84 + 50 * 12);
  assert(!new TextDecoder().decode(bytes.subarray(0, 5)).startsWith("solid"));
  const m = parseStl(bytes);
  assertEquals([m.format, m.triangles.length], ["binary", 12]);
  assertEquals(m.triangles, cube());
});

Deno.test("stl: ASCII parse; junk refused", () => {
  const m = parseStl(new TextEncoder().encode(ascii(cube(5))));
  assertEquals([m.format, m.triangles.length], ["ascii", 12]);
  assertThrows(() => parseStl(new TextEncoder().encode("hello world")));
  assertThrows(() => parseStl(new TextEncoder().encode("solid x\n vertex 0 0 0\n vertex 1 0 0\n")));
});

Deno.test("analyze: a cube is watertight, 1000 mm3, 10mm box", () => {
  const r = analyze(mesh(cube()));
  assert(r.watertight);
  assertEquals([r.triangles, r.vertices, r.shells, r.boundaryEdges, r.nonManifoldEdges, r.misorientedEdges], [12, 8, 1, 0, 0, 0]);
  assertAlmostEquals(r.volumeMm3, 1000, 1e-6);
  assertEquals(r.bbox.size, [10, 10, 10]);
});

Deno.test("analyze: holes, flipped facets, inside-out and non-manifold edges are caught", () => {
  const holed = cube().slice(0, 11);
  const rh = analyze(mesh(holed));
  assert(!rh.watertight && rh.boundaryEdges === 3);

  const flipped = cube();
  flipped[0] = [flipped[0][0], flipped[0][2], flipped[0][1]];
  const rf = analyze(mesh(flipped));
  assert(!rf.watertight && rf.misorientedEdges > 0);

  const inside = cube().map(([a, b, c]) => [a, c, b] as Triangle);
  const ri = analyze(mesh(inside));
  assert(ri.watertight && ri.volumeMm3 < 0);
  assert(!validate(mesh(inside)).ok, "inside-out fails validation");

  // Two cubes sharing an edge: that edge has four facets.
  const shifted = cube().map((t) => t.map(([x, y, z]) => [x + 10, y + 10, z]) as Triangle);
  const touching = [...cube(), ...shifted];
  const rt = analyze(mesh(touching));
  assert(rt.nonManifoldEdges > 0 && !rt.watertight);

  // Two separate cubes: watertight, two shells, double volume.
  const two = [...cube(), ...cube(10, 30)];
  const r2 = analyze(mesh(two));
  assert(r2.watertight);
  assertEquals(r2.shells, 2);
  assertAlmostEquals(r2.volumeMm3, 2000, 1e-6);
});

Deno.test("validate: bed limit is configurable (default 250mm)", () => {
  assert(validate(mesh(cube(200))).ok);
  const big = validate(mesh(cube(260)));
  assert(!big.ok && big.problems.some((p) => p.includes("exceeds bed 250mm")));
  assert(validate(mesh(cube(260)), { bedMm: 300 }).ok);
  assert(!validate(mesh([])).ok);
});

Deno.test("box: base and lid are watertight, one shell each, and the volumes match the analytic math", () => {
  const box = makeBox({ innerW: 60, innerD: 40, innerH: 25 });
  for (const [name, tris, want] of [["base", box.base, box.expected.baseMm3], ["lid", box.lid, box.expected.lidMm3]] as const) {
    // Through the real binary format, as a printer would read it.
    const v = validate(parseStl(writeBinaryStl(tris)));
    assert(v.ok, `${name}: ${v.problems.join("; ")}`);
    assertEquals(v.report.shells, 1, name);
    assertAlmostEquals(v.report.volumeMm3, want, want * 1e-4, name);
  }
  // Independent hand math for the defaults (wall 2, lip 4 high, 1.6 wall, 0.25 clearance).
  assertAlmostEquals(box.expected.baseMm3, 64 * 44 * 27 - 60 * 40 * 25, 1e-6); // 16,032 mm3
  const lipRing = 59.5 * 39.5 - (59.5 - 3.2) * (39.5 - 3.2);
  assertAlmostEquals(box.expected.lidMm3, 64 * 44 * 2 + lipRing * 4, 1e-6);
  const base = analyze(mesh(box.base));
  assertEquals(base.bbox.size.map((n) => Math.round(n * 1000) / 1000), [64, 44, 27]);
  const lid = analyze(mesh(box.lid));
  assertEquals(lid.bbox.size.map((n) => Math.round(n * 1000) / 1000), [64, 44, 6]);
});

Deno.test("box: the lid's lip fits inside the base cavity with the clearance", () => {
  const box = makeBox({ innerW: 50, innerD: 50, innerH: 20, clearance: 0.3 });
  const lid = analyze(mesh(box.lid.filter((t) => t.every((v) => v[2] > box.params.wall))));
  // Lip footprint = cavity minus clearance on each side.
  assertAlmostEquals(lid.bbox.size[0], 50 - 0.6, 1e-4);
  assertAlmostEquals(lid.bbox.size[1], 50 - 0.6, 1e-4);
});

Deno.test("box: screw posts add four closed shells and their volume", () => {
  const box = makeBox({ innerW: 80, innerD: 60, innerH: 30, posts: true });
  const v = validate(mesh(box.base));
  assert(v.ok, v.problems.join("; "));
  assertEquals(v.report.shells, 5);
  assertAlmostEquals(v.report.volumeMm3, box.expected.baseMm3, box.expected.baseMm3 * 1e-4);
  const post = (6 * 6 - 2.5 * 2.5) * 5.5;
  assertAlmostEquals(box.expected.baseMm3, 84 * 64 * 32 - 80 * 60 * 30 + 4 * post, 1e-6);
});

Deno.test("box: bad parameters are refused", () => {
  const ok = { innerW: 60, innerD: 40, innerH: 25, ...DEFAULT_BOX };
  assertEquals(checkParams(ok), []);
  assert(checkParams({ ...ok, wall: 0.8 }).some((e) => e.includes("wall")));
  assert(checkParams({ ...ok, lipHeight: 30 }).length > 0);
  assert(checkParams({ ...ok, innerW: 3 }).length > 0);
  assert(checkParams({ ...ok, posts: true, postHeight: 24 }).some((e) => e.includes("lip")));
  assert(checkParams({ ...ok, innerW: NaN }).length > 0);
  assertThrows(() => makeBox({ innerW: -1, innerD: 40, innerH: 25 }));
});

Deno.test("CLIs: box.ts writes base + lid that validate_stl.ts passes; validate fails a broken file", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "ejb-design-" });
  try {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      assertEquals(await boxMain(["--inner", "60x40x25", "--posts", "--out", `${dir}/test-box`]), 0);
      assertEquals(await validateMain([`${dir}/test-box-base.stl`, `${dir}/test-box-lid.stl`]), 0);
      assertEquals(await validateMain([`${dir}/test-box-base.stl`, "--bed", "50"]), 1, "64mm part on a 50mm bed");
      await Deno.writeFile(`${dir}/broken.stl`, writeBinaryStl(cube().slice(0, 10)));
      assertEquals(await validateMain([`${dir}/broken.stl`]), 1);
      await Deno.writeTextFile(`${dir}/junk.stl`, "not an stl");
      assertEquals(await validateMain([`${dir}/junk.stl`, "--json"]), 1);
      assertEquals(await validateMain([]), 2);
      assertEquals(await boxMain(["--inner", "60x40", "--out", `${dir}/x`]), 2);
      assertEquals(await boxMain(["--inner", "60x40x25", "--wall", "0.5", "--out", `${dir}/x`]), 2);
    } finally {
      console.log = log;
      console.error = err;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
