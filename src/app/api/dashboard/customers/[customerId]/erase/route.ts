import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { eraseCustomer } from "@/lib/privacy/erase-customer";
import { createAdminClient } from "@/lib/supabase/admin";

type RouteParams = { params: Promise<{ customerId: string }> };

/**
 * Seller-initiated buyer erasure. Verifies ownership via RLS, then runs
 * eraseCustomer with the service-role client (queues + hard deletes).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { customerId } = await params;
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { business, error: businessError } = await resolveActiveOwnedBusiness(
    auth.supabase,
    auth.user.id,
  );
  if (businessError) {
    return NextResponse.json({ error: businessError }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  // RLS-scoped ownership check — must see the customer.
  const { data: customer, error: customerError } = await auth.supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("business_id", business.id)
    .maybeSingle();

  if (customerError) {
    return NextResponse.json({ error: customerError.message }, { status: 500 });
  }
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const result = await eraseCustomer(admin, {
    businessId: business.id,
    customerId,
    requestedBy: "seller",
  });

  if (!result.ok) {
    if ("blocked" in result && result.blocked) {
      return NextResponse.json(
        {
          error: result.reason,
          blockingOrderRefs: result.blockingOrderRefs,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "error" in result ? result.error : "Erase failed" },
      { status: 500 },
    );
  }

  console.info("[privacy] customer erased", {
    businessId: business.id,
    customerId,
    alreadyErased: result.alreadyErased,
    counts: result.counts,
  });

  return NextResponse.json({
    ok: true,
    alreadyErased: result.alreadyErased,
    counts: {
      messagesDeleted: result.counts.messagesDeleted,
      pendingReplaysDeleted: result.counts.pendingReplaysDeleted,
      ordersAnonymised: result.counts.ordersAnonymised,
      refundReasonsCleared: result.counts.refundReasonsCleared,
      customerAnonymised: result.counts.customerAnonymised,
      twilioMessagesDeleted: result.counts.twilio.messagesDeleted,
      twilioMediaDeleted: result.counts.twilio.mediaDeleted,
    },
  });
}
