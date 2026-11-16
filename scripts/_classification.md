# Step 22c failure classification

Pre-Step-21 commit: `45745ad` (worktree `../tradeflow-pre21`, `node_modules` junctioned from current tree, same `.env.local` + same DB).
Caveat: Next.js server was the **current** checkout (not rebuilt at 45745ad). Script-level regressions vs shared-env/config are still comparable; pure product-code regressions would need a second server.

| Script | Baseline assertion | Pre-21 | Class | Evidence |
| --- | --- | --- | --- | --- |
| verify-webhook-ingress.mjs | Headerless Twilio + Stripe sig 3a | same FAILs | **b** | identical fails at 45745ad |
| verify-support-catalog.mjs | In-stock catalog Q&A | same FAIL | **b/c** | same at pre21; also seed/orphan sensitive |
| verify-support-order-status.mjs | DISPATCHED status + catalog regression | same FAIL | **b/c** | same at pre21 |
| verify-confirm-payment.mjs | Case 4 cancel + Case 6 lazy sweep | FAIL (more cases at pre21) | **c** | isolation/orphans; baseline narrower |
| verify-dispatch-deliver.mjs | Case 1 + 4 WhatsApp | same FAIL | **b/c** | same at pre21 |
| verify-tracking.mjs | /t/{ref} + WhatsApp URL | same FAIL | **b/c** | same at pre21 |
| verify-shipping-address.mjs | Checkout GB shipping UI | same FAIL | **b** | same at pre21 |
| verify-returns.mjs | WhatsApp return flow | same FAIL | **b/c** | same at pre21 |
| verify-cooling-off.mjs | changed_mind / damaged_faulty | same FAIL | **b/c** | same at pre21 |
| verify-fulfil-order.mjs | No catalog variant | same FAIL | **c** | empty seed catalog; fixed by reseed |
| verify-customers.mjs | live order stats | **PASS** at pre21 | **c** | flaky / isolation |
| verify-live-analytics.mjs | AOV / top product | same FAIL | **b/c** | same at pre21 |
| verify-i18n-refund-only.mjs | (no clean summary) | **MISSING** in pre21 tree | **a/b** | script post-dates Step 21 tree; incomplete harness |
| verify-product-knowledge.mjs | allergens not_provided escalate | n/a (Step 22) | **a** | new since Step 21 |
| verify-billing-enforcement.mjs | missing Stripe customer wall | same FAIL | **b/c** | shared pilot billing state |
| verify-payment-intent.mjs | Connect transfers capability | same FAIL | **b** | **real Stripe TEST Connect config** (not a test bug) |
| verify-account-updated.mjs | account.updated sync | same FAIL | **b** | same Connect account state |

Leftovers deleted this step (so far): 23 orphan PENDING + 2 test shops (earlier) + 8 orphan PENDING (this pass). Soft-deleted seed products reported: 20 (left in place; active seed recreated).
