import { COPALLA_PRIVACY_URL, COPALLA_TERMS_URL } from "@/lib/legal";

export function LegalLinks({
  className,
  linkClassName,
}: {
  className?: string;
  linkClassName?: string;
}) {
  return (
    <p className={className}>
      <a
        href={COPALLA_PRIVACY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
      >
        Privacy
      </a>
      <span aria-hidden> · </span>
      <a
        href={COPALLA_TERMS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
      >
        Terms
      </a>
    </p>
  );
}

/** Understated footer pair, matching Powered by TradeFlow. */
export function StorefrontLegalFooter() {
  return (
    <LegalLinks
      className="pb-2 text-center text-[11px] text-[color:var(--tf-text-muted)]"
      linkClassName="underline-offset-2 hover:underline"
    />
  );
}
