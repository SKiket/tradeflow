import { NextResponse } from "next/server";

import { isVercelProduction } from "@/lib/api/runtime-env";
import { anyCronJobDegraded } from "@/lib/cron/heartbeat";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DB_TIMEOUT_MS = 2000;

async function pingDatabase(): Promise<boolean> {
  // Verification-only hook — never active in Vercel production.
  if (
    process.env.HEALTH_FORCE_DEGRADED === "true" &&
    !isVercelProduction()
  ) {
    return false;
  }

  const supabase = createAdminClient();
  const probe = supabase
    .from("businesses")
    .select("id")
    .limit(1)
    .maybeSingle();

  const result = await Promise.race([
    probe.then((r) => ({ ok: !r.error, timedOut: false as const })),
    new Promise<{ ok: false; timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ ok: false, timedOut: true }), DB_TIMEOUT_MS),
    ),
  ]);

  return result.ok;
}

/**
 * Liveness + shallow DB readiness + cron heartbeat freshness.
 * No secrets, versions, job names, or error details in the response.
 */
export async function GET() {
  try {
    const ok = await pingDatabase();
    if (!ok) {
      return NextResponse.json(
        { status: "degraded" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const cronDegraded = await anyCronJobDegraded();
    if (cronDegraded) {
      return NextResponse.json(
        { status: "degraded" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      { status: "ok" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "degraded" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
