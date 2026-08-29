# Verification log

TradeFlow has two kinds of verification. Do not treat them as equivalent.

## Scripted / synthetic (localhost)

`scripts/verify-*.mjs` (and similar) post **signed Twilio-shaped webhooks to the local Next.js server**. They prove handler logic, DB transitions, and Stripe test-mode APIs. They do **not** prove:

- a real WhatsApp inbound from a phone
- the Twilio sandbox “WHEN A MESSAGE COMES IN” webhook
- an outbound message actually delivered on WhatsApp
- a buyer completing Checkout on a real device

Those runs remain useful for regression, but they are not an end-to-end commerce confirmation.

## Real phone end-to-end (2026-08-29)

**First non-synthetic confirmation of the full commerce loop.**

| Step | What happened |
|---|---|
| Inbound | Real WhatsApp from `+447733308706` to the sandbox number: *Hello, i'd like 2 of th blue mug* |
| Parse + draft | `order_parse` matched the catalog; a `PENDING_CONFIRMATION` draft was created |
| Confirm | Buyer sent **YES** on the phone; a live Stripe Checkout link was delivered on WhatsApp |
| Pay | Real **Pay by Bank** test payment completed |
| After pay | Order confirmed (`PAID`); buyer and seller WhatsApp notifications both received on the actual devices |

This path used production ingress (`https://tradeflow-tau-blush.vercel.app/api/webhooks/ingress`) after the sandbox inbound URL was pointed at TradeFlow (it had been Twilio’s demo Function `timberwolf-mastiff-9776.twil.io/demo-reply`) and after ingress learned to route Twilio WhatsApp without a custom `X-Source` header.
