export function PoweredByTradeFlow() {
  return (
    <p className="flex items-center justify-center gap-2 py-8 text-[11px] font-medium uppercase tracking-[0.22em] text-[color:var(--tf-text-muted)]">
      <span>Powered by</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/tradeflow-wordmark-navy.svg"
        alt="TradeFlow"
        className="h-3.5 w-auto opacity-70"
      />
    </p>
  );
}
