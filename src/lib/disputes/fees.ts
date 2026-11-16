import type Stripe from "stripe";

import {
  getDisputeCounterFeePence,
  getDisputeReceivedFeePence,
  type DisputeFeeSource,
  type DisputeOutcome,
  sellerFeeLiabilityPence,
} from "@/lib/disputes/constants";

export type ResolvedDisputeFees = {
  receivedFeePence: number;
  counterFeePence: number;
  /** Fee portion the seller owes given outcome + contested. */
  sellerFeePence: number;
  /** Total Stripe dispute fees observed on balance transactions (if any). */
  stripeTotalFeePence: number | null;
  feeSource: DisputeFeeSource;
};

/** Sum positive fee amounts on dispute balance transactions. */
export function extractStripeTotalFeePence(
  dispute: Stripe.Dispute,
): number | null {
  const txs = dispute.balance_transactions ?? [];
  let fee = 0;
  for (const tx of txs) {
    if (typeof tx === "string") continue;
    if (typeof tx.fee === "number" && tx.fee > 0) {
      fee += tx.fee;
    }
    // Prefer fee_details when present (more precise).
    if (Array.isArray(tx.fee_details)) {
      for (const detail of tx.fee_details) {
        if (typeof detail.amount === "number" && detail.amount > 0) {
          // fee already includes fee_details sum in Stripe BT.fee — don't double.
        }
      }
    }
  }
  return fee > 0 ? fee : null;
}

/**
 * Resolve received/counter fees for recovery.
 * Prefer Stripe balance-transaction totals when present; otherwise constants.
 *
 * Seller liability (see recover.ts comment):
 * - accepted / lost not contested → received only
 * - contested + lost → received + counter
 * - won / withdrawn → £0 (Copalla absorbs received fee)
 */
export function resolveDisputeFees(params: {
  stripeDispute?: Stripe.Dispute | null;
  contested: boolean;
  outcome: DisputeOutcome | null;
  storedReceived?: number | null;
  storedCounter?: number | null;
  storedSource?: DisputeFeeSource | null;
}): ResolvedDisputeFees {
  const receivedDefault = getDisputeReceivedFeePence();
  const counterDefault = getDisputeCounterFeePence();

  const stripeTotal = params.stripeDispute
    ? extractStripeTotalFeePence(params.stripeDispute)
    : null;

  let receivedFeePence: number;
  let counterFeePence: number;
  let feeSource: DisputeFeeSource;

  if (
    typeof params.storedReceived === "number" &&
    params.storedReceived >= 0 &&
    params.storedSource
  ) {
    receivedFeePence = params.storedReceived;
    counterFeePence =
      typeof params.storedCounter === "number" && params.storedCounter >= 0
        ? params.storedCounter
        : params.contested
          ? counterDefault
          : 0;
    feeSource = params.storedSource;
  } else if (stripeTotal != null && stripeTotal > 0) {
    feeSource = "stripe_balance_transactions";
    if (params.contested) {
      // Split Stripe total into received + counter when possible.
      if (stripeTotal >= receivedDefault + counterDefault) {
        receivedFeePence = receivedDefault;
        counterFeePence = stripeTotal - receivedDefault;
      } else if (stripeTotal >= receivedDefault) {
        receivedFeePence = receivedDefault;
        counterFeePence = Math.max(0, stripeTotal - receivedDefault);
      } else {
        receivedFeePence = stripeTotal;
        counterFeePence = counterDefault;
      }
    } else {
      receivedFeePence = stripeTotal;
      counterFeePence = 0;
    }
  } else {
    feeSource = "constants";
    receivedFeePence = receivedDefault;
    counterFeePence = params.contested ? counterDefault : 0;
  }

  // Counter fee only applies when contested; clear otherwise.
  if (!params.contested) {
    counterFeePence = 0;
  }

  const sellerFeePence = sellerFeeLiabilityPence({
    contested: params.contested,
    outcome: params.outcome,
    receivedFeePence,
    counterFeePence,
  });

  return {
    receivedFeePence,
    counterFeePence,
    sellerFeePence,
    stripeTotalFeePence: stripeTotal,
    feeSource,
  };
}

/** Legacy helper — total positive fee on dispute BTs. */
export function extractDisputeFeePence(dispute: Stripe.Dispute): number | null {
  return extractStripeTotalFeePence(dispute);
}
