import type { SupabaseClient } from "@supabase/supabase-js";

import { businessHasOpenDispute } from "@/lib/disputes/open-disputes";
import {
  eraseCustomer,
  ERASURE_BLOCKING_STATUSES,
  type EraseCustomerCounts,
} from "@/lib/privacy/erase-customer";
import {
  PURGE_MAX_SHOPS_PER_RUN,
  RETAINED_RECORD_YEARS,
  SHOP_CLOSE_GRACE_DAYS,
} from "@/lib/privacy/constants";
import { getStripe } from "@/lib/stripe/client";

export type ShopCloseResult =
  | { ok: true; purgeAfter: string }
  | { ok: false; error: string; blockingOrderRefs?: string[] };

export type ShopPurgeCounts = {
  customersErased: number;
  productsDeleted: number;
  variantsDeleted: number;
  productImagesDeleted: number;
  storageObjectsDeleted: number;
  broadcastsDeleted: number;
  analyticsDeleted: number;
  templatesDeleted: number;
  authUserDeleted: number;
  ordersRetainedAnonymised: number;
};

function emptyPurgeCounts(): ShopPurgeCounts {
  return {
    customersErased: 0,
    productsDeleted: 0,
    variantsDeleted: 0,
    productImagesDeleted: 0,
    storageObjectsDeleted: 0,
    broadcastsDeleted: 0,
    analyticsDeleted: 0,
    templatesDeleted: 0,
    authUserDeleted: 0,
    ordersRetainedAnonymised: 0,
  };
}

export function isShopClosed(business: {
  closed_at?: string | null;
} | null | undefined): boolean {
  return Boolean(business?.closed_at);
}

export function isWithinCloseGrace(business: {
  closed_at?: string | null;
  purge_after?: string | null;
}): boolean {
  if (!business.closed_at) return false;
  if (!business.purge_after) return true;
  return new Date(business.purge_after).getTime() > Date.now();
}

async function findBusinessBlockingOrders(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("orders")
    .select("order_ref, status")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .in("status", [...ERASURE_BLOCKING_STATUSES]);
  return (data ?? []).map((o) => o.order_ref as string);
}

export async function closeShop(
  supabase: SupabaseClient,
  params: { businessId: string; requestedBy: "seller" | "operator" },
): Promise<ShopCloseResult> {
  const { businessId } = params;

  const { data: business, error } = await supabase
    .from("businesses")
    .select(
      "id, name, closed_at, stripe_subscription_id, stripe_subscription_status",
    )
    .eq("id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!business) return { ok: false, error: "Business not found" };
  if (business.closed_at) {
    const { data: again } = await supabase
      .from("businesses")
      .select("purge_after")
      .eq("id", businessId)
      .maybeSingle();
    return {
      ok: true,
      purgeAfter: (again?.purge_after as string) ?? new Date().toISOString(),
    };
  }

  const openDisputes = await businessHasOpenDispute(supabase, businessId);
  if (openDisputes.hasOpen) {
    return {
      ok: false,
      error:
        "Cannot close while a payment dispute is open. Wait until disputes are closed.",
      blockingOrderRefs: openDisputes.orderRefs,
    };
  }

  const blocking = await findBusinessBlockingOrders(supabase, businessId);
  if (blocking.length > 0) {
    return {
      ok: false,
      error:
        "Cannot close while orders are unpaid, paid-but-unfulfilled, or in refund/return.",
      blockingOrderRefs: blocking,
    };
  }

  const subId = business.stripe_subscription_id as string | null;
  if (subId) {
    try {
      await getStripe().subscriptions.cancel(subId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // Already canceled is fine.
      if (!/no such subscription|already been canceled/i.test(message)) {
        return { ok: false, error: `Stripe cancel failed: ${message}` };
      }
    }
  }

  const closedAt = new Date();
  const purgeAfter = new Date(
    closedAt.getTime() + SHOP_CLOSE_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );

  const { error: updateError } = await supabase
    .from("businesses")
    .update({
      closed_at: closedAt.toISOString(),
      purge_after: purgeAfter.toISOString(),
      stripe_subscription_status: "canceled",
    })
    .eq("id", businessId);

  if (updateError) return { ok: false, error: updateError.message };

  await supabase.from("deletion_requests").insert({
    business_id: businessId,
    subject_type: "seller_account",
    subject_id: businessId,
    requested_by: params.requestedBy,
    status: "pending",
    counts: {
      action: "shop_closed",
      grace_days: SHOP_CLOSE_GRACE_DAYS,
      purge_after: purgeAfter.toISOString(),
    },
  });

  return { ok: true, purgeAfter: purgeAfter.toISOString() };
}

export async function reopenShop(
  supabase: SupabaseClient,
  params: { businessId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: business, error } = await supabase
    .from("businesses")
    .select("id, closed_at, purge_after")
    .eq("id", params.businessId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!business?.closed_at) return { ok: false, error: "Shop is not closed" };
  if (!isWithinCloseGrace(business)) {
    return { ok: false, error: "Grace period has ended — shop cannot be reopened" };
  }

  const { error: updateError } = await supabase
    .from("businesses")
    .update({ closed_at: null, purge_after: null })
    .eq("id", params.businessId);

  if (updateError) return { ok: false, error: updateError.message };
  return { ok: true };
}

async function deleteStoragePrefix(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string,
): Promise<number> {
  let deleted = 0;
  const { data: listed } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1000,
  });
  const names = (listed ?? [])
    .map((f) => f.name)
    .filter(Boolean)
    .map((name) => `${prefix}/${name}`);
  if (names.length === 0) return 0;
  const { data } = await supabase.storage.from(bucket).remove(names);
  deleted += data?.length ?? 0;
  return deleted;
}

