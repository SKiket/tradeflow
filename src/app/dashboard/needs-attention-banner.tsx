import Link from "next/link";

export type NeedsAttentionItem = {
  kind: "dispute" | "fraud" | "complaint";
  href: string;
  label: string;
};

export function NeedsAttentionBanner({ items }: { items: NeedsAttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <div
      role="status"
      className="border-b border-sky-800/30 bg-sky-50 px-4 py-3 text-sky-950 md:px-6"
    >
      <p className="text-sm font-semibold">Needs attention</p>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((item) => (
          <li key={`${item.kind}-${item.href}-${item.label}`}>
            <Link
              href={item.href}
              className="underline-offset-2 hover:underline"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
