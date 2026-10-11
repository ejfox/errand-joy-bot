# Vendors

A vendor is a code adapter, not a config entry. The allowlist is closed: the gate only
buys from adapters registered in `gate/adapters/registry.ts` **and** listed in
`vendors` in `config.toml`. Adding one is a reviewed code change.

Shipped today: `zinc` (see [Zinc](#zinc-retail-amazon-walmart-target-mcmaster-carr) below) and
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
| `OWNER_SHIP_TO_JSON` | the owner's address in Zinc's shape: `{"first_name","last_name","address_line1","address_line2","city","state","postal_code","phone_number","country":"US"}`. Private. `place()` refuses if it is missing or any required field is empty, the ZIP isn't 5 or 9 digits, or `state` isn't a 2-letter code |

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

## Roadmap adapters

Mouser (electronics), Lob and Stannp (physical mail),
Tree-Nation (tree planting), SkyFi (satellite imagery). None are built. Each needs its
own ToS read, key, vendor-side cap and `reachFor`. PRs welcome.
