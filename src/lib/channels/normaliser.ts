import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  NormalisedMessage,
  ParsedInboundMessage,
} from "@/lib/channels/types";

export type NormaliseResult =
  | {
      status: "persisted";
      message: NormalisedMessage;
      messageId: string;
      customerCreated: boolean;
      threadCreated: boolean;
    }
  | { status: "unresolved_business"; recipientAddress: string }
  | { status: "error"; reason: string };

/**
 * Resolves a parsed inbound message against a business, customer and thread,
 * then persists it to the messages table as an inbound message.
 *
 * Must be called with a service-role client — this runs in unauthenticated
 * webhook context, so RLS would otherwise block the writes.
 */
export async function normaliseAndPersist(
  parsed: ParsedInboundMessage,
  supabase: SupabaseClient,
): Promise<NormaliseResult> {
  // 1. Resolve the owning business from the receiving channel address.
  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id")
    .eq("whatsapp_phone_e164", parsed.recipientAddress)
    .is("deleted_at", null)
    .maybeSingle();

  if (businessError) {
    return { status: "error", reason: `business_lookup: ${businessError.message}` };
  }
  if (!business) {
    return { status: "unresolved_business", recipientAddress: parsed.recipientAddress };
  }

  // 2. Find-or-create the customer by (business_id, phone_e164).
  const resolved = await resolveCustomer(supabase, business.id, parsed);
  if (resolved.status === "error") return resolved;
  const { customerId, customerCreated } = resolved;

  // 3. Resolve the thread — reuse the latest open thread for this pair.
  const thread = await resolveThread(supabase, business.id, customerId);
  if (thread.status === "error") return thread;
  const { threadId, threadCreated } = thread;

  // 4. Persist the inbound message.
  const { data: inserted, error: insertError } = await supabase
    .from("messages")
    .insert({
      business_id: business.id,
      customer_id: customerId,
      channel: parsed.channel,
      direction: "inbound",
      raw_payload: parsed.rawPayload,
      normalised_text: parsed.text,
      media_urls: parsed.mediaUrls.length > 0 ? parsed.mediaUrls : null,
      thread_id: threadId,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return {
      status: "error",
      reason: `message_insert: ${insertError?.message ?? "no row returned"}`,
    };
  }

  const message: NormalisedMessage = {
    businessId: business.id,
    customerId,
    customerPhone: parsed.senderPhoneE164,
    channel: parsed.channel,
    direction: "inbound",
    rawPayload: parsed.rawPayload,
    normalisedText: parsed.text,
    mediaUrls: parsed.mediaUrls,
    threadId,
    receivedAt: parsed.receivedAt,
  };

  return {
    status: "persisted",
    message,
    messageId: inserted.id,
    customerCreated,
    threadCreated,
  };
}

async function resolveCustomer(
  supabase: SupabaseClient,
  businessId: string,
  parsed: ParsedInboundMessage,
): Promise<
  | { status: "ok"; customerId: string; customerCreated: boolean }
  | { status: "error"; reason: string }
> {
  const { data: existing, error: selectError } = await supabase
    .from("customers")
    .select("id, name")
    .eq("business_id", businessId)
    .eq("phone_e164", parsed.senderPhoneE164)
    .is("deleted_at", null)
    .maybeSingle();

  if (selectError) {
    return { status: "error", reason: `customer_lookup: ${selectError.message}` };
  }

  if (existing) {
    // Backfill a display name if we didn't have one and now do.
    if (!existing.name && parsed.senderDisplayName) {
      await supabase
        .from("customers")
        .update({ name: parsed.senderDisplayName })
        .eq("id", existing.id);
    }
    return { status: "ok", customerId: existing.id, customerCreated: false };
  }

  const { data: created, error: insertError } = await supabase
    .from("customers")
    .insert({
      business_id: businessId,
      phone_e164: parsed.senderPhoneE164,
      name: parsed.senderDisplayName,
      channel_identifiers: { [parsed.channel]: parsed.senderPhoneE164 },
    })
    .select("id")
    .single();

  if (created) {
    return { status: "ok", customerId: created.id, customerCreated: true };
  }

  // Likely a concurrent insert hit the UNIQUE (business_id, phone_e164)
  // constraint — re-select the row the other request created.
  const { data: raced } = await supabase
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", parsed.senderPhoneE164)
    .maybeSingle();

  if (raced) {
    return { status: "ok", customerId: raced.id, customerCreated: false };
  }

  return {
    status: "error",
    reason: `customer_insert: ${insertError?.message ?? "unknown"}`,
  };
}

async function resolveThread(
  supabase: SupabaseClient,
  businessId: string,
  customerId: string,
): Promise<
  | { status: "ok"; threadId: string; threadCreated: boolean }
  | { status: "error"; reason: string }
> {
  const { data: latest, error } = await supabase
    .from("messages")
    .select("thread_id")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .not("thread_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { status: "error", reason: `thread_lookup: ${error.message}` };
  }

  if (latest?.thread_id) {
    return { status: "ok", threadId: latest.thread_id, threadCreated: false };
  }

  return { status: "ok", threadId: randomUUID(), threadCreated: true };
}
