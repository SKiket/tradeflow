/**
 * Code-side WhatsApp utility template definitions.
 * Bodies use Meta numbered variables {{1}}, {{2}}, … — never first/last token,
 * never adjacent. Values must not contain newlines or tabs at send time.
 * Wording mirrors lib/i18n/messages.ts free-form copy where applicable.
 */

export type TemplateLanguage = "en" | "fr";

export type TemplateKey =
  | "order_dispatched"
  | "order_delivered"
  | "refund_processed"
  | "payment_reminder"
  | "order_auto_cancelled"
  | "return_approved"
  | "return_declined"
  | "order_confirmation_needed"
  | "seller_new_order"
  | "seller_refund_failed"
  | "seller_low_stock"
  | "seller_needs_attention"
  | "seller_delivery_issue"
  | "seller_dispute_opened"
  | "seller_dispute_closed"
  | "seller_dispute_reminder"
  | "seller_dispute_charge"
  | "seller_fraud_warning";

export interface TemplateVariableDef {
  /** Logical name used by callers (mapped to {{n}} by position). */
  name: string;
  /** Sample for Twilio Content Template Builder / Meta review. */
  sample: string;
}

export interface TemplateDefinition {
  key: TemplateKey;
  category: "utility";
  variables: TemplateVariableDef[];
  bodies: Record<TemplateLanguage, string>;
}

