export default function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-[var(--tf-bg-page)] text-[var(--tf-text-primary)] antialiased">
      {children}
    </div>
  );
}
