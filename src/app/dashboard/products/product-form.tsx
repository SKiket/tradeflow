"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { poundsToPence, penceToPoundsInput } from "@/lib/orders/display";
import { createClient } from "@/lib/supabase/client";

export type ProductFormVariant = {
  id?: string;
  label: string | null;
  stock_quantity: number;
  low_stock_threshold: number;
  track_inventory: boolean;
};

export type ProductFormValues = {
  id?: string;
  name: string;
  description: string | null;
  price_pence: number;
  photo_url: string | null;
  active: boolean;
  variants: ProductFormVariant[];
};

type VariantDraft = {
  clientId: string;
  id?: string;
  label: string;
  stockQuantity: string;
  lowStockThreshold: string;
  trackInventory: boolean;
  removed: boolean;
};

let draftSeq = 0;

function newClientId() {
  draftSeq += 1;
  return `draft-${draftSeq}`;
}

function blankVariant(): VariantDraft {
  return {
    clientId: newClientId(),
    label: "",
    stockQuantity: "0",
    lowStockThreshold: "5",
    trackInventory: true,
    removed: false,
  };
}

function parseIntField(value: string, fallback: number) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function ProductForm({
  businessId,
  product,
}: {
  businessId: string;
  product?: ProductFormValues;
}) {
  const router = useRouter();
  const isEdit = Boolean(product?.id);
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(
    product ? penceToPoundsInput(product.price_pence) : "",
  );
  const [photoUrl, setPhotoUrl] = useState(product?.photo_url ?? "");
  const [active, setActive] = useState(product?.active ?? true);
  const [variants, setVariants] = useState<VariantDraft[]>(() => {
    if (product?.variants.length) {
      return product.variants.map((variant) => ({
        clientId: variant.id ?? newClientId(),
        id: variant.id,
        label: variant.label ?? "",
        stockQuantity: String(variant.stock_quantity),
        lowStockThreshold: String(variant.low_stock_threshold),
        trackInventory: variant.track_inventory,
        removed: false,
      }));
    }
    return isEdit ? [] : [blankVariant()];
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleVariants = variants.filter((variant) => !variant.removed);

  function updateVariant(clientId: string, patch: Partial<VariantDraft>) {
    setVariants((current) =>
      current.map((variant) =>
        variant.clientId === clientId ? { ...variant, ...patch } : variant,
      ),
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    const pricePence = poundsToPence(price);
    if (pricePence === null || pricePence < 0) {
      setError("Enter a valid price in pounds.");
      return;
    }

    setPending(true);
    const supabase = createClient();
    const photo = photoUrl.trim();
    const desc = description.trim();

    try {
      let productId = product?.id;

      if (isEdit && productId) {
        const { error: updateError } = await supabase
          .from("products")
          .update({
            name: trimmedName,
            description: desc || null,
            price_pence: pricePence,
            photo_url: photo || null,
            active,
          })
          .eq("id", productId);
        if (updateError) throw new Error(updateError.message);
      } else {
        const { data: inserted, error: insertError } = await supabase
          .from("products")
          .insert({
            business_id: businessId,
            name: trimmedName,
            description: desc || null,
            price_pence: pricePence,
            photo_url: photo || null,
            active,
          })
          .select("id")
          .single();
        if (insertError) throw new Error(insertError.message);
        productId = inserted.id as string;
      }

      if (!productId) throw new Error("Product was not saved.");

      for (const variant of variants) {
        if (variant.removed && variant.id) {
          const { error: deleteError } = await supabase
            .from("product_variants")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", variant.id);
          if (deleteError) throw new Error(deleteError.message);
          continue;
        }
        if (variant.removed || !productId) continue;

        const payload = {
          label: variant.label.trim() || null,
          stock_quantity: Math.max(0, parseIntField(variant.stockQuantity, 0)),
          low_stock_threshold: Math.max(
            0,
            parseIntField(variant.lowStockThreshold, 5),
          ),
          track_inventory: variant.trackInventory,
        };

        if (variant.id) {
          const { error: variantUpdateError } = await supabase
            .from("product_variants")
            .update(payload)
            .eq("id", variant.id);
          if (variantUpdateError) throw new Error(variantUpdateError.message);
        } else {
          const { error: variantInsertError } = await supabase
            .from("product_variants")
            .insert({
              ...payload,
              product_id: productId,
              business_id: businessId,
              reserved_quantity: 0,
            });
          if (variantInsertError) throw new Error(variantInsertError.message);
        }
      }

      router.push("/dashboard/products");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <section className="space-y-4 rounded-xl border p-4">
        <div className="space-y-1">
          <Label htmlFor="product-name">Name</Label>
          <Input
            id="product-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="product-description">Description</Label>
          <textarea
            id="product-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={pending}
            rows={3}
            className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="product-price">Price (£)</Label>
            <Input
              id="product-price"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              required
              disabled={pending}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="product-photo">Photo URL</Label>
            <Input
              id="product-photo"
              type="text"
              value={photoUrl}
              onChange={(event) => setPhotoUrl(event.target.value)}
              placeholder="https://"
              disabled={pending}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            disabled={pending}
          />
          Active — inactive products are hidden from WhatsApp order matching
        </label>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Variants
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Seeded products use at least one variant (for example “Standard”).
              A product with none cannot be ordered yet — order lines require a
              variant.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setVariants((current) => [...current, blankVariant()])}
          >
            Add variant
          </Button>
        </div>

        {visibleVariants.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
            No variants. Add one to make this product purchasable.
          </p>
        ) : (
          <div className="space-y-3">
            {visibleVariants.map((variant, index) => (
              <div key={variant.clientId} className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Variant {index + 1}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      updateVariant(variant.clientId, { removed: true })
                    }
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`variant-label-${variant.clientId}`}>
                      Label
                    </Label>
                    <Input
                      id={`variant-label-${variant.clientId}`}
                      value={variant.label}
                      onChange={(event) =>
                        updateVariant(variant.clientId, {
                          label: event.target.value,
                        })
                      }
                      placeholder="e.g. Standard, Size 10"
                      disabled={pending}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`variant-stock-${variant.clientId}`}>
                      Stock
                    </Label>
                    <Input
                      id={`variant-stock-${variant.clientId}`}
                      type="number"
                      min="0"
                      step="1"
                      value={variant.stockQuantity}
                      onChange={(event) =>
                        updateVariant(variant.clientId, {
                          stockQuantity: event.target.value,
                        })
                      }
                      disabled={pending}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`variant-threshold-${variant.clientId}`}>
                      Low stock threshold
                    </Label>
                    <Input
                      id={`variant-threshold-${variant.clientId}`}
                      type="number"
                      min="0"
                      step="1"
                      value={variant.lowStockThreshold}
                      onChange={(event) =>
                        updateVariant(variant.clientId, {
                          lowStockThreshold: event.target.value,
                        })
                      }
                      disabled={pending}
                    />
                  </div>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input
                      type="checkbox"
                      checked={variant.trackInventory}
                      onChange={(event) =>
                        updateVariant(variant.clientId, {
                          trackInventory: event.target.checked,
                        })
                      }
                      disabled={pending}
                    />
                    Track inventory
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save product" : "Add product"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => router.push("/dashboard/products")}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
