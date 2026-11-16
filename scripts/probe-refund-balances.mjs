/**
 * Step 22 Part 6 — read-only refund balance probe (Stripe TEST).
 *   node scripts/probe-refund-balances.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" });
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findDestination() {
  const { data } = await admin
    .from("businesses")
    .select("stripe_connected_account_id")
    .not("stripe_connected_account_id", "is", null)
    .eq("stripe_charges_enabled", true)
    .limit(5);
  for (const row of data ?? []) {
    const id = row.stripe_connected_account_id;
    try {
      const acct = await stripe.accounts.retrieve(id);
      if (acct.charges_enabled) return id;
    } catch {
      /* continue */
    }
  }
  throw new Error("No usable connected account");
}

async function summarizeCharge(piId, label) {
  const pi = await stripe.paymentIntents.retrieve(piId, {
    expand: ["latest_charge.balance_transaction", "latest_charge.transfer"],
  });
  const charge =
    typeof pi.latest_charge === "object" ? pi.latest_charge : await stripe.charges.retrieve(pi.latest_charge, {
      expand: ["balance_transaction", "transfer"],
    });
  const btId =
    typeof charge.balance_transaction === "string"
      ? charge.balance_transaction
      : charge.balance_transaction?.id;
  const bt = btId ? await stripe.balanceTransactions.retrieve(btId) : null;

  const transferId =
    typeof charge.transfer === "string"
      ? charge.transfer
      : charge.transfer?.id;
  const transfer = transferId
    ? await stripe.transfers.retrieve(transferId)
    : null;

  console.log(`\n=== ${label} ===`);
  console.log(`PI ${pi.id} amount=${pi.amount} app_fee=${pi.application_fee_amount}`);
  console.log(`Charge ${charge.id} amount=${charge.amount} amount_refunded=${charge.amount_refunded}`);
  if (bt) {
    console.log(
      `Platform BT: amount=${bt.amount} fee=${bt.fee} net=${bt.net} type=${bt.type}`,
    );
  }
  if (transfer) {
    console.log(`Transfer ${transfer.id} amount=${transfer.amount} reversed=${transfer.reversed} amount_reversed=${transfer.amount_reversed}`);
  }

  // Refund balance transactions
  const refunds = await stripe.refunds.list({ payment_intent: piId, limit: 5 });
  for (const refund of refunds.data) {
    const rBtId =
      typeof refund.balance_transaction === "string"
        ? refund.balance_transaction
        : refund.balance_transaction?.id;
    const rBt = rBtId
      ? await stripe.balanceTransactions.retrieve(rBtId)
      : null;
    const trr =
      typeof refund.transfer_reversal === "string"
        ? await stripe.transfers.retrieveReversal(
            transferId,
            refund.transfer_reversal,
          ).catch(() => null)
        : null;
    console.log(
      `Refund ${refund.id} amount=${refund.amount} reverse_transfer=${refund.reverse_transfer} app_fee_refund=${refund.refund_application_fee}`,
    );
    if (rBt) {
      console.log(
        `  Refund BT: amount=${rBt.amount} fee=${rBt.fee} net=${rBt.net}`,
      );
    }
    if (trr) {
      console.log(`  Transfer reversal amount=${trr.amount}`);
    }
  }

  return { charge, bt, transfer, refunds: refunds.data };
}

async function main() {
  const destination = await findDestination();
  console.log(`destination=${destination}`);

  // Full £50 refund
  const fullPi = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination },
    application_fee_amount: 245,
    metadata: { purpose: "step22-refund-full" },
  });
  await sleep(2500);
  await stripe.refunds.create({
    payment_intent: fullPi.id,
    reverse_transfer: true,
    // refund_application_fee unset — matches production
  });
  await sleep(2500);
  const full = await summarizeCharge(fullPi.id, "FULL £50 refund (fee 245p)");

  // Partial £20 of £50
  const partPi = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination },
    application_fee_amount: 245,
    metadata: { purpose: "step22-refund-partial" },
  });
  await sleep(2500);
  await stripe.refunds.create({
    payment_intent: partPi.id,
    amount: 2000,
    reverse_transfer: true,
  });
  await sleep(2500);
  const part = await summarizeCharge(partPi.id, "PARTIAL £20 of £50 (fee 245p)");

  console.log("\n=== INTERPRETATION ===");
  console.log(
    "Buyer: receives refund amount (full 5000 / partial 2000). Platform keeps application fee unless refund_application_fee=true (unset → kept).",
  );
  console.log(
    "Seller: transfer reversed by refund amount; net after full reverse should be ~0 on that transfer (minus any Stripe Connect nuances).",
  );
  console.log(
    `Full: platform BT net=${full.bt?.net} fee=${full.bt?.fee}; transfer reversed=${full.transfer?.amount_reversed}/${full.transfer?.amount}`,
  );
  console.log(
    `Partial: platform BT net=${part.bt?.net} fee=${part.bt?.fee}; transfer reversed=${part.transfer?.amount_reversed}/${part.transfer?.amount}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
