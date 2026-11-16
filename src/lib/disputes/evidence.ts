import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { getStripe } from "@/lib/stripe/client";

/** Stripe dispute evidence file purpose; max ~5MB for most evidence files. */
const MAX_EVIDENCE_FILE_BYTES = 4_500_000;

export type BuildEvidenceResult = {
  disputeId: string;
  stripeDisputeId: string;
  staged: boolean;
  submitted: boolean;
  evidenceStatus: "draft" | "ready" | "submitted";
  fieldsUsed: string[];
};

function formatIso(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  try {
    return new Date(iso).toISOString();
  } catch {
    return iso;
  }
}

function formatAddress(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  const parts = ["line1", "line2", "city", "postcode", "country"]
    .map((k) => a[k])
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…[truncated]`;
}

/**
 * Assemble evidence for ONE order, stage on Stripe with submit:false (or
 * submit:true when finalising). Never includes unrelated customers.
 */
export async function buildDisputeEvidence(
  supabase: SupabaseClient,
  disputeId: string,
  options?: { submit?: boolean; submittedBy?: "seller" | "auto" },
): Promise<BuildEvidenceResult> {
  const submit = options?.submit === true;

  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      "id, business_id, order_id, stripe_dispute_id, seller_notes, evidence_status, evidence_submitted_at, submitted_by",
    )
    .eq("id", disputeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");

  if (dispute.evidence_status === "submitted" || dispute.evidence_submitted_at) {
    if (submit) {
      throw new Error("EVIDENCE_ALREADY_SUBMITTED");
    }
    return {
      disputeId,
      stripeDisputeId: dispute.stripe_dispute_id as string,
      staged: true,
      submitted: true,
      evidenceStatus: "submitted",
      fieldsUsed: [],
    };
  }

  if (!dispute.order_id) {
    throw new Error("DISPUTE_HAS_NO_ORDER");
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(
      "id, order_ref, business_id, customer_id, thread_id, total_pence, status, created_at, shipping_address, dispatch_carrier, dispatch_tracking_number, tracking_status, delivered_at, stripe_payment_intent_id",
    )
    .eq("id", dispute.order_id as string)
    .eq("business_id", dispute.business_id as string)
    .maybeSingle();

  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("ORDER_NOT_FOUND");

  const [{ data: customer }, { data: items }, { data: history }, { data: business }] =
    await Promise.all([
      supabase
        .from("customers")
        .select("id, name, phone_e164")
        .eq("id", order.customer_id as string)
        .maybeSingle(),
      supabase
        .from("order_items")
        .select(
          "quantity, unit_price_pence, product_variants(label, products(name))",
        )
        .eq("order_id", order.id as string)
        .eq("business_id", dispute.business_id as string),
      supabase
        .from("order_status_history")
        .select("from_status, to_status, changed_at")
        .eq("order_id", order.id as string)
        .eq("business_id", dispute.business_id as string)
        .order("changed_at", { ascending: true }),
      supabase
        .from("businesses")
        .select("returns_policy_text, name")
        .eq("id", dispute.business_id as string)
        .maybeSingle(),
    ]);

  const lineSummaries: string[] = [];
  for (const item of items ?? []) {
    const variant = item.product_variants as
      | { label: string | null; products: { name: string } | { name: string }[] | null }
      | { label: string | null; products: { name: string } | { name: string }[] | null }[]
      | null;
    const v = Array.isArray(variant) ? variant[0] : variant;
    const products = v?.products;
    const product = Array.isArray(products) ? products[0] : products;
    const name = product?.name ?? "Item";
    const label = v?.label ? ` (${v.label})` : "";
    const qty = item.quantity as number;
    const unit = item.unit_price_pence as number;
    lineSummaries.push(
      `${qty}× ${name}${label} @ £${(unit / 100).toFixed(2)}`,
    );
  }

  const productDescription = truncate(
    [
      `Order ${order.order_ref}`,
      ...lineSummaries,
      `Total: £${((order.total_pence as number) / 100).toFixed(2)}`,
    ].join("\n"),
    20000,
  );

  const paidAt =
    (history ?? []).find((h) => h.to_status === "PAID")?.changed_at ?? null;
  const confirmedAt =
    (history ?? []).find((h) => h.to_status === "AWAITING_PAYMENT")
      ?.changed_at ?? null;
  const dispatchedAt =
    (history ?? []).find((h) => h.to_status === "DISPATCHED")?.changed_at ??
    null;

  const timeline = [
    `Order ${order.order_ref} timeline:`,
    confirmedAt
      ? `- Order confirmed by the buyer's YES at ${formatIso(confirmedAt as string)}`
      : `- Order created at ${formatIso(order.created_at as string)}`,
    paidAt
      ? `- Paid at ${formatIso(paidAt as string)}`
      : "- Payment confirmation time: not recorded",
    dispatchedAt
      ? `- Dispatched at ${formatIso(dispatchedAt as string)}`
      : "- Not yet dispatched (or dispatch time not recorded)",
    order.delivered_at
      ? `- Delivered at ${formatIso(order.delivered_at as string)} (tracking: ${order.tracking_status ?? "n/a"})`
      : `- Delivery: not confirmed (tracking: ${order.tracking_status ?? "n/a"})`,
    dispute.seller_notes
      ? `- Seller notes: ${String(dispute.seller_notes).slice(0, 4000)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const shippingAddress = formatAddress(order.shipping_address);
  const policyText =
    (business?.returns_policy_text as string | null)?.trim() ||
    "Returns are handled according to the seller's published returns policy shown to the buyer at checkout and on the order tracking page.";

  // refund_policy is a file field on Stripe — upload PDF, not raw text.
  let refundPolicyFileId: string | null = null;
  try {
    refundPolicyFileId = await uploadDisputeEvidenceFile(
      textToSimplePdf(truncate(policyText, 50_000)),
      `order-${order.order_ref}-refund-policy.pdf`,
      "application/pdf",
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error("[disputes] refund policy file upload failed", {
      disputeId,
      error: message,
    });
  }

  // Conversation for THIS order's thread only.
  let conversationFileId: string | null = null;
  if (order.thread_id) {
    const { data: messages } = await supabase
      .from("messages")
      .select("direction, normalised_text, created_at, send_mode")
      .eq("business_id", dispute.business_id as string)
      .eq("thread_id", order.thread_id as string)
      .order("created_at", { ascending: true })
      .limit(500);

    const lines = (messages ?? []).map((m) => {
      const dir = (m.direction as string) === "inbound" ? "BUYER" : "SELLER";
      const body = String(m.normalised_text ?? "")
        .replace(/\r\n/g, "\n")
        .trim();
      return `[${formatIso(m.created_at as string)}] ${dir}: ${body}`;
    });
    const transcript = truncate(
      [
        `WhatsApp conversation for order ${order.order_ref}`,
        `Business: ${business?.name ?? "n/a"}`,
        "",
        ...lines,
      ].join("\n"),
      200_000,
    );
    // Stripe dispute_evidence rejects text/plain — upload a minimal PDF.
    const pdfBuf = textToSimplePdf(transcript);
    if (pdfBuf.length <= MAX_EVIDENCE_FILE_BYTES) {
      try {
        conversationFileId = await uploadDisputeEvidenceFile(
          pdfBuf,
          `order-${order.order_ref}-conversation.pdf`,
          "application/pdf",
        );
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        console.error("[disputes] conversation file upload failed", {
          disputeId,
          error: message,
        });
      }
    }
  }

  const evidence: Stripe.DisputeUpdateParams.Evidence = {
    customer_name: customer?.name?.trim() || undefined,
    customer_email_address: undefined, // TradeFlow holds WhatsApp, not email
    billing_address: shippingAddress ?? undefined,
    shipping_address: shippingAddress ?? undefined,
    product_description: productDescription,
    shipping_carrier: (order.dispatch_carrier as string | null) ?? undefined,
    shipping_tracking_number:
      (order.dispatch_tracking_number as string | null) ?? undefined,
    shipping_date: dispatchedAt
      ? new Date(dispatchedAt as string).toISOString().slice(0, 10)
      : undefined,
    refund_policy_disclosure:
      "The return/refund policy was shown to the buyer on the storefront and order tracking page before and after purchase. See the attached refund_policy file.",
    refund_policy: refundPolicyFileId ?? undefined,
    uncategorized_text: truncate(
      refundPolicyFileId
        ? timeline
        : `${timeline}\n\nReturn/refund policy:\n${policyText}`,
      20000,
    ),
    customer_communication: conversationFileId ?? undefined,
  };

  // Optional shipping documentation placeholder via uncategorized if delivered.
  if (order.delivered_at && order.dispatch_tracking_number) {
    evidence.uncategorized_text = truncate(
      `${timeline}\n\nDelivery confirmation: delivered_at=${formatIso(order.delivered_at as string)}; tracking_status=${order.tracking_status ?? "n/a"}; tracking=${order.dispatch_tracking_number}.`,
      20000,
    );
  }

  const fieldsUsed = Object.entries(evidence)
    .filter(([, v]) => v != null && v !== "")
    .map(([k]) => k);

  const stripe = getStripe();
  await stripe.disputes.update(dispute.stripe_dispute_id as string, {
    evidence,
    submit,
  });

  const nextStatus = submit ? "submitted" : "ready";
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("disputes")
    .update({
      evidence_status: nextStatus,
      ...(submit
        ? {
            evidence_submitted_at: now,
            submitted_by: options?.submittedBy ?? "seller",
          }
        : {}),
      updated_at: now,
    })
    .eq("id", disputeId)
    .neq("evidence_status", "submitted");

  if (updateError) throw new Error(updateError.message);

  return {
    disputeId,
    stripeDisputeId: dispute.stripe_dispute_id as string,
    staged: !submit,
    submitted: submit,
    evidenceStatus: nextStatus,
    fieldsUsed,
  };
}

async function uploadDisputeEvidenceFile(
  buf: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const stripe = getStripe();
  const file = await stripe.files.create({
    purpose: "dispute_evidence",
    file: {
      data: buf,
      name: filename,
      type: mimeType,
    },
  });
  return file.id;
}

/**
 * Minimal single-page PDF carrying plain text (Stripe accepts application/pdf
 * for dispute_evidence; text/plain is rejected).
 */
function textToSimplePdf(text: string): Buffer {
  const sanitized = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, "");
  const lines = sanitized.split("\n").slice(0, 80);
  const contentLines = ["BT", "/F1 9 Tf", "40 800 Td", "12 TL"];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].slice(0, 110);
    if (i === 0) contentLines.push(`(${line}) Tj`);
    else contentLines.push(`T* (${line}) Tj`);
  }
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const objects: string[] = [];
  objects.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n");
  objects.push("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n");
  objects.push(
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n",
  );
  objects.push(
    `4 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}\nendstream\nendobj\n`,
  );
  objects.push(
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

/**
 * Persist seller notes and regenerate the staged evidence pack.
 */
export async function updateDisputeSellerNotes(
  supabase: SupabaseClient,
  params: { disputeId: string; businessId: string; notes: string },
): Promise<BuildEvidenceResult> {
  const { data: dispute, error } = await supabase
    .from("disputes")
    .select("id, evidence_status, evidence_submitted_at")
    .eq("id", params.disputeId)
    .eq("business_id", params.businessId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");
  if (dispute.evidence_status === "submitted" || dispute.evidence_submitted_at) {
    throw new Error("EVIDENCE_ALREADY_SUBMITTED");
  }

  const { error: noteError } = await supabase
    .from("disputes")
    .update({
      seller_notes: params.notes.slice(0, 8000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.disputeId)
    .eq("business_id", params.businessId);

  if (noteError) throw new Error(noteError.message);

  return buildDisputeEvidence(supabase, params.disputeId, { submit: false });
}

export async function submitDisputeEvidence(
  supabase: SupabaseClient,
  params: {
    disputeId: string;
    businessId: string;
    submittedBy: "seller" | "auto";
  },
): Promise<BuildEvidenceResult> {
  const { data: dispute, error } = await supabase
    .from("disputes")
    .select("id, evidence_status, evidence_submitted_at")
    .eq("id", params.disputeId)
    .eq("business_id", params.businessId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");
  if (dispute.evidence_status === "submitted" || dispute.evidence_submitted_at) {
    throw new Error("EVIDENCE_ALREADY_SUBMITTED");
  }

  return buildDisputeEvidence(supabase, params.disputeId, {
    submit: true,
    submittedBy: params.submittedBy,
  });
}
