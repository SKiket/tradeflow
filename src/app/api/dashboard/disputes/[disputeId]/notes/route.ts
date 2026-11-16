import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { updateDisputeSellerNotes } from "@/lib/disputes/evidence";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ disputeId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { disputeId } = await context.params;
  let body: { notes?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const notes = typeof body.notes === "string" ? body.notes : "";

  // Ownership via seller-scoped select, then service-role write for Stripe sync.
  const { data: owned, error: ownError } = await auth.supabase
    .from("disputes")
    .select("id, business_id")
    .eq("id", disputeId)
    .maybeSingle();

  if (ownError) {
    return NextResponse.json({ error: ownError.message }, { status: 500 });
  }
  if (!owned) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  try {
    const admin = createAdminClient();
    const result = await updateDisputeSellerNotes(admin, {
      disputeId,
      businessId: owned.business_id as string,
      notes,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === "EVIDENCE_ALREADY_SUBMITTED") {
      return NextResponse.json(
        { ok: false, error: "Evidence has already been submitted" },
        { status: 409 },
      );
    }
    console.error("[disputes/notes] failed", { disputeId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
