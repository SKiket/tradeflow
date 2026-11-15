import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { closeShop, reopenShop } from "@/lib/privacy/shop-lifecycle";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    confirmName?: string;
  };

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

  const admin = createAdminClient();

  if (body.action === "reopen") {
    const result = await reopenShop(admin, { businessId: business.id });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, reopened: true });
  }

  const confirm = (body.confirmName ?? "").trim();
  if (!confirm || confirm !== (business.name as string)) {
    return NextResponse.json(
      { error: "Type the exact shop name to confirm closure." },
      { status: 400 },
    );
  }

  const result = await closeShop(admin, {
    businessId: business.id,
    requestedBy: "seller",
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        blockingOrderRefs: result.blockingOrderRefs ?? [],
      },
      { status: 409 },
    );
  }

  console.info("[privacy] shop closed", {
    businessId: business.id,
    purgeAfter: result.purgeAfter,
  });

  return NextResponse.json({
    ok: true,
    purgeAfter: result.purgeAfter,
    note: "Your Stripe Connect account was not changed — it belongs to you.",
  });
}
