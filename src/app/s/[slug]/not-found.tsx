export default function StoreNotFound() {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-20 text-center">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        TradeFlow
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Store not found
      </h1>
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        This link doesn&apos;t match a store. Check the URL and try again.
      </p>
    </main>
  );
}
