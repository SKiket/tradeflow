import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

/**
 * Clear customers.ai_paused_until so order_parse/support_reply run again.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;

  const { business, error: bizError } = await resolveActiveOwnedBusiness(
    auth.supabase,
    auth.user.id,
  );
  if (bizError) {
    return NextResponse.json({ error: bizError }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  const { data: rows, error: threadError } = await auth.supabase
    .from("messages")
    .select("customer_id")
    .eq("thread_id", threadId)
    .eq("business_id", business.id)
    .not("customer_id", "is", null)
    .is("deleted_at", null)
    .limit(1);

  if (threadError) {
    return NextResponse.json({ error: threadError.message }, { status: 500 });
  }
  const row = rows?.[0];
  if (!row?.customer_id) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const { error: updateError } = await auth.supabase
    .from("customers")
    .update({ ai_paused_until: null })
    .eq("id", row.customer_id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    customerId: row.customer_id,
    aiPausedUntil: null,
  });
}
