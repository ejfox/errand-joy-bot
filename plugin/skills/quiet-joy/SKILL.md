---
name: quiet-joy
description: The weekly quiet-joy routine. Use when asked to "do the joy run", "spend the joy budget", "pick this week's surprise", or when a scheduled weekly joy task fires. Reads the owner's to-do list, notes and owned-items list, picks 1 to 3 small things they don't own that would quietly improve their week, and submits them to the purchase gate with budget "joy" and reach "self", keeping the picks secret.
---

# Quiet joy: the weekly surprise budget

Once a week you get a small budget (default $40 per ISO week, each purchase under the auto line) to buy the owner something that quietly makes their week better. It's a surprise. Picks under $40 are **silent**: no DM at all until it arrives. A bigger pick (only possible if the owner raised the weekly joy cap) gets a sealed DM: "robot spent $55 on something (hint: for clear nights), tap to veto". Either way the owner learns what it was, and why, only when it arrives, from your `whyNote`.

## Where to look

These come from the plugin's settings (`/plugin` → errand-joy-bot → configure). If one is empty or shows as a literal `${user_config...}`, skip it. If all three are empty, ask the owner where to look and stop there.

- To-do list: `${user_config.joy_todo_path}`
- Notes folder: `${user_config.joy_notes_dir}` (skim the most recent couple of weeks, not everything)
- Owned items: `${user_config.joy_owned_items_path}`
- Shared household spaces allowed: `${user_config.joy_household_ok}`

Read only what you need. Don't copy their notes anywhere.

## Picking

Pick **1 to 3** things. Fewer, better.

- **Small and specific**: a friction from the to-do list that a cheap object fixes, a consumable they keep running out of, a tool that unblocks a project they're stuck on, a book on something they've been writing about lately.
- **Not already owned.** Check the owned-items list and the notes. Never buy a duplicate or a slightly different version of what they have.
- **For the owner only.** Their own use, their own space. Never anything for another household member's room, things, kids, pets or partner, and never a gift for someone else. If shared household spaces is `false` (the default), nothing for shared rooms either. When in doubt, leave it out.
- **Quiet.** Nothing that needs setup from them, a subscription, a recurring charge, a decision, or a conversation. No food or anything perishable unless the notes clearly say they want it. Nothing that implies a judgment about them (no self-improvement nudges).
- **Fits the budget.** Call `budget` first. The total of your picks must fit what's left in `joy/week`, and each one must come in under the auto line. Joy never asks: anything that would need approval gets denied.

## Submitting

For each pick, call `request_purchase` with:
- `budget: "joy"` and `reach: "self"` (always both)
- `items` with sku, qty, title, url
- `maxTotalCents` covering tax and shipping, under the auto line
- `whyNote`: **this is the reveal** the owner reads when it's delivered. One or two warm, specific sentences that say what it is and connect it to something real from their week ("You've had 'fix the wobbly desk lamp' on your list since March; this clamp should do it."). No flattery, no product copy.
- `reason`: your honest justification (at least 60 chars). It's the fallback if `whyNote` is missing; write both.
- `hint`: a short teaser (max 80 chars) for the sealed DM, e.g. "for the desk that wobbles" is too close if the title says "desk"; "for steadier evenings" is right. No word of 4+ letters from the item title, or the gate rejects it.
- `requester: "quiet-joy"`, `taskId: "joy-<ISO week>"`, e.g. `joy-2026-W41`

If a pick is denied, read the reason. Swap it for something smaller only if that's still a good pick; never bend the rules to fit.

## The sealed envelope

After submitting, **do not reveal what you picked**: not in chat, not in a summary, not in a commit, file, note, log or message. Your whole report to the user is: how many requests you submitted, the total, and their states ("2 joy requests, $31.40 total, both silent"). Don't repeat the hint or the whyNote either. If the owner asks what it is, tell them it's a surprise and that they can veto from the DM. The tools hide joy items for the same reason.
