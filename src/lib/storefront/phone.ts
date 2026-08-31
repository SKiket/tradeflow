const E164_RE = /^\+[1-9]\d{6,14}$/;

export type ParsedBuyerPhone =
  | { ok: true; e164: string }
  | { ok: false; error: string };

/**
 * Normalise a buyer-typed phone into E.164 for WhatsApp notifications.
 * Accepts +E.164, 00-prefix, UK 07… mobiles, and bare country-code digits.
 */
export function parseBuyerPhone(raw: string): ParsedBuyerPhone {
  let value = raw.trim().replace(/[\s().-]/g, "");
  if (!value) {
    return {
      ok: false,
      error: "Enter a WhatsApp-capable phone number.",
    };
  }

  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }
  if (/^07\d{9}$/.test(value)) {
    value = `+44${value.slice(1)}`;
  }
  if (/^447\d{9}$/.test(value)) {
    value = `+${value}`;
  }
  if (!value.startsWith("+") && /^\d{8,15}$/.test(value)) {
    value = `+${value}`;
  }

  if (!E164_RE.test(value)) {
    return {
      ok: false,
      error:
        "Enter a WhatsApp-capable phone number with country code, e.g. +447700900000.",
    };
  }

  return { ok: true, e164: value };
}
