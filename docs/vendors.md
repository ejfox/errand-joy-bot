# Vendors

A vendor is a code adapter, not a config entry. The allowlist is closed: the gate only
buys from adapters registered in `gate/adapters/registry.ts` **and** listed in
`vendors` in `config.toml`. Adding one is a reviewed code change.

Shipped today: `zinc` (see [Zinc](#zinc-retail-amazon-walmart-target-mcmaster-carr) below),
`slant3d` (see [Slant 3D](#slant-3d-3d-printing)) and
`mock`, a deterministic fake vendor that moves no money. Use the mock for the
rehearsal stage in [runbook.md](runbook.md).

## The adapter interface

Every adapter implements `VendorAdapter` from `gate/types.ts`:

| Member | What it must do |
|---|---|
| `id` | the vendor name used in requests and in `config.toml` |
| `maxReach` | the highest reach this vendor can ever have (`self` < `world` < `others`) |
| `reachFor(req)` | the reach **floor** for this request. The agent can declare higher, never lower. Return `others` whenever the order reaches another person (any `shipTo` other than the owner-home label, mail, gifts, hiring people) |
| `quote(req)` | a dry run: subtotal, tax, shipping, total. No money moves. Tiers use this total |
| `place(req, quote, hardCapCents, idempotencyKey)` | place the order; refuse if the vendor's final total would exceed `hardCapCents`; pass the idempotency key to the vendor if it supports one |
| `status(id)` | `open`, `shipped`, `delivered` or `cancelled`, plus tracking |
| `cancel(id)` | best-effort cancel |
| `listCharges(sinceISO)` | every charge the vendor made, for the nightly reconcile. A charge with no ledger row trips STOP |
| `pause()` | the kill-switch instrument: pause the card, disable the key, or no-op if the vendor offers nothing |

## guarded(): what you get for free

The registry never hands out a raw adapter. It wraps each one in `guarded()`
(`gate/adapters/registry.ts`), which enforces, regardless of what the adapter does:

- **DRY_RUN**: `place()` never reaches the real vendor unless `DRY_RUN=0`.
- **STOP**: no call that can spend money goes through while STOP is set.
- **paused**: after `pause()`, `place()` is refused.
- **hard cap**: a `place()` whose result exceeds `hardCapCents` is treated as a failure.
- **reach floor**: effective reach = max(declared, `reachFor(req)`), so an agent can never
  talk its way down to a lower reach. `maxReach` is the adapter's honest worst case and
  is what reviewers check when deciding whether to accept the adapter.

So an adapter can stay a thin translation layer over the vendor's API. It should still
validate its own inputs and never log keys or full addresses.

## Adding a vendor, step by step

1. **Read the vendor's terms of service.** Many retailers forbid automated ordering or
   reselling, and some API resellers (proxy buyers) carry their own risks. If the ToS
   says no, don't build it. See "What can go wrong" in the README.
2. **Write the adapter** in `gate/adapters/<vendor>.ts`, implementing `VendorAdapter`.
   Read the key from env (`<VENDOR>_API_KEY`) inside the adapter. Never hardcode a key or
   a default.
3. **Tests**: `gate/adapters/<vendor>_test.ts`, run with `DRY_RUN=1` and a fake `fetch`.
   Tests never touch the network.
4. **Register it** in `gate/adapters/registry.ts` (it gets `guarded()` there).
5. **Add it to `vendors`** in your `config.toml`.
6. **Allow its API host**: `ops/install.sh --allow-net api.vendor.example --start`. The gate
   runs with a Deno `--allow-net` allowlist, so an unlisted host is unreachable.
7. **Create the key** (below), paste it with `ops/set-key.sh VENDOR_API_KEY`, restart.
8. **One small auto-tier test** with your own address, and watch the DM, the veto window
   and `bin/buy reconcile`.

## Keys: naming and vendor-side caps

The gate's caps are the first line. The vendor's own limit is the second, and it is the
one that still holds if the gate host is compromised.

- **One key per app per host.** Name it on the vendor dashboard
  `<app>-<host>-<yyyy-mm>`, e.g. `errand-joy-bot-homeserver-2026-10`. Spend stays
  attributable, and revoking one breaks nothing else.
- **Every key gets a vendor-side spend limit**, monthly where possible, at about 2-3x the
  `vendor_month_cents` you set in `config.toml`. No unlimited keys.
- **Prepaid beats postpaid.** A prepaid wallet with auto-reload OFF is its own cap; keep
  the balance small.
- **Virtual cards**: if the vendor bills a card, use a single-merchant virtual card with
  a monthly limit (several card issuers and banks offer these). Pause, don't close, when
  stopping.
- **Keys live only in the gate's `.env`** (mode 600). Agents, the relay and the notifier
  never see them. Move them with `ops/set-key.sh` (hidden prompt or pipe), never on a
  command line, and never paste them into an AI chat.
- **Rotate** by create new → swap → restart → verify → disable old (see runbook).
- **Retiring a vendor**: remove it from `vendors`, then disable its key the same day.

## Reach examples

| Vendor kind | `maxReach` | `reachFor` |
|---|---|---|
| retailer shipping to you | `others` | `self` for the owner-home label, else `others` |
| electronics distributor | `others` | same as above |
| physical mail to a third party (Lob, Stannp) | `others` | always `others` (always asks) |
| tree planting, satellite imagery tasking | `world` | `world` |
| gift services | `others` | always `others` |

## Zinc (retail: Amazon, Walmart, Target, McMaster-Carr...)

`gate/adapters/zinc.ts`, against Zinc 2.0 (`https://api.zinc.com`, docs:
<https://www.zinc.com/docs/llms-full.txt>, spec: <https://api.zinc.com/openapi.json>).
Paid from a prepaid Zinc wallet; no card on the request.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `ZINC_API_KEY` | `zn_live_...` for real orders, `zn_test_...` for the sandbox. Test mode is per key, not per host |
| `ZINC_BASE_URL` | optional, default `https://api.zinc.com` (https only) |
| `ZINC_RETAILER` | optional retailer slug for quotes, default `amazon` |
| `ZINC_TAX_RATE` | optional tax buffer on the quote, default `0.10` (offers carry no tax) |
| `OWNER_SHIP_TO_JSON` | the owner's address in Zinc's shape: `{"first_name","last_name","address_line1","address_line2","city","state","postal_code","phone_number","country":"US"}`. Private. `place()` refuses if it is missing or any required field is empty, the ZIP isn't 5 or 9 digits, or `state` isn't a 2-letter code. Env files can't hold spaces or quotes, so store it base64-encoded: `printf '%s' '{"first_name":…}' \| base64 \| ops/set-key.sh OWNER_SHIP_TO_JSON` (raw JSON is accepted too) |

Allow the host: `ops/install.sh --allow-net api.zinc.com`.

**How it maps:**

- `quote()`: per item, `GET /products/{sku}/offers?retailer=…` → the cheapest available
  *New* offer counting its cheapest shipping (and under `maxUnitCents`), × qty. Tax =
  subtotal × `ZINC_TAX_RATE`. `totalCents` = subtotal + tax + shipping + Zinc's $1 order fee,
  so tiers see the fee too (the parts don't sum to the total; `Quote` has no fee field).
  Offers calls cost $0.01 each from the live wallet; free in the sandbox.
- `place()`: sends `max_price = min(hardCap, floor(quote × 1.10)) − $1 fee`, so the wallet
  hold (`max_price + $1`) never exceeds the gate's hard cap. The agent never picks it.
  Also sends `idempotency_key` (the gate key, or a sha256-derived UUID when it's over 36
  chars) and the same value in `metadata.ejb_idempotency_key` and `po_number`. A duplicate
  (`already_exists`) is treated as success and the order is looked up by that metadata.
  For Amazon the ordered URL is always built from the quoted ASIN; for other retailers the
  item `url` must contain the quoted `sku`. A third-party `shipTo` is refused (`ShipTo` has
  no phone number, which Zinc requires).
- `chargedCents` = the up-front hold (`max_price + $1`). Zinc refunds the difference later,
  so the ledger over-counts slightly (the safe direction).
- Errors: synchronous rejections where Zinc creates no order (`insufficient_funds`,
  `invalid_shipping_address`, `url_unreachable`, `validation_error`, auth errors…) become
  `GuardRefused(<code>)` → the request is `failed`, not `outcome_unknown`. 5xx and network
  errors stay `ZincError` → `outcome_unknown` + STOP. `max_price_exceeded` is asynchronous: the
  order goes `order_failed` and `status()` reports `cancelled` with `raw.error_type`.
- `status()`: `pending`/`in_progress`/`order_placed` → `open`; a package `in_transit` →
  `shipped`; every package `delivered` → `delivered`; `order_failed`, `cancelled`,
  `cancelled_by_retailer` → `cancelled` (wallet refunded).
- `cancel()`: only works while the order is still queued (`pending`); otherwise `false`.
- `listCharges()`: Zinc has no wallet-transactions endpoint, so it reads `GET /orders?created_after=`
  and reports one charge per order that wasn't refunded, sized as the hold, same as `place()`.
  An order you place by hand in the dashboard shows up here and trips STOP as a phantom
  charge unless the ledger knows about it.
- `pause()` is a local flag. **The real kill is revoking the key** at app.zinc.com → Settings.

**Vendor-side caps.** Zinc has no per-key spend limit. The caps are the wallet balance and
`max_price`:

1. Sign in at <https://app.zinc.com>, top up the wallet by ACH (0.8%, capped at $5) with a
   small amount (e.g. $50). **Leave auto top-up OFF**: then the balance is a hard cap.
2. Create a dedicated live key named `zinc-<host>-<yyyy-mm>` (e.g. `zinc-ejfvps-2026-10`),
   paste it with `ops/set-key.sh ZINC_API_KEY`.
3. Optionally register a webhook (Settings, or `PUT /webhooks/endpoint`) for `order.*` events.
   Test-mode webhooks are configured separately from live ones.

**Sandbox.** `POST https://api.zinc.com/sandbox/keys` mints a `zn_test_` key with no account
or email. Rehearsal products live at `https://zinc.com/shop/products/test-*` (`test-success`,
`test-price-exceeded`, `test-insufficient-funds`, …). The opt-in live test:
`ZINC_SANDBOX_LIVE=1 ZINC_API_KEY=zn_test_… deno test --allow-read --allow-env --allow-net=api.zinc.com --filter LIVE gate/adapters/zinc_test.ts`
(it refuses to run with anything but a `zn_test_` key).

## Slant 3D (3D printing)

`gate/adapters/slant3d.ts`, against the Slant 3D v2 API (`https://slant3dapi.com/v2/api`,
spec: <https://slant3dapi.com/v2/api/openapi.json>, docs:
<https://slant3dapi.com/documentation/introduction>). US print farm, FDM in PLA, PETG and OPM,
no minimums. The spec says it "is for automated tools and AI Agents". Designs come from the
[design pipeline](design-pipeline.md).

Billing: orders are charged **at processing time to the card on the Slant account** ("will default
to your card if not provided"). Drafts are free, but drafting needs a card on file. There is no
prepaid wallet, no `max_price` and no idempotency key, so the adapter enforces the cap itself
(below) and the card is the vendor-side cap.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `SLANT3D_API_KEY` | Bearer key from the Slant account page. Max 3 keys per account |
| `SLANT3D_PLATFORM_ID` | the platform id (Account page → Platforms). Every upload and order needs one; max 5 per account. The adapter never creates platforms |
| `SLANT3D_CUSTOMER_EMAIL` | email on the order (Slant's shipping notices go here) |
| `SLANT3D_BASE_URL` | optional, default `https://slant3dapi.com/v2/api` (https only) |
| `OWNER_SHIP_TO_JSON` | shared with Zinc (same shape, see above); converted to Slant's `Address` |

Allow the hosts: `ops/install.sh --allow-net slant3dapi.com,<upload host>`. Uploads go to a
presigned S3 URL that Slant hands out, not to slant3dapi.com. The live test prints the request
that fails if the host is missing; add that S3 hostname. If agents give https design URLs,
their hosts need allowing too.

**Items.** `sku` = `<PROFILE>:<color>`, e.g. `PLA:black`, `PETG:dark blue` (profiles `PLA`,
`PETG`, `OPM`). An exact color match wins (`black` never becomes `matte black`), then a unique
partial match; an ambiguous or out-of-stock color is refused. `url` = the design file: a path
under `$DATA_DIR/designs/` (relative, or absolute but resolving inside it, symlinks included) or
an https URL the gate host fetches. `.stl` (binary or ASCII) or `.3mf`, at most 50 MB. `qty` 1-100,
at most 10 items. `maxUnitCents` is checked against the draft's item price.

**How it maps:**

- `quote()`: `GET /filaments` (resolve the sku) → upload each design (`POST /files/direct-upload`,
  `PUT` to the presigned URL without the API key, `POST /files/confirm-upload` with the
  placeholder verbatim; cached by sha256, so a re-quote doesn't upload again; 500 uploads per
  platform per day) → `POST /orders` to make a **draft**. subtotal = `printingCost`, shipping =
  `deliveryCost`, tax 0, `vendorRef` = the draft id. Money strings are parsed exactly, not as floats.
  Each quote leaves one draft behind; drafts are never charged and `listCharges` skips them.
- `place()`: the gate re-quotes right before placing and hands that newest quote over. The adapter
  `GET`s the draft and refuses with `GuardRefused` (nothing charged) unless it is still `DRAFT`,
  `printing + delivery` equals the quoted total and is within the hard cap, and it holds exactly
  the quoted files, filaments and quantities. Then `POST /orders/{id}` processes it (charges).
  `chargedCents` = the processed order's printing + delivery. A draft that is already processed
  is returned, not processed again (a retry). A 4xx with the order still `DRAFT` is a
  `GuardRefused`; a 5xx, a network error or a charge above the cap is a `Slant3dError` →
  `outcome_unknown` + STOP.
- `status()`: `SHIPPED` → shipped, `DELIVERED` → delivered, `CANCELED` → cancelled,
  `PAYMENT_ERROR` → failed, every other status (PAID, QUEUED, PRINTING, … AWAITING_SHIPMENT) →
  open. Tracking comes from `fulfillment.tracking_number`.
- `cancel()`: `DELETE /orders/{id}` cancels **and refunds** before production. After shipping
  Slant refunds only. A 4xx → `false`.
- `listCharges()`: `GET /orders` (all platforms on the account, paged, `startDate` a week before
  `since`), one charge per order in a paid status, `amount` = printing + delivery, `at` =
  `processedAt`, id = `paymentId` (or the order id). Drafts, cancelled (refunded) and
  payment-error orders are skipped. An order placed by hand on the site shows up here.
- `pause()` is a local flag. **The real kill is revoking the key** on the Slant account page and
  pausing the card.
- `reachFor`: `self` for the owner-home label, `others` for any other address. Slant's
  `Address` matches the gate's `ShipTo`, so third-party shipping works (and always asks).

**Not verified until the first real order:** whether any sales tax is added on top of printing +
delivery (none appears in the spec or the examples); the `Content-Type` the presigned PUT expects
(the adapter sends `application/octet-stream`); `.3mf` upload (the docs list it, the spec's
`File.type` enum has only `stl`); the URL-upload `POST /files` that the docs show but the spec lacks
(not used: the gate fetches https designs itself and uploads them through the presigned flow).

**Vendor-side cap.** Slant bills a card, so the card is the cap: a single-merchant virtual card
locked to Slant 3D with a monthly limit (e.g. Privacy.com, $50/month), added on the Slant account
page. Name the key `slant3d-<host>-<yyyy-mm>`.

**Live test** (quote only; refuses to process; leaves one unpaid draft):
`SLANT3D_LIVE=1 deno test --allow-read --allow-write=/tmp --allow-env --allow-net=slant3dapi.com,<s3 host> --filter LIVE gate/adapters/slant3d_test.ts`
with `SLANT3D_API_KEY` and `SLANT3D_PLATFORM_ID` in the environment (plus
`SLANT3D_CUSTOMER_EMAIL` and `OWNER_SHIP_TO_JSON` for the draft step).

## Roadmap adapters

Mouser (electronics), Lob and Stannp (physical mail),
Tree-Nation (tree planting), SkyFi (satellite imagery). None are built. Each needs its
own ToS read, key, vendor-side cap and `reachFor`. PRs welcome.
