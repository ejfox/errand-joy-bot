# Notifiers

The DM to the owner is not a courtesy, it is part of the approval path. Nothing is placed
until a DM about it has been **delivered**, confirmed by a message id from the platform.
No message id, no purchase. That makes the notifier fail closed: if it is down, buying
stops (and after 24h the gate trips STOP).

Pick one with `NOTIFIER` in `.env`. With `DRY_RUN=1` an in-memory notifier is always
used and nothing is sent.

## `http-dm` (shipped)

A generic "POST JSON, get a message id back" transport. Point it at any small service
that can DM you: an existing chat bot, a webhook bridge, a tiny script.

```
POST $NOTIFY_DM_URL
Authorization: Bearer $NOTIFY_DM_TOKEN
Content-Type: application/json

{"userId": "$NOTIFY_USER_ID", "message": "<text>"}
```

- **Success** = a 2xx response whose JSON body has `messageId`, `message_id` or `id`
  (string up to 64 chars, or a number). Anything else is a failure and is retried on the
  next tick.
- 10 second timeout, redirects refused.
- `NOTIFY_DM_URL` must be `https://`, or plain `http://` only on loopback
  (`127.0.0.1`, `localhost`, `[::1]`), so the bearer token never crosses a network in clear.
- `ops/install.sh` adds the endpoint's host to the gate's `--allow-net`.

Your endpoint must:

1. Check the bearer token (constant-time compare).
2. Send the message as a **private** message to exactly one user. Never a channel.
3. Return the platform's message id only after the platform accepted the message.
4. Not log message bodies. **DMs contain live approval links** (single-use, 24h). Treat
   the endpoint's logs and the chat history like a password manager's clipboard.
5. Suppress link previews if the platform supports it (the gate wraps URLs in `<...>`,
   which Discord honours), so the platform's crawler doesn't fetch the approval page.
   Fetching the page is harmless (GET performs zero writes), but it is a needless leak.

A minimal endpoint is a few dozen lines in any language: verify the token, call your chat
platform's "send direct message" API, return `{"messageId": "<id>"}`.

## Quiet hours

`[quiet_hours]` in `config.toml` (in `timezone`) queues DMs instead of sending them.
Because nothing is placed before its DM is delivered, purchases wait too.

## Adding a transport

Transports live in `gate/notify.ts`. Implement the `Notifier` interface:

```ts
interface Notifier { send(text: string): Promise<DmResult> }   // gate/types.ts
// DmResult = { ok: boolean; messageId?: string; error?: string }
```

Rules for a transport:

- `ok: true` **only** when the platform confirms delivery and you have a message id.
- `error` is a short code (`http_502`, `fetch_TimeoutError`), never the message text,
  because errors are stored in the ledger and the text carries the approval token.
- Read its own config from env inside its factory; no hardcoded ids or tokens.
- Register a factory in `NOTIFY_TRANSPORTS` under the name users put in `NOTIFIER`.
  An unknown name fails closed (never sends).
- Tests use a fake `fetch`; no network.

## Roadmap transports

| Name | Idea | Delivery confirmation |
|---|---|---|
| `discord-bot` | the gate talks to the Discord API directly with a bot token, opening a DM channel to the owner | message object id |
| `ntfy` | push via an ntfy server you control (self-hosted or a private topic) | response `id` |
| `telegram` | Bot API `sendMessage` to the owner's chat id | `message_id` |

Whatever the transport, keep the DM private to the owner. A shared channel turns every
approval link into a link anyone in that channel can tap.
