import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { suggestProductDescription } from "@/lib/ai/tasks/product-describe";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
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

  let body: {
    productId?: string;
    language?: string;
    sellerHints?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const productId = body.productId?.trim();
  if (!productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }
  const language = body.language === "fr" ? "fr" : "en";

  const result = await suggestProductDescription({
    businessId: business.id,
    productId,
    language,
    sellerHints: body.sellerHints ?? null,
    supabase: createAdminClient(),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    suggestion: result.suggestion,
    label: "AI suggestion: check before publishing",
  });
}
