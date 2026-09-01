"use client";

import { useEffect } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Implicit magic-link tokens arrive in the URL hash (`#access_token=...`),
 * which the server never sees. This page must run in the browser.
 */
export default function AuthCallbackPage() {
  useEffect(() => {
    let cancelled = false;

    async function completeSignIn() {
      const hashParams = new URLSearchParams(
        window.location.hash.replace(/^#/, ""),
      );
      const query = new URLSearchParams(window.location.search);
      const authError =
        query.get("error") ||
        query.get("error_description") ||
        hashParams.get("error") ||
        hashParams.get("error_description");

      if (authError) {
        console.error("[auth/callback]", authError);
        window.location.replace("/login?error=auth");
        return;
      }

      const supabase = createClient();
      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          console.error("[auth/callback] setSession", error.message);
          window.location.replace("/login?error=auth");
          return;
        }
      }

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (cancelled) return;

      if (sessionError || !session) {
        console.error(
          "[auth/callback] no session",
          sessionError?.message ?? "missing tokens",
        );
        window.location.replace("/login?error=auth");
        return;
      }

      window.location.replace("/dashboard");
    }

    void completeSignIn();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">Signing you in…</p>
    </main>
  );
}
