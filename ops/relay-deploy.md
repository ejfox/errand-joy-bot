# Deploying the approval relay (`relay/`)

The relay is the **only** public piece of errand-joy-bot. It renders the one-use
approve / veto page at `https://approve.example.com/a/<token>` that the owner's DM links
to. It holds no vendor keys and no gate tokens, only `RELAY_TOKEN`, and it never calls
the gate: the gate pushes approval records (token hashes only) and pulls verdicts.

Everything else stays private:

| Piece | Exposure |
|---|---|
| gate (`gate/main.ts`) | loopback only (`127.0.0.1:47400`). Never put it behind a tunnel or proxy. |
| `.env`, `config.toml`, `data/` | the gate host's disk, mode 600 / 700 |
| relay (`relay/`) | public over HTTPS, keyless |

> **Access logs capture live link tokens.** The token is in the URL path, so any proxy,
> CDN, tunnel or platform that logs request paths (Cloudflare, smallweb, Deno Deploy,
> nginx, Caddy) records it. Tokens are single-use and expire after 24h, and an approve
> also needs the token in the POST body, but treat those logs as sensitive: don't ship
> `/a/*` paths to a third-party log service, or redact them. The relay itself logs
> nothing.

Deploy **only the `relay/` folder**. It is self-contained (a test fails on any `../`
import). Never point a host at the repo root: that would expose the gate code and,
worse, a `.env` or `data/` sitting next to it.

## Relay environment

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | (required) | shared secret with the gate, 32+ chars. Or the file `data/.relay-token` (mode 600) |
| `RELAY_DATA_DIR` | `<relay>/data` | where the SQLite store and token file live |
| `RELAY_STORE` | `sqlite` | `kv` uses Deno KV (required on Deno Deploy; locally it needs `deno --unstable-kv`) |
| `RELAY_KV_PATH` | (platform default) | optional Deno KV path when `RELAY_STORE=kv` |
| `RELAY_IP_HEADER` | `cf-connecting-ip` | header the per-IP rate limit trusts: `cf-connecting-ip`, `x-forwarded-for` (first hop), or `none` (one shared bucket). Deny taps are never rate-limited |
| `RELAY_MAX_CENTS` | `100000` | largest amount the relay accepts in an approval record |
| `RELAY_TIMEZONE` | `UTC` | time zone for times shown on the page |

Only set `RELAY_IP_HEADER` to a header your proxy actually sets and strips from client
requests; otherwise a client can spoof it.

## The relay token

The gate and the relay share one random `RELAY_TOKEN` (32+ chars). Mint it on the gate
host and pipe it to both places, so it is never typed, echoed or put in a command line:

```bash
# on the gate host, in INSTALL_DIR
ops/set-key.sh --generate RELAY_TOKEN          # prints only RELAY_TOKEN set (...last4)
```

The relay reads `RELAY_TOKEN` from its environment, or from the file
`<relay>/data/.relay-token` (mode 600). To copy the value without printing it:

```bash
# same machine (target B below)
( umask 077; grep '^RELAY_TOKEN=' .env | cut -d= -f2- > /srv/relay/data/.relay-token )
# another machine over ssh
grep '^RELAY_TOKEN=' .env | cut -d= -f2- | ssh <relay-host> 'umask 077; cat > /srv/relay/data/.relay-token'
```

For a platform with a secrets UI (Deno Deploy), paste it from the clipboard into the
secret field; don't put it in a deploy command.

Then set `RELAY_URL` and `RELAY_PUBLIC_URL` in the gate's `.env` to the relay's public
origin, re-run `ops/install.sh` (the relay host goes into the gate's `--allow-net`), and
restart the gate.

---

## Target A (recommended): Cloudflare Tunnel to a local Deno

The relay runs as its own small process on any box you control (the gate host is fine),
bound to loopback, and a Cloudflare Tunnel publishes it. No open inbound ports.

1. **Copy the source** (never `data/`), checking first:
   ```bash
   rsync -azn --itemize-changes --exclude=data/ --exclude='*.db*' relay/ /srv/relay/   # look
   rsync -az  --itemize-changes --exclude=data/ --exclude='*.db*' relay/ /srv/relay/
   mkdir -p /srv/relay/data && chmod 700 /srv/relay/data
   ```
   If `/srv/relay` already exists, back it up first:
   `cp -a /srv/relay /srv/relay.bak-$(date +%Y%m%d-%H%M%S)`.

2. **Write the token** into `/srv/relay/data/.relay-token` (see above).

3. **Run it** on loopback with tight permissions. As a systemd unit
   (`/etc/systemd/system/errand-joy-relay.service`; back up any existing one):
   ```ini
   [Unit]
   Description=errand-joy-bot approval relay
   After=network-online.target

   [Service]
   User=<relay-user>
   WorkingDirectory=/srv/relay
   ExecStart=/usr/local/bin/deno serve --host 127.0.0.1 --port 47401 \
     --allow-read=/srv/relay --allow-write=/srv/relay/data \
     --allow-env=RELAY_TOKEN,RELAY_DATA_DIR,RELAY_STORE,RELAY_KV_PATH,RELAY_IP_HEADER,RELAY_MAX_CENTS,RELAY_TIMEZONE \
     main.ts
   Restart=on-failure
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=read-only
   ReadWritePaths=/srv/relay/data
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```
   Use the absolute path of your deno (`readlink -f "$(command -v deno)"`).

4. **Publish it** through a tunnel (`cloudflared`), in the tunnel's config:
   ```yaml
   ingress:
     - hostname: approve.example.com
       service: http://127.0.0.1:47401
     - service: http_status:404
   ```
   The relay's per-IP rate limit reads the header named by `RELAY_IP_HEADER` (default
   `cf-connecting-ip`), which is correct here because the tunnel is the only way in.
   Keep port 47401 on loopback; if the origin were reachable directly, that header could
   be spoofed.

