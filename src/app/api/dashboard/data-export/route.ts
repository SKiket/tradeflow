import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import { buildSellerDataExport } from "@/lib/privacy/export-seller-data";

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
    const { files, counts } = await buildSellerDataExport(
      auth.supabase,
      business.id,
    );
    console.info("[privacy] seller data export", {
      businessId: business.id,
      counts,
    });

    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.name, file.content);
    }
    const buffer = await zip.generateAsync({ type: "uint8array" });
    const slug = (business.slug as string) || "shop";
    const date = new Date().toISOString().slice(0, 10);

    return new NextResponse(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="tradeflow-data-${slug}-${date}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error("[privacy] seller export failed", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
