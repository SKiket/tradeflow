import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug")?.trim();

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return Response.json({ available: false, reason: "invalid" });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("businesses")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  return Response.json({ available: !data });
}
