import { resolveLang } from "@/lib/i18n";
import type { SupportedLang } from "@/lib/i18n/types";

export type AssistUiCopy = {
  polish: string;
  suggest: string;
  useIt: string;
  keepMine: string;
  undo: string;
  checkDetails: string;
  pending: string;
  placeholderHint: string;
};

const COPY: Record<SupportedLang, AssistUiCopy> = {
  en: {
    polish: "Polish",
    suggest: "Suggest a reply",
    useIt: "Use it",
    keepMine: "Keep mine",
    undo: "Undo",
    checkDetails: "Check these details",
    pending: "Working…",
    placeholderHint:
      "Replace or remove every [placeholder] before sending.",
  },
  fr: {
    polish: "Peaufiner",
    suggest: "Suggérer une réponse",
    useIt: "Utiliser",
    keepMine: "Garder la mienne",
    undo: "Annuler",
    checkDetails: "Vérifiez ces détails",
    pending: "En cours…",
    placeholderHint:
      "Remplacez ou supprimez chaque [placeholder] avant d'envoyer.",
  },
};

export function assistUiCopy(lang: string | null | undefined): AssistUiCopy {
  return COPY[resolveLang(lang)];
}
