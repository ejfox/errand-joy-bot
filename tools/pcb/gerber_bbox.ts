// Board size from a Gerber zip: finds the outline layer (X2 Profile attribute, else Edge_Cuts /
// .gko / .gm1 / .gml / "outline" by name) and prints its bounding box in mm and inches, plus the
// OSH Park price for each service.
//
//   deno run --allow-read tools/pcb/gerber_bbox.ts board-gerbers.zip [boards]
//
// The parser lives in gate/adapters/oshpark_gerber.ts (the gate image only ships gate/), so the
// number printed here is exactly the one the oshpark adapter quotes.
import { boardSizeFromZip } from "../../gate/adapters/oshpark_gerber.ts";
import { OSHPARK_SERVICES, oshParkPriceCents } from "../../gate/adapters/oshpark.ts";

export { boardSizeFromZip, findOutline, gerberBboxMm, readZip } from "../../gate/adapters/oshpark_gerber.ts";
export type { BoardSize, Bbox } from "../../gate/adapters/oshpark_gerber.ts";

if (import.meta.main) {
  const [path, boardsArg] = Deno.args;
  if (!path) {
    console.error("usage: deno run --allow-read tools/pcb/gerber_bbox.ts <gerbers.zip> [boards=3]");
    Deno.exit(2);
  }
  const boards = boardsArg ? Number(boardsArg) : 3;
  const size = await boardSizeFromZip(await Deno.readFile(path));
  const prices: Record<string, string> = {};
  for (const svc of Object.keys(OSHPARK_SERVICES)) {
    prices[svc] = `$${(oshParkPriceCents(size.areaSqIn, svc, boards).cents / 100).toFixed(2)}`;
  }
  console.log(JSON.stringify(
    {
      outlineFile: size.outlineFile,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      widthIn: Number(size.widthIn.toFixed(4)),
      heightIn: Number(size.heightIn.toFixed(4)),
      areaSqIn: Number(size.areaSqIn.toFixed(4)),
      boards,
      oshpark: prices,
    },
    null,
    2,
  ));
}
