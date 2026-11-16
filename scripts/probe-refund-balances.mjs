/**
 * Step 22b — refund balance probe with refund_application_fee: true (Stripe TEST).
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
    expand: [
      "latest_charge.balance_transaction",
      "latest_charge.application_fee.balance_transaction",
    ],
  });
  const charge =
    typeof pi.latest_charge === "object"
      ? pi.latest_charge
      : await stripe.charges.retrieve(pi.latest_charge, {
          expand: ["balance_transaction", "application_fee.balance_transaction"],
        });

  const chargeBt =
    typeof charge.balance_transaction === "object"
      ? charge.balance_transaction
      : charge.balance_transaction
        ? await stripe.balanceTransactions.retrieve(charge.balance_transaction)
        : null;

  const feeObj =
    typeof charge.application_fee === "object" && charge.application_fee
      ? charge.application_fee
      : typeof charge.application_fee === "string"
        ? await stripe.applicationFees.retrieve(charge.application_fee, {
            expand: ["balance_transaction"],
          })
        : null;
  const feeBt =
    feeObj && typeof feeObj.balance_transaction === "object"
      ? feeObj.balance_transaction
      : feeObj?.balance_transaction
        ? await stripe.balanceTransactions.retrieve(feeObj.balance_transaction)
        : null;

  const transferId =
    typeof charge.transfer === "string"
      ? charge.transfer
      : charge.transfer?.id ?? null;
  const transfer = transferId
    ? await stripe.transfers.retrieve(transferId)
    : null;

  console.log(`\n=== ${label} ===`);
  console.log(
    `PI ${pi.id} amount=${pi.amount} app_fee=${pi.application_fee_amount}`,
  );
  console.log(
    `Charge ${charge.id} amount=${charge.amount} amount_refunded=${charge.amount_refunded}`,
  );
  if (chargeBt) {
    console.log(
      `Platform charge BT: amount=${chargeBt.amount} fee=${chargeBt.fee} net=${chargeBt.net}`,
    );
  }
  if (feeObj) {
    console.log(
      `App fee: amount=${feeObj.amount} amount_refunded=${feeObj.amount_refunded}`,
    );
  }
  if (feeBt) {
    console.log(
      `App fee BT: amount=${feeBt.amount} fee=${feeBt.fee} net=${feeBt.net}`,
    );
  }
  if (transfer) {
    console.log(
      `Transfer ${transfer.id} amount=${transfer.amount} amount_reversed=${transfer.amount_reversed}`,
    );
  }

  const refunds = await stripe.refunds.list({ payment_intent: piId, limit: 5 });
  for (const refund of refunds.data) {
    const rBt = refund.balance_transaction
      ? await stripe.balanceTransactions.retrieve(refund.balance_transaction)
      : null;
    console.log(
      `Refund ${refund.id} amount=${refund.amount} reverse_transfer=${refund.reverse_transfer} refund_application_fee=${refund.refund_application_fee}`,
    );
    if (rBt) {
      console.log(
        `  Refund BT (buyer/platform): amount=${rBt.amount} fee=${rBt.fee} net=${rBt.net}`,
      );
    }
    if (refund.transfer_reversal && transferId) {
      try {
        const trr = await stripe.transfers.retrieveReversal(
          transferId,
          typeof refund.transfer_reversal === "string"
            ? refund.transfer_reversal
            : refund.transfer_reversal.id,
        );
        console.log(`  Transfer reversal amount=${trr.amount}`);
      } catch (e) {
        console.log(`  Transfer reversal lookup failed: ${e.message}`);
      }
    }
  }

  // Application fee refund BTs (platform returns fee)
  if (feeObj?.id) {
    const feeRefunds = await stripe.applicationFees.listRefunds(feeObj.id, {
      limit: 5,
    });
    for (const fr of feeRefunds.data) {
      const frBt = fr.balance_transaction
        ? await stripe.balanceTransactions.retrieve(fr.balance_transaction)
        : null;
      console.log(
        `App fee refund ${fr.id} amount=${fr.amount}`,
      );
      if (frBt) {
        console.log(
          `  App fee refund BT: amount=${frBt.amount} fee=${frBt.fee} net=${frBt.net}`,
        );
      }
    }
  }

  // Platform net across charge + refund + app fee + app fee refund
  const platformNet =
    (chargeBt?.net ?? 0) +
    (feeBt?.net ?? 0) +
    refunds.data.reduce((sum, r) => {
      // refund BT retrieved above — recompute simply from amounts
      return sum - (r.amount ?? 0);
    }, 0) -
    (feeObj?.amount_refunded ?? 0);

  // Simpler: chargeBT.net + sum(refund BTs net) + feeBT.net + sum(fee refund BTs)
  // We'll print components for the report.
  console.log(
    `Seller transfer net after reversals: ${
      (transfer?.amount ?? 0) - (transfer?.amount_reversed ?? 0)
    } (amount ${transfer?.amount} reversed ${transfer?.amount_reversed})`,
  );
  console.log(
    `App fee remaining on platform: ${(feeObj?.amount ?? 0) - (feeObj?.amount_refunded ?? 0)}`,
  );

  return {
    piId,
    chargeBt,
    feeObj,
    feeBt,
    transfer,
    refunds: refunds.data,
    platformNetRough: platformNet,
  };
}

async function main() {
  const destination = await findDestination();
  console.log(`destination=${destination}`);

  const fullPi = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination },
    application_fee_amount: 245,
    metadata: { purpose: "step22b-refund-full" },
  });
  await sleep(3000);
  await stripe.refunds.create({
    payment_intent: fullPi.id,
    reverse_transfer: true,
    refund_application_fee: true,
  });
  await sleep(3000);
  await summarizeCharge(fullPi.id, "FULL £50 refund (fee 245p returned)");

  const partPi = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    payment_method_types: ["card"],
    payment_method: "pm_card_visa",
    confirm: true,
    transfer_data: { destination },
    application_fee_amount: 245,
    metadata: { purpose: "step22b-refund-partial" },
  });
  await sleep(3000);
  await stripe.refunds.create({
    payment_intent: partPi.id,
    amount: 2000,
    reverse_transfer: true,
    refund_application_fee: true,
  });
  await sleep(3000);
  await summarizeCharge(partPi.id, "PARTIAL £20 of £50 (expect ~98p fee refund)");

  console.log("\n=== EXPECTED ===");
  console.log(
    "Full: seller transfer net 0; app fee fully refunded; platform net = -Stripe fee (178).",
  );
  console.log(
    "Partial: transfer reverse 2000; app fee refund ~98 (245*2000/5000); Stripe fee stays 178.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
