/**
 * Code-side WhatsApp utility template definitions.
 * Bodies use Meta numbered variables {{1}}, {{2}}, … — never first/last token,
 * never adjacent. Values must not contain newlines or tabs at send time.
 * Wording mirrors lib/i18n/messages.ts free-form copy.
 */

export type TemplateLanguage = "en" | "fr";

export type TemplateKey =
  | "order_dispatched"
  | "order_delivered"
  | "refund_processed"
  | "payment_reminder"
  | "order_auto_cancelled"
  | "return_update"
  | "order_confirmation_needed";

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
      { name: "url", sample: "https://tradeflow.app/t/TF-ABC123" },
    ],
    bodies: {
      en: "Your order {{1}} has been dispatched via {{2}}. Tracking number: {{3}}. Track your order at {{4}} — it is on its way!",
      fr: "Votre commande {{1}} a été expédiée via {{2}}. Numéro de suivi : {{3}}. Suivez votre commande sur {{4}} — elle est en route !",
    },
  },
  {
    key: "order_delivered",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      { name: "url", sample: "https://tradeflow.app/t/TF-ABC123" },
    ],
    bodies: {
      en: "Your order {{1}} has been delivered. Enjoy — thanks for shopping with us! Track or manage your order at {{2}} anytime.",
      fr: "Votre commande {{1}} a été livrée. Profitez-en — merci d'avoir commandé chez nous ! Suivez ou gérez votre commande sur {{2}} à tout moment.",
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
      fr: "Un remboursement de {{1}} a été effectué pour la commande {{2}}. Le remboursement devrait apparaître sur votre compte sous quelques jours ouvrés.",
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
    variables: [],
    bodies: {
      en: "Your order has been cancelled because we did not receive payment in time. The payment link is no longer valid. Message us anytime if you would like to order again.",
      fr: "Votre commande a été annulée car nous n'avons pas reçu le paiement à temps. Le lien de paiement n'est plus valable. Écrivez-nous quand vous voulez pour commander à nouveau.",
    },
  },
  {
    key: "return_update",
    category: "utility",
    variables: [
      { name: "orderRef", sample: "TF-ABC123" },
      {
        name: "detail",
        sample: "approved — print your return slip at https://tradeflow.app/t/TF-ABC123/return",
      },
    ],
    bodies: {
      en: "Update on your return for order {{1}}: {{2}}. Reply here if you need any further help.",
      fr: "Mise à jour concernant votre retour pour la commande {{1}} : {{2}}. Répondez ici si vous avez besoin d'aide.",
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
] as const;

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
