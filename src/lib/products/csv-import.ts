import { poundsToPence } from "@/lib/orders/display";
import { DEFAULT_WEIGHT_GRAMS } from "@/lib/shippo/client";

import type { NewProductInput, NewProductVariant } from "./create";

export const CSV_COLUMNS = [
  "product_name",
  "description",
  "price_gbp",
  "photo_url",
  "active",
  "variant_label",
  "stock_quantity",
  "low_stock_threshold",
  "weight_grams",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const CSV_TEMPLATE = [
  CSV_COLUMNS.join(","),
  'Example Soap Bar,"Hand-poured honey soap, 100g bar.",6.00,,yes,,40,5,100',
  'Example Tote Bag,"Reusable linen tote for daily errands.",18.00,,yes,Natural,12,5,200',
  'Example Tote Bag,"Reusable linen tote for daily errands.",18.00,,yes,Navy,8,5,200',
].join("\n") + "\n";

export const CSV_TEMPLATE_FILENAME = "tradeflow-catalog-template.csv";

export type CsvRowError = {
  row: number;
  field: string;
  message: string;
};

export type ParsedCatalogVariant = NewProductVariant & {
  sourceRows: number[];
};

export type ParsedCatalogProduct = {
  name: string;
  description: string | null;
  price_pence: number;
  photo_url: string | null;
  active: boolean;
  variants: ParsedCatalogVariant[];
  sourceRows: number[];
};

export type CsvParseResult = {
  products: ParsedCatalogProduct[];
  errors: CsvRowError[];
  rowCount: number;
};

type ProductGroup = {
  name: string;
  description: string | null;
  price_pence: number;
  photo_url: string | null;
  active: boolean;
  sourceRows: number[];
  variants: ParsedCatalogVariant[];
};

function parseCsvRows(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    throw new Error("CSV has an unclosed quoted field.");
  }

  row.push(field);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) {
    rows.push(row);
  }
  return rows;
}

function cell(row: string[], index: number | undefined): string {
  if (index == null) return "";
  return (row[index] ?? "").trim();
}

function emptyRow(row: string[]): boolean {
  return row.every((value) => value.trim() === "");
}

function parseActive(value: string, rowNumber: number): {
  value: boolean | null;
  error: CsvRowError | null;
} {
  if (!value) return { value: true, error: null };
  const lowered = value.toLowerCase();
  if (lowered === "yes" || lowered === "true") {
    return { value: true, error: null };
  }
  if (lowered === "no" || lowered === "false") {
    return { value: false, error: null };
  }
  return {
    value: null,
    error: {
      row: rowNumber,
      field: "active",
      message: `active must be "yes" or "no" (got "${value}").`,
    },
  };
}

function parseNonNegativeInt(
  value: string,
  rowNumber: number,
  field: string,
): { value: number | null; error: CsvRowError | null } {
  if (!value) return { value: null, error: null };
  if (!/^\d+$/.test(value)) {
    return {
      value: null,
      error: {
        row: rowNumber,
        field,
        message: `${field} must be a whole number of 0 or more.`,
      },
    };
  }
  return { value: Number.parseInt(value, 10), error: null };
}

function parsePositiveInt(
  value: string,
  rowNumber: number,
  field: string,
): { value: number | null; error: CsvRowError | null } {
  if (!value) return { value: null, error: null };
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) < 1) {
    return {
      value: null,
      error: {
        row: rowNumber,
        field,
        message: `${field} must be a whole number greater than 0.`,
      },
    };
  }
  return { value: Number.parseInt(value, 10), error: null };
}

function parsePhotoUrl(
  value: string,
  rowNumber: number,
): { value: string | null; error: CsvRowError | null } {
  if (!value) return { value: null, error: null };
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("not http(s)");
    }
    return { value, error: null };
  } catch {
    return {
      value: null,
      error: {
        row: rowNumber,
        field: "photo_url",
        message: "photo_url must be an http(s) URL, or left blank.",
      },
    };
  }
}

