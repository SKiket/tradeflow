import type { MessageId, SupportedLang } from "@/lib/i18n/types";

/**
 * Fixed buyer-facing WhatsApp copy. Variables ({name}) are inserted unchanged.
 * Product names, prices (£), order refs, URLs, carriers, and tracking numbers
 * must never be translated by callers — pass them in as vars.
 */
export const MESSAGES: Record<MessageId, Record<SupportedLang, string>> = {
  "draft.confirmation": {
    en: "Here's your draft order:\n{items}\n\nTotal: {total}\n\nReply YES to confirm and pay, or tell us what to change.",
    fr: "Voici le brouillon de votre commande :\n{items}\n\nTotal : {total}\n\nRépondez OUI pour confirmer et payer, ou dites-nous ce qu'il faut modifier.",
  },
  "draft.clarification_unsure": {
    en: "Sorry — I wasn't sure which items you wanted. Could you tell me the product name and size/colour again?",
    fr: "Désolé — je n'étais pas sûr des articles souhaités. Pouvez-vous me redonner le nom du produit et la taille/couleur ?",
  },
  "draft.clarification_need_detail": {
    en: "I need a bit more detail before I can prepare that order — which product and size/colour did you want?",
    fr: "J'ai besoin d'un peu plus de détails avant de préparer cette commande — quel produit et quelle taille/couleur souhaitez-vous ?",
  },
  "draft.clarification_low_confidence": {
    en: "I wasn't confident enough to prepare that order. Could you rephrase the items you want?",
    fr: "Je n'étais pas assez sûr pour préparer cette commande. Pouvez-vous reformuler les articles souhaités ?",
  },
  "draft.clarification_unmatched": {
    en: 'I couldn\'t match "{query}" to anything in our catalogue. Which product did you mean?',
    fr: "Je n'ai pas pu associer « {query} » à un article de notre catalogue. De quel produit s'agit-il ?",
  },
  "draft.clarification_confirm_product": {
    en: 'I wasn\'t sure about "{query}". Could you confirm the exact product name?',
    fr: "Je n'étais pas sûr pour « {query} ». Pouvez-vous confirmer le nom exact du produit ?",
  },
  "draft.clarification_not_in_catalogue": {
    en: 'I couldn\'t find "{query}" in our catalogue right now. Could you pick something else?',
    fr: "Je n'ai pas trouvé « {query} » dans notre catalogue pour le moment. Pouvez-vous choisir autre chose ?",
  },
  "draft.clarification_which_option": {
    en: "Which option of {product} did you want ({options})?",
    fr: "Quelle option de {product} souhaitez-vous ({options}) ?",
  },
  "draft.clarification_no_option": {
    en: "I couldn't resolve a purchasable option for {product}.",
    fr: "Je n'ai pas pu trouver d'option achetable pour {product}.",
  },
  "draft.stock_shortage": {
    en: "Sorry — we don't have enough stock for that order right now:\n{details}\n\nWant a smaller quantity, or a different item?",
    fr: "Désolé — nous n'avons pas assez de stock pour cette commande pour le moment :\n{details}\n\nSouhaitez-vous une quantité plus petite, ou un autre article ?",
  },
  "draft.stock_out": {
    en: "• {name} is out of stock",
    fr: "• {name} est en rupture de stock",
  },
  "draft.stock_partial": {
    en: "• {name}: only {available} left (you asked for {requested})",
    fr: "• {name} : il n'en reste que {available} (vous en avez demandé {requested})",
  },
  "draft.stock_shortage_footer": {
    en: "Want a smaller quantity, or a different item?",
    fr: "Souhaitez-vous une quantité plus petite, ou un autre article ?",
  },
  "confirm.stock_unavailable": {
    en: "Sorry — we no longer have enough stock to fulfil that order. Nothing has been charged. Want to try a different item or quantity?",
    fr: "Désolé — nous n'avons plus assez de stock pour honorer cette commande. Aucun montant n'a été débité. Souhaitez-vous essayer un autre article ou une autre quantité ?",
  },
  "confirm.payment_link": {
    en: "Great — here's your secure payment link: {url} — valid for {hours} hours.",
    fr: "Parfait — voici votre lien de paiement sécurisé : {url} — valable {hours} heures.",
  },
  "confirm.draft_cancelled": {
    en: "No problem — I've cancelled that draft order. Just message us anytime if you'd like to order something else.",
    fr: "Pas de souci — j'ai annulé ce brouillon de commande. Écrivez-nous quand vous voulez pour commander autre chose.",
  },
  "confirm.awaiting_payment_cancelled": {
    en: "No problem — I've cancelled that order. The payment link is no longer valid. Message us anytime if you'd like to order something else.",
    fr: "Pas de souci — j'ai annulé cette commande. Le lien de paiement n'est plus valable. Écrivez-nous quand vous voulez pour commander autre chose.",
  },
  "confirm.payment_auto_cancelled": {
    en: "Your order has been cancelled because we didn't receive payment in time. The payment link is no longer valid. Message us anytime if you'd like to order again.",
    fr: "Votre commande a été annulée car nous n'avons pas reçu le paiement à temps. Le lien de paiement n'est plus valable. Écrivez-nous quand vous voulez pour commander à nouveau.",
  },
  "chase.reminder_12h_with_url": {
    en: "Just a reminder — here's your secure payment link: {url} — still valid.",
    fr: "Petit rappel — voici votre lien de paiement sécurisé : {url} — toujours valable.",
  },
  "chase.reminder_12h_no_url": {
    en: "Just a reminder — we haven't received payment for order {orderRef} yet. Reply here if you'd still like to complete it.",
    fr: "Petit rappel — nous n'avons pas encore reçu le paiement pour la commande {orderRef}. Répondez ici si vous souhaitez toujours la finaliser.",
  },
  "chase.reminder_23h_with_url": {
    en: "Final reminder — your order {orderRef} will be cancelled in about an hour if we don't receive payment. Here's your secure payment link: {url} — still valid.",
    fr: "Dernier rappel — votre commande {orderRef} sera annulée dans environ une heure si nous ne recevons pas le paiement. Voici votre lien de paiement sécurisé : {url} — toujours valable.",
  },
  "chase.reminder_23h_no_url": {
    en: "Final reminder — your order {orderRef} will be cancelled in about an hour if we don't receive payment. Reply here if you'd still like to complete it.",
    fr: "Dernier rappel — votre commande {orderRef} sera annulée dans environ une heure si nous ne recevons pas le paiement. Répondez ici si vous souhaitez toujours la finaliser.",
  },
  "chase.reminder_url_fallback": {
    en: "reply to this chat to complete payment",
    fr: "répondez à ce message pour finaliser le paiement",
  },
  "fulfil.payment_received": {
    en: "Payment received! Your order {orderRef} is confirmed.\nTotal: {total}.\n\nTrack your order: {url}\nWe'll be in touch about dispatch. Thanks for your order!",
    fr: "Paiement reçu ! Votre commande {orderRef} est confirmée.\nTotal : {total}.\n\nSuivez votre commande : {url}\nNous vous recontacterons pour l'expédition. Merci pour votre commande !",
  },
  "fulfil.payment_failed": {
    en: "Sorry — your payment for order {orderRef} didn't go through. We've released the items back to stock. Reply anytime if you'd like to order again.",
    fr: "Désolé — le paiement pour la commande {orderRef} n'a pas abouti. Nous avons remis les articles en stock. Répondez quand vous voulez pour commander à nouveau.",
  },
  "dispatch.dispatched": {
    en: "Your order {orderRef} has been dispatched!",
    fr: "Votre commande {orderRef} a été expédiée !",
  },
  "dispatch.carrier": {
    en: "Carrier: {carrier}",
    fr: "Transporteur : {carrier}",
  },
  "dispatch.tracking": {
    en: "Tracking: {trackingNumber}",
    fr: "Suivi : {trackingNumber}",
  },
  "dispatch.track_order": {
    en: "Track your order: {url}",
    fr: "Suivez votre commande : {url}",
  },
  "dispatch.on_its_way": {
    en: "It's on its way to you!",
    fr: "Elle est en route vers vous !",
  },
  "deliver.delivered": {
    en: "Your order {orderRef} has been delivered!",
    fr: "Votre commande {orderRef} a été livrée !",
  },
  "deliver.enjoy": {
    en: "Enjoy — thanks for shopping with us!",
    fr: "Profitez-en — merci d'avoir commandé chez nous !",
  },
  "deliver.track_manage": {
    en: "Track or manage your order: {url}",
    fr: "Suivez ou gérez votre commande : {url}",
  },
  "refund.full": {
    en: "A full refund of {amount} has been processed for order {orderRef}.",
    fr: "Un remboursement intégral de {amount} a été effectué pour la commande {orderRef}.",
  },
  "refund.partial": {
    en: "A partial refund of {amount} has been processed for order {orderRef}.",
    fr: "Un remboursement partiel de {amount} a été effectué pour la commande {orderRef}.",
  },
  "refund.reason": {
    en: "Reason: {reason}",
    fr: "Motif : {reason}",
  },
  "refund.timing": {
    en: "The refund should appear in your account within a few business days.",
    fr: "Le remboursement devrait apparaître sur votre compte sous quelques jours ouvrés.",
  },
  "return_reason.wrong_size": {
    en: "wrong size",
    fr: "mauvaise taille",
  },
  "return_reason.damaged_faulty": {
    en: "item arrived damaged",
    fr: "article arrivé endommagé",
  },
  "return_reason.changed_mind": {
    en: "changed mind",
    fr: "changement d'avis",
  },
  "return_reason.not_as_described": {
    en: "not as described",
    fr: "ne correspond pas à la description",
  },
  "return_reason.arrived_late": {
    en: "arrived late",
    fr: "arrivé en retard",
  },
  "return_reason.other": {
    en: "other",
    fr: "autre",
  },
  "return.approved": {
    en: "Your return for order {orderRef} has been approved.\n\nPlease print your return slip: {slipUrl}\n\nYou're responsible for return postage — the slip has the return address.",
    fr: "Votre retour pour la commande {orderRef} a été approuvé.\n\nVeuillez imprimer votre bon de retour : {slipUrl}\n\nLes frais de retour sont à votre charge — l'adresse de retour figure sur le bon.",
  },
  "return.requested": {
    en: "Got it — return requested for order {orderRef}, reason: {reason}. We'll let you know once the seller's reviewed it.",
    fr: "C'est noté — retour demandé pour la commande {orderRef}, motif : {reason}. Nous vous tiendrons au courant dès que le vendeur l'aura examiné.",
  },
  "return.not_delivered_with_status": {
    en: "A return can only be requested after the order has been delivered. Order {orderRef} is currently {status}, so I can't start a return yet.",
    fr: "Un retour ne peut être demandé qu'après la livraison de la commande. La commande {orderRef} est actuellement {status}, je ne peux donc pas encore démarrer un retour.",
  },
  "return.not_delivered": {
    en: "A return can only be requested after an order has been delivered. I can't start a return for you yet.",
    fr: "Un retour ne peut être demandé qu'après la livraison d'une commande. Je ne peux pas encore démarrer un retour pour vous.",
  },
  "return.already_requested": {
    en: "A return has already been requested for order {orderRef}. The seller is still reviewing it.",
    fr: "Un retour a déjà été demandé pour la commande {orderRef}. Le vendeur est encore en train de l'examiner.",
  },
  "return.already_approved": {
    en: "A return for order {orderRef} has already been approved. Print your return slip from the tracking page to send it back.",
    fr: "Un retour pour la commande {orderRef} a déjà été approuvé. Imprimez votre bon de retour depuis la page de suivi pour le renvoyer.",
  },
  "return.declined": {
    en: "The return request for order {orderRef} was declined.",
    fr: "La demande de retour pour la commande {orderRef} a été refusée.",
  },
  "return.already_returned": {
    en: "Order {orderRef} has already been marked as returned.",
    fr: "La commande {orderRef} a déjà été marquée comme retournée.",
  },
  "return.already_started": {
    en: "A return has already been started for order {orderRef}.",
    fr: "Un retour a déjà été démarré pour la commande {orderRef}.",
  },
  "return.which_order": {
    en: "Which order would you like to return? {orderRefs}",
    fr: "Quelle commande souhaitez-vous retourner ? {orderRefs}",
  },
  "return.not_approved": {
    en: "Your return for order {orderRef} wasn't approved.",
    fr: "Votre retour pour la commande {orderRef} n'a pas été approuvé.",
  },
  "support.other_fallback": {
    en: "Sorry, I didn't quite catch that — did you want to place an order, or is there something else I can help with?",
    fr: "Désolé, je n'ai pas bien compris — souhaitiez-vous passer une commande, ou y a-t-il autre chose que je puisse faire ?",
  },
  "support.processing_apology": {
    en: "Sorry, something went wrong on our side — the seller has been notified",
    fr: "Désolé, quelque chose a mal tourné de notre côté — le vendeur a été informé",
  },
  "billing.shop_unavailable": {
    en: "This shop isn't currently taking new orders. If you already have an order with us, we'll still fulfil it. Please try again later.",
    fr: "Cette boutique n'accepte pas de nouvelles commandes pour le moment. Si vous avez déjà une commande chez nous, nous l'honorerons quand même. Veuillez réessayer plus tard.",
  },
  "billing.shop_closed": {
    en: "This shop has closed.",
    fr: "Cette boutique a fermé.",
  },
  "voice.too_long": {
    en: "That voice note is a bit long for me — could you send a shorter one or type your order?",
    fr: "Ce message vocal est un peu long pour moi — pouvez-vous en envoyer un plus court ou taper votre commande ?",
  },
  "voice.unclear": {
    en: "Sorry — I couldn't make out that voice note. Could you send it again, or type your order?",
    fr: "Désolé — je n'ai pas compris ce message vocal. Pouvez-vous le renvoyer, ou taper votre commande ?",
  },
  "voice.heard_prefix": {
    en: 'I heard: "{transcript}" — ',
    fr: 'J\'ai entendu : « {transcript} » — ',
  },
};
