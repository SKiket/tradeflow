import { NextResponse } from "next/server";

/**
 * Hide internal verification routes in production. Empty 404 — not an auth
 * error — so the paths do not advertise that they exist.
 */
export function notFoundInProduction(): NextResponse | null {
  if (process.env.NODE_ENV !== "production") return null;
  return new NextResponse(null, { status: 404 });
}
