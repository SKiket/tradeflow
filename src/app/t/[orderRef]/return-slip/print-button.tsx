"use client";

export function PrintSlipButton() {
  return (
    <button
      type="button"
      className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold"
      onClick={() => window.print()}
    >
      Print slip
    </button>
  );
}
