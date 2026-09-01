/**
 * Magic-link email is opened in a different browser than /login (Mail/Gmail
 * in-app vs Safari/Chrome). PKCE needs a code_verifier cookie from the
 * originating browser; implicit puts tokens in the callback URL instead.
 *
 * `@supabase/ssr` still hardcodes `flowType: "pkce"` after spreading
 * `auth` options, so callers pass implicit here and then call
 * `forceImplicitFlow` on the created client.
 */
export const IMPLICIT_AUTH = {
  flowType: "implicit" as const,
  detectSessionInUrl: true,
};

export function forceImplicitFlow<T extends { auth: object }>(client: T): T {
  (client.auth as { flowType: string }).flowType = "implicit";
  return client;
}
