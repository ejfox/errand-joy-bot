# approve relay

The only internet-facing piece of the purchase gate. The owner taps a link from a private message
(`https://approve.example.com/a/<token>`); the private gate pushes records here and pulls verdicts.
The relay never calls the gate and holds no vendor keys or gate tokens, only `RELAY_TOKEN`.

## Two links, two tokens
Every record has a **deny token**; ask-tier records (`kind: "approve"`) also have a separate
**approve token**. The gate mints both, sends the relay only their SHA-256 hashes
(`denyTokenHash`, `approveTokenHash`), and puts each plaintext in its own link in the message:

- ask tier: `/a/<approveToken>` and `/a/<denyToken>`
- veto (auto / fund / joy): only `/a/<denyToken>`. A veto record must not carry `approveTokenHash`.

Each token does exactly one thing. The approve link's page shows only an Approve button, the deny
link's page only Deny (or "Veto this purchase"). Posting a token to the other action is refused
with 403 and consumes nothing. Either successful tap consumes the whole record.

### Proof of tap
On a successful **approve** tap the relay stores the plaintext approve token next to the verdict.
`GET /internal/verdicts` returns it as `token` on that approve verdict the first time it is pulled
and deletes it in the same operation, so it is returned at most once. The gate hashes it and
compares it with its own `approveTokenHash`; an approve without a matching token is ignored, so a
compromised relay can deny but never approve. Deny verdicts never carry a token. As a backstop, a
stored token older than 24h after the tap is deleted (on every publish and every verdict pull) and
never returned.

## Files
- `main.ts`: router, auth, rate limit, body cap, validation. `export default { fetch }`.
- `store.ts`: the `RelayStore` interface plus two backends, `SqliteStore` and `KvStore`.
- `page.ts`: HTML renderers (inline CSS, no JS, no external assets, everything escaped).
- `main_test.ts`: every behavioural test runs once per backend (`[sqlite] ...`, `[kv] ...`):
  `deno test --allow-read --allow-write=/tmp --allow-env --unstable-kv relay/main_test.ts`

## Routes
| Route | Auth | Notes |
|---|---|---|
| `GET/HEAD /a/:token` | token | Zero writes on both backends (prefetch-safe). Matches the token's hash against both the deny and approve hashes and renders the one form for that link. Unknown, expired, used and malformed tokens get one byte-identical neutral 404. |
| `POST /a/:token/approve`, `/deny` | token | Form field `token` must equal the path token (constant-time) or 403. `/approve` only accepts an approve token, `/deny` only a deny token; the wrong one gets 403 and nothing is consumed. Single-use per record (atomic on both backends). GET/HEAD → 405. |
| `POST /internal/pending` | `Bearer RELAY_TOKEN` | Strict JSON `ApprovalRecord`: unknown keys, bad kind, non-hex `denyTokenHash`, missing/bad `approveTokenHash` on `kind: "approve"`, any `approveTokenHash` on `kind: "veto"`, equal hashes, negative/non-integer/over-`RELAY_MAX_CENTS` cents, or expiry > 25h out → 400. Upsert by `approvalId`; a tapped record is frozen (`already_decided`); either hash already used by another `approvalId` → 409; re-publishing with new hashes replaces the old ones. Client `usedAt`/`verdict` are ignored. Prunes records 30 days past expiry. |
| `GET /internal/verdicts?since=ISO` | `Bearer RELAY_TOKEN` | `Verdict[]` with `used_at > since`, oldest first, about 500 per page (never splits a same-millisecond group). `at` is the cursor for the next pull. Approve verdicts carry `token` once (above). |
| anything else | none | Neutral 404. |

`/internal/*` returns 503 when `RELAY_TOKEN` is unset or shorter than 32 chars.

## Storage backends
- **`sqlite`** (default): `node:sqlite` at `<RELAY_DATA_DIR>/relay.db`. Single-use taps run in a
  `BEGIN IMMEDIATE` transaction. A database from the older single-token schema is renamed to
  `approvals_legacy_v1`, never dropped.
- **`kv`**: Deno KV via `Deno.openKv(RELAY_KV_PATH)`. Keys: `["approval", id]`, `["hash", hash]`
  (both hashes indexed), `["verdict", usedAt, id]` (ordered for `since` paging), `["proof", id]`.
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
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
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
- Tokens are in the URL path, so proxy and platform access logs record live tokens, valid for up to 24h.
  The relay itself logs nothing. Keep access logs for `/a/*` out of any log shipping, or redact them.
