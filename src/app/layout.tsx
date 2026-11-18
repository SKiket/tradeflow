import type { Metadata } from "next";
import { DM_Sans, Syne } from "next/font/google";

import { publicAppOrigin } from "@/lib/storefront/url";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz"],
  variable: "--font-dm-sans",
  display: "swap",
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Arial",
    "sans-serif",
  ],
});

const syne = Syne({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-syne",
  display: "swap",
  fallback: ["Arial Black", "Impact", "sans-serif"],
});

export const metadata: Metadata = {
  metadataBase: new URL(publicAppOrigin()),
  title: "TradeFlow",
  description: "Sell on WhatsApp. Get paid. Stay in control.",
  icons: {
    icon: [
      {
        url: "/brand/tradeflow-app-icon-512.svg",
        type: "image/svg+xml",
      },
    ],
    apple: "/brand/tradeflow-app-icon-512.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${syne.variable} h-full antialiased`}
    >
      <body className={`${dmSans.className} min-h-full flex flex-col`}>
        {children}
      </body>
    </html>
  );
}
