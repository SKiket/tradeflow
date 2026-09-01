/** Direction 5 motif: two overlapping outline rings as decorative art. */
export function NodesRingMotif({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 90 90"
      className={`tf-nodes-ring ${className ?? "h-[70%] w-[70%]"}`}
      aria-hidden
    >
      <circle cx="32" cy="45" r="26" fill="none" strokeWidth="5" />
      <circle cx="58" cy="45" r="26" fill="none" strokeWidth="5" />
    </svg>
  );
}
