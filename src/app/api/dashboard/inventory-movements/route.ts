import { NextResponse } from "next/server";

import {
  fetchVariantInventoryMovements,
  INVENTORY_HISTORY_PAGE_SIZE,
} from "@/lib/inventory/movements";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId")?.trim();
  const before = url.searchParams.get("before")?.trim() || null;
  if (!variantId) {
    return NextResponse.json({ error: "variantId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { business } = await resolveActiveOwnedBusiness(supabase, user.id);
  if (!business) {
    return NextResponse.json({ error: "No shop" }, { status: 403 });
  }

  const { data: variant } = await supabase
    .from("product_variants")
    .select("id")
    .eq("id", variantId)
    .eq("business_id", business.id)
    .maybeSingle();
  if (!variant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { rows, error } = await fetchVariantInventoryMovements(
    supabase,
    business.id,
    variantId,
    INVENTORY_HISTORY_PAGE_SIZE,
    before,
  );
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  return NextResponse.json({ rows });
}
