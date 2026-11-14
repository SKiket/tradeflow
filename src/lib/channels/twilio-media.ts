/**
 * Server-side download of Twilio media URLs (HTTP Basic auth with
 * account SID + auth token). Audio bytes are held only in memory for
 * transcription — never written to Supabase storage.
 */

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_AUDIO_DURATION_SECONDS = 90;

export const VOICE_NOTE_TOO_LONG_MESSAGE =
  "That voice note is a bit long for me — could you send a shorter one or type your order?";

export const VOICE_NOTE_UNCLEAR_MESSAGE =
  "Sorry — I couldn't make out that voice note. Could you send it again, or type your order?";

export class TwilioMediaError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "download_failed"
      | "too_large"
      | "too_long",
  ) {
    super(message);
    this.name = "TwilioMediaError";
  }
}

export interface DownloadedTwilioMedia {
  buffer: Buffer;
  mimeType: string;
  byteLength: number;
  /** Duration in seconds when detectable from the container; otherwise null. */
  durationSeconds: number | null;
}

function twilioAuthHeader(): string {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new TwilioMediaError(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be configured",
      "not_configured",
    );
  }
  return "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

/**
 * Fetch a Twilio media URL with Basic auth. Enforces the 10 MB size limit
 * (Content-Length when present, then actual body length) and, when duration
 * can be read from an OGG container, the ~90s limit.
 */
export async function downloadTwilioMedia(params: {
  url: string;
  mimeType: string;
  signal?: AbortSignal;
}): Promise<DownloadedTwilioMedia> {
  const response = await fetch(params.url, {
    method: "GET",
    headers: { Authorization: twilioAuthHeader() },
    redirect: "follow",
    signal: params.signal,
  });

  if (!response.ok) {
    throw new TwilioMediaError(
      `Twilio media download failed (${response.status})`,
      "download_failed",
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      throw new TwilioMediaError(
        `Audio exceeds ${MAX_AUDIO_BYTES} byte limit`,
        "too_large",
      );
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new TwilioMediaError(
      `Audio exceeds ${MAX_AUDIO_BYTES} byte limit`,
      "too_large",
    );
  }

  const mimeType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ||
    params.mimeType;

  const durationSeconds = estimateAudioDurationSeconds(buffer, mimeType);
  if (
    durationSeconds !== null &&
    durationSeconds > MAX_AUDIO_DURATION_SECONDS
  ) {
    throw new TwilioMediaError(
      `Audio exceeds ${MAX_AUDIO_DURATION_SECONDS}s limit`,
      "too_long",
    );
  }

  return {
    buffer,
    mimeType,
    byteLength: buffer.byteLength,
    durationSeconds,
  };
}

/**
 * Best-effort duration from OGG (Opus/Vorbis) granule position.
 * Returns null when the container cannot be parsed — callers then rely on
 * size limits only.
 */
export function estimateAudioDurationSeconds(
  buffer: Buffer,
  mimeType: string,
): number | null {
  const mime = mimeType.toLowerCase();
  if (
    mime.includes("ogg") ||
    mime.includes("opus") ||
    mime === "audio/ogg" ||
    mime === "application/ogg"
  ) {
    return parseOggDurationSeconds(buffer);
  }
  return null;
}

/**
 * Scan Ogg pages for the highest granule position and Opus sample rate
 * (default 48000). Good enough for WhatsApp voice notes (Ogg/Opus).
 */
function parseOggDurationSeconds(buffer: Buffer): number | null {
  if (buffer.length < 27) return null;
  let offset = 0;
  let maxGranule = BigInt(0);
  let sampleRate = 48000;
  let foundPage = false;

  while (offset + 27 <= buffer.length) {
    if (buffer.toString("ascii", offset, offset + 4) !== "OggS") {
      offset += 1;
      continue;
    }

    const headerType = buffer[offset + 5];
    const granule = buffer.readBigUInt64LE(offset + 6);
    const pageSegments = buffer[offset + 26];
    const segmentTableEnd = offset + 27 + pageSegments;
    if (segmentTableEnd > buffer.length) break;

    let bodySize = 0;
    for (let i = 0; i < pageSegments; i += 1) {
      bodySize += buffer[offset + 27 + i];
    }
    const bodyStart = segmentTableEnd;
    const bodyEnd = bodyStart + bodySize;
    if (bodyEnd > buffer.length) break;

    // OpusHead carries the input sample rate at bytes 12..15 of the packet.
    if ((headerType & 0x02) !== 0 && bodySize >= 16) {
      const magic = buffer.toString("ascii", bodyStart, bodyStart + 8);
      if (magic === "OpusHead") {
        const rate = buffer.readUInt32LE(bodyStart + 12);
        if (rate > 0 && rate <= 192000) sampleRate = rate;
      }
    }

    if (granule > BigInt(0)) {
      foundPage = true;
      if (granule > maxGranule) maxGranule = granule;
    }

    offset = bodyEnd;
  }

  if (!foundPage || maxGranule <= BigInt(0)) return null;
  // Opus granule is in 48 kHz units regardless of input rate for most
  // WhatsApp notes; prefer the OpusHead rate when present, else 48000.
  const seconds = Number(maxGranule) / sampleRate;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

/** True when Body is empty/whitespace and the first media item is audio/*. */
export function isAudioOnlyInbound(params: {
  text: string;
  mediaUrls: string[];
  rawPayload: Record<string, unknown>;
}): boolean {
  if (params.text.trim().length > 0) return false;
  if (params.mediaUrls.length === 0) return false;
  const contentType = firstMediaContentType(params.rawPayload);
  return contentType !== null && contentType.startsWith("audio/");
}

export function firstMediaContentType(
  rawPayload: Record<string, unknown>,
): string | null {
  const value = rawPayload.MediaContentType0;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
