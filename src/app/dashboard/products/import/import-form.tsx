"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatPence } from "@/lib/orders/display";
import type { CsvRowError, ParsedCatalogProduct } from "@/lib/products/csv-import";

type PreviewResponse = {
  ok?: boolean;
  valid?: boolean;
  error?: string;
  productCount?: number;
  variantCount?: number;
  products?: ParsedCatalogProduct[];
  errors?: CsvRowError[];
  rowCount?: number;
  created?: boolean;
};

function errorsForProduct(
  product: ParsedCatalogProduct,
  errors: CsvRowError[],
): CsvRowError[] {
  const rows = new Set(product.sourceRows);
  return errors.filter((error) => rows.has(error.row));
}

export function CatalogImportForm() {
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadFile(file: File) {
    setError(null);
    setSuccess(null);
    setPreview(null);
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);
    setPending(true);
    try {
      const response = await fetch("/api/dashboard/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, confirm: false }),
      });
      const result = (await response.json()) as PreviewResponse;
      if (!response.ok && !result.errors) {
        setError(result.error ?? "Could not read this file.");
        return;
      }
      setPreview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  async function confirmImport() {
    if (!csv || !preview?.valid) return;
    setConfirming(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, confirm: true }),
      });
      const result = (await response.json()) as PreviewResponse;
      if (!response.ok) {
        setPreview(result.errors ? result : preview);
        setError(result.error ?? "Import was blocked.");
        return;
      }
      setSuccess(
        `Created ${result.productCount} product${result.productCount === 1 ? "" : "s"} and ${result.variantCount} variant${result.variantCount === 1 ? "" : "s"}.`,
      );
      setPreview(null);
      setCsv(null);
      setFileName(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConfirming(false);
    }
  }

  const errors = preview?.errors ?? [];
  const products = preview?.products ?? [];
  const blocked = Boolean(preview && !preview.valid);

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border p-4 text-sm">
        <h2 className="font-semibold">CSV format</h2>
        <p className="text-muted-foreground">
          One row per product + variant. Rows that share the same{" "}
          <code className="rounded bg-muted px-1">product_name</code> (case
          insensitive) become one product. They do not need to sit next to each
          other, but description, price, photo URL, and active must be identical
          across those rows.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <code className="rounded bg-muted px-1">product_name</code> —
            required
          </li>
          <li>
            <code className="rounded bg-muted px-1">description</code> —
            optional
          </li>
          <li>
            <code className="rounded bg-muted px-1">price_gbp</code> — required,
            pounds, e.g. 12.00
          </li>
          <li>
            <code className="rounded bg-muted px-1">photo_url</code> — optional
            http(s) URL (no file upload in bulk import). Multiple photos are
            added later in the product editor, not as extra CSV columns.
          </li>
          <li>
            <code className="rounded bg-muted px-1">active</code> — yes or no,
            defaults to yes
          </li>
          <li>
            <code className="rounded bg-muted px-1">variant_label</code> — blank
            becomes a single Standard variant
          </li>
          <li>
            <code className="rounded bg-muted px-1">stock_quantity</code> —
            blank means inventory is not tracked
          </li>
          <li>
            <code className="rounded bg-muted px-1">low_stock_threshold</code> —
            blank uses your shop default
          </li>
          <li>
            <code className="rounded bg-muted px-1">weight_grams</code> — blank
            uses 200 g
          </li>
        </ul>
        <p className="text-muted-foreground">
          Import only creates new products. If a name already exists in this
          shop, the whole file is blocked. If any row is invalid, nothing is
          created.
        </p>
        <a
          href="/api/dashboard/products/import"
          className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
        >
          Download template
        </a>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <label className="block text-sm font-medium" htmlFor="catalog-csv">
          Upload CSV
        </label>
        <input
          id="catalog-csv"
          type="file"
          accept=".csv,text/csv"
          disabled={pending || confirming}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void loadFile(file);
            event.target.value = "";
          }}
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:bg-background file:px-3 file:py-1.5"
        />
        {fileName ? (
          <p className="text-xs text-muted-foreground">Selected: {fileName}</p>
        ) : null}
        {pending ? (
          <p className="text-sm text-muted-foreground">Reading file…</p>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
          {success}{" "}
          <a href="/dashboard/products" className="font-medium underline-offset-4 hover:underline">
            View products
          </a>
        </p>
      ) : null}

      {preview && !success ? (
        <section className="space-y-4">
          <div className="rounded-xl border px-4 py-3 text-sm">
            {blocked ? (
              <p className="font-medium text-destructive">
                Import blocked — {errors.length} error
                {errors.length === 1 ? "" : "s"} in this file. Nothing will be
                created until every row is valid.
              </p>
            ) : (
              <p>
                Ready to create{" "}
                <strong>
                  {preview.productCount} product
                  {preview.productCount === 1 ? "" : "s"}
                </strong>{" "}
                and{" "}
                <strong>
                  {preview.variantCount} variant
                  {preview.variantCount === 1 ? "" : "s"}
                </strong>{" "}
                from {preview.rowCount} row
                {preview.rowCount === 1 ? "" : "s"}.
              </p>
            )}
          </div>

          {errors.length > 0 ? (
            <ol className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              {errors.map((item, index) => (
                <li key={`${item.row}-${item.field}-${index}`}>
                  <span className="font-medium">Row {item.row}</span>
                  {item.field !== "file" ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {item.field}
                    </span>
                  ) : null}
                  <span> — {item.message}</span>
                </li>
              ))}
            </ol>
          ) : null}

          {products.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Price</th>
                    <th className="px-4 py-3">Active</th>
                    <th className="px-4 py-3">Variants</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => {
                    const productErrors = errorsForProduct(product, errors);
                    return (
                      <tr
                        key={product.name}
                        className="border-b last:border-b-0"
                      >
                        <td className="px-4 py-3 align-top">
                          <p className="font-medium">{product.name}</p>
                          {product.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {product.description}
                            </p>
                          ) : null}
                          {productErrors.length > 0 ? (
                            <p className="mt-1 text-xs text-destructive">
                              {productErrors.length} error
                              {productErrors.length === 1 ? "" : "s"} on this
                              product
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 align-top tabular-nums">
                          {product.price_pence >= 0
                            ? formatPence(product.price_pence)
                            : "—"}
                        </td>
                        <td className="px-4 py-3 align-top">
                          {product.active ? "Yes" : "No"}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <ul className="space-y-1">
                            {product.variants.map((variant) => (
                              <li key={`${product.name}-${variant.label}`}>
                                {variant.label}
                                {variant.track_inventory
                                  ? ` · stock ${variant.stock_quantity}`
                                  : " · not tracked"}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {preview.valid ? (
              <Button
                type="button"
                disabled={confirming}
                onClick={() => void confirmImport()}
              >
                {confirming ? "Importing…" : "Confirm import"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Confirm import is unavailable until the file has no errors.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={confirming}
              onClick={() => {
                setPreview(null);
                setCsv(null);
                setFileName(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
