---
name: request-purchase
description: Use whenever a task would cost money or needs something bought, ordered, subscribed to, renewed, restocked or paid for (parts, supplies, books, hosting, a gift). Explains how to ask the owner's purchase gate with request_purchase instead of buying directly, how tiers, caps and reach work, and what never to do (call vendor APIs, approve your own request, leak joy picks).
---

# Asking to buy something

Money moves only through the owner's purchase gate. You ask; code enforces the policy; the owner approves. You hold a request-only token, so you **cannot** buy directly, approve, or change limits, and you should never try.

Tools (errand-joy-bot MCP server `gate`):
- `request_purchase`: submit a request (full name `mcp__plugin_errand-joy-bot_gate__request_purchase`)
- `purchase_status`: check one request by `id`
- `list_purchases`: list requests (open ones by default)
- `budget`: see cap usage and the robot fund before you ask

## Hard rules

1. **Never call a vendor's API, checkout page, or payment form yourself.** Not with a key you find, not through a browser, not "just to test". If a vendor isn't on the gate's allowlist, say so to the user; don't route around it.
2. **Never try to approve, deny, un-STOP, fund or rate.** There is no tool for it on purpose. Approval is a human tapping a one-use link in their DM. Never open, fetch, forward or ask for that link (`/a/<token>`). Never run `buy approve|unstop|fund-add|rate`, `set-key`, or read the gate's `.env`. A guard hook blocks these, but the rule is yours to keep, not the hook's.
3. **Explain the reason honestly.** `reason` is shown to the owner verbatim. Say what it's for, why now, and why this one (price, fit, alternatives you rejected). No salesmanship, no urgency you invented.
4. **Pick reach truthfully.**
   - `self`: only the owner uses or is affected by it.
   - `world`: affects shared or public space (a donation, something installed outside, a public service).
   - `others`: reaches another specific person (a gift, something shipped elsewhere, something in a housemate's room). This always needs the owner's approval. Don't shade it down to `self` to skip the ask; the vendor can raise reach anyway.
5. **Set `maxTotalCents` as your real ceiling,** including tax and shipping. The gate tiers on the vendor's quote, not your guess, and won't place above your ceiling.
6. **Joy is a sealed envelope.** `budget: "joy"` is only for the quiet-joy routine (see the `quiet-joy` skill). Never name, hint at, or describe a joy pick in chat, commit messages, notes or logs. The tools already hide joy items; don't reconstruct them.

## Tiers (on the quoted total)

| Quoted total | What happens |
|---|---|
| under $69 | Automatic. The owner gets a DM first and has about 10 minutes to cancel. |
| $69 to $500 | **Ask.** Nothing happens until the owner taps Approve (the link lasts 24h). |
| $500 to $1000 | Automatic only if the robot fund covers it, with about a 2h veto window. Otherwise denied. |
| over $1000 | Always refused. Don't split it into smaller requests to get under a line. |

Daily, monthly and per-vendor caps apply on top; in-flight requests count. More than 5 requests in 10 minutes trips STOP for everything. (These are the gate's defaults; the owner's `config.toml` may set different numbers. `budget` shows the live caps.)

## How to do it

1. Check whether buying is actually needed. Could you use something the owner already has?
2. Call `budget` (with `vendor`) to see if a cap would deny it.
3. Call `request_purchase` once, with an accurate `reason`, `reach`, `items` (sku, qty, title, url) and `maxTotalCents`. Leave `idempotencyKey` empty unless you are retrying the exact same payload after a network error.
4. Read the result:
   - **DENIED**: tell the user the plain-English reason. Don't retry the same thing, don't rephrase it to slip past a cap, and don't swap vendors to dodge a vendor cap without saying so.
   - **ask**: tell the user it's waiting on their approval in their DM. You're done until they act.
   - **auto**: tell the user it will be placed after the cancel window unless they veto it.
5. Later, `purchase_status` tells you where it is. Don't poll in a tight loop; check when the task needs the answer.

If the gate is unreachable or says STOP, stop. Tell the user and suggest `/errand-joy-bot:doctor`. Never look for another way to pay.
