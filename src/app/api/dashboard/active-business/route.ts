import { NextResponse, type NextRequest } from "next/server";

import {
  ACTIVE_BUSINESS_COOKIE,
  ACTIVE_BUSINESS_COOKIE_OPTIONS,
  parseBusinessId,
  resolveActiveOwnedBusiness,
} from "@/lib/auth/active-business";
import { requireUser } from "@/lib/api/auth";

function withActiveCookie(response: NextResponse, businessId: string) {
  response.cookies.set(
    ACTIVE_BUSINESS_COOKIE,
    businessId,
    ACTIVE_BUSINESS_COOKIE_OPTIONS,
  );
  return response;
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { business, businesses, error } = await resolveActiveOwnedBusiness(
    auth.supabase,
    auth.user.id,
  );
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  if (!business) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  return withActiveCookie(
    NextResponse.json({
      ok: true,
      businessId: business.id,
      name: business.name,
      businesses: businesses.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
      })),
    }),
    business.id,
  );
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { businessId?: unknown } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const businessId = parseBusinessId(
    typeof body.businessId === "string" ? body.businessId : null,
  );
  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const { businesses, error } = await resolveActiveOwnedBusiness(
    auth.supabase,
    auth.user.id,
    businessId,
  );
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  const owned = businesses.find((row) => row.id === businessId);
  if (!owned) {
    return NextResponse.json(
      { error: "You do not own that shop." },
      { status: 403 },
    );
  }

  return withActiveCookie(
    NextResponse.json({ ok: true, businessId: owned.id, name: owned.name }),
    owned.id,
  );
}

export async function DELETE(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACTIVE_BUSINESS_COOKIE, "", {
    ...ACTIVE_BUSINESS_COOKIE_OPTIONS,
    maxAge: 0,
  });
  return response;
}
