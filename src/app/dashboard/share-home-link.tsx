import Link from "next/link";

import { shareCopy } from "@/lib/dashboard/share-copy";

/** Quiet teaser on seller home — never inside Needs your attention. */
export function ShareHomeLink({ lang }: { lang: string | null }) {
  const copy = shareCopy(lang);
  return (
    <p className="text-sm text-muted-foreground" data-tf-share-home>
      <Link
        href="/dashboard/share"
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {copy.homeLink}
      </Link>
    </p>
  );
}
