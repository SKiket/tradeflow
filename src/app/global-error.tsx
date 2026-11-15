"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          padding: "2rem",
          color: "#111",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
          Something went wrong
        </h1>
        <p style={{ color: "#555", marginBottom: "1rem" }}>
          Please refresh the page. If the problem continues, try again later.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            border: "1px solid #ccc",
            borderRadius: 8,
            padding: "0.5rem 0.75rem",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
