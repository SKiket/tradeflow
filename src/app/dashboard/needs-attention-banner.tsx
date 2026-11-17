/**
 * @deprecated Prefer SellerAttentionPanel on the home (orders) page.
 * Kept as a thin re-export so older imports keep type-checking during the cutover.
 */
export {
  SellerAttentionPanel as NeedsAttentionBanner,
} from "./seller-attention-panel";

export type { SellerAttentionItem as NeedsAttentionItem } from "@/lib/dashboard/seller-attention";
