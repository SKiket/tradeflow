import { ImageResponse } from "next/og";

export const contentType = "image/png";

export function GET() {
  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#122840",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 800,
            letterSpacing: -2,
            color: "#F5C518",
          }}
        >
          tradeflow
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 18,
            fontSize: 28,
            color: "#FFFFFF",
            opacity: 0.86,
          }}
        >
          Shop on WhatsApp
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
  response.headers.set(
    "Cache-Control",
    "public, max-age=86400, stale-while-revalidate=604800",
  );
  return response;
}
