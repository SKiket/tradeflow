import type { SupabaseClient } from "@supabase/supabase-js";

import { CSV_COLUMNS } from "@/lib/products/csv-import";
import {
  buildCatalogCsv,
  loadCatalogForExport,
} from "@/lib/products/csv-export";

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value) || /^[=+\-@]/.test(value)) {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(headers: string[], rows: string[][]): string {
  return `\uFEFF${[headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n")}\n`;
}

/**
 * Build seller data-export files (RLS-scoped client). Counts only in logs.
 * Returns text files suitable for ZIP packaging.
 */
export async function buildSellerDataExport(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{
  files: Array<{ name: string; content: string }>;
  counts: Record<string, number>;
}> {
  const products = await loadCatalogForExport(supabase, businessId);
  const catalogCsv = buildCatalogCsv(products);

  const { data: customers } = await supabase
    .from("customers")
    .select("id, name, phone_e164, notes, tags, broadcast_opt_in, created_at")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const customersCsv = toCsv(
    [
      "name",
      "phone_e164",
      "notes",
      "tags",
      "broadcast_opt_in",
      "created_at",
    ],
    (customers ?? []).map((c) => [
      (c.name as string | null) ?? "",
      (c.phone_e164 as string) ?? "",
      (c.notes as string | null) ?? "",
      Array.isArray(c.tags) ? (c.tags as string[]).join("|") : "",
      c.broadcast_opt_in === false ? "no" : "yes",
      (c.created_at as string) ?? "",
    ]),
  );

  const { data: orders } = await supabase
    .from("orders")
    .select(
      "id, order_ref, status, total_pence, refunded_amount_pence, notes, shipping_address, created_at, customer_id, anonymised_at",
    )
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const ordersCsv = toCsv(
    [
      "order_ref",
      "status",
      "total_pence",
      "refunded_amount_pence",
      "notes",
      "shipping_line1",
      "shipping_city",
      "shipping_postcode",
      "created_at",
      "anonymised",
    ],
    (orders ?? []).map((o) => {
      const addr =
        o.shipping_address && typeof o.shipping_address === "object"
          ? (o.shipping_address as Record<string, string>)
          : {};
      return [
        (o.order_ref as string) ?? "",
        (o.status as string) ?? "",
        String(o.total_pence ?? 0),
        String(o.refunded_amount_pence ?? 0),
        (o.notes as string | null) ?? "",
        addr.line1 ?? "",
        addr.city ?? "",
        addr.postcode ?? "",
        (o.created_at as string) ?? "",
        o.anonymised_at ? "yes" : "no",
      ];
    }),
  );

  const { data: messages } = await supabase
    .from("messages")
    .select("created_at, direction, normalised_text, customer_id")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(5000);

  const messagesTxt = (messages ?? [])
    .map((m) => {
      const when = (m.created_at as string) ?? "";
      const dir = (m.direction as string) ?? "";
      const text = ((m.normalised_text as string | null) ?? "").replace(
        /\r?\n/g,
        " ",
      );
      return `[${when}] ${dir}: ${text}`;
    })
    .join("\n");

  return {
    files: [
      { name: "products.csv", content: catalogCsv },
      { name: "customers.csv", content: customersCsv },
      { name: "orders.csv", content: ordersCsv },
      { name: "messages.txt", content: messagesTxt + (messagesTxt ? "\n" : "") },
      {
        name: "README.txt",
        content:
          "TradeFlow seller data export.\n" +
          `Columns for products match the catalogue importer: ${CSV_COLUMNS.join(", ")}.\n` +
          "Messages are plain text (newest 5000). Contains personal data — store securely.\n",
      },
    ],
    counts: {
      products: products.length,
      customers: (customers ?? []).length,
      orders: (orders ?? []).length,
      messages: (messages ?? []).length,
    },
  };
}
