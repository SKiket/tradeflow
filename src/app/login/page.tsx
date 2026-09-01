import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">TradeFlow</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with a magic link — no password required.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            That link may have expired or been opened in a different browser —
            request a new one.
          </p>
        ) : null}
        <LoginForm />
      </div>
    </main>
  );
}
