/**
 * Best-effort Twilio message/media deletion for GDPR erasure.
 *
 * Twilio REST:
 * - DELETE /Accounts/{Sid}/Messages/{MessageSid}.json — deletes/redacts the
 *   message resource (body no longer retrievable via API).
 * - DELETE .../Messages/{MessageSid}/Media/{MediaSid}.json — deletes a media
 *   resource when MediaSid is known.
 *
 * Limits: Twilio may retain metadata or backups per their retention policy;
 * we cannot force immediate purge of all copies. Failures are logged as counts
 * only — never throw, never log phone numbers or message bodies.
 */

export type TwilioRedactCounts = {
  messagesAttempted: number;
  messagesDeleted: number;
  mediaAttempted: number;
  mediaDeleted: number;
  failures: number;
};

function twilioAuthHeader(): string | null {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

function accountSid(): string | null {
  return process.env.TWILIO_ACCOUNT_SID?.trim() || null;
}

async function twilioDelete(url: string, auth: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    // 204 deleted; 404 already gone — both OK for idempotent erase.
    return res.status === 204 || res.status === 200 || res.status === 404;
  } catch {
    return false;
  }
}

/** Extract MessageSid / MediaSid from a message row's stored Twilio payload. */
export function extractTwilioSids(rawPayload: unknown): {
  messageSid: string | null;
  mediaSids: string[];
} {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { messageSid: null, mediaSids: [] };
  }
  const p = rawPayload as Record<string, unknown>;
  const messageSid =
    (typeof p.MessageSid === "string" && p.MessageSid) ||
    (typeof p.SmsSid === "string" && p.SmsSid) ||
    (typeof p.sid === "string" && p.sid) ||
    null;

  const mediaSids: string[] = [];
  if (typeof p.NumMedia === "string" || typeof p.NumMedia === "number") {
    const n = Number(p.NumMedia);
    for (let i = 0; i < n; i += 1) {
      const sid = p[`MediaSid${i}`];
      if (typeof sid === "string" && sid) mediaSids.push(sid);
    }
  }
  return { messageSid, mediaSids };
}

export async function redactTwilioMessageResources(params: {
  rawPayload: unknown;
}): Promise<TwilioRedactCounts> {
  const counts: TwilioRedactCounts = {
    messagesAttempted: 0,
    messagesDeleted: 0,
    mediaAttempted: 0,
    mediaDeleted: 0,
    failures: 0,
  };

  const auth = twilioAuthHeader();
  const sid = accountSid();
  if (!auth || !sid) return counts;

  const { messageSid, mediaSids } = extractTwilioSids(params.rawPayload);
  if (!messageSid || messageSid.startsWith("DRYRUN_")) return counts;

  for (const mediaSid of mediaSids) {
    counts.mediaAttempted += 1;
    const ok = await twilioDelete(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}/Media/${mediaSid}.json`,
      auth,
    );
    if (ok) counts.mediaDeleted += 1;
    else counts.failures += 1;
  }

  counts.messagesAttempted += 1;
  const ok = await twilioDelete(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}.json`,
    auth,
  );
  if (ok) counts.messagesDeleted += 1;
  else counts.failures += 1;

  return counts;
}