/**
 * Permanently erase a closed shop after grace. Idempotent. dryRun = counts only.
 * Keeps anonymised financial orders for RETAINED_RECORD_YEARS (app policy).
 */
export async function purgeClosedShop(
  supabase: SupabaseClient,
  params: { businessId: string; dryRun?: boolean },
): Promise<
  | { ok: true; dryRun: boolean; counts: ShopPurgeCounts; skipped?: string }
  | { ok: false; error: string }
> {
  const dryRun = Boolean(params.dryRun);
  const counts = emptyPurgeCounts();
  void RETAINED_RECORD_YEARS;

  const { data: business, error } = await supabase
    .from("businesses")
    .select(
      "id, owner_user_id, slug, name, closed_at, purge_after, deleted_at, stripe_connected_account_id",
    )
    .eq("id", params.businessId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!business) return { ok: false, error: "Business not found" };

  if (!business.closed_at && !business.deleted_at) {
    return { ok: false, error: "Shop is not closed" };
  }

  if (
    business.purge_after &&
    new Date(business.purge_after as string).getTime() > Date.now() &&
    !business.deleted_at
  ) {
    return {
      ok: true,
      dryRun,
      counts,
      skipped: "grace_period_active",
    };
  }

  // Open disputes block purge (Step 19b / 21b). Dispute financial rows are
  // retained (ON DELETE RESTRICT) and must not be deleted by the 30-day purge.
  const openDisputeCheck = await businessHasOpenDispute(
    supabase,
    params.businessId,
  );
  if (openDisputeCheck.hasOpen) {
    return {
      ok: false,
      error: `Cannot purge while a payment dispute is open (${openDisputeCheck.orderRefs.join(", ") || "open dispute"})`,
    };
  }

  const { data: customers } = await supabase
    .from("customers")
    .select("id, deleted_at, name")
    .eq("business_id", params.businessId);

  const { count: orderCount } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", params.businessId);
  counts.ordersRetainedAnonymised = orderCount ?? 0;

  const { count: productCount } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("business_id", params.businessId);
  counts.productsDeleted = productCount ?? 0;

  const { count: variantCount } = await supabase
    .from("product_variants")
    .select("id", { count: "exact", head: true })
    .eq("business_id", params.businessId);
  counts.variantsDeleted = variantCount ?? 0;

  const { count: imageCount } = await supabase
    .from("product_images")
    .select("id", { count: "exact", head: true })
    .eq("business_id", params.businessId);
  counts.productImagesDeleted = imageCount ?? 0;

  counts.customersErased = (customers ?? []).length;

  if (dryRun) {
    return { ok: true, dryRun: true, counts };
  }

  for (const customer of customers ?? []) {
    const result = await eraseCustomer(supabase, {
      businessId: params.businessId,
      customerId: customer.id as string,
      requestedBy: "operator",
      recordRequest: true,
    });
    if (!result.ok && "blocked" in result && result.blocked) {
      return {
        ok: false,
        error: `Cannot purge: customer ${customer.id} blocked (${result.reason})`,
      };
    }
  }

  await supabase
    .from("ai_knowledge_gaps")
    .delete()
    .eq("business_id", params.businessId);
  await supabase
    .from("ai_describe_usage")
    .delete()
    .eq("business_id", params.businessId);
  await supabase
    .from("product_images")
    .delete()
    .eq("business_id", params.businessId);
  await supabase
    .from("product_variants")
    .delete()
    .eq("business_id", params.businessId);
  await supabase.from("products").delete().eq("business_id", params.businessId);

  counts.storageObjectsDeleted += await deleteStoragePrefix(
    supabase,
    "product-images",
    params.businessId,
  );
  counts.storageObjectsDeleted += await deleteStoragePrefix(
    supabase,
    "business-branding",
    params.businessId,
  );

  const { count: bCast } = await supabase
    .from("broadcasts")
    .delete({ count: "exact" })
    .eq("business_id", params.businessId);
  counts.broadcastsDeleted = bCast ?? 0;

  const { count: analytics } = await supabase
    .from("analytics_cache")
    .delete({ count: "exact" })
    .eq("business_id", params.businessId);
  counts.analyticsDeleted = analytics ?? 0;

  const { count: templates } = await supabase
    .from("message_templates")
    .delete({ count: "exact" })
    .eq("business_id", params.businessId);
  counts.templatesDeleted = templates ?? 0;

  // Anonymise any remaining orders (customers already erased).
  await supabase
    .from("orders")
    .update({
      notes: null,
      shipping_address: null,
      return_reason: null,
      return_reason_detail: null,
      return_notes: null,
      anonymised_at: new Date().toISOString(),
    })
    .eq("business_id", params.businessId)
    .is("anonymised_at", null);

  await supabase
    .from("order_refunds")
    .update({ reason: null })
    .eq("business_id", params.businessId)
    .not("reason", "is", null);

  const shortId = (params.businessId as string).replace(/-/g, "").slice(0, 8);
  const tombstoneSlug = `closed-${shortId}`;

  // Keep Connect id cleared from our row? Spec: do NOT touch Connect account
  // at Stripe; we clear local personal shop content but can leave the id on
  // tombstone for accounting or null it — leave stripe_connected_account_id.
  const { error: tombstoneError } = await supabase
    .from("businesses")
    .update({
      slug: tombstoneSlug,
      name: "Closed shop",
      bio: null,
      logo_url: null,
      banner_url: null,
      dispatch_address_line1: null,
      dispatch_city: null,
      dispatch_postcode: null,
      dispatch_days: null,
      returns_policy_text: null,
      shop_faq: [],
      delivery_info: null,
      whatsapp_phone_e164: null,
      whatsapp_waba_id: null,
      seller_whatsapp_phone_e164: null,
      payout_account_holder_name: null,
      payout_sort_code: null,
      payout_account_number: null,
      payout_dob: null,
      payout_address_line1: null,
      payout_city: null,
      payout_postcode: null,
      ai_tone: "friendly",
      storefront_accent_color: null,
      deleted_at: new Date().toISOString(),
    })
    .eq("id", params.businessId);

  if (tombstoneError) return { ok: false, error: tombstoneError.message };

  const ownerId = business.owner_user_id as string;
  const { data: otherShops } = await supabase
    .from("businesses")
    .select("id")
    .eq("owner_user_id", ownerId)
    .is("deleted_at", null)
    .neq("id", params.businessId);

  if ((otherShops ?? []).length === 0) {
    const { error: authError } = await supabase.auth.admin.deleteUser(ownerId);
    if (!authError) counts.authUserDeleted = 1;
  }

  await supabase.from("deletion_requests").insert({
    business_id: params.businessId,
    subject_type: "seller_account",
    subject_id: params.businessId,
    requested_by: "operator",
    status: "completed",
    completed_at: new Date().toISOString(),
    counts: {
      ...counts,
      retained_record_years: RETAINED_RECORD_YEARS,
      tombstone_slug: tombstoneSlug,
      // Connect account intentionally untouched at Stripe.
      stripe_connect_untouched: true,
    },
  });

  return { ok: true, dryRun: false, counts };
}

