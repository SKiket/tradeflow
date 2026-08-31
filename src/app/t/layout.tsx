export default function TrackingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-zinc-50 text-zinc-900 antialiased">
      {children}
    </div>
  );
}
