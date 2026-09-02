import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireSeller } from "../../require-seller";
import { CatalogImportForm } from "./import-form";

export default async function CatalogImportPage() {
  await requireSeller();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/dashboard/products"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to products
        </Link>
        <h1 className="tf-page-heading mt-3">Import catalog</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create many products at once from a TradeFlow CSV. Nothing is saved
          until you confirm a file with no errors.
        </p>
      </div>
      <CatalogImportForm />
    </div>
  );
}
