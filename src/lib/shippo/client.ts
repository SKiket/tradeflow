/**
 * Thin Shippo REST client (API version 2018-02-08).
 *
 * Parcel assumption: one 20×15×10 cm box (small padded mailer / shoe-box
 * scale). That size covers typical TradeFlow SKUs (mug, soap, tote,
 * sneakers). Weight is the real sum of variant weight_grams × quantity;
 * we do not shop box sizes or split multi-parcel shipments.
 */

const SHIPPO_BASE = "https://api.goshippo.com";
const SHIPPO_API_VERSION = "2018-02-08";

export const DEFAULT_WEIGHT_GRAMS = 200;

export const DEFAULT_PARCEL_CM = {
  length: "20",
  width: "15",
  height: "10",
} as const;

export class ShippoClientError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status = 400, payload?: unknown) {
    super(message);
    this.name = "ShippoClientError";
    this.status = status;
    this.payload = payload;
  }
}

export interface ShippoAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  zip: string;
  country: string;
  state?: string;
  phone?: string;
  email?: string;
  validate?: boolean;
}

export interface ShippoAddressValidation {
  is_valid?: boolean;
  messages?: Array<{ text?: string }>;
}

export interface ShippoRate {
  object_id: string;
  amount: string;
  currency: string;
  provider: string;
  servicelevel?: { name?: string; token?: string } | null;
  estimated_days?: number | null;
  duration_terms?: string | null;
}

export interface ShippoShipment {
  object_id: string;
  status?: string;
  rates?: ShippoRate[];
  messages?: Array<{ text?: string; source?: string }>;
  address_to?: {
    is_complete?: boolean;
    validation_results?: ShippoAddressValidation;
  };
  address_from?: {
    is_complete?: boolean;
    validation_results?: ShippoAddressValidation;
  };
}

export interface ShippoTransaction {
  object_id: string;
  status?: string;
  tracking_number?: string | null;
  tracking_url_provider?: string | null;
  label_url?: string | null;
  rate?: string | ShippoRate;
  messages?: Array<{ text?: string }>;
  test?: boolean;
}

function apiKey(): string {
  const key = process.env.SHIPPO_API_KEY?.trim();
  if (!key) {
    throw new ShippoClientError("Shipping is not configured (missing SHIPPO_API_KEY).");
  }
  return key;
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail.trim()) {
    return record.detail.trim();
  }
  const messages = record.messages;
  if (Array.isArray(messages)) {
    const texts = messages
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "text" in entry) {
          const text = (entry as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean);
    if (texts.length) return texts.join(" ");
  }
  return fallback;
}

async function shippoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SHIPPO_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `ShippoToken ${apiKey()}`,
      "Content-Type": "application/json",
      "Shippo-API-Version": SHIPPO_API_VERSION,
      ...(init?.headers ?? {}),
    },
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ShippoClientError(
      messageFromPayload(payload, `Shippo request failed (${response.status})`),
      response.status,
      payload,
    );
  }
  return payload as T;
}

export async function createShipment(params: {
  addressFrom: ShippoAddress;
  addressTo: ShippoAddress;
  weightGrams: number;
}): Promise<ShippoShipment> {
  const weight = Math.max(1, Math.round(params.weightGrams));
  return shippoFetch<ShippoShipment>("/shipments/", {
    method: "POST",
    body: JSON.stringify({
      address_from: params.addressFrom,
      address_to: params.addressTo,
      parcels: [
        {
          length: DEFAULT_PARCEL_CM.length,
          width: DEFAULT_PARCEL_CM.width,
          height: DEFAULT_PARCEL_CM.height,
          distance_unit: "cm",
          weight: String(weight),
          mass_unit: "g",
        },
      ],
      async: false,
    }),
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function purchaseLabel(rateObjectId: string): Promise<ShippoTransaction> {
  let transaction = await shippoFetch<ShippoTransaction>("/transactions/", {
    method: "POST",
    body: JSON.stringify({
      rate: rateObjectId,
      label_file_type: "PDF",
      async: false,
    }),
  });

  for (
    let attempt = 0;
    attempt < 10 &&
    (transaction.status === "QUEUED" || transaction.status === "WAITING") &&
    !transaction.tracking_number;
    attempt += 1
  ) {
    await sleep(700);
    transaction = await retrieveTransaction(transaction.object_id);
  }

  return transaction;
}

export async function retrieveTransaction(
  transactionId: string,
): Promise<ShippoTransaction> {
  return shippoFetch<ShippoTransaction>(`/transactions/${transactionId}`);
}
