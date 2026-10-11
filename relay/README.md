# approve relay

The only internet-facing piece of the purchase gate. The owner taps a link from a private message
(`https://approve.example.com/a/<lookupId>#<token>`); the private gate pushes records here and
pulls verdicts. The relay never calls the gate and holds no vendor keys or gate tokens, only
`RELAY_TOKEN`.

## Two links, two tokens, fragment only
Every record has a **deny token**; ask-tier records (`kind: "approve"`) also have a separate
**approve token**. The gate mints both, sends the relay only their SHA-256 hashes
(`denyTokenHash`, `approveTokenHash`), and puts each plaintext in its own link in the message,
next to a random public **lookupId** per link (`denyLookupId`, `approveLookupId`):

- ask tier: `/a/<approveLookupId>#<approveToken>` and `/a/<denyLookupId>#<denyToken>`
- veto (auto / fund / joy): only `/a/<denyLookupId>#<denyToken>`. A veto record must not carry
  `approveTokenHash` or `approveLookupId`.

The token is in the URL **fragment**, which browsers never send to a server, so a GET of the link
(the owner opening it, Discord's unfurler, an iOS preview, any prefetcher) reaches the relay with
the lookupId only. The lookupId selects the record and the page; it cannot approve or deny.

Each link does exactly one thing. The approve link's page shows only an Approve button, the deny
link's page only Deny (or "Veto this purchase"). The page is rendered with an empty `token` field
and a disabled button; one inline script reads `location.hash`, fills the field, enables the
button and clears the fragment with `history.replaceState`. Without JavaScript the button stays
disabled and the page says JavaScript is needed to confirm. A tap POSTs the token in the form
body. Posting to the other action, or a token that doesn't hash to the one stored for that
lookupId, is refused with 403 and consumes nothing. Either successful tap consumes the whole record.

### Proof of tap
On a successful **approve** tap the relay stores the plaintext approve token (from the POST body)
next to the verdict. `GET /internal/verdicts` returns it as `token` on that approve verdict the
first time it is pulled and deletes it in the same operation, so it is returned at most once. The
gate hashes it and compares it with its own `approveTokenHash`; an approve without a matching token
is ignored. Before a tap the relay has never seen the approve token (not in a GET, not in its
database, not in any access log), so a relay compromised at rest can deny but never approve. The
limit: a relay that is compromised while it serves the page could ship a different script that
reads the fragment when the owner opens an Approve link (see `docs/threat-model.md`, scenario 3).
Deny verdicts never carry a token. As a backstop, a stored token older than 24h after the tap is
deleted (on every publish and every verdict pull) and never returned.

## Files
- `main.ts`: router, auth, rate limit, body cap, validation. `export default { fetch }`.
- `store.ts`: the `RelayStore` interface plus two backends, `SqliteStore` and `KvStore`.
- `page.ts`: HTML renderers (inline CSS, one static inline script `TOKEN_SCRIPT`, no external
  assets, everything escaped).
- `main_test.ts`: every behavioural test runs once per backend (`[sqlite] ...`, `[kv] ...`):
  `deno test --allow-read --allow-write=/tmp --allow-env --unstable-kv relay/main_test.ts`

## Routes
| Route | Auth | Notes |
|---|---|---|
| `GET/HEAD /a/:lookupId` | none (public id) | Zero writes on both backends (prefetch-safe). Looks the lookupId up against both the deny and approve lookupIds and renders the one form for that link, with an empty `token` field. The response never contains a token. Unknown, expired, used and malformed lookupIds get one byte-identical neutral 404. |
| `POST /a/:lookupId/approve`, `/deny` | token in body | Form field `token` (filled from the fragment by the page script) must hash (sha256, constant-time compare) to the hash stored for that lookupId's link, or 403. `/approve` only accepts the approve link, `/deny` only the deny link; the wrong one gets 403. A 403 consumes nothing. Unknown, expired and used lookupIds get the neutral 404. Single-use per record (atomic on both backends). GET/HEAD → 405. |
| `POST /internal/pending` | `Bearer RELAY_TOKEN` | Strict JSON `ApprovalRecord`: unknown keys, bad kind, non-hex `denyTokenHash`, missing/bad `approveTokenHash` on `kind: "approve"`, any `approveTokenHash` on `kind: "veto"`, equal hashes, the same rules for `denyLookupId`/`approveLookupId` (base64url, 16 to 64 chars), negative/non-integer/over-`RELAY_MAX_CENTS` cents, or expiry > 25h out → 400. Upsert by `approvalId`; a tapped record is frozen (`already_decided`); either hash or either lookupId already used by another `approvalId` → 409; re-publishing with new hashes and lookupIds replaces the old ones. Client `usedAt`/`verdict` are ignored. Prunes records 30 days past expiry. |
| `GET /internal/verdicts?since=ISO` | `Bearer RELAY_TOKEN` | `Verdict[]` with `used_at > since`, oldest first, about 500 per page (never splits a same-millisecond group). `at` is the cursor for the next pull. Approve verdicts carry `token` once (above). |
| anything else | none | Neutral 404. |

`/internal/*` returns 503 when `RELAY_TOKEN` is unset or shorter than 32 chars.

## Storage backends
- **`sqlite`** (default): `node:sqlite` at `<RELAY_DATA_DIR>/relay.db`. Single-use taps run in a
  `BEGIN IMMEDIATE` transaction. A database from the older single-token schema is renamed to
  `approvals_legacy_v1`, and one from before lookupIds (links of the form `/a/<token>`) to
  `approvals_legacy_v2`; neither is dropped.
- **`kv`**: Deno KV via `Deno.openKv(RELAY_KV_PATH)`. Keys: `["approval", id]`, `["hash", hash]`
  (both hashes indexed), `["lookup", lookupId]` (both lookupIds indexed), `["verdict", usedAt, id]`
  (ordered for `since` paging), `["proof", id]`.
  A tap is one `atomic().check(entry)` commit on the record's versionstamp, so of two concurrent
  taps exactly one wins. All keys get `expireIn` (expiry or tap + 30 days; proof tokens 24h).

The opened handle is cached per backend and path.

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | none | Bearer for `/internal/*`, at least 32 random chars; the gate's `RelayClient` uses the same value. Falls back to the file `<RELAY_DATA_DIR>/.relay-token` (chmod 600). |
| `RELAY_DATA_DIR` | `data/` next to `main.ts` | SQLite directory (and the token file). |
| `RELAY_STORE` | `sqlite` | `sqlite` or `kv`. Any other value fails closed: every route returns 503. |
| `RELAY_KV_PATH` | none | Path passed to `Deno.openKv` (tests use a `/tmp` path). Unset → `Deno.openKv()` default, which is what Deno Deploy wants. |
| `RELAY_IP_HEADER` | `cf-connecting-ip` | Header the per-IP rate limit keys on. `x-forwarded-for` uses the right-most hop (the one your proxy appended; earlier hops are client-supplied); any other name is read as-is; `none` puts every client in one shared bucket. Values that aren't an IPv4/IPv6-looking string (≤ 45 chars) share one bucket. |
| `RELAY_MAX_CENTS` | `100000` | Upper bound on `boundCents` (positive integer; anything else → default). |
| `RELAY_TIMEZONE` | `UTC` | IANA zone for the expiry time on the page; invalid → `UTC`. |

## Hardening
- Every response: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and the CSP
  `default-src 'none'; script-src 'sha256-<hash of TOKEN_SCRIPT>'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
  The script hash is computed from `TOKEN_SCRIPT` at startup, so exactly that one inline script
  can run: no `'unsafe-inline'` for scripts, no nonces, no script sources.
  The HTML also carries `<meta name="robots" content="noindex,nofollow">`.
- Rate limit of 10 requests/min per IP on `/a/*` (in memory, per process; a restart resets it). The map is
  bounded at 10k keys.
- `POST /a/*/deny` is never rate-limited. Deny is the fail-safe direction, and a 429 on a veto link would
  let the purchase go through.
- Bodies are capped at 4 KB by reading the stream, so chunked bodies can't get around it.
- Nothing logs URLs, tokens or bodies. Unhandled errors log only `err.name`.

## Deploy
- Deploy **only this `relay/` folder** (smallweb, Deno Deploy, or `deno serve main.ts`). It's
  self-contained, with local mirrors of `ApprovalRecord`, `Verdict` and `FUND_MAX_CENTS`; a test keeps
  them in sync with `gate/types.ts` and fails on any `../` import. Never serve the repo root: static
  hosting would expose the gate code, `data/` and `.env`.
- **Deno Deploy** has no writable disk: set `RELAY_STORE=kv` and leave `RELAY_KV_PATH` unset. Locally,
  the KV backend needs `--unstable-kv`. Set `RELAY_IP_HEADER` to whatever your platform/proxy sets
  (`x-forwarded-for` behind a typical reverse proxy).
- The rate limit trusts the IP header. If the origin is reachable without your proxy in front, that
  header can be spoofed; choose `none` rather than trusting a header nobody sets.
- Proxy and platform access logs record request paths, which hold only lookupIds: tokens are in
  the link's `#fragment` (never sent) and in POST bodies. The relay itself logs nothing. Don't
  enable request-body logging in front of the relay.