export async function purgeDueShops(
  supabase: SupabaseClient,
  params?: { dryRun?: boolean },
): Promise<{
  dueTotal: number;
  processed: number;
  remaining: number;
  purged: number;
  skipped: number;
  failed: number;
  /** @deprecated use dueTotal — kept for callers expecting scanned */
  scanned: number;
  summaries: Array<{ businessId: string; result: string }>;
}> {
  const now = new Date().toISOString();
  const { count: dueTotalCount } = await supabase
    .from("businesses")
    .select("id", { count: "exact", head: true })
    .not("closed_at", "is", null)
    .lte("purge_after", now)
    .is("deleted_at", null);

  const dueTotal = dueTotalCount ?? 0;

  // Oldest due first (earliest purge_after), capped per run.
  const { data: due } = await supabase
    .from("businesses")
    .select("id")
    .not("closed_at", "is", null)
    .lte("purge_after", now)
    .is("deleted_at", null)
    .order("purge_after", { ascending: true })
    .limit(PURGE_MAX_SHOPS_PER_RUN);

  const summaries: Array<{ businessId: string; result: string }> = [];
  let purged = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due ?? []) {
    const id = row.id as string;
    const result = await purgeClosedShop(supabase, {
      businessId: id,
      dryRun: params?.dryRun,
    });
    if (!result.ok) {
      failed += 1;
      summaries.push({ businessId: id, result: result.error });
      continue;
    }
    if (result.skipped) {
      skipped += 1;
      summaries.push({ businessId: id, result: result.skipped });
      continue;
    }
    purged += 1;
    summaries.push({
      businessId: id,
      result: params?.dryRun
        ? `dry_run:${JSON.stringify(result.counts)}`
        : `purged:${JSON.stringify(result.counts)}`,
    });
  }

  const processed = (due ?? []).length;
  const remaining = Math.max(0, dueTotal - processed);

  return {
    dueTotal,
    processed,
    remaining,
    purged,
    skipped,
    failed,
    scanned: dueTotal,
    summaries,
  };
}

/** Aggregate erase counts for reporting (no PII). */
export function sumEraseCounts(
  list: EraseCustomerCounts[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of list) {
    out.messagesDeleted = (out.messagesDeleted ?? 0) + c.messagesDeleted;
    out.ordersAnonymised = (out.ordersAnonymised ?? 0) + c.ordersAnonymised;
  }
  return out;
}
