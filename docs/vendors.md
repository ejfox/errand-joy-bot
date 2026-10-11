# Vendors

A vendor is a code adapter, not a config entry. The allowlist is closed: the gate only
buys from adapters registered in `gate/adapters/registry.ts` **and** listed in
`vendors` in `config.toml`. Adding one is a reviewed code change.

Shipped today: `zinc` (see [Zinc](#zinc-retail-amazon-walmart-target-mcmaster-carr) below),
`treenation` ([Tree-Nation](#tree-nation-tree-planting)), `skyfi`
([SkyFi](#skyfi-archive-satellite-imagery)),
`stannp` ([Stannp](#stannp-us-postcards-and-letters)), `lulu` ([Lulu](#lulu-print-api-zines-and-books)),
`slant3d` ([Slant 3D](#slant-3d-3d-printing)),
`prodigi` ([Prodigi](#prodigi-fine-art-prints-posters-puzzles)), `mouser`
([Mouser](#mouser-electronics-adafruit-parts)) and
`mock`, a deterministic fake vendor that moves no money. Use the mock for the
rehearsal stage in [runbook.md](runbook.md).

## All vendors at a glance

| Vendor (`id`) | What | Reach | Payment | Vendor-side cap (holds if the gate host is compromised) | Env vars | Key name |
|---|---|---|---|---|---|---|
| Zinc (`zinc`) | Amazon and other retailers | `self` to owner-home, else `others` | prepaid Zinc wallet | per-order `max_price` + a small wallet, auto top-up OFF | `ZINC_API_KEY`, `OWNER_SHIP_TO_JSON`; opt. `ZINC_RETAILER`, `ZINC_TAX_RATE`, `ZINC_BASE_URL` | `zinc-<host>-<yyyy-mm>` |
| Tree-Nation (`treenation`) | trees planted | `world` | prepaid planting credit | the credit balance (no top-up from the gate) | `TREENATION_API_KEY`, `TREENATION_BASE_URL` (test host by default); opt. `TREENATION_EUR_USD_RATE` | `treenation-<host>-<yyyy-mm>` |
| SkyFi (`skyfi`) | archive satellite imagery | `world` | card on the SkyFi account | the SkyFi budget (`budgetAmount`) | `SKYFI_API_KEY`; opt. `SKYFI_BASE_URL` | `skyfi-<host>-<yyyy-mm>` |
| Stannp (`stannp`) | US postcards and letters | `self` to owner-home, else `others` (always asks) | prepaid balance | the balance, auto top-up OFF; re-quote before the live call | `STANNP_API_KEY`, `OWNER_SHIP_TO_JSON`; opt. `STANNP_BASE_URL` | `stannp-<host>-<yyyy-mm>` |
| Lulu (`lulu`) | printed zines and books | `self` to owner-home, else `others` | card on file, charged at production | Privacy merchant-locked card, monthly limit; cancel window before production | `LULU_CLIENT_KEY`, `LULU_CLIENT_SECRET`, `LULU_CONTACT_EMAIL`, `LULU_ENV` (sandbox default), `OWNER_SHIP_TO_JSON`; opt. `LULU_SHIPPING_LEVEL`, `LULU_PRODUCTION_DELAY_MINUTES` | `lulu-<host>-<yyyy-mm>` |
| Slant 3D (`slant3d`) | 3D prints (FDM) | `self` to owner-home, else `others` | card on the Slant account | Privacy merchant-locked card; the draft total is re-read before processing | `SLANT3D_API_KEY`, `SLANT3D_PLATFORM_ID`, `SLANT3D_CUSTOMER_EMAIL`, `OWNER_SHIP_TO_JSON`; opt. `SLANT3D_BASE_URL` | `slant3d-<host>-<yyyy-mm>` |
| Prodigi (`prodigi`) | art prints, posters, puzzles | `self` to owner-home, else `others` | card on file | Privacy merchant-locked card, monthly limit | `PRODIGI_API_KEY`, `PRODIGI_ENV` (sandbox default), `OWNER_SHIP_TO_JSON`; opt. `PRODIGI_SHIPPING_METHOD`, `PRODIGI_TAX_RATE` | `prodigi-<host>-<yyyy-mm>` |
| Mouser (`mouser`) | electronics, Adafruit parts | `self` to owner-home, else `others` | saved card | Privacy merchant-locked card, monthly limit; dry-run total checked before submit | `MOUSER_SEARCH_API_KEY`, `MOUSER_ORDER_API_KEY`, `MOUSER_CARD_LAST4`, `OWNER_SHIP_TO_JSON`; opt. `MOUSER_SHIPPING_CODE`, `MOUSER_TAX_RATE`, `MOUSER_SHIPPING_ESTIMATE_CENTS` | `mouser-<host>-<yyyy-mm>` |
| mock (`mock`) | rehearsal | per request | none | none (moves no money) | none | none |

The gate-side caps (tiers, day / month / per-vendor windows, the per-order hard cap) apply to all
of them. Every variable is listed, commented, in `.env.example`. `ops/install.sh` adds each enabled
vendor's API hosts to Deno's `--allow-net` itself (`VENDOR_HOSTS` in `gate/adapters/registry.ts`).

**Item fields beyond `sku` / `qty` / `title` / `url`** (bounded at intake):

| Field | Used by | Limit |
|---|---|---|
| `message` | Stannp: the postcard's printed back message. Unsealed DMs show it as `printed message:` | ≤ 500 chars |
| `files: {interior, cover}` | Lulu: interior and cover PDFs | https, ≤ 2000 chars each |
| `pageCount` | Lulu: interior pages | 1-1200 (Lulu: 2-1200) |
| `sizing` | Prodigi: `fillPrintArea` (default), `fitPrintArea`, `stretchToPrintArea` | letters, ≤ 40 |
| `attributes` | Prodigi: product attributes, e.g. `{"color": "black"}` | ≤ 20 keys, values ≤ 80 chars |
| `aoi` | SkyFi: area of interest on the `archive:` item, a WKT polygon | ≤ 10,000 chars |

**What the gate reads back from an adapter** (`Order.raw` from `place()`, `status().raw`):
`links: string[]` (certificates, downloads, tracking pages) are kept if https, without userinfo,
and without a credential query parameter (`apiKey`, `key`, `token`, ...; such a link is dropped,
never "fixed"). They are stored on the request and the delivery why-note DM shows up to 3, wrapped
in `<>`. `blocked: string` means the order exists but waits on the owner at the vendor (Prodigi
`RequiresPaymentAuthorisation`): the request stays `placed`, gets `needs_action`, and the owner
gets ONE DM per request, `<vendor label> order needs you: <dashboard hint>`.

**Reconcile and the hard cap.** At placing the gate stores the order's hard cap (the bound quote,
never above the agent's `maxTotalCents`). Reconcile trips STOP for a charge with no order, a second
charge against one order, or a charge **above** the hard cap. A charge at or under the cap is the
real amount (a refunded Zinc hold, real tax): the request's final amount is set to it, the windows
count it, and an event `reconcile_final:<from>-><to>` is logged. Rows placed before the hard cap was
stored use `maxTotalCents` as their cap.

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
| `listCharges(sinceISO)` | every charge the vendor made, for the nightly reconcile. A charge with no ledger row, or above the order's hard cap, trips STOP |
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
4. **Register it** in `gate/adapters/registry.ts` (it gets `guarded()` there): a factory in
   `VENDOR_FACTORIES`, its API hosts in `VENDOR_HOSTS`, a label in `VENDOR_LABELS` and (if it
   can report `raw.blocked`) a hint in `VENDOR_ACTION_HINTS` (`gate/notify.ts`).
5. **Add it to `vendors`** in your `config.toml`.
6. **Re-run `ops/install.sh --start`**: it adds the vendor's `VENDOR_HOSTS` to the gate's Deno
   `--allow-net` allowlist (an unlisted host is unreachable). A custom base URL or upload host
   goes in by hand: `ops/install.sh --allow-net host.example --start`.
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
| physical mail or print (Stannp, Lulu) | `others` | `self` to the owner-home label, else `others` (always asks, never sealed) |
| tree planting (Tree-Nation), archive satellite imagery (SkyFi) | `world` | `world`; `others` for a third-party `shipTo` (both refuse it at `place()`) |
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

Hosts: `api.zinc.com` (added to `--allow-net` by `ops/install.sh` when `zinc` is enabled).

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
2. Create a dedicated live key named `zinc-<host>-<yyyy-mm>` (e.g. `zinc-myvps-2026-10`),
   paste it with `ops/set-key.sh ZINC_API_KEY`.
3. Optionally register a webhook (Settings, or `PUT /webhooks/endpoint`) for `order.*` events.
   Test-mode webhooks are configured separately from live ones.

**Sandbox.** `POST https://api.zinc.com/sandbox/keys` mints a `zn_test_` key with no account
or email. Rehearsal products live at `https://zinc.com/shop/products/test-*` (`test-success`,
`test-price-exceeded`, `test-insufficient-funds`, …). The opt-in live test:
`ZINC_SANDBOX_LIVE=1 ZINC_API_KEY=zn_test_… deno test --allow-read --allow-env --allow-net=api.zinc.com --filter LIVE gate/adapters/zinc_test.ts`
(it refuses to run with anything but a `zn_test_` key).

## Tree-Nation (tree planting)

`gate/adapters/treenation.ts`, against the Tree-Nation API (docs:
<https://docs.tree-nation.com/llms-full.txt>, spec: <https://docs.tree-nation.com/openapi.json>,
flow and test host: the [gifting integration guide](https://docs.tree-nation.com/tree-nation-api-gifting-trees-integration-guide.md)).
Plants trees from the account's prepaid planting credit. Reach `world`; the request category
`tree` is a world category by default.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `TREENATION_API_KEY` | the bearer token Tree-Nation issues (test and live tokens are separate) |
| `TREENATION_BASE_URL` | optional, **default `https://youcannevertestenough.tree-nation.com` (the test host)**. Set `https://tree-nation.com` to plant for real |
| `TREENATION_EUR_USD_RATE` | optional, default `1.25`: USD per EUR for quotes (prices are EUR; `Quote` is USD). Deliberately high, so the ledger over-counts |

Hosts: `tree-nation.com`, `youcannevertestenough.tree-nation.com` (added by `ops/install.sh`).

**Items:** exactly one item, `qty` = number of trees (1-1000):
`species:<id>` (a species id from `GET /api/species`) or `project:<id>` (the cheapest
in-stock species of that project). Species ids and prices differ between the test and live hosts.

**How it maps:**

- `quote()`: the public `GET /api/species/{id}` (or `/api/projects/{id}/species`) price in EUR ×
  qty, converted at `TREENATION_EUR_USD_RATE` and rounded up. No tax, shipping or fee. Needs
  `stock >= qty`. The species quoted is pinned in `vendorRef` (`treenation:species:<id>`). The
  token is never sent to these public endpoints.
- `place()`: re-reads the pinned species and refuses (`GuardRefused`) if price × qty now
  converts above the quote or the hard cap, then `POST /api/plant {species_id, quantity,
  order_id, language}`. `order_id` is the gate's idempotency key (or a sha256-derived id when it's
  over 64 chars). It never sends `recipients` or `message`, so nobody else is emailed and nothing
  private lands on the public certificate page. A third-party `shipTo` is refused.
- Tree-Nation answers HTTP 200 for business errors. `errorCode` `species`, `quantity`,
  `tree_template`, `planter`, `recipients` (and HTTP 401/403) → `GuardRefused` (nothing planted).
  `already_processed`, any undocumented code (e.g. out of credit), 5xx and network errors →
  `TreeNationError` → `outcome_unknown` + STOP: there is no endpoint to check what was planted.
  `status: "processing"` with a `payment_id` counts as placed.
- `vendorOrderId` = `payment_id`; `chargedCents` = the quoted USD total. The certificate and
  collect URLs (`trees[].certificate_url` / `collect_url`, in the guide's example response but
  not in the OpenAPI schema) go in `Order.raw.links`, certificates first, for the delivery why-note.
- `status()`: there is no status endpoint and planting is immediate, so it reports `delivered`.
- `cancel()` → `false` (planting can't be undone). `listCharges()` → `[]`: Tree-Nation exposes
  no payment history, so **reconcile cannot catch a planting the gate didn't make here**; the
  prepaid credit is the only vendor-side cap. `authCheck()` (`GET /api/authcheck`) checks the token.
- `pause()` is a local flag. The real kill is asking Tree-Nation to revoke the token.

**Getting access (not self-serve):**

1. Create a company account on tree-nation.com, and a test account on the test host.
2. Request a test token with the form linked from the integration guide. The live token comes after
   testing. Name it `treenation-<host>-<yyyy-mm>` on your side, e.g. `treenation-myvps-2026-10`.
3. Pay by card: credit the account with a small amount (e.g. €20, enough for 40-60 trees).
   **The card option auto-recharges when the balance falls to 10% of the last top-up**, which
   makes the balance useless as a cap. Ask Tree-Nation to switch auto-recharge off, or to set a
   `credit_unpaid_limit` on the API user. The adapter never calls `POST /api/credit`.
4. `ops/set-key.sh TREENATION_API_KEY`, set `TREENATION_BASE_URL`, restart.

Opt-in live test (quote only, no token needed):
`TREENATION_LIVE=1 deno test --allow-read --allow-env --allow-net=youcannevertestenough.tree-nation.com --filter LIVE gate/adapters/treenation_test.ts`
(add `TREENATION_BASE_URL=https://tree-nation.com` and `--allow-net=tree-nation.com` for live prices).

**Not yet possible: planting "for" someone.** `recipients[{name, email}]` makes Tree-Nation
email that person a certificate (reach `others`, so it always asks). `PurchaseRequest` has no
recipient field yet, so the adapter refuses it.

## SkyFi (archive satellite imagery)

`gate/adapters/skyfi.ts`, against the SkyFi Platform API 2.0 (`https://app.skyfi.com/platform-api`,
spec: <https://app.skyfi.com/platform-api/openapi.json>, agent flow: <https://mcp.skyfi.com/docs>).
Buys **archive** imagery (existing captures in SkyFi's catalog, from about $15). Reach `world`; the
request category `satellite` is a world category by default. **Tasking (new captures, $200+) is
refused**: the adapter never calls the tasking endpoints, and a `tasking:` sku is an error.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `SKYFI_API_KEY` | sent as the `X-Skyfi-Api-Key` header. There is no sandbox host |
| `SKYFI_BASE_URL` | optional, default `https://app.skyfi.com/platform-api` (https only) |

Hosts: `app.skyfi.com` (added by `ops/install.sh`).

**Items:**

- exactly one `archive:<archiveId>` (from a catalog search: `POST /archives` or the SkyFi MCP), qty 1.
  Its `aoi` field is the area: `POLYGON((lon lat, …))`, a simple closed WKT ring (≤ 10k chars,
  ≤ 500 vertices);
- or, instead of `aoi`, at most one shorthand area item, qty 1: `point:<lat>,<lon>,<radiusKm>` (a
  square of side 2 × radius, radius up to 25 km) or `bbox:<minLon>,<minLat>,<maxLon>,<maxLat>` (up
  to 2° a side);
- no area → the archive's whole footprint (`GET /archives/{id}`), priced like any other.

**How it maps:**

- `quote()`: `POST /order-archive/validate` (free, creates nothing) → `estimatedCostCents` is the
  total; tax and shipping 0. 402 → `skyfi_budget_exceeded`, 403 → `skyfi_forbidden` or
  `skyfi_vantor_eula_required` (accept the EULA at <https://app.skyfi.com/accept-vantor-eula>),
  404 → `skyfi_not_found`, 422 → `skyfi_order_rejected`, 429 → `skyfi_order_limit`.
- `place()`: first looks for an earlier attempt (`GET /orders?search=<label>`; found → returned
  as the order, since it already used budget), then re-validates and refuses unless the price
  still equals the quote and fits the hard cap, checks the remaining budget (`GET /auth/whoami`:
  `budgetAmount − currentBudgetUsage`, refuses `skyfi_budget_insufficient`), and only then
  `POST /order-archive` with `deliveryDriver: NONE`
  (SkyFi hosts the files; bucket credentials are never accepted). SkyFi has no idempotency key,
  so the gate key goes into `orderLabel` and `metadata` as `ejb-<key>`. Every failure before the
  POST is a `GuardRefused`; POST rejections with the documented validation codes (400-429, 503)
  are too. 5xx and network errors → `SkyFiError` → `outcome_unknown` + STOP.
- `vendorOrderId` = `orderId` (not the item `id`); `chargedCents` = `orderCost`.
- `status()`: `CREATED` / `STARTED` / `PROVIDER_PENDING` → `open`; provider-complete, processing
  and delivery-pending stages → `shipped`; `DELIVERY_COMPLETED` with a download URL → `delivered`,
  the URLs (view-ready COG first, then image, COG, payload) in `raw.links` for the why-note;
  any `*_FAILED` → `failed`. Archive delivery is usually within 24 hours.
- `cancel()` → `false` (no endpoint). `listCharges()` pages `GET /orders` newest first back to
  the cutoff: one charge per `orderId`, amount `orderCost`, `PAYMENT_FAILED` skipped. Orders you
  place by hand in the SkyFi app (or via the MCP) show up and trip STOP unless the ledger knows them.
- `budget()` reports the SkyFi budget and remaining cents for ops.
- `pause()` is a local flag. The real kill is deleting the API key in the SkyFi app.

**Vendor-side caps.** SkyFi bills a card (`hasValidSharedCard`); the cap is SkyFi's own
budget (`budgetAmount`), which `place()` and validate (402) both enforce.

1. Create a SkyFi account at <https://app.skyfi.com>, add a single-merchant virtual card with a
   monthly limit (e.g. $60).
2. Set the account budget low (e.g. $50/month) and create an API key; name it
   `skyfi-<host>-<yyyy-mm>`, e.g. `skyfi-myvps-2026-10`. `ops/set-key.sh SKYFI_API_KEY`.
3. If you want Vantor scenes, accept the Vantor EULA once in the app.

Opt-in live test (quote only: whoami, a catalog search near Peekskill, one validate; nothing is ordered):
`SKYFI_LIVE=1 SKYFI_API_KEY=… deno test --allow-read --allow-env --allow-net=app.skyfi.com --filter LIVE gate/adapters/skyfi_test.ts`

## Stannp (US postcards and letters)

`gate/adapters/stannp.ts`, against Stannp's US region (`https://api-us1.stannp.com/v1/…`, docs:
<https://www.stannp.com/us/direct-mail-api/guide>, LLM reference:
<https://www.stannp.com/stannp-api-llm.md>). Paid from a **prepaid Stannp balance**; no card on
the request. US 4x6 postcard ≈ $0.80, 6x9 ≈ $0.99, letter ≈ $0.94, postage included.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `STANNP_API_KEY` | the account API key (bottom of the Stannp settings page). Sent as HTTP Basic username, empty password |
| `STANNP_BASE_URL` | optional, default `https://api-us1.stannp.com` (https only). EU accounts use `api-eu1`, which this adapter isn't tested against |
| `OWNER_SHIP_TO_JSON` | the owner's address, same var and Zinc shape as above. Postcards "to me" go here |

Hosts: `api-us1.stannp.com` (added by `ops/install.sh`).

**What an agent sends.** One item, `qty: 1` (one request = one mailpiece):

| `sku` | `url` | `message` |
|---|---|---|
| `postcard-4x6`, `postcard-6x9`, `postcard-6x11` | the front image, https JPG/PNG/PDF (e.g. a render) | the message printed on the back (≤ 500 chars) |
| `letter` | the letter PDF (https, ≤ 25 pages) | not allowed (refused: a letter prints only its PDF) |

`title` is a label for the DMs and is never printed. Every unsealed DM shows the message as
`printed message: "…"`.

`shipTo` = the owner-home label (reach `self`) or `{name, line1, city, state, zip}` (reach
`others`: always an ask, never silent or sealed, so the DM shows the recipient, the message and
the reason). US addresses only. `post_unverified=false` is always sent, so Stannp won't mail
to an address it can't verify.

**How it maps:**

- `quote()`: the real create call with `test=true`. Stannp's docs: "a sample PDF file will be
  produced but the item will never be dispatched and no charge will be taken". `totalCents` =
  the returned `cost` (tax and shipping 0; postage is included). A non-test answer fails loudly.
- `place()`: Stannp has no `max_price`, so the adapter **re-quotes** (test=true) and refuses
  (`GuardRefused max_price_exceeded`) when that exceeds the hard cap, then checks
  `GET /v1/accounts/balance` (`stannp_insufficient_balance`), then sends the live create with
  `idempotency_key` (the gate key, ≤ 36 chars) and `tags=ejb-<key>`. A network error is retried
  once with the identical body: Stannp answers a duplicate with **409 + the original response**,
  which counts as success. `chargedCents` = the live `cost`; a live cost above the cap is
  cancelled at once and thrown. Order ids are `postcard:<id>` / `letter:<id>`.
- Errors: a refused re-quote, short balance or 401 are `GuardRefused` (nothing was mailed).
  Other failures of the live call stay `StannpError` → `outcome_unknown` + STOP; resolve by
  looking for the `ejb-<key>` tag in Stannp's reporting.
- `status()`: `received`/`producing`/`printing` → `open`; `handed_over`/`dispatched`/
  `local_delivery` → `shipped`; `delivered` → `delivered`; `cancelled` → `cancelled`;
  **`returned` → `delivered`** (printed and posted, money spent; `raw.status` says `returned`).
- `cancel()`: `POST /v1/{postcards|letters}/cancel`, only before Stannp starts processing.
- `listCharges()`: Stannp has no transactions endpoint. It reads
  `GET /v1/reporting/list/<since date>/<today>` and reports every non-cancelled mailpiece since
  the cutoff (any type: a greeting card nobody asked for is still a phantom charge), amount =
  `cost`. Stannp's timestamps carry no zone; they are read as UTC.
- `pause()` is a local flag. **The real kill is regenerating the API key** in Stannp settings.
  The adapter never calls `/v1/accounts/topup` (it charges the saved card).

**Vendor-side caps.** Stannp keys have no spend limit; the balance is the cap.

1. Sign up at <https://www.stannp.com/us> (business-oriented; no Amex).
2. Top up a small prepaid balance, e.g. **$10** (≈ 12 postcards). **Auto top-up OFF**, and
   ideally no saved card at all, so `/accounts/topup` can't charge anything either.
3. Name the key `stannp-myvps-2026-10`. The docs only show one key on the settings page
   (unverified whether keys can be named or multiplied); if it can't be named there, record
   that name with the key's last 4 characters in your notes. Paste it with
   `ops/set-key.sh STANNP_API_KEY`.

**Live test** (test mode only: nothing is mailed or charged; the place step sends `test=true`):
`STANNP_LIVE=1 STANNP_API_KEY=… deno test --allow-read --allow-env --allow-net=api-us1.stannp.com --filter LIVE gate/adapters/stannp_test.ts`

## Lulu Print API (zines and books)

`gate/adapters/lulu.ts`, against the Lulu Print API (docs: <https://api.lulu.com/docs/>, spec:
<https://api.lulu.com/api-docs/openapi-specs/openapi_public.yml>). **Sandbox by default**
(`https://api.sandbox.lulu.com`); production (`https://api.lulu.com`) only when
`LULU_ENV=production`. Booklets from about $4.30 plus shipping, a fulfillment fee and tax.

**Env** (gate `.env` only):

| Var | What |
|---|---|
| `LULU_CLIENT_KEY`, `LULU_CLIENT_SECRET` | OAuth client credentials from the API Keys page. The sandbox needs a **separate account** at <https://developers.sandbox.lulu.com/> with its own keys |
| `LULU_ENV` | `sandbox` (default) or `production`. Anything else is a startup error |
| `LULU_CONTACT_EMAIL` | Lulu's required `contact_email` for questions about a job. `place()` refuses without it |
| `LULU_SHIPPING_LEVEL` | optional, `MAIL` (default), `PRIORITY_MAIL`, `GROUND`, `EXPEDITED`, `EXPRESS` |
| `LULU_PRODUCTION_DELAY_MINUTES` | optional, 60-2880, default 60: Lulu's own cancel window before the card is charged |
| `OWNER_SHIP_TO_JSON` | the owner's address (Zinc shape). Lulu limits: name ≤ 35, street/city ≤ 30 chars; longer refuses |

Hosts: `api.sandbox.lulu.com`, `api.lulu.com` (both added by `ops/install.sh`).

**What an agent sends.** Up to 10 items (one per title), `qty` = copies (1-100):

- `sku` = the pod package id. Known-good (quoted live): `0550X0850FCPRESS080CW444GXX` (5.5x8.5
  full-color saddle-stitch zine; 32 pages ≈ $15.89 delivered to NY) and `0600X0900BWSTDPB060UW444MXX`
  (6x9 B&W paperback). Many plausible-looking ids don't exist; check new ones with a quote first.
- `pageCount` = interior pages (2-1200).
- `files.interior` and `files.cover` = the interior and cover PDFs, public https URLs Lulu can
  download.
- `title` = the line-item title (printed on Lulu's records; default "Untitled").
- A third-party `shipTo` must include `phone` (Lulu requires one; otherwise it would use yours).

**How it maps:**

- Auth: `POST {base}/auth/realms/glasstree/protocol/openid-connect/token`,
  `grant_type=client_credentials`, Basic `client_key:client_secret`; the bearer token is cached
  until a minute before `expires_in`. A refused token is `GuardRefused lulu_auth_failed`.
- `quote()`: `POST /print-job-cost-calculations/` (creates nothing). subtotal = Σ line totals
  excl. tax, shipping = shipping excl. tax, tax = `total_tax`, fee = the residual up to
  `total_cost_incl_tax` (fulfillment fee). `fees[]` isn't summed: in Lulu's own example the
  handling fee isn't part of the total.
- `place()`: re-quotes and refuses above the hard cap; looks for an existing job with
  `external_id` = the gate key (Lulu has no idempotency key) and returns it if found; then
  `POST /print-jobs/` with `external_id`, `contact_email`, `production_delay`, `shipping_level`
  and `printable_normalization {interior, cover, pod_package_id}`. `chargedCents` = the job's
  `costs.total_cost_incl_tax`, or the re-quote if Lulu hasn't priced it yet. A 400/401/403 is
  `GuardRefused` (no job). A 5xx or network error looks the job up by `external_id`: found =
  success, not found = `LuluError` → `outcome_unknown`. A job priced above the cap is cancelled.
- `status()`: `CREATED`/`UNPAID`/`PAYMENT_IN_PROGRESS`/`PRODUCTION_DELAYED`/`PRODUCTION_READY`/
  `IN_PRODUCTION`/`ERROR` → `open` (ERROR comes after production started, so money may have
  moved); `SHIPPED` → `shipped`; `DELIVERED` → `delivered`; `CANCELED` → `cancelled`;
  `REJECTED` → `failed` (bad files, never paid). Tracking from the line item.
- `cancel()`: `PUT /print-jobs/{id}/status/ {"name":"CANCELED"}`, possible until the job enters
  production (i.e. within `production_delay`). Lulu's "Invalid transition" 400 → `false`.
- `listCharges()`: `GET /print-jobs/?created_after=…&exclude_line_items=true`, every page; one
  charge per job not `CANCELED`/`REJECTED`, amount = `costs.total_cost_incl_tax`. Jobs Lulu
  hasn't priced yet are skipped until it has (the card isn't charged before production).
- `pause()` is a local flag. **The real kills**: pause the Privacy card, then regenerate the
  client secret.

**Vendor-side caps.** Lulu has no prepaid balance: "After a Print-Job has been created
successfully, it will remain in an UNPAID state until it is paid … you can automate the process
by putting a credit card on file", charged when the job is sent to production. So the cap is
the card:

1. Create a **Privacy.com card locked to Lulu** (merchant-locked on first charge) with a
   **$40/month** spending limit, and make it the only card on the Lulu account. Pause it, don't
   close it, when stopping.
2. Generate the client key/secret and record them as `lulu-myvps-2026-10`; paste with
   `ops/set-key.sh LULU_CLIENT_KEY` and `ops/set-key.sh LULU_CLIENT_SECRET`.
3. Rehearse on the sandbox first (separate account, Lulu's test card); switch
   `LULU_ENV=production` only after a sandbox run passes.

**Live test** (sandbox only; it refuses `LULU_ENV=production`):
`LULU_LIVE=1 LULU_CLIENT_KEY=… LULU_CLIENT_SECRET=… LULU_CONTACT_EMAIL=… deno test --allow-read --allow-env --allow-net=api.sandbox.lulu.com --filter LIVE gate/adapters/lulu_test.ts`
It submits Lulu's own docs template book as a sandbox job (never printed), then cancels it.

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

Hosts: `slant3dapi.com` is added by `ops/install.sh`; the upload host is NOT (it isn't documented
and hasn't been observed live yet): `ops/install.sh --allow-net <upload host>`. Uploads go to a
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

Hosts: `api.sandbox.prodigi.com`, `api.prodigi.com` (both added by `ops/install.sh`).

**Items**: `sku` = a Prodigi product SKU from their catalogue (e.g. a giclée fine-art print
`GLOBAL-FAP-12X16`); `url` = the **https** image asset Prodigi downloads and prints (required:
`quote()` already refuses an item without one); `qty` = copies; `sizing` = `fillPrintArea`
(default), `fitPrintArea` or `stretchToPrintArea`; `attributes` = the product's attributes, e.g.
`{"color": "black"}` for a framed print (default none).

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
  Prodigi dashboard. The gate marks the request `needs_action` and DMs you once:
  `art print (Prodigi) order needs you: authorise the card payment in the Prodigi dashboard …`.
  The `authorisationUrl` itself is never DMed.
- `status()`: `GET /v4.0/orders/{id}`. Stage `Cancelled` → `cancelled`; `Complete` ("all
  shipments sent") → `delivered`, because Prodigi has no door-delivery signal; a shipment
  `Shipped` → `shipped`; otherwise `open` (an order inside a pause window has no status yet).
- `cancel()`: `POST /v4.0/orders/{id}/actions/cancel`; `cancelled` → true, `failedToCancel` /
  `actionNotAvailable` → false. Only possible before the order is in fulfilment.
- `listCharges()`: `GET /v4.0/orders?createdFrom=…&top=100&skip=…`; one charge per order = the net
  of its `charges[].totalCost` (refunds are negative). Orders with no charges yet are skipped.
  The ledger records the quote, which includes the 10% tax buffer whenever Prodigi quotes no US
  tax, and that quote is the order's hard cap. Prodigi's real charge (with real tax) at or under
  it just updates the request's final amount; a charge above it trips STOP. If real tax ever runs
  past the buffer, raise `PRODIGI_TAX_RATE`.
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

Hosts: `api.mouser.com` (added by `ops/install.sh`).

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

## Known gaps

- A robot-fund (`fund_auto`) order's `spend` entry is the amount at placing. When reconcile later
  moves the final amount (real tax, a refunded hold), the fund entry is not corrected yet.
- Slant 3D's upload host (a presigned S3 URL) isn't in `VENDOR_HOSTS`; add it with
  `ops/install.sh --allow-net` once seen.
- Mouser has no cancel endpoint and Tree-Nation no charges list (reconcile is blind there; the
  prepaid credit is the cap).

## Roadmap adapters

Lob (physical mail). Not built. Each needs its
own ToS read, key, vendor-side cap and `reachFor`. PRs welcome.

## Lob (postcards)

`gate/adapters/lob.ts`, id `lob`. Prints and mails one postcard per request through
[Lob](https://docs.lob.com) (US First Class). `maxReach` is `others`; `reachFor` is `self` when
`shipTo` is `owner-home`, otherwise `others`, so a postcard to anyone else always asks.

**Request shape.** Exactly one item, `qty: 1`:

- `sku`: `postcard` or `postcard:4x6` (4x6), or `postcard:6x9`.
- `url`: the front artwork, an https URL ending in `.pdf`, `.png` or `.jpg` with no query string
  (Lob's `remote_file_url` rule; ≤5 MB, 300 DPI, full bleed 4.25"x6.25" or 6.25"x9.25").
- The back is the message: `item.message` when present, else `item.title`. Max 350 characters
  (4x6) or 600 (6x9). It is HTML-escaped (braces too, so it can never be read as a Lob merge
  variable) into a left-column layout that stays clear of the address and postage block.
- `shipTo`: `owner-home` (from `OWNER_SHIP_TO_JSON`, the same value Zinc reads, base64 or JSON) or
  a US `{name, line1, city, state, zip}`. Lob needs no phone. The owner's address, when configured,
  is the return address.

| Env | |
|---|---|
| `LOB_API_KEY` | a secret `test_…` or `live_…` key (publishable `_pub_` keys are refused). Sent as the basic-auth username, never logged |
| `LOB_BASE_URL` | optional, default `https://api.lob.com/v1` (https only) |
| `LOB_POSTCARD_CENTS` | optional 4x6 per-piece price, default `91` |
| `LOB_POSTCARD_6X9_CENTS` | optional 6x9 per-piece price, default `103` |
| `LOB_CARD_FEE_RATE` | optional, default `0.03` (Lob's card service fee); `0` if the account pays by ACH |
| `OWNER_SHIP_TO_JSON` | the owner's address, shared with Zinc |

Allow the host: `ops/install.sh --allow-net api.lob.com`.

**Pricing.** Lob has no price-estimate endpoint and the postcard object carries no price, so
`quote()` uses the published per-piece table, offline. Lob's rates are all-in (print + postage +
delivery), so `shippingCents = 0`; Lob charges no sales tax on print or postage (since
2026-10-01), so `taxCents = 0`. Developer plan, First Class, as of 2026-07-12
([pricing details](https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details),
[pricing](https://lob.com/pricing/print-mail)): 4x6 $0.905 → 91¢, 6x9 $1.026 → 103¢. From
2026-11-01: $0.909 and $1.030 (same rounded cents). Total = price + `ceil(price × 0.03)` card fee
= **94¢** (4x6) or **107¢** (6x9). Update the env values if the plan or prices change.

**How it maps:**

- `place()`: `POST /postcards` with an `Idempotency-Key` header (the gate key; Lob returns the
  existing postcard for a repeat within 24 h), `use_type: "operational"` (Lob requires one; this is
  personal mail, not marketing), `mail_type: "usps_first_class"`, and metadata
  `ejb_idempotency_key`, `ejb_cents`, `task_id`. `chargedCents` = the table cost, refused if over
  the hard cap. Lob validation errors (`invalid_file_url`, `failed_deliverability_strictness`,
  `payment_method_unverified`, `rate_limit_exceeded`…) mean no postcard exists → `GuardRefused`
  → `failed`. 5xx, 408 and network errors stay `LobError` → `outcome_unknown`.
- `status()`: deleted → `cancelled`; render `failed` → `failed`; a `Delivered` tracking event →
  `delivered`; `Mailed` / `In Transit` / `In Local Area` / `Processed for Delivery` / `Re-Routed` /
  `International Exit` → `shipped`; none → `open`. `Returned to Sender` → `shipped` with
  `raw.returned = true`, never `cancelled`: it was printed and mailed, so it is billed and keeps
  counting against the windows. Postcards have no carrier tracking number. **Test-mode postcards
  never get tracking events, so they stay `open`.**
- `cancel()`: `DELETE /postcards/{id}`. Works only inside Lob's cancellation window (5 minutes by
  default on new accounts) and then the postcard is not billed; after that `not_deletable` → `false`.
  Longer windows and `send_date` scheduling are paid-edition features, so the adapter sets neither.
- `listCharges()`: `GET /postcards?date_created[gte]=…`, following `next_url`. One charge per
  postcard not deleted; amount = `metadata.ejb_cents`, else the table cost for its size. A postcard
  made by hand in the dashboard shows up here as a phantom charge and trips STOP.
- `pause()` is a local flag. **The real kill is disabling the live key** in the Lob dashboard
  (Settings → API Keys).

**Vendor-side caps.** None. Lob bills usage monthly in arrears (card +3% or ACH), has no per-key
spend limit, and does not stop mail on overage. The gate's caps and the lob/month window are the
only caps, so keep `vendor_month_cents` small for `lob`.

1. Sign up at <https://dashboard.lob.com> on the free Developer plan. Add a billing address and a
   payment method (live requests fail with `billing_address_required` / `payment_method_unverified`
   until you do). Optionally set the low-balance notification under billing.
2. Live postcards need `use_type`; the adapter sends `operational`, so no account default is needed.
3. Take the live secret key (`live_…`) under Settings → API Keys, name it `lob-<host>-<yyyy-mm>`
   (e.g. `lob-ejfvps-2026-10`; if the dashboard has no name field, record that name in your key
   inventory) and paste it with `ops/set-key.sh LOB_API_KEY`.

**Test mode.** A `test_…` key makes free postcards that never print or mail. The opt-in live test
makes ONE (plus an idempotent retry of the same key) to the docs' sample address with the docs'
sample artwork, then status, cancel and listCharges:
`LOB_LIVE=1 LOB_API_KEY=test_… deno test --allow-read --allow-env --allow-net=api.lob.com --filter LIVE gate/adapters/lob_test.ts`
(it refuses to run with a `live_` key).

## OSH Park (PCBs, made in the US): a handoff, the owner pays

`oshpark` is a **handoff** adapter: the robot prices and uploads the board, and **a human does
the checkout**. No money moves through the gate. OSH Park has no quote or order API; what it
documents ([API uploading](https://docs.oshpark.com/tips+tricks/api/), read 2026-10-11) is an
anonymous upload, `POST https://oshpark.com/import.json` with a multipart `file`, which answers
`{"token", "url": "https://oshpark.com/uploads/<token>"}`. Per the docs, the upload can't return
previews or warnings, nor add the project to an account. No key, no account, nothing to revoke.

- **Items:** exactly one. `sku` = the service, `qty` = boards (rounded up to sets of 3, max 30),
  `url` = the Gerber zip as a path under `$DATA_DIR/designs/` (anything else is refused). The
  pipeline that makes the zip is in [tools/pcb/README.md](../tools/pcb/README.md).
- **`quote()`** is computed locally, no network. The board size is the bounding box of the outline
  layer (X2 `Profile`, else `Edge_Cuts` / `.gko` / `.gm1` / `.gml`), arcs included
  (`gate/adapters/oshpark_gerber.ts`, CLI `tools/pcb/gerber_bbox.ts`). Price = rate × sq in ×
  sets, rounded once to the cent, from [docs.oshpark.com/services](https://docs.oshpark.com/services/)
  (verified 2026-10-11):

  | `sku` | service | $/sq in per set of 3 | ships in |
  |---|---|---|---|
  | `2layer` | 2-layer prototype, 1.6mm 1oz | 5 | 9-12 calendar days |
  | `2layer-swift` | 2-layer Super Swift | 10 | 4-5 business days |
  | `2layer-2oz` | 2-layer 2oz, 0.8mm | 5 | 12-21 calendar days |
  | `2layer-afterdark` | 2-layer After Dark | 5 | 12-21 calendar days |
  | `4layer` | 4-layer prototype | 10 | 9-14 calendar days |
  | `4layer-swift` | 4-layer Super Swift | 20 | 5-6 business days |
  | `6layer` | 6-layer prototype | 15 | 12-21 calendar days |

  Shipping is free worldwide; tax is quoted as 0 (OSH Park's checkout is authoritative and may
  add sales tax). Flex (suspended) and Medium Run (100 sq in minimum) are not offered.
  `vendorRef` binds the zip's sha256, so `place()` refuses a file that changed after the quote.
- **`place()` spends nothing.** It uploads the zip and returns an `Order` with
  `vendorOrderId` = the upload token, **`chargedCents = 0`**, and `raw = { handoff: true,
  blocked: "handoff", links: ["https://oshpark.com/uploads/<token>"] }`. The gate stores the link
  on the request and sends its one "order needs you" DM. The owner opens the link, reviews the
  render, picks the address and pays on oshpark.com. A third-party `shipTo` is refused (reach is
  `self`). Every failure is a `GuardRefused` (request `failed`, never `outcome_unknown`), since an
  upload can't move money; a retry may leave an orphan upload, which costs nothing. The upload
  still reaches OSH Park, so it needs `DRY_RUN=0` like any real vendor.
- **`status()`** is `open` (still reporting the handoff block and link) until the owner marks it:
  `touch $DATA_DIR/oshpark/<token>.delivered` when the boards arrive (the request then closes,
  with the link in the why-note), or `.cancelled` if they never order.
- **`cancel()`** returns `true` without a call: an upload nobody checks out is never made or billed.
- **`listCharges()` is always `[]`**: the card charge happens at OSH Park, outside the gate, so
  reconcile has nothing to match and nothing to flag. Because the order is recorded at $0, it
  does **not** use the day / month / vendor windows. The tier (auto / ask) is still chosen on the
  quoted price. To count the real spend, first `touch $DATA_DIR/oshpark/<token>-paid.delivered`,
  then `POST /internal/import-order` with `{vendor: "oshpark", vendorOrderId: "<token>-paid",
  cents, note}`. The marker comes first because the gate polls `status()` for imported rows too,
  and an unmarked id reads as an open handoff (it would close the row only after a "needs you" DM).
- `pause()` is a local flag.

**Gap.** The "needs you" DM is static text per vendor (`VENDOR_ACTION_HINTS`) and, by design,
carries no vendor URL; the uploads link is on the request (`GET /api/requests/:id`) and in the
delivery why-note. A DM that includes the sanitized `row.links[0]` would make the handoff one
tap. The live test:
`OSHPARK_LIVE=1 deno test --allow-read --allow-write=/tmp --allow-env --allow-net=oshpark.com --filter LIVE gate/adapters/oshpark_test.ts`
uploads a 20×20mm outline anonymously and orders nothing.

**Future auto-pay path:** PCBWay's partner API (`PcbQuotation`, `PlaceOrder`, `ConfirmOrder`
against a prepaid balance) would let the robot pay for boards under the normal caps, with the
balance as a vendor-side cap. Access is by application (anson@pcbway.com).
