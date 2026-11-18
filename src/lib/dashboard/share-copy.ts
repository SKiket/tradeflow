import type { SupportedLang } from "@/lib/i18n/types";
import { resolveLang } from "@/lib/i18n";

export type ShareCopy = {
  pageTitle: string;
  pageIntro: string;
  navLabel: string;
  homeLink: string;
  shopLinkHeading: string;
  copy: string;
  copied: string;
  share: string;
  qrHeading: string;
  downloadPng: string;
  printPoster: string;
  posterScanLine: string;
  whatsappHeading: string;
  orderOnWhatsApp: string;
  statusHeading: string;
  statusPlaceholder: string;
  shareOnWhatsApp: string;
  socialHeading: string;
  socialHint: string;
  noProductsTitle: string;
  noProductsBody: string;
  goToProducts: string;
  notLiveTitle: string;
  notLiveBody: string;
  ordersPausedReminder: string;
  orderPrefill: string;
  statusTemplate: (link: string) => string;
  socialBio: (link: string) => string;
};

const COPY: Record<SupportedLang, ShareCopy> = {
  en: {
    pageTitle: "Share your shop",
    pageIntro: "Copy a link, show a QR code, or post a short message — buyers browse and order from your shop page.",
    navLabel: "Share",
    homeLink: "Share your shop",
    shopLinkHeading: "Shop link",
    copy: "Copy",
    copied: "Copied",
    share: "Share",
    qrHeading: "QR code",
    downloadPng: "Download",
    printPoster: "Print poster",
    posterScanLine: "Scan to browse and order",
    whatsappHeading: "WhatsApp",
    orderOnWhatsApp: "Order on WhatsApp",
    statusHeading: "Ready-made status",
    statusPlaceholder: "Edit before you copy",
    shareOnWhatsApp: "Share on WhatsApp",
    socialHeading: "Social bio",
    socialHint: "One line for Instagram or Facebook",
    noProductsTitle: "Add a product first",
    noProductsBody: "Your shop link is ready once you have at least one active product.",
    goToProducts: "Go to Products",
    notLiveTitle: "Sharing is paused",
    notLiveBody: "This shop is closed or unavailable, so share tools are hidden for now.",
    ordersPausedReminder: "Your shop page is still shareable, but new orders are paused right now.",
    orderPrefill: "Hi, I'd like to order",
    statusTemplate: (link) => `New in the shop! Browse and order here: ${link}`,
    socialBio: (link) => `Shop with us → ${link}`,
  },
  fr: {
    pageTitle: "Partagez votre boutique",
    pageIntro: "Copiez un lien, affichez un QR code ou publiez un court message — les clients parcourent et commandent depuis votre page boutique.",
    navLabel: "Partager",
    homeLink: "Partagez votre boutique",
    shopLinkHeading: "Lien boutique",
    copy: "Copier",
    copied: "Copié",
    share: "Partager",
    qrHeading: "QR code",
    downloadPng: "Télécharger",
    printPoster: "Imprimer l'affiche",
    posterScanLine: "Scannez pour parcourir et commander",
    whatsappHeading: "WhatsApp",
    orderOnWhatsApp: "Commander sur WhatsApp",
    statusHeading: "Statut prêt à publier",
    statusPlaceholder: "Modifiez avant de copier",
    shareOnWhatsApp: "Partager sur WhatsApp",
    socialHeading: "Bio réseau social",
    socialHint: "Une ligne pour Instagram ou Facebook",
    noProductsTitle: "Ajoutez d'abord un produit",
    noProductsBody: "Votre lien boutique est prêt dès que vous avez au moins un produit actif.",
    goToProducts: "Aller aux produits",
    notLiveTitle: "Partage en pause",
    notLiveBody: "Cette boutique est fermée ou indisponible, les outils de partage sont masqués pour le moment.",
    ordersPausedReminder: "Votre page boutique reste partageable, mais les nouvelles commandes sont en pause.",
    orderPrefill: "Bonjour, je voudrais commander",
    statusTemplate: (link) => `Nouveautés en boutique ! Parcourez et commandez ici : ${link}`,
    socialBio: (link) => `Commandez chez nous → ${link}`,
  },
};

export function shareCopy(lang: string | null | undefined): ShareCopy {
  return COPY[resolveLang(lang)];
}

/** Poster line in both languages when seller language is unknown. */
export function posterScanLines(lang: string | null | undefined): string[] {
  const resolved = resolveLang(lang);
  if (resolved === "fr") {
    return [COPY.fr.posterScanLine, COPY.en.posterScanLine];
  }
  if (resolved === "en" && lang) {
    return [COPY.en.posterScanLine];
  }
  // No seller language configured — show both.
  return [COPY.en.posterScanLine, COPY.fr.posterScanLine];
}
