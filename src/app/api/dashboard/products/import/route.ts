import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { createCatalogProducts } from "@/lib/products/create";
import {
  CSV_TEMPLATE,
  CSV_TEMPLATE_FILENAME,
  parseCatalogCsv,
  toCreateInputs,
} from "@/lib/products/csv-import";

const MAX_CSV_CHARS = 512_000;

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return new NextResponse(CSV_TEMPLATE, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${CSV_TEMPLATE_FILENAME}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { csv?: unknown; confirm?: unknown } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.csv !== "string") {
    return NextResponse.json({ error: "csv is required." }, { status: 400 });
  }
  if (body.csv.length > MAX_CSV_CHARS) {
    return NextResponse.json(
      { error: "CSV is too large. Split it into a smaller file." },
      { status: 400 },
    );
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

  const { data: businessRow, error: defaultsError } = await auth.supabase
    .from("businesses")
    .select("default_low_stock_threshold")
    .eq("id", business.id)
    .maybeSingle();
  if (defaultsError) {
    return NextResponse.json({ error: defaultsError.message }, { status: 500 });
  }

  const { data: existingRows, error: existingError } = await auth.supabase
    .from("products")
    .select("name")
    .eq("business_id", business.id)
    .is("deleted_at", null);
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  const parsed = parseCatalogCsv(body.csv, {
    existingNames: (existingRows ?? []).map((row) => row.name as string),
    defaultLowStockThreshold:
      (businessRow?.default_low_stock_threshold as number | null) ?? 5,
  });

  const productCount = parsed.products.length;
  const variantCount = parsed.products.reduce(
    (sum, product) => sum + product.variants.length,
    0,
  );
  const valid = parsed.errors.length === 0 && productCount > 0;

  if (body.confirm !== true) {
    return NextResponse.json({
      ok: true,
      valid,
      productCount,
      variantCount,
      products: parsed.products,
      errors: parsed.errors,
      rowCount: parsed.rowCount,
    });
  }

  if (!valid) {
    return NextResponse.json(
      {
        ok: false,
        error: "Import blocked — fix every row error and upload again.",
        valid: false,
        productCount,
        variantCount,
        products: parsed.products,
        errors: parsed.errors,
        rowCount: parsed.rowCount,
      },
      { status: 400 },
    );
  }

  try {
    const { productIds } = await createCatalogProducts(
      auth.supabase,
      toCreateInputs(parsed.products, business.id),
    );
    return NextResponse.json({
      ok: true,
      valid: true,
      created: true,
      productCount: productIds.length,
      variantCount,
      productIds,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error("[products/import] create failed", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}
