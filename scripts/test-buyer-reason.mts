/**
 * Unit checks for buyer-facing reason labels (L1b).
 * Run: npx --yes tsx scripts/test-buyer-reason.mts
 */
import { t } from "../src/lib/i18n/index.ts";
import {
  buyerFacingRefundReasonDisplay,
  buyerFacingReturnReasonLabel,
} from "../src/lib/i18n/buyer-reason.ts";
import { buildBuyerRefundMessage } from "../src/lib/orders/refund-order.ts";
import { buyerReturnRequestedMessage } from "../src/lib/orders/request-return.ts";
import { RETURN_REASONS } from "../src/lib/orders/return-reasons.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("OK:", msg);
  }
}

function assertEq(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    console.error("FAIL:", label);
    console.error("  expected:", JSON.stringify(expected));
    console.error("  actual:  ", JSON.stringify(actual));
    process.exitCode = 1;
  } else {
    console.log("OK:", label);
  }
}

// --- fraudulent must never reach a buyer ---
assert(
  buyerFacingRefundReasonDisplay("fraudulent", "en") === null,
  'buyerFacingRefundReasonDisplay("fraudulent", en) === null',
);
assert(
  buyerFacingRefundReasonDisplay("fraudulent", "fr") === null,
  'buyerFacingRefundReasonDisplay("fraudulent", fr) === null',
);
assert(
  buyerFacingRefundReasonDisplay("FRAUDULENT", "en") === null,
  'buyerFacingRefundReasonDisplay("FRAUDULENT") === null (case-insensitive)',
);

const fraudulentEn = buildBuyerRefundMessage({
  orderRef: "TF-TEST",
  amountPence: 1000,
  reason: "fraudulent",
  isFullRefund: true,
  lang: "en",
});
const fraudulentFr = buildBuyerRefundMessage({
  orderRef: "TF-TEST",
  amountPence: 1000,
  reason: "fraudulent",
  isFullRefund: true,
  lang: "fr",
});
assert(
  !/fraudulent/i.test(fraudulentEn) && !/^Reason:/m.test(fraudulentEn),
  "EN refund with Stripe reason fraudulent omits Reason line and never contains fraudulent",
);
assert(
  !/fraudulent/i.test(fraudulentFr) && !/^Motif/m.test(fraudulentFr),
  "FR refund with Stripe reason fraudulent omits Motif line and never contains fraudulent",
);

assert(
  buyerFacingRefundReasonDisplay("requested_by_customer", "fr") === null,
  "requested_by_customer omitted",
);
assert(
  buyerFacingRefundReasonDisplay("duplicate", "en") === null,
  "duplicate omitted",
);

// --- exact refund texts ---
const amount = "£10.00";
const orderRef = "TF-TEST";

const frReturnRefund = buildBuyerRefundMessage({
  orderRef,
  amountPence: 1000,
  reason: "damaged_faulty",
  isFullRefund: true,
  lang: "fr",
});
assertEq(
  frReturnRefund,
  [
    `Un remboursement intégral de ${amount} a été effectué pour la commande ${orderRef}.`,
    `Motif : ${t("return_reason.damaged_faulty", "fr")}`,
    "",
    t("refund.timing", "fr"),
  ].join("\n"),
  "French refund after a return (damaged_faulty)",
);

const frNoReason = buildBuyerRefundMessage({
  orderRef,
  amountPence: 1000,
  reason: null,
  isFullRefund: true,
  lang: "fr",
});
assertEq(
  frNoReason,
  [
    `Un remboursement intégral de ${amount} a été effectué pour la commande ${orderRef}.`,
    "",
    t("refund.timing", "fr"),
  ].join("\n"),
  "French refund with no reason",
);

assertEq(
  fraudulentFr,
  [
    `Un remboursement intégral de ${amount} a été effectué pour la commande ${orderRef}.`,
    "",
    t("refund.timing", "fr"),
  ].join("\n"),
  'French refund whose Stripe reason is "fraudulent" (reason line omitted)',
);

const enReturnRefund = buildBuyerRefundMessage({
  orderRef,
  amountPence: 1000,
  reason: "damaged_faulty",
  isFullRefund: true,
  lang: "en",
});
assertEq(
  enReturnRefund,
  [
    `A full refund of ${amount} has been processed for order ${orderRef}.`,
    `Reason: ${t("return_reason.damaged_faulty", "en")}`,
    "",
    t("refund.timing", "en"),
  ].join("\n"),
  "English refund after a return (damaged_faulty)",
);

const enNoReason = buildBuyerRefundMessage({
  orderRef,
  amountPence: 1000,
  reason: null,
  isFullRefund: true,
  lang: "en",
});
assertEq(
  enNoReason,
  [
    `A full refund of ${amount} has been processed for order ${orderRef}.`,
    "",
    t("refund.timing", "en"),
  ].join("\n"),
  "English refund with no reason",
);

assertEq(
  fraudulentEn,
  [
    `A full refund of ${amount} has been processed for order ${orderRef}.`,
    "",
    t("refund.timing", "en"),
  ].join("\n"),
  'English refund whose Stripe reason is "fraudulent" (reason line omitted)',
);

// Seller free text unchanged
assertEq(
  buyerFacingRefundReasonDisplay("Item scratched on arrival", "fr")!,
  "Item scratched on arrival",
  "seller free-text refund reason unchanged",
);

// --- French return requested for each of the six reasons ---
const otherDetail = "la couleur n'est pas celle de la photo";
for (const reason of RETURN_REASONS) {
  const detail = reason === "other" ? otherDetail : null;
  const expectedLabel = buyerFacingReturnReasonLabel(reason, detail, "fr");
  const msg = buyerReturnRequestedMessage({
    orderRef,
    reason,
    detail,
    lang: "fr",
  });
  assertEq(
    msg,
    t("return.requested", "fr", { orderRef, reason: expectedLabel }),
    `French return requested — ${reason}`,
  );
  assert(!msg.includes(reason) || reason === "other", `no raw code ${reason} in message`);
  if (reason === "other") {
    assert(msg.includes(otherDetail), "other uses buyer detail text");
  }
}

console.log("\n--- EXACT TEXTS ---");
console.log("\n[FR refund after return]\n" + frReturnRefund);
console.log("\n[FR refund no reason]\n" + frNoReason);
console.log("\n[FR refund fraudulent]\n" + fraudulentFr);
console.log("\n[EN refund after return]\n" + enReturnRefund);
console.log("\n[EN refund no reason]\n" + enNoReason);
console.log("\n[EN refund fraudulent]\n" + fraudulentEn);
for (const reason of RETURN_REASONS) {
  const detail = reason === "other" ? otherDetail : null;
  console.log(
    `\n[FR return requested — ${reason}]\n` +
      buyerReturnRequestedMessage({ orderRef, reason, detail, lang: "fr" }),
  );
}

if (process.exitCode) {
  console.error("\nSome assertions failed.");
  process.exit(1);
}
console.log("\nAll buyer-reason assertions passed.");
