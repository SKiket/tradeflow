import Link from "next/link";

import {
  performanceCopy,
  type PerformanceLang,
} from "@/lib/analytics/performance-copy";
import { formatPence } from "@/lib/orders/display";

/** Compact teaser on seller home when the shop has recent paid sales. */
export function PerformanceHomeLink({
  salesPence,
  lang,
}: {
  salesPence: number;
  lang: PerformanceLang;
}) {
  if (salesPence <= 0) return null;
  const copy = performanceCopy(lang);
  return (
    <p className="text-sm text-muted-foreground" data-tf-performance-home>
      {copy.homeTeaser(formatPence(salesPence))}{" "}
      <Link
        href="/dashboard/performance"
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {copy.seePerformance}
      </Link>
    </p>
  );
}
