import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import {
  buildCatalogCsv,
  catalogExportFilename,
  loadCatalogForExport,
} from "@/lib/products/csv-export";

export async function GET(request: NextRequest) {
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

  try {
    const products = await loadCatalogForExport(auth.supabase, business.id);
    const csv = buildCatalogCsv(products);
    const filename = catalogExportFilename(business.slug || "shop");

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error("[products/export] failed", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
