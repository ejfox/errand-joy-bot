# Vendors

A vendor is a code adapter, not a config entry. The allowlist is closed: the gate only
buys from adapters registered in `gate/adapters/registry.ts` **and** listed in
`vendors` in `config.toml`. Adding one is a reviewed code change.

Shipped today: `zinc` (see [Zinc](#zinc-retail-amazon-walmart-target-mcmaster-carr) below),
`prodigi` ([Prodigi](#prodigi-fine-art-prints-posters-puzzles)), `mouser`
([Mouser](#mouser-electronics-adafruit-parts)) and `mock`, a deterministic fake vendor that moves no money. Use the mock for the
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

## Card-paid vendors: the Privacy.com card is the vendor-side cap

Prodigi and Mouser have no prepaid wallet and no per-key spend limit. They charge the card
saved on the account, so that card is the cap that still holds if the gate host is
compromised. Use one Privacy.com virtual card per vendor:

1. Privacy **Plus** plan or higher (API access, needed later for `pause` from the kill switch).
2. Create a card of type **`MERCHANT_LOCKED`**: it locks to the first merchant that charges it,
   so it is useless anywhere else. Memo / name it after the key, e.g. `prodigi-<host>-<yyyy-mm>`.
3. **`spend_limit` with duration `MONTHLY`** at the amount in the vendor section below (2-3x the
   `vendor_month_cents` you set for that vendor in `config.toml`).
4. Save it as the **only** card on the vendor account. Remove every other card, so a request can
   never fall through to a real card.
5. To stop spending: **pause** the card (reversible). Don't close it: closing can't be undone.

A charge the card declines doesn't silently vanish: at Prodigi it shows up as
`RequiresPaymentAuthorisation` on the order (see below); at Mouser the submit returns errors and
no order number, which the gate records as `outcome_unknown` (STOP until you resolve it).

## Prodigi (fine-art prints, posters, puzzles)

`gate/adapters/prodigi.ts`, against the Prodigi Print API v4 (reference:
<https://www.prodigi.com/print-api/docs/reference/>). Paid per order by the card on file.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `PRODIGI_API_KEY` | sent as the `X-API-Key` header. Sandbox and live keys differ (both in the Prodigi dashboard) |
| `PRODIGI_ENV` | `sandbox` (default) → `https://api.sandbox.prodigi.com`; only `production` → `https://api.prodigi.com`. Anything else refuses to start |
| `PRODIGI_SHIPPING_METHOD` | optional, `Budget` (default), `Standard`, `StandardPlus`, `Express` or `Overnight` |
| `PRODIGI_TAX_RATE` | optional US sales-tax buffer, default `0.10`, applied when a US quote carries no tax |
| `OWNER_SHIP_TO_JSON` | the same owner address as Zinc (see below). Required: it is the recipient |

Allow the hosts: `ops/install.sh --allow-net api.sandbox.prodigi.com,api.prodigi.com`.

**Items**: `sku` = a Prodigi product SKU from their catalogue (e.g. a giclée fine-art print
`GLOBAL-FAP-12X16`); `url` = the **https** image asset Prodigi downloads and prints (required:
`quote()` already refuses an item without one); `qty` = copies. Sizing defaults to
`fillPrintArea` and attributes to none. The adapter reads `sizing` and `attributes` off the item,
but `Item` has no such fields yet and gate intake drops unknown item keys, so through the gate
today only the defaults apply. Products with a required attribute (e.g. a frame colour) need that
types change first.

**How it maps:**

- `quote()`: `POST /v4.0/quotes` with the shipping method, the owner's country, `currencyCode
  USD`, and one `default` print area per item. subtotal = `costSummary.items`, shipping =
  `costSummary.shipping`, tax = `totalTax`, or `PRODIGI_TAX_RATE` × (items + shipping) when a US
  quote has none (Prodigi warns `UsSalesTaxWarning`: prices may be subject to US sales tax).
  Anything not in USD, or a `totalCost` that disagrees with its parts, is refused.
- `place()`: re-quotes first (no money moves) and refuses (`GuardRefused`) if the fresh total is
  over the hard cap. Then one `POST /v4.0/orders` with `idempotencyKey` = `merchantReference` =
  `ejb-` + sha256 of the gate key. Outcomes `created`, `onHold`, `createdWithIssues`,
  `alreadyExists` are all success (`alreadyExists` returns the original order, never a second).
  `chargedCents` = the fresh quote (or the payment amount Prodigi names, if higher).
  `validationFailed` / 401 / 404 → `GuardRefused` (no order); 5xx / `timedOut` / network →
  `ProdigiError` → `outcome_unknown` + STOP.
- **`RequiresPaymentAuthorisation`** (a `status.issues[]` entry with an `authorisationUrl`): the
  order exists but the card payment needs action, e.g. a 3-D Secure check or a decline against
  the Privacy cap. The adapter treats it as **placed but blocked**: it returns the order (so the
  ledger counts it), logs one line naming the order id and amount, and **never re-posts it**.
  `status()` keeps reporting `open` with `raw.blocked` until you authorise or cancel it in the
  Prodigi dashboard. The gate doesn't DM about it yet (see "known gaps" below), so check the gate
  log after a Prodigi order.
- `status()`: `GET /v4.0/orders/{id}`. Stage `Cancelled` → `cancelled`; `Complete` ("all
  shipments sent") → `delivered`, because Prodigi has no door-delivery signal; a shipment
  `Shipped` → `shipped`; otherwise `open` (an order inside a pause window has no status yet).
- `cancel()`: `POST /v4.0/orders/{id}/actions/cancel`; `cancelled` → true, `failedToCancel` /
  `actionNotAvailable` → false. Only possible before the order is in fulfilment.
- `listCharges()`: `GET /v4.0/orders?createdFrom=…&top=100&skip=…`; one charge per order = the net
  of its `charges[].totalCost` (refunds are negative). Orders with no charges yet are skipped.
  **Expect STOP after the first US order.** The ledger records the quote, which includes the 10%
  tax buffer whenever Prodigi quotes no US tax; Prodigi's real charge will almost never equal it
  to the cent. So the first reconcile after each US Prodigi order will report `amount_mismatch`
  and trip STOP until you've seen what Prodigi actually charges for tax, then set
  `PRODIGI_TAX_RATE` to match (or `0`) and resolve.
- `pause()` is a local flag. **The real kill is pausing the Privacy `prodigi` card.**

**Card:** Privacy `MERCHANT_LOCKED`, `MONTHLY` **$60**, saved as the only card in the Prodigi
dashboard (Settings → Billing). Keep `vendor_month_cents` for prodigi at about $20-30.

**Sandbox.** The sandbox never fulfils and never charges, and its key comes with the account. The
opt-in live test runs only against `api.sandbox.prodigi.com` (it forces `PRODIGI_ENV=sandbox`):
`PRODIGI_LIVE=1 deno test --allow-read --allow-env --allow-net=api.sandbox.prodigi.com --filter LIVE gate/adapters/prodigi_test.ts`
with `PRODIGI_API_KEY` and `OWNER_SHIP_TO_JSON` set in the environment (optional `PRODIGI_LIVE_SKU`,
`PRODIGI_LIVE_ASSET_URL`). It quotes, places, reads status and cancels one sandbox order.

## Mouser (electronics, Adafruit parts)

`gate/adapters/mouser.ts`, against the Mouser API V1 (Swagger:
<https://api.mouser.com/api/docs/V1>). Paid with the card saved on the My Mouser account.
Adafruit parts are listed as `485-<Adafruit PID>`; check one with search before relying on it.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `MOUSER_SEARCH_API_KEY` | Search API key (My Mouser → APIs). Used only by `quote()` |
| `MOUSER_ORDER_API_KEY` | Order API key (My Mouser → APIs). Cart, order and order history |
| `MOUSER_CARD_LAST4` | last four digits of the Privacy `mouser` card. `place()` refuses unless exactly one saved card matches. Not a secret |
| `MOUSER_SHIPPING_CODE` | optional Mouser shipping method `Code`; default = the cheapest the account offers |
| `MOUSER_TAX_RATE` | optional tax buffer on the quote, default `0.10` |
| `MOUSER_SHIPPING_ESTIMATE_CENTS` | optional shipping estimate on the quote, default `999` |
| `OWNER_SHIP_TO_JSON` | the same owner address as Zinc, sent as the order's shipping address |

Allow the host: `ops/install.sh --allow-net api.mouser.com`.

**The keys ride in the URL** (`?apiKey=`), so the adapter never puts a URL into an error, a log
line or `raw`, and it swallows fetch's own error text (which contains the URL). `scrubUrl()` in
`mouser.ts` redacts `apiKey=` for anything that must log one. Don't log Mouser URLs elsewhere.

**How it maps:**

- `quote()`: one `POST /api/v1/search/partnumber` (Search key, `partSearchOptions: Exact`, up to
  10 part numbers joined by `|`). Per item: the highest price break at or below the quantity,
  × qty, rounded up to the cent; the quantity must meet `Min` and `Mult` and the reported stock.
  Search has no tax or shipping, so the quote adds `MOUSER_TAX_RATE` and
  `MOUSER_SHIPPING_ESTIMATE_CENTS` as buffers. The dry run below carries Mouser's real numbers.
- `place()`, in order, all with the Order key:
  1. `GET orderhistory/ByDateRange` (last 30 days): an order whose `PoNumber` is this request's
     (`ejb-` + 16 hex of sha256 of the gate key) is returned as-is. Mouser has no idempotency
     field, so this is the duplicate guard.
  2. `POST cart/items/insert` with no `CartKey` → a fresh cart; its lines must match the request.
  3. `POST order/options/query` → the saved card whose `CreditCardLastFourDigits` is
     `MOUSER_CARD_LAST4` (exactly one) and the shipping method.
  4. `POST order` with **`SubmitOrder: false`** (a free dry run): lines must match; Mouser's total
     must be ≤ the hard cap and ≤ the quote + 10%.
  5. The same body with **`SubmitOrder: true`**. `chargedCents` = the dry-run total (or the
     submit's, if higher).

  Steps 1-4 can't buy anything, so any failure there is `GuardRefused` (request `failed`). Only
  step 5 can: a network error, a 5xx, or a 200 without an `OrderID` is a `MouserError` →
  `outcome_unknown` + STOP, never a blind retry. A card decline lands here too.
- `status()`: `GET orderhistory/webOrderNumber`. A status name containing "cancel" →
  `cancelled`; tracking present → `shipped`; else `open`. Mouser doesn't publish its status names
  and has no delivery signal, so Mouser rows stay `placed`: the gate never sees `delivered` (and
never sends a delivery why-note) for Mouser.
- `cancel()`: the API has no cancel endpoint; always `false`. Cancel by phone or email.
- `listCharges()`: `orderhistory/ByDateRange` (mm/dd/yyyy) then each order's detail for
  `SummaryDetail.OrderTotal`; one charge per non-cancelled order, keyed by web order number.
  **Unverified until the first real order:** that the submit's `OrderID` equals history's
  `WebOrderNumber`. If it doesn't, the first reconcile sees the charge as unmatched and trips STOP.
- `pause()` is a local flag. **The real kill is pausing the Privacy `mouser` card** (and deleting
  the keys in My Mouser → APIs).

**Card and keys:** Privacy `MERCHANT_LOCKED`, `MONTHLY` **$60**, saved in My Mouser as the
**only** card. Create the two keys in My Mouser → APIs, named `mouser-<host>-<yyyy-mm>`, and paste
them with `ops/set-key.sh MOUSER_SEARCH_API_KEY` and `ops/set-key.sh MOUSER_ORDER_API_KEY`. Mouser
has no sandbox; the dry run is the rehearsal.

**Live test (search/quote only, never orders):** it builds the adapter with only the Search key,
so it cannot reach the cart or order endpoints.
`MOUSER_LIVE=1 deno test --allow-read --allow-env --allow-net=api.mouser.com --filter LIVE gate/adapters/mouser_test.ts`
with `MOUSER_SEARCH_API_KEY` in the environment (optional `MOUSER_LIVE_PART`, default `485-4116`).

## Known gaps (card-paid vendors)

- `Item` has no `sizing` / `attributes`, and intake strips unknown item keys, so Prodigi
  products that need an attribute can't be ordered through the gate yet.
- Neither `Order.raw` nor `status().raw` reaches the owner, so a Prodigi order blocked on
  `RequiresPaymentAuthorisation` is only in the gate log. It needs a "needs action" field on
  `Order` / `status()` and a DM.
- The sealed-DM vendor label falls back to the vendor id (`prodigi`, `mouser`); add entries to
  `VENDOR_LABELS` in `gate/notify.ts` for nicer wording.

## Roadmap adapters

Lob and Stannp (physical mail),
Tree-Nation (tree planting), SkyFi (satellite imagery). None are built. Each needs its
own ToS read, key, vendor-side cap and `reachFor`. PRs welcome.
