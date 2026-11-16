import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api/auth";
import { resolveActiveOwnedBusiness } from "@/lib/auth/active-business";
import {
  FAQ_FIELD_MAX,
  PRODUCT_FAQ_MAX,
  SHOP_FAQ_MAX,
} from "@/lib/knowledge/types";
import { parseFaqArray } from "@/lib/knowledge/validate";

type RouteContext = { params: Promise<{ gapId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
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

  const { gapId } = await context.params;
  let body: {
    action?: string;
    answer?: string;
    resolveTo?: string;
    question?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = auth.supabase;
  const { data: gap, error: gapError } = await supabase
    .from("ai_knowledge_gaps")
    .select("id, business_id, product_id, question_text, status")
    .eq("id", gapId)
    .eq("business_id", business.id)
    .maybeSingle();

  if (gapError || !gap) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.action === "dismiss") {
    const { error } = await supabase
      .from("ai_knowledge_gaps")
      .update({ status: "dismissed", resolved_to: null })
      .eq("id", gapId)
      .eq("business_id", business.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action !== "answer") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const question = (body.question?.trim() || gap.question_text || "").slice(
    0,
    FAQ_FIELD_MAX,
  );
  const answer = (body.answer ?? "").trim().slice(0, FAQ_FIELD_MAX);
  if (!question || !answer) {
    return NextResponse.json(
      { error: "Question and answer are required" },
      { status: 400 },
    );
  }

  const resolveTo =
    body.resolveTo === "shop_faq" ? "shop_faq" : "product_faq";

  if (resolveTo === "product_faq") {
    if (!gap.product_id) {
      return NextResponse.json(
        {
          error:
            "Choose shop FAQ — no product linked to this question",
        },
        { status: 400 },
      );
    }
    const { data: product } = await supabase
      .from("products")
      .select("id, product_faqs")
      .eq("id", gap.product_id)
      .eq("business_id", business.id)
      .maybeSingle();
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    const existing = parseFaqArray(product.product_faqs, PRODUCT_FAQ_MAX).items;
    if (existing.length >= PRODUCT_FAQ_MAX) {
      return NextResponse.json(
        { error: `Product already has ${PRODUCT_FAQ_MAX} FAQs` },
        { status: 400 },
      );
    }
    const { error: updErr } = await supabase
      .from("products")
      .update({
        product_faqs: [...existing, { question, answer }],
      })
      .eq("id", product.id)
      .eq("business_id", business.id);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  } else {
    const { data: biz } = await supabase
      .from("businesses")
      .select("id, shop_faq")
      .eq("id", business.id)
      .maybeSingle();
    const existing = parseFaqArray(biz?.shop_faq, SHOP_FAQ_MAX).items;
    if (existing.length >= SHOP_FAQ_MAX) {
      return NextResponse.json(
        { error: `Shop already has ${SHOP_FAQ_MAX} FAQs` },
        { status: 400 },
      );
    }
    const { error: updErr } = await supabase
      .from("businesses")
      .update({ shop_faq: [...existing, { question, answer }] })
      .eq("id", business.id);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  }

  const { error: gapUpd } = await supabase
    .from("ai_knowledge_gaps")
    .update({ status: "answered", resolved_to: resolveTo })
    .eq("id", gapId)
    .eq("business_id", business.id);
  if (gapUpd) {
    return NextResponse.json({ error: gapUpd.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
