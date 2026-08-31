const PRODUCTION_ORIGIN = "https://tradeflow-tau-blush.vercel.app";

export function publicAppOrigin(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return PRODUCTION_ORIGIN;
}

export function storefrontUrl(slug: string): string {
  return `${publicAppOrigin()}/s/${slug}`;
}
