# Vendors

A vendor is a code adapter, not a config entry. The allowlist is closed: the gate only
buys from adapters registered in `gate/adapters/registry.ts` **and** listed in
`vendors` in `config.toml`. Adding one is a reviewed code change.

Shipped today: `zinc` (see [Zinc](#zinc-retail-amazon-walmart-target-mcmaster-carr) below),
`stannp` ([Stannp](#stannp-us-postcards-and-letters)), `lulu` ([Lulu](#lulu-print-api-zines-and-books)) and
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
| physical mail or print (Stannp, Lulu) | `others` | `self` to the owner-home label, else `others` (always asks, never sealed) |
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

Allow the host: `ops/install.sh --allow-net api-us1.stannp.com`.

**What an agent sends.** One item, `qty: 1` (one request = one mailpiece):

| `sku` | `url` | `title` |
|---|---|---|
| `postcard-4x6`, `postcard-6x9`, `postcard-6x11` | the front image, https JPG/PNG/PDF (e.g. a render) | the message printed on the back |
| `letter` | the letter PDF (https, ≤ 25 pages) | unused |

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
3. Name the key `stannp-ejfvps-2026-10`. The docs only show one key on the settings page
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

Allow the host: `ops/install.sh --allow-net api.sandbox.lulu.com` (and `api.lulu.com` for production).

**What an agent sends.** Up to 10 items (one per title), `qty` = copies (1-100):

- `sku` = `<pod_package_id>/<page_count>`, e.g. `0550X0850.FC.STD.SS.080CW444.GXX/16` (dotted or
  legacy 27-char pod package ids; pick one with Lulu's price calculator).
- `url` = the interior PDF with the cover PDF in the fragment:
  `https://files.example/zine-42/interior.pdf#cover=https://files.example/zine-42/cover.pdf`
  (the cover may be percent-encoded). Both must be public https URLs Lulu can download.
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
2. Generate the client key/secret and record them as `lulu-ejfvps-2026-10`; paste with
   `ops/set-key.sh LULU_CLIENT_KEY` and `ops/set-key.sh LULU_CLIENT_SECRET`.
3. Rehearse on the sandbox first (separate account, Lulu's test card); switch
   `LULU_ENV=production` only after a sandbox run passes.

**Live test** (sandbox only; it refuses `LULU_ENV=production`):
`LULU_LIVE=1 LULU_CLIENT_KEY=… LULU_CLIENT_SECRET=… LULU_CONTACT_EMAIL=… deno test --allow-read --allow-env --allow-net=api.sandbox.lulu.com --filter LIVE gate/adapters/lulu_test.ts`
It submits Lulu's own docs template book as a sandbox job (never printed), then cancels it.

## Roadmap adapters

Mouser (electronics), Lob (physical mail),
Tree-Nation (tree planting), SkyFi (satellite imagery). None are built. Each needs its
own ToS read, key, vendor-side cap and `reachFor`. PRs welcome.
