/**
 * Typed errors for outbound WhatsApp sending.
 *
 * Callers can check `error instanceof WhatsAppNotConfiguredError` (or
 * `error.code === "WHATSAPP_NOT_CONFIGURED"`) rather than parsing message text.
 */
export class WhatsAppNotConfiguredError extends Error {
  readonly code = "WHATSAPP_NOT_CONFIGURED" as const;
  readonly businessId: string;

  constructor(businessId: string) {
    super(
      `Business ${businessId} has no WhatsApp number configured (whatsapp_phone_e164 is null). Connect WhatsApp before sending.`,
    );
    this.name = "WhatsAppNotConfiguredError";
    this.businessId = businessId;
  }
}

export class WhatsAppSendError extends Error {
  readonly code = "WHATSAPP_SEND_FAILED" as const;
  readonly twilioStatus?: number;
  readonly twilioCode?: number | string;

  constructor(
    message: string,
    opts?: { twilioStatus?: number; twilioCode?: number | string },
  ) {
    super(message);
    this.name = "WhatsAppSendError";
    this.twilioStatus = opts?.twilioStatus;
    this.twilioCode = opts?.twilioCode;
  }
}
