import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { submitDisputeEvidence } from "@/lib/disputes/evidence";
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
    const result = await submitDisputeEvidence(admin, {
      disputeId,
      businessId: owned.business_id as string,
      submittedBy: "seller",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === "EVIDENCE_ALREADY_SUBMITTED") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Evidence has already been submitted. Submission is one-shot and cannot be repeated.",
        },
        { status: 409 },
      );
    }
    console.error("[disputes/submit] failed", { disputeId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
