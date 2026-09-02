import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export const SETUP_ITEM_IDS = [
  "product",
  "stripe",
  "returns",
  "order",
  "whatsapp",
] as const;

export type SetupItemId = (typeof SETUP_ITEM_IDS)[number];

export type SetupItemState = "complete" | "incomplete" | "pending";

export type SetupProgress = {
  slug: string;
  hasActiveProduct: boolean;
  stripeConnectComplete: boolean;
  returnsPolicySet: boolean;
  hasOrder: boolean;
  whatsappConnected: boolean;
};

export type SetupChecklistItem = {
  id: SetupItemId;
  label: string;
  detail: string;
  href: string | null;
  state: SetupItemState;
};

export function setupChecklistShouldShow(progress: SetupProgress): boolean {
  return !(
    progress.hasActiveProduct &&
    progress.stripeConnectComplete &&
    progress.returnsPolicySet &&
    progress.hasOrder
  );
}

export function setupChecklistItems(
  progress: SetupProgress,
): SetupChecklistItem[] {
  return [
    {
      id: "product",
      label: "Add an active product",
      detail: "Buyers can only order what is in your catalogue.",
      href: "/dashboard/products",
      state: progress.hasActiveProduct ? "complete" : "incomplete",
    },
    {
      id: "stripe",
      label: "Connect Stripe to take payments",
      detail: "Charges need to be enabled before buyers can pay you.",
      href: "/dashboard/settings#stripe",
      state: progress.stripeConnectComplete ? "complete" : "incomplete",
    },
    {
      id: "returns",
      label: "Add a returns policy",
      detail: "Used when buyers ask about returns over WhatsApp.",
      href: "/dashboard/settings#returns",
      state: progress.returnsPolicySet ? "complete" : "incomplete",
    },
    {
      id: "order",
      label: "Receive your first order",
      detail: "Share your storefront so a buyer can place an order.",
      href: `/s/${progress.slug}`,
      state: progress.hasOrder ? "complete" : "incomplete",
    },
    {
      id: "whatsapp",
      label: progress.whatsappConnected
        ? "WhatsApp connected"
        : "Connect WhatsApp (coming soon)",
      detail: progress.whatsappConnected
        ? "Inbound WhatsApp is mapped to this shop."
        : "Pending platform rollout — per-seller WhatsApp connection is not available yet.",
      href: progress.whatsappConnected ? "/dashboard/settings#whatsapp" : null,
      state: progress.whatsappConnected ? "complete" : "pending",
    },
  ];
}

export function setupActionableCompleteCount(progress: SetupProgress): {
  done: number;
  total: number;
} {
  const flags = [
    progress.hasActiveProduct,
    progress.stripeConnectComplete,
    progress.returnsPolicySet,
    progress.hasOrder,
  ];
  return {
    done: flags.filter(Boolean).length,
    total: flags.length,
  };
}

export const fetchSetupProgress = cache(
  async (
    supabase: SupabaseClient,
    businessId: string,
  ): Promise<SetupProgress | null> => {
    const [businessRes, productsRes, ordersRes] = await Promise.all([
      supabase
        .from("businesses")
        .select(
          "slug, stripe_charges_enabled, returns_policy_text, whatsapp_phone_e164",
        )
        .eq("id", businessId)
        .maybeSingle(),
      supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("active", true)
        .is("deleted_at", null),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId),
    ]);

    if (businessRes.error) {
      throw new Error(
        `setup progress business lookup failed: ${businessRes.error.message}`,
      );
    }
    if (!businessRes.data) return null;
    if (productsRes.error) {
      throw new Error(
        `setup progress product lookup failed: ${productsRes.error.message}`,
      );
    }
    if (ordersRes.error) {
      throw new Error(
        `setup progress order lookup failed: ${ordersRes.error.message}`,
      );
    }

    const returns = (businessRes.data.returns_policy_text as string | null)?.trim();
    const whatsapp = (
      businessRes.data.whatsapp_phone_e164 as string | null
    )?.trim();

    return {
      slug: businessRes.data.slug as string,
      hasActiveProduct: (productsRes.count ?? 0) > 0,
      stripeConnectComplete: Boolean(businessRes.data.stripe_charges_enabled),
      returnsPolicySet: Boolean(returns),
      hasOrder: (ordersRes.count ?? 0) > 0,
      whatsappConnected: Boolean(whatsapp),
    };
  },
);
