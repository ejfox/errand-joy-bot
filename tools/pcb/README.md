# tools/pcb: the robot's PCB pipeline

From a KiCad board to a priced OSH Park request. The robot never pays for boards: OSH Park
has no order API, so the gate uploads the design and the owner does the checkout.

## 1. Export Gerbers and drills (KiCad 8+ CLI)

```sh
mkdir -p out/gerbers
kicad-cli pcb export gerbers --output out/gerbers/ board.kicad_pcb
kicad-cli pcb export drill   --output out/gerbers/ board.kicad_pcb
```

`export gerbers` writes every enabled layer, including `Edge.Cuts` (the board outline). Pass
`--layers F.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,Edge.Cuts` to limit it. The drill
export defaults to Excellon, which OSH Park reads.

## 2. Zip

```sh
(cd out/gerbers && zip -q ../board-gerbers.zip *)
```

## 3. Measure and price

```sh
deno run --allow-read tools/pcb/gerber_bbox.ts out/board-gerbers.zip 3
```

It finds the outline layer (the Gerber X2 `Profile` attribute KiCad writes, otherwise a file
named `*Edge_Cuts*`, `*.gko`, `*.gm1`, `*.gml` or `*outline*`), follows its draws and arcs, and
prints the bounding box in mm and inches plus the OSH Park price for each service. This is the
same code the gate's `oshpark` adapter quotes with (`gate/adapters/oshpark_gerber.ts`), so the
number matches.

OSH Park bills the rectangular bounding box: **$5 per sq in per set of 3** for 2-layer
(prototype, After Dark, 2oz 0.8mm), $10 for 2-layer Super Swift and 4-layer, $20 for 4-layer
Super Swift, $15 for 6-layer. Free shipping. A 50×50mm board is 3.875 sq in, so $19.38 for 3.

## 4. Ask the gate

Copy the zip under the gate's `$DATA_DIR/designs/` (the adapter refuses any path outside it),
then `request_purchase` with vendor `oshpark`:

```json
{
  "vendor": "oshpark",
  "items": [{ "sku": "2layer", "qty": 3, "title": "sensor breakout", "url": "board-gerbers.zip" }],
  "reach": "self",
  "maxTotalCents": 2500,
  "reason": "..."
}
```

- `sku` is the service: `2layer`, `2layer-swift`, `2layer-2oz`, `2layer-afterdark`, `4layer`,
  `4layer-swift`, `6layer`. Flex (suspended) and Medium Run are not offered.
- `qty` is boards, rounded up to whole sets of 3 (max 30). One board design per request.
- The quote binds the zip's sha256; if the file changes before placing, the gate refuses.

What happens next: once the gate approves, it uploads the zip to OSH Park's anonymous import
endpoint and records an order with $0 charged. The owner gets a "needs you" DM; the upload link
(`https://oshpark.com/uploads/<token>`) is on the request (`GET /api/requests/:id`). **The owner
opens it, checks the render, and orders and pays on oshpark.com.** When the boards arrive:
`touch $DATA_DIR/oshpark/<token>.delivered` (or `.cancelled` if they never order).

## Future: auto-pay

PCBWay has a partner API (`PcbQuotation`, `PlaceOrder`, `ConfirmOrder` against a prepaid
balance, `CancelOrder`, `QueryOrderProcess`). Access is approved case by case
(anson@pcbway.com). With it, the robot could quote and pay for boards under the gate's normal
caps, and the prepaid balance would be a vendor-side hard cap. Landed cost from China now
includes US duty (roughly $30-60 for a small 2-layer job).
