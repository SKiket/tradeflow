/**
 * Deterministic payment-complaint phrase list (EN + FR).
 * Easy to extend — keep lowercase; matching is case-insensitive substring.
 * False positives only flag urgent + calm fixed reply (never promise a refund).
 */

export const PAYMENT_COMPLAINT_PHRASES_EN: readonly string[] = [
  "chargeback",
  "charge back",
  "dispute the payment",
  "dispute my payment",
  "dispute this payment",
  "report to my bank",
  "report it to my bank",
  "my bank",
  "scam",
  "fraud",
  "stolen",
  "i want my money back",
  "want my money back",
  "unauthorized payment",
  "unauthorised payment",
  "did not authorise",
  "did not authorize",
  "cancel the payment",
];

export const PAYMENT_COMPLAINT_PHRASES_FR: readonly string[] = [
  "rétrofacturation",
  "retrofacturation",
  "contester le paiement",
  "conteste le paiement",
  "ma banque",
  "à ma banque",
  "a ma banque",
  "arnaque",
  "fraude",
  "volé",
  "vole",
  "je veux être remboursé",
  "je veux etre rembourse",
  "je veux mon argent",
  "remboursez-moi",
  "remboursez moi",
  "paiement non autorisé",
  "paiement non autorise",
];

export const PAYMENT_COMPLAINT_PHRASES: readonly string[] = [
  ...PAYMENT_COMPLAINT_PHRASES_EN,
  ...PAYMENT_COMPLAINT_PHRASES_FR,
];

export function detectPaymentComplaint(text: string): boolean {
  const normalised = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return false;
  return PAYMENT_COMPLAINT_PHRASES.some((phrase) => {
    const p = phrase
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    return normalised.includes(p);
  });
}

/** Fixed buyer reply — never promise or imply a refund; never argue. */
export const COMPLAINT_BUYER_REPLY = {
  en: "Thank you for your message. The seller has been alerted and will contact you shortly.",
  fr: "Merci pour votre message. Le vendeur a été alerté et vous contactera sous peu.",
} as const;