export const TEMPLATE_REGISTRY: readonly TemplateDefinition[] = [
  {
    key: "order_dispatched",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "carrier", sample: "Royal Mail" },
      { name: "trackingNumber", sample: "AB123456789GB" },
      {
        name: "url",
        sample: "https://tradeflow-tau-blush.vercel.app/t/TF-ABC123",
      },
    ],
    bodies: {
      en: "Your order {{1}} has been dispatched via {{2}}. Tracking number: {{3}}. You can follow it at {{4}}. It is on its way.",
      fr: "Votre commande {{1}} a été expédiée via {{2}}. Numéro de suivi : {{3}}. Vous pouvez la suivre sur {{4}}. Elle est en route.",
    },
  },
  {
    key: "order_delivered",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      {
        name: "url",
        sample: "https://tradeflow-tau-blush.vercel.app/t/TF-ABC123",
      },
    ],
    bodies: {
      en: "Your order {{1}} has been delivered. Tracking details are available at {{2}}. Thank you for your order.",
      fr: "Votre commande {{1}} a été livrée. Le suivi est disponible sur {{2}}. Merci pour votre commande.",
    },
  },
  {
    key: "refund_processed",
    category: "utility",
    variables: [
      { name: "amount", sample: "£24.99" },
      { name: "orderRef", sample: "TF-ABC123" },
    ],
    bodies: {
      en: "A refund of {{1}} has been processed for order {{2}}. The refund should appear in your account within a few business days.",
      fr: "Un remboursement de {{1}} a été effectué pour la commande {{2}}. Il devrait apparaître sur votre compte dans quelques jours ouvrés.",
    },
  },
  {
    key: "payment_reminder",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "url", sample: "https://pay.stripe.com/example" },
    ],
    bodies: {
      en: "Reminder — payment for order {{1}} is still outstanding. Your secure payment link {{2}} is still valid.",
      fr: "Rappel — le paiement pour la commande {{1}} est encore en attente. Votre lien de paiement sécurisé {{2}} est toujours valable.",
    },
  },
  {
    key: "order_auto_cancelled",
    category: "utility",
    variables: [{ name: "orderRef", sample: "TF-ABC123" }],
    bodies: {
      en: "Your order {{1}} has been cancelled because payment was not received in time, and its payment link is no longer valid. Reply here if you would like to place a new order.",
      fr: "Votre commande {{1}} a été annulée car le paiement n'a pas été reçu à temps, et son lien de paiement n'est plus valable. Répondez ici si vous souhaitez passer une nouvelle commande.",
    },
  },
  {
    key: "return_approved",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      {
        name: "url",
        sample:
          "https://tradeflow-tau-blush.vercel.app/t/TF-ABC123/return-slip",
      },
    ],
    bodies: {
      en: "Your return request for order {{1}} has been approved. You can find your return instructions at {{2}}. Reply here if you need help.",
      fr: "Votre demande de retour pour la commande {{1}} a été approuvée. Vous trouverez les instructions de retour sur {{2}}. Répondez ici si vous avez besoin d'aide.",
    },
  },
  {
    key: "return_declined",
    category: "utility",
    variables: [{ name: "orderRef", sample: "TF-ABC123" }],
    bodies: {
      en: "Your return request for order {{1}} could not be approved. Reply here and the seller will explain and help with next steps.",
      fr: "Votre demande de retour pour la commande {{1}} n'a pas pu être approuvée. Répondez ici et le vendeur vous expliquera la suite.",
    },
  },
  {
    key: "order_confirmation_needed",
    category: "utility",
    variables: [
      { name: "items", sample: "2× Blue Mug, 1× Red Hat" },
      { name: "total", sample: "£34.50" },
    ],
    bodies: {
      en: "Here is your draft order: {{1}}. Total: {{2}}. Reply YES to confirm and pay, or tell us what to change.",
      fr: "Voici le brouillon de votre commande : {{1}}. Total : {{2}}. Répondez OUI pour confirmer et payer, ou dites-nous ce qu'il faut modifier.",
    },
  },
  {
    key: "seller_new_order",
    category: "utility",
    variables: [
      { name: "ref", sample: "TF-ABC123" },
      { name: "buyer", sample: "+447700900123" },
      { name: "total", sample: "£34.50" },
    ],
    bodies: {
      en: "New order {{1}} from {{2}} for {{3}}. Open your TradeFlow dashboard to review it.",
      fr: "Nouvelle commande {{1}} de {{2}} pour {{3}}. Ouvrez votre tableau de bord TradeFlow pour la consulter.",
    },
  },
  {
    key: "seller_refund_failed",
    category: "utility",
    variables: [{ name: "ref", sample: "TF-ABC123" }],
    bodies: {
      en: "A refund for order {{1}} could not be completed. Please check the order in your TradeFlow dashboard.",
      fr: "Un remboursement pour la commande {{1}} n'a pas pu être effectué. Veuillez vérifier la commande dans votre tableau de bord TradeFlow.",
    },
  },
  {
    key: "seller_low_stock",
    category: "utility",
    variables: [
      { name: "product", sample: "Classic Blue Mug (Standard)" },
      { name: "count", sample: "2" },
    ],
    bodies: {
      en: "Stock is low for {{1}}: {{2}} left. Update your inventory in your TradeFlow dashboard.",
      fr: "Le stock est bas pour {{1}} : il reste {{2}}. Mettez à jour votre inventaire dans votre tableau de bord TradeFlow.",
    },
  },
  {
    key: "seller_needs_attention",
    category: "utility",
    variables: [
      { name: "buyer", sample: "+447700900123" },
      { name: "ref", sample: "TF-ABC123" },
    ],
    bodies: {
      en: "A buyer ({{1}}) needs your attention on order {{2}}. Open your TradeFlow inbox to reply.",
      fr: "Un acheteur ({{1}}) a besoin de votre attention concernant la commande {{2}}. Ouvrez votre boîte de réception TradeFlow pour répondre.",
    },
  },
  {
    key: "seller_delivery_issue",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      {
        name: "issue",
        sample: "returned to sender",
      },
    ],
    bodies: {
      en: "There is a delivery problem with order {{1}}: the carrier reports {{2}}. Open your TradeFlow dashboard for details.",
      fr: "Il y a un problème de livraison pour la commande {{1}} : le transporteur signale {{2}}. Ouvrez votre tableau de bord TradeFlow pour plus de détails.",
    },
  },
  {
    key: "seller_dispute_opened",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "deadlineDate", sample: "30 Nov 2026" },
    ],
    bodies: {
      en: "A customer has disputed the payment for order {{1}}. The response deadline is {{2}}. Open your TradeFlow dashboard to review and add details.",
      fr: "Un client a contesté le paiement de la commande {{1}}. La date limite de réponse est le {{2}}. Ouvrez votre tableau de bord TradeFlow pour vérifier et ajouter des détails.",
    },
  },
  {
    key: "seller_dispute_closed",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "outcome", sample: "won" },
    ],
    bodies: {
      en: "The payment dispute for order {{1}} has closed: you {{2}}. Open your TradeFlow dashboard for details.",
      fr: "Le litige de paiement pour la commande {{1}} est clos : {{2}}. Ouvrez votre tableau de bord TradeFlow pour plus de détails.",
    },
  },
  {
    key: "seller_dispute_reminder",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "deadlineDate", sample: "30 Nov 2026" },
    ],
    bodies: {
      en: "Reminder: your response to the payment dispute for order {{1}} is due by {{2}}. Contesting adds a £20 counter fee. Open your TradeFlow dashboard to confirm your evidence.",
      fr: "Rappel : votre réponse au litige de paiement pour la commande {{1}} est due pour le {{2}}. Contester ajoute des frais de contre-argument de 20 £. Ouvrez votre tableau de bord TradeFlow pour confirmer vos preuves.",
    },
  },
  {
    key: "seller_dispute_charge",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "amount", sample: "£45.00" },
      { name: "method", sample: "transfer, card" },
      { name: "owed", sample: "£0.00" },
    ],
    bodies: {
      en: "For the lost payment dispute on order {{1}}, we recovered {{2}} via {{3}} covering dispute fees and any unrecovered chargeback. Remaining owed: {{4}}. Open your TradeFlow dashboard for details.",
      fr: "Pour le litige de paiement perdu sur la commande {{1}}, nous avons récupéré {{2}} via {{3}} pour les frais de litige et tout rétrofacturation non récupérée. Reste dû : {{4}}. Ouvrez votre tableau de bord TradeFlow pour plus de détails.",
    },
  },
  {
    key: "seller_fraud_warning",
    category: "utility",
    variables: [{ name: "orderRef", sample: "TF-ABC123" }],
    bodies: {
      en: "A card network early fraud warning was raised for order {{1}}. Refunding now usually avoids a dispute fee. Open the order in your TradeFlow dashboard to decide.",
      fr: "Une alerte fraude précoce du réseau de cartes a été émise pour la commande {{1}}. Un remboursement maintenant évite souvent des frais de litige. Ouvrez la commande dans votre tableau de bord TradeFlow pour décider.",
    },
  },
] as const;

/** Keys removed from the registry; draft DB rows may be deleted by the seed. */
export const OBSOLETE_TEMPLATE_KEYS = ["return_update"] as const;

export function getTemplateDefinition(
  key: string,
): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY.find((t) => t.key === key);
}

/** Map named caller variables → Twilio ContentVariables {"1":"...","2":"..."}. */
export function toContentVariables(
  key: TemplateKey,
  named: Record<string, string>,
): Record<string, string> {
  const def = getTemplateDefinition(key);
  if (!def) return {};
  const out: Record<string, string> = {};
  def.variables.forEach((v, i) => {
    const raw = named[v.name] ?? "";
    out[String(i + 1)] = sanitiseTemplateValue(raw);
  });
  return out;
}

/** Meta forbids newlines/tabs inside variable values. */
export function sanitiseTemplateValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}
