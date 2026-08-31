"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { formatPence } from "@/lib/orders/display";
import { catalogLine, type PublicStorefront } from "@/lib/storefront/catalog";

import { useCart } from "../cart-provider";

export function CheckoutForm({ storefront }: { storefront: PublicStorefront }) {
  const cart = useCart();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resolved = useMemo(() => {
    return cart.lines
      .map((line) => {
        const found = catalogLine(storefront, line.variantId);
        if (!found) return null;
        return { ...found, quantity: line.quantity };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [cart.lines, storefront]);

  const totalPence = resolved.reduce(
    (sum, line) => sum + line.pricePence * line.quantity,
    0,
  );

  if (cart.hydrated && cart.lines.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-4 py-12 text-center">
        <h2 className="text-base font-semibold">Your cart is empty</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Add something from the catalog to check out.
        </p>
        <Link
          href={`/s/${storefront.slug}`}
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          Back to catalog
        </Link>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/storefront/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: storefront.businessId,
          customerName: name,
          customerPhone: phone,
          items: cart.lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        checkoutUrl?: string;
      };
      if (!response.ok || !json.ok || !json.checkoutUrl) {
        setError(json.error || "Could not place that order. Please try again.");
        return;
      }
      cart.clear();
      window.location.assign(json.checkoutUrl);
    } catch {
      setError("Could not place that order. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <ul className="space-y-3">
        {resolved.map((line) => (
          <li
            key={line.variantId}
            className="rounded-2xl border border-zinc-200 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{line.productName}</p>
                {line.variantLabel ? (
                  <p className="text-sm text-zinc-600">{line.variantLabel}</p>
                ) : null}
              </div>
              <p className="shrink-0 text-sm font-medium">
                {formatPence(line.pricePence * line.quantity)}
              </p>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() =>
                    cart.setQuantity(line.variantId, line.quantity - 1)
                  }
                  className="flex size-9 items-center justify-center rounded-lg border border-zinc-300 text-lg leading-none hover:bg-zinc-50"
                >
                  −
                </button>
                <span className="w-8 text-center text-sm tabular-nums">
                  {line.quantity}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() =>
                    cart.setQuantity(line.variantId, line.quantity + 1)
                  }
                  className="flex size-9 items-center justify-center rounded-lg border border-zinc-300 text-lg leading-none hover:bg-zinc-50"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => cart.remove(line.variantId)}
                className="text-sm text-zinc-600 underline-offset-4 hover:underline"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <p className="flex items-baseline justify-between px-1 text-base font-semibold">
        <span>Total</span>
        <span>{formatPence(totalPence)}</span>
      </p>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-4"
      >
        <div className="space-y-1.5">
          <label htmlFor="checkout-name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="checkout-name"
            name="customerName"
            autoComplete="name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="checkout-phone" className="text-sm font-medium">
            WhatsApp phone number
          </label>
          <input
            id="checkout-phone"
            name="customerPhone"
            type="tel"
            autoComplete="tel"
            required
            inputMode="tel"
            placeholder="+44 7700 900000"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            className="h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-sm"
          />
          <p className="text-sm leading-5 text-zinc-600">
            We&apos;ll send order updates to this WhatsApp number.
          </p>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-950">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || !cart.hydrated || resolved.length === 0}
          className="flex min-h-11 w-full items-center justify-center rounded-xl bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {submitting ? "Placing order…" : "Place order"}
        </button>
      </form>
    </div>
  );
}
