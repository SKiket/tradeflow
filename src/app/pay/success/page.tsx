import { createAdminClient } from "@/lib/supabase/admin";

interface PaySuccessPageProps {
  searchParams: Promise<{ session_id?: string }>;
}

function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export default async function PaySuccessPage({ searchParams }: PaySuccessPageProps) {
  const { session_id: sessionId } = await searchParams;

  if (!sessionId) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "32rem" }}>
        <h1>Payment submitted</h1>
        <p>Thank you — return to WhatsApp for your order confirmation.</p>
      </main>
    );
  }

  const supabase = createAdminClient();
  const { data: order } = await supabase
    .from("orders")
    .select("order_ref, status, total_pence")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();

  if (!order) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "32rem" }}>
        <h1>Payment submitted</h1>
        <p>We&apos;re processing your payment. You&apos;ll receive a WhatsApp confirmation shortly.</p>
      </main>
    );
  }

  const isPaid = order.status === "PAID";
  const isPending =
    order.status === "AWAITING_PAYMENT" ||
    order.status === "PENDING_CONFIRMATION";

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "32rem" }}>
      <h1>{isPaid ? "Order confirmed" : "Payment submitted"}</h1>
      <p>
        <strong>{order.order_ref}</strong>
        {" — "}
        {formatPence(order.total_pence)}
      </p>
      {isPaid ? (
        <p>Payment received — your order is confirmed. Check WhatsApp for details.</p>
      ) : isPending ? (
        <p>
          Your bank payment is being processed. We&apos;ll confirm your order on WhatsApp once
          it clears.
        </p>
      ) : (
        <p>Status: {order.status}. Return to WhatsApp if you need help.</p>
      )}
    </main>
  );
}
