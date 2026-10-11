---
expect:
  budget: joy
  reach: self
  vendor: mock
  items: array
  reason: string
  maxTotalCents: number
---

Submitted. The owner is notified first and can cancel within the window; check back with purchase_status.
{
  "idempotencyKey": "ejb-joy-eval",
  "id": "a11ce0de-0000-4000-8000-000000000003",
  "state": "dm_delivered",
  "stateMeaning": "owner notified; inside the cancel/veto window",
  "budget": "joy",
  "vendor": "mock",
  "decision": "auto",
  "tier": "auto",
  "reachEffective": "self",
  "quotedTotal": "$14.07",
  "reasons": [],
  "sealed": "joy purchase: items and note are hidden on purpose. Do not reveal or guess them."
}
