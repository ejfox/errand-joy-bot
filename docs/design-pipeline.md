# Design pipeline: from a box the robot designs to a 3D print at the door

```
design  →  validate_stl  →  request_purchase (vendor "slant3d")  →  gate quote, tier, DM  →  place  →  status
```

The agent never talks to Slant 3D. It writes a design file, checks it, and asks the gate. The
gate quotes it (a free draft order), applies every cap and tier as for any other purchase, and
only then processes the order. See [vendors.md](vendors.md#slant-3d-3d-printing) for the adapter.

## 1. Design

Put files in `$DATA_DIR/designs/` on the gate host (or at an https URL the gate host can fetch and
that is in its `--allow-net`). Units are millimetres; Slant prints them as they are.

**Boxes and enclosures: `tools/design/box.ts`.** A parametric enclosure: an open base and a lid
with a locating lip, as two binary STLs. No CAD install needed, no network.

```sh
deno task design:box --inner 60x40x25 --out "$DATA_DIR/designs/sensor-box"
# → sensor-box-base.stl (64 x 44 x 27 mm) and sensor-box-lid.stl (64 x 44 x 6 mm)
```

| Flag | Default | What |
|---|---|---|
| `--inner WxDxH` | required | cavity size, mm |
| `--wall` | 2 | wall, floor and lid-plate thickness (min 1.2) |
| `--lip-height` | 4 | how far the lid's lip drops into the base |
| `--lip-wall` | 1.6 | lip thickness (min 1.2) |
| `--clearance` | 0.25 | gap between lip and inner wall, per side. 0.2-0.3 suits FDM; raise it for a looser lid |
| `--posts` | off | four square screw posts (PCB standoffs) in the inner corners |
| `--post-size` / `--post-hole` / `--post-height` | 6 / 2.5 / 5 | post side, pilot hole, height above the floor |
| `--bed` | 250 | refuse parts larger than this on any axis |

Each part is one closed surface made from rectangles that share exact vertices, so it is
watertight by construction and checked again before writing. Both parts print flat side down.
Posts are separate closed tubes overlapping the floor and walls by 0.5 mm, which slicers merge;
they show up as extra shells, and Slant may charge a multi-body fee (its `bodyCount`). Size the
cavity from the board: board outline + 1 mm per side, height = tallest part + standoff + 2 mm.

**Anything else:**

- **Blender** (headless): `blender -b model.blend --python-expr "import bpy; bpy.ops.wm.stl_export(filepath='out.stl', apply_modifiers=True)"`
  (Blender 4.2+; older versions use `bpy.ops.export_mesh.stl`). Apply scale first: Blender units
  are metres unless the scene is set to millimetres, and a 0.06 "m" box becomes a 0.06 mm print.
- **OpenSCAD** if installed: `openscad -o part.stl part.scad`. YAPP_Box is a good PCB-first
  enclosure library. Without a local OpenSCAD, Slant's `POST /files/openScad` turns SCAD source into
  an STL (5 per hour), but that is a vendor call: only the gate holds the key, so it is not wired up.
- **build123d / CadQuery** (Python) when the geometry has to be computed, e.g. a lid that fits a
  KiCad STEP export.

## 2. Validate

```sh
deno task design:validate "$DATA_DIR/designs/sensor-box-base.stl" "$DATA_DIR/designs/sensor-box-lid.stl"
```

`tools/design/validate_stl.ts` parses binary and ASCII STL and reports the triangle count, the
bounding box in mm, the approximate volume (cm³) and the shell count. It checks that the mesh is
watertight: every edge shared by exactly two facets that run it in opposite directions, with a
positive volume (not inside out). It also checks the largest dimension against the bed (`--bed`,
default 250 mm). It exits 1 if any file fails, and `--json` prints machine-readable output.
**Don't request a print for a file that fails.** Fix the model instead: a hole or flipped facet
can make the quote meaningless or the print fail.

It does not check wall thickness or overhangs. Keep walls at least 1.2 mm (two perimeters) and
design to print without supports where you can; Slant decides on supports at upload and prices
them in.

The gate does its own cheap check too: the file must look like an STL (binary size matches, or
ASCII `solid … facet … vertex`) or a 3MF (zip), be at most 50 MB, and for local files resolve
inside `$DATA_DIR/designs`.

## 3. Request

One item per part. `sku` is the material and color, `url` the design:

```json
{
  "vendor": "slant3d",
  "items": [
    { "sku": "PLA:black", "qty": 1, "title": "sensor box base", "url": "sensor-box-base.stl" },
    { "sku": "PLA:black", "qty": 1, "title": "sensor box lid", "url": "sensor-box-lid.stl" }
  ],
  "reason": "Enclosure for the garden soil sensor so it survives the porch. 60x40x25mm cavity, validated watertight.",
  "reach": "self",
  "maxTotalCents": 2500
}
```

- Materials: `PLA`, `PETG` or `OPM`, then a color as Slant names it (`black`, `matte black`,
  `dark blue` …). An ambiguous color is refused rather than guessed.
- `maxTotalCents` covers print + shipping. The quote is a real Slant draft, so the tier is set by
  the real price. Tiers are the usual ones: a cheap print to the owner's address can be **silent**
  (below the silent threshold, no DM, revealed on delivery), above that it's a veto window or an
  approval tap.
- `shipTo` other than the owner's address works (Slant ships anywhere in the US) but makes the
  request reach `others`, so it always asks.

## 4. After it's placed

`purchase_status` follows the order. Slant's statuses (QUEUED, PRINTING, AWAITING_SHIPMENT …)
read as `open` until `SHIPPED` (with tracking) and `DELIVERED`. Cancelling refunds the order
before production; after that, Slant refunds only.
