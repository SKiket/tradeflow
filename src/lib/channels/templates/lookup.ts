import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getTemplateDefinition,
  type TemplateKey,
  type TemplateLanguage,
  toContentVariables,
} from "@/lib/channels/templates/registry";
import { resolveLang } from "@/lib/i18n";

export interface ApprovedTemplateRow {
  id: string;
  template_key: string;
  language: TemplateLanguage;
  body: string;
  twilio_content_sid: string;
  business_id: string | null;
}

/**
 * Prefer business-specific approved template, then platform-wide.
 * Fall back to English when the buyer's language has no approved row.
 */
export async function lookupApprovedTemplate(params: {
  supabase: SupabaseClient;
  key: string;
  language: string | null | undefined;
  businessId: string;
}): Promise<ApprovedTemplateRow | null> {
  const preferred = resolveLang(params.language);
  const languages: TemplateLanguage[] =
    preferred === "en" ? ["en"] : [preferred, "en"];

  for (const language of languages) {
    const businessSpecific = await fetchApproved(params.supabase, {
      key: params.key,
      language,
      businessId: params.businessId,
    });
    if (businessSpecific) return businessSpecific;

    const platform = await fetchApproved(params.supabase, {
      key: params.key,
      language,
      businessId: null,
    });
    if (platform) return platform;
  }

  return null;
}

async function fetchApproved(
  supabase: SupabaseClient,
  params: {
    key: string;
    language: TemplateLanguage;
    businessId: string | null;
  },
): Promise<ApprovedTemplateRow | null> {
  let query = supabase
    .from("message_templates")
    .select("id, template_key, language, body, twilio_content_sid, business_id")
    .eq("template_key", params.key)
    .eq("language", params.language)
    .eq("meta_status", "approved")
    .not("twilio_content_sid", "is", null)
    .limit(1);

  if (params.businessId) {
    query = query.eq("business_id", params.businessId);
  } else {
    query = query.is("business_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data?.twilio_content_sid) return null;

  return {
    id: data.id as string,
    template_key: data.template_key as string,
    language: data.language as TemplateLanguage,
    body: data.body as string,
    twilio_content_sid: data.twilio_content_sid as string,
    business_id: (data.business_id as string | null) ?? null,
  };
}

export function buildContentVariablesForKey(
  key: TemplateKey,
  named: Record<string, string>,
): Record<string, string> {
  if (!getTemplateDefinition(key)) return {};
  return toContentVariables(key, named);
}

export function isTemplatesEnabled(): boolean {
  return process.env.TEMPLATES_ENABLED === "true";
}
