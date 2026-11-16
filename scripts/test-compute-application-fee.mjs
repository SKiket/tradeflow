/**
 * Unit checks for computeApplicationFee (pure).
 *   node scripts/test-compute-application-fee.mjs
 */
import assert from "node:assert/strict";

/** Mirror of src/lib/pricing/config.ts computeApplicationFee */
function computeApplicationFee(amountPence, pricing) {
  if (!Number.isFinite(amountPence) || amountPence <= 0) return 0;
  const amount = Math.floor(amountPence);
  const pct = Math.round((amount * pricing.orderFeeBps) / 10_000);
  const fee = pct + Math.max(0, pricing.orderFeeFixedPence);
  if (fee <= 0) return 0;
  return Math.min(amount, fee);
}

const pricing = { orderFeeBps: 450, orderFeeFixedPence: 20 };

const cases = [
  [50, 22],
  [1000, 65],
  [1900, 106],
  [5000, 245],
  [10000, 470],
  [0, 0],
  [1, 1], // 0% round + 20p clamped to amount
  [10, 10],
  [19, 19],
  [20, 20],
  [21, 21],
];

for (const [amount, expected] of cases) {
  const got = computeApplicationFee(amount, pricing);
  assert.equal(
    got,
    expected,
    `amount=${amount} expected=${expected} got=${got}`,
  );
  assert.ok(got <= amount || amount <= 0, `fee never above amount (${amount})`);
  assert.ok(got >= 0, "fee never negative");
}

console.log("OK computeApplicationFee unit cases");
