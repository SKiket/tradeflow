/**
 * Deploy / runtime guards shared by internal test routes and sim hooks.
 *
 * - Local (no VERCEL_ENV): test routes + sim hooks allowed.
 * - Any Vercel deploy (production / preview): test routes blocked unless
 *   ALLOW_TEST_ROUTES=true.
 * - Sim hooks are ignored only when VERCEL_ENV === 'production'.
 */

export function isVercelProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/** True on any Vercel-hosted deployment (production, preview, or development). */
export function isVercelDeployed(): boolean {
  return (
    process.env.VERCEL === "1" ||
    typeof process.env.VERCEL_ENV === "string" &&
      process.env.VERCEL_ENV.length > 0
  );
}

export function allowTestRoutes(): boolean {
  return process.env.ALLOW_TEST_ROUTES === "true";
}

/**
 * Whether /api/internal/test-* should return 404.
 * Local + verification: open. Deployed: closed unless ALLOW_TEST_ROUTES.
 */
export function shouldBlockTestRoutes(): boolean {
  if (allowTestRoutes()) return false;
  if (isVercelProduction()) return true;
  if (isVercelDeployed()) return true;
  return false;
}

/**
 * Whether TWILIO_* / INBOUND_* simulate hooks may run.
 * Always false in Vercel production, even if the env var is set by mistake.
 */
export function allowSimulationHooks(): boolean {
  return !isVercelProduction();
}

/** Log once per process when a sim hook is ignored in production. */
const warnedHooks = new Set<string>();

export function warnSimHookIgnoredInProduction(hookName: string): void {
  if (warnedHooks.has(hookName)) return;
  warnedHooks.add(hookName);
  console.warn(
    `[security] ${hookName} is set but ignored because VERCEL_ENV=production`,
  );
}
