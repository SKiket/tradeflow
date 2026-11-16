import { NextResponse } from "next/server";

import { acceptDispute } from "@/lib/disputes/accept";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(
  _request: Request,
  context: { params: Promise<{ disputeId: string }> },
) {
  const { disputeId } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dispute } = await supabase
    .from("disputes")
    .select("id, business_id")
    .eq("id", disputeId)
    .maybeSingle();
  if (!dispute) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: owned } = await supabase
    .from("businesses")
    .select("id")
    .eq("id", dispute.business_id)
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!owned) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const result = await acceptDispute({
    supabase: admin,
    disputeId,
    businessId: dispute.business_id as string,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, stripeDisputeId: result.stripeDisputeId });
}
