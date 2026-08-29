/** Available sellable units: on-hand minus the current unpaid hold. */
export function availableQuantity(
  stockQuantity: number | null | undefined,
  reservedQuantity: number | null | undefined,
): number {
  return Math.max(0, (stockQuantity ?? 0) - (reservedQuantity ?? 0));
}

export function isVariantLowStock(variant: {
  track_inventory: boolean | null;
  stock_quantity: number | null;
  reserved_quantity: number | null;
  low_stock_threshold: number | null;
}): boolean {
  if (!variant.track_inventory) return false;
  return (
    availableQuantity(variant.stock_quantity, variant.reserved_quantity) <=
    (variant.low_stock_threshold ?? 0)
  );
}
