import { NextResponse } from "next/server";

import { shouldBlockTestRoutes } from "@/lib/api/runtime-env";

/**
 * Hide internal verification routes on deployed environments.
 * Empty 404 — not an auth error — so the paths do not advertise that they exist.
 * Locally (and when ALLOW_TEST_ROUTES=true) they remain reachable.
 */
export function notFoundInProduction(): NextResponse | null {
  if (!shouldBlockTestRoutes()) return null;
  return new NextResponse(null, { status: 404 });
}
