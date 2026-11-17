/**
 * Sync Stripe Connect capability flags onto businesses from live Stripe accounts.
 *   node scripts/sync-connect-capabilities.mjs
 */
import Stripe from "stripe";
import { createAdmin, loadVerifyEnv } from "./lib/verify-harness.mjs";

loadVerifyEnv();
const admin = createAdmin();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-06-24.dahlia",
});

const { data: businesses, error } = await admin
  .from("businesses")
  .select(
    "id, name, stripe_connected_account_id, stripe_charges_enabled, stripe_transfers_capability_active",
  )
  .not("stripe_connected_account_id", "is", null)
  .is("deleted_at", null);

if (error) throw error;

for (const biz of businesses ?? []) {
  const account = await stripe.accounts.retrieve(biz.stripe_connected_account_id);
  const transfersActive = account.capabilities?.transfers === "active";
  const next = {
    stripe_charges_enabled: account.charges_enabled ?? false,
    stripe_payouts_enabled: account.payouts_enabled ?? false,
    stripe_details_submitted: account.details_submitted ?? false,
    stripe_transfers_capability_active: transfersActive,
    stripe_requirements_currently_due: Array.isArray(
      account.requirements?.currently_due,
    )
      ? account.requirements.currently_due
      : null,
  };
  const { error: upd } = await admin.from("businesses").update(next).eq("id", biz.id);
  console.log(
    `${biz.name}: charges=${next.stripe_charges_enabled} transfers=${next.stripe_transfers_capability_active} err=${upd?.message || "ok"}`,
  );
}