## Target B: smallweb

[smallweb](https://www.smallweb.run) serves each folder in its workspace as
`<folder>.<your-domain>`, and the relay already follows its conventions
(`export default { fetch }`, writes only under `data/`).

1. **Inspect.** Read your workspace's own notes on its Deno version and conventions.
   Check whether the folder (call it `approve`) already exists and whether the workspace
   is a git repo:
   ```bash
   ls -la "$SMALLWEB_DIR/approve" 2>/dev/null || echo "not there yet"
   git -C "$SMALLWEB_DIR" status --short 2>/dev/null | head
   ```
2. **Back up** if it exists, to a path **outside** the workspace (it may contain the token):
   `cp -a "$SMALLWEB_DIR/approve" "$HOME/approve.bak-$(date +%Y%m%d-%H%M%S)"`
3. **Gitignore `data/` before any secret lands there**, if the workspace is a git repo.
   Back up `.gitignore`, add `approve/data/` with an editor, then confirm:
   ```bash
   git -C "$SMALLWEB_DIR" check-ignore -v approve/data/.relay-token approve/data/relay.db
   ```
   Both paths must print a matching rule.
4. **Copy the source** with the same `rsync --exclude=data/` pair as target A (no `--delete`).
5. **Write the token** to `approve/data/.relay-token`. If smallweb runs as a different uid
   and can't read a mode-600 file, fix ownership (`chown`), don't loosen the mode.
6. If smallweb sits behind Cloudflare, the default `RELAY_IP_HEADER=cf-connecting-ip`
   is right. Behind another proxy, set it to `x-forwarded-for`; with nothing trustworthy,
   `none` (every visitor shares one bucket, which fails toward 429 on approve; deny is
   never rate-limited).

## Target C: Deno Deploy

By default the relay keeps its records in SQLite under `data/`, and Deno Deploy has no
persistent writable disk. Set `RELAY_STORE=kv` and the relay uses Deno KV instead.

1. Create a project whose entrypoint is `relay/main.ts`, deploying only the `relay/`
   folder (never the repo root).
2. Environment variables, set in the dashboard:
   - `RELAY_TOKEN`: paste from the clipboard into the secret field.
   - `RELAY_STORE=kv`
   - `RELAY_IP_HEADER=x-forwarded-for` (or `none`). There is no `cf-connecting-ip` on
     Deno Deploy unless you front it with Cloudflare; with the wrong header every visitor
     shares one rate-limit bucket.
3. Add a custom domain such as `approve.example.com`, or use the project's deno.net URL.
4. Deno Deploy keeps request logs with paths; see the access-log warning above.

---

## Verify the public surface (any target)

```bash
curl -sI https://approve.example.com/a/not-a-real-token                       # 404, neutral page
curl -sI https://approve.example.com/a/not-a-real-token | grep -iE 'cache-control|x-robots|referrer'
curl -s -o /dev/null -w '%{http_code}\n' https://approve.example.com/internal/verdicts   # 401
curl -s -o /dev/null -w '%{http_code}\n' https://approve.example.com/a/x/approve          # 405 (GET)
curl -s -o /dev/null -w '%{http_code}\n' https://approve.example.com/.env                 # 404
```

Expect `no-store`, `noindex, nofollow` and `no-referrer` on every response. Then run
`bin/buy tick` on the gate host; the gate log should show a verdict pull with no auth
errors.

## Rollback / offline

Move the live folder aside and restore the backup; restart the relay process if it is
not smallweb. Taking the relay offline entirely **fails closed**: approvals can't be
tapped, so nothing in the ask tier gets placed. (Veto links also stop working, so set
STOP with `bin/buy stop` if you want auto-tier buys held too.)