function sameOptionalText(a: string | null, b: string | null): boolean {
  return (a ?? "") === (b ?? "");
}

/**
 * Parse a TradeFlow catalog CSV. Groups rows by case-insensitive
 * product_name. Does not write to the database.
 */
export function parseCatalogCsv(
  text: string,
  options: {
    existingNames: string[];
    defaultLowStockThreshold: number;
    defaultWeightGrams?: number;
  },
): CsvParseResult {
  const errors: CsvRowError[] = [];
  const defaultWeight = options.defaultWeightGrams ?? DEFAULT_WEIGHT_GRAMS;
  const existing = new Set(
    options.existingNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
  );

  let rows: string[][];
  try {
    rows = parseCsvRows(text);
  } catch (caught) {
    return {
      products: [],
      errors: [
        {
          row: 1,
          field: "file",
          message: caught instanceof Error ? caught.message : String(caught),
        },
      ],
      rowCount: 0,
    };
  }

  if (rows.length === 0) {
    return {
      products: [],
      errors: [{ row: 1, field: "file", message: "The file is empty." }],
      rowCount: 0,
    };
  }

  const header = rows[0]!.map((value) => value.trim().toLowerCase());
  const indexByColumn = new Map<string, number>();
  header.forEach((name, index) => {
    if (!name) return;
    if (indexByColumn.has(name)) {
      errors.push({
        row: 1,
        field: name,
        message: `Column "${name}" is repeated in the header.`,
      });
      return;
    }
    indexByColumn.set(name, index);
  });

  for (const column of CSV_COLUMNS) {
    if (!indexByColumn.has(column) && (column === "product_name" || column === "price_gbp")) {
      errors.push({
        row: 1,
        field: column,
        message: `Missing required column "${column}".`,
      });
    }
  }

  for (const name of indexByColumn.keys()) {
    if (!(CSV_COLUMNS as readonly string[]).includes(name)) {
      errors.push({
        row: 1,
        field: name,
        message: `Unknown column "${name}". Use the TradeFlow template columns.`,
      });
    }
  }

  if (errors.length > 0) {
    return { products: [], errors, rowCount: Math.max(0, rows.length - 1) };
  }

  const groups = new Map<string, ProductGroup>();
  let dataRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i]!;
    if (emptyRow(raw)) continue;
    dataRows += 1;
    const rowNumber = i + 1;
    const name = cell(raw, indexByColumn.get("product_name"));
    const description = cell(raw, indexByColumn.get("description"));
    const priceRaw = cell(raw, indexByColumn.get("price_gbp"));
    const photoRaw = cell(raw, indexByColumn.get("photo_url"));
    const activeRaw = cell(raw, indexByColumn.get("active"));
    const variantLabelRaw = cell(raw, indexByColumn.get("variant_label"));
    const stockRaw = cell(raw, indexByColumn.get("stock_quantity"));
    const thresholdRaw = cell(raw, indexByColumn.get("low_stock_threshold"));
    const weightRaw = cell(raw, indexByColumn.get("weight_grams"));

    if (!name) {
      errors.push({
        row: rowNumber,
        field: "product_name",
        message: "product_name is required.",
      });
      continue;
    }

    if (!priceRaw) {
      errors.push({
        row: rowNumber,
        field: "price_gbp",
        message: "price_gbp is required.",
      });
    }
    const pricePence = priceRaw ? poundsToPence(priceRaw) : null;
    if (priceRaw && (pricePence === null || pricePence < 0)) {
      errors.push({
        row: rowNumber,
        field: "price_gbp",
        message: `price_gbp must be a pound amount such as 12.00 (got "${priceRaw}").`,
      });
    }

    const active = parseActive(activeRaw, rowNumber);
    if (active.error) errors.push(active.error);

    const photo = parsePhotoUrl(photoRaw, rowNumber);
    if (photo.error) errors.push(photo.error);

    const stock = parseNonNegativeInt(stockRaw, rowNumber, "stock_quantity");
    if (stock.error) errors.push(stock.error);

    const threshold = parseNonNegativeInt(
      thresholdRaw,
      rowNumber,
      "low_stock_threshold",
    );
    if (threshold.error) errors.push(threshold.error);

    const weight = parsePositiveInt(weightRaw, rowNumber, "weight_grams");
    if (weight.error) errors.push(weight.error);

    const key = name.toLowerCase();
    if (existing.has(key)) {
      errors.push({
        row: rowNumber,
        field: "product_name",
        message: `A product named "${name}" already exists in this shop. CSV import creates new products only.`,
      });
    }

    const rowHadError =
      !priceRaw ||
      pricePence === null ||
      pricePence < 0 ||
      Boolean(active.error) ||
      Boolean(photo.error) ||
      Boolean(stock.error) ||
      Boolean(threshold.error) ||
      Boolean(weight.error);

    const variantLabel = variantLabelRaw || "Standard";
    const trackInventory = stock.value != null;
    const variant: ParsedCatalogVariant = {
      label: variantLabel,
      stock_quantity: stock.value ?? 0,
      low_stock_threshold: threshold.value ?? options.defaultLowStockThreshold,
      track_inventory: trackInventory,
      weight_grams: weight.value ?? defaultWeight,
      sourceRows: [rowNumber],
    };

    const productFields = {
      name,
      description: description || null,
      price_pence: pricePence ?? -1,
      photo_url: photo.value,
      active: active.value ?? true,
    };

    if (rowHadError) continue;

    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ...productFields,
        sourceRows: [rowNumber],
        variants: [variant],
      });
      continue;
    }

    group.sourceRows.push(rowNumber);
    const conflicts: Array<{ field: string; message: string }> = [];
    if (!sameOptionalText(group.description, productFields.description)) {
      conflicts.push({
        field: "description",
        message: `Rows for "${name}" have conflicting description values.`,
      });
    }
    if (group.price_pence !== productFields.price_pence) {
      conflicts.push({
        field: "price_gbp",
        message: `Rows for "${name}" have conflicting prices.`,
      });
    }
    if (!sameOptionalText(group.photo_url, productFields.photo_url)) {
      conflicts.push({
        field: "photo_url",
        message: `Rows for "${name}" have conflicting photo_url values.`,
      });
    }
    if (group.active !== productFields.active) {
      conflicts.push({
        field: "active",
        message: `Rows for "${name}" have conflicting active values.`,
      });
    }
    for (const conflict of conflicts) {
      errors.push({ row: rowNumber, field: conflict.field, message: conflict.message });
    }

    const duplicateVariant = group.variants.find(
      (entry) => (entry.label ?? "").toLowerCase() === variantLabel.toLowerCase(),
    );
    if (duplicateVariant) {
      errors.push({
        row: rowNumber,
        field: "variant_label",
        message: `Duplicate variant "${variantLabel}" for "${name}" (also on row ${duplicateVariant.sourceRows[0]}).`,
      });
    } else {
      group.variants.push(variant);
    }
  }

  if (dataRows === 0 && errors.length === 0) {
    errors.push({
      row: 1,
      field: "file",
      message: "The file has a header but no product rows.",
    });
  }

  const products: ParsedCatalogProduct[] = [...groups.values()].map((group) => ({
    name: group.name,
    description: group.description,
    price_pence: group.price_pence,
    photo_url: group.photo_url,
    active: group.active,
    variants: group.variants,
    sourceRows: group.sourceRows,
  }));

  return { products, errors, rowCount: dataRows };
}

export function toCreateInputs(
  products: ParsedCatalogProduct[],
  businessId: string,
): NewProductInput[] {
  return products.map((product) => ({
    businessId,
    name: product.name,
    description: product.description,
    price_pence: product.price_pence,
    photo_url: product.photo_url,
    active: product.active,
    variants: product.variants.map((variant) => ({
      label: variant.label,
      stock_quantity: variant.stock_quantity,
      low_stock_threshold: variant.low_stock_threshold,
      track_inventory: variant.track_inventory,
      weight_grams: variant.weight_grams,
    })),
  }));
}
