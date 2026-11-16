export const ALLERGENS_STATUSES = [
  "not_provided",
  "none_declared",
  "listed",
] as const;

export type AllergensStatus = (typeof ALLERGENS_STATUSES)[number];

export type FaqItem = {
  question: string;
  answer: string;
};

export const PRODUCT_FAQ_MAX = 10;
export const SHOP_FAQ_MAX = 20;
export const FAQ_FIELD_MAX = 500;
export const KNOWLEDGE_FIELD_MAX = 2000;
export const DELIVERY_INFO_MAX = 1000;
export const GAP_QUESTION_MAX = 300;
export const PRODUCT_DESCRIBE_DAILY_LIMIT = 20;

export type ProductKnowledgeFields = {
  usage_instructions: string | null;
  ingredients: string | null;
  storage_and_care: string | null;
  size_and_fit: string | null;
  allergens_text: string | null;
  allergens_status: AllergensStatus;
  product_faqs: FaqItem[];
};

export type ShopKnowledgeFields = {
  shop_faq: FaqItem[];
  delivery_info: string | null;
};
