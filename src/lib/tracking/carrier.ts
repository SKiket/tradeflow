/**
 * Best-effort carrier tracking page. Unknown carriers get no URL — the
 * tracking number is still shown on the public page.
 */
const PATTERNS: Array<{
  test: RegExp;
  url: (trackingNumber: string) => string;
}> = [
  {
    test: /royal\s*mail/i,
    url: (n) =>
      `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`,
  },
  {
    test: /parcelforce/i,
    url: (n) =>
      `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(n)}`,
  },
  {
    test: /\bevri\b|\bhermes\b/i,
    url: (n) => `https://www.evri.com/track/parcel/${encodeURIComponent(n)}`,
  },
  {
    test: /\bdpd\b/i,
    url: (n) =>
      `https://track.dpd.co.uk/search?reference=${encodeURIComponent(n)}`,
  },
  {
    test: /\bups\b/i,
    url: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  },
  {
    test: /fedex/i,
    url: (n) =>
      `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
  {
    test: /\bdhl\b/i,
    url: (n) =>
      `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  },
  {
    test: /\busps\b|united\s*states\s*postal/i,
    url: (n) =>
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  },
  {
    test: /yodel/i,
    url: (n) => `https://www.yodel.co.uk/tracking/${encodeURIComponent(n)}`,
  },
];

export function carrierTrackingUrl(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  const number = trackingNumber?.trim();
  const name = carrier?.trim();
  if (!number || !name) return null;
  const match = PATTERNS.find((pattern) => pattern.test.test(name));
  return match ? match.url(number) : null;
}
