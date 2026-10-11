---
expect:
  vendor: string
  items: array
  reason: string
  reach: [self, world, others]
  maxTotalCents: number
---

Submitted. The owner is notified first and can cancel within the window; check back with purchase_status.
{
  "idempotencyKey": "ejb-0b6c2f0e-eval",
  "id": "7d1f3c2a-0000-4000-8000-000000000001",
  "state": "dm_delivered",
  "stateMeaning": "owner notified; inside the cancel/veto window",
  "budget": "general",
  "vendor": "{{input.vendor}}",
  "decision": "auto",
  "tier": "auto",
  "reachEffective": "{{input.reach}}",
  "quotedTotal": "$21.64",
  "reasons": []
}
