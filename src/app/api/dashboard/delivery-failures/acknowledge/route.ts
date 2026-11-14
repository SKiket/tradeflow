import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { acknowledgeDeliveryFailures } from "@/lib/dashboard/delivery-failures";

/**
 * Dismiss the dashboard delivery-failure banner for the active business.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  try {
    const cleared = await acknowledgeDeliveryFailures(
      auth.supabase,
      business.id,
    );
    return NextResponse.json({ ok: true, cleared });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
