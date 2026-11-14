/**
 * Verifies WhatsApp voice-note transcription (audio_transcribe → existing pipeline).
 *
 * Serves short audio clips from a local HTTP server (MediaUrl0) so the Next.js
 * handler can download them with Twilio Basic auth headers (ignored by the
 * local server). Posts Twilio-signed webhooks like the other verify-*.mjs scripts.
 *
 * Requires: Next.js on :3000, .env.local, Windows SAPI for spoken clips (or
 * pre-generated WAV files under scripts/fixtures/voice/).
 *
 *   node scripts/verify-voice-note.mjs
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/webhooks/ingress`;
const SANDBOX_NUMBER = "+14155238886";
const BUYER = "+447733308706";
const FIXTURES = resolve(root, "scripts/fixtures/voice");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} — ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function signTwilio(url, params) {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

let sidCounter = Date.now();
function nextSid() {
  sidCounter += 1;
  return `SM${sidCounter.toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

/** Minimal silent PCM WAV (numSeconds at 8kHz mono 16-bit). */
function silentWav(numSeconds = 1) {
  const sampleRate = 8000;
  const numSamples = sampleRate * numSeconds;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/** Ogg page claiming a long Opus granule (for duration-limit tests). */
function longDurationOggClaim(seconds = 120) {
  const granule = BigInt(48000 * seconds);
  const buffer = Buffer.alloc(27 + 1 + 8);
  buffer.write("OggS", 0);
  buffer[4] = 0;
  buffer[5] = 0x02; // BOS
  buffer.writeBigUInt64LE(granule, 6);
  buffer.writeUInt32LE(0, 14); // serial
  buffer.writeUInt32LE(0, 18); // page seq
  buffer.writeUInt32LE(0, 22); // checksum
  buffer[26] = 1; // one segment
  buffer[27] = 8; // segment size
  buffer.write("OpusHead", 28);
  // Not a valid OpusHead body — duration parser only needs granule + OggS.
  return buffer;
}

function synthesizeWav(text, outPath) {
  mkdirSync(FIXTURES, { recursive: true });
  if (existsSync(outPath) && process.env.FORCE_RESYNTH !== "1") {
    return readFileSync(outPath);
  }
  const ps1 = join(tmpdir(), `tf-voice-${Date.now()}.ps1`);
  const escaped = text.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = -1
$synth.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}')
$synth.Speak('${escaped}')
$synth.Dispose()
`;
  writeFileSync(ps1, script, "utf8");
  const run = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { encoding: "utf8" },
  );
  try {
    unlinkSync(ps1);
  } catch {
    /* ignore */
  }
  if (run.status !== 0 || !existsSync(outPath)) {
    throw new Error(
      `SAPI synth failed: ${run.stderr || run.stdout || "no wav written"}`,
    );
  }
  return readFileSync(outPath);
}

function startMediaServer(files) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const key = (req.url ?? "/").replace(/^\//, "").split("?")[0];
      const file = files[key];
      if (!file) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": file.buffer.length,
      });
      res.end(file.buffer);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        port,
        urlFor: (name) => `http://127.0.0.1:${port}/${name}`,
        close: () =>
          new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function sendAudioWhatsApp({ mediaUrl, contentType, body = "" }) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Voice Note Tester",
    Body: body,
    NumMedia: "1",
    MediaUrl0: mediaUrl,
    MediaContentType0: contentType,
  };
  const bodyEncoded = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body: bodyEncoded,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, messageSid: full.MessageSid };
}

async function sendTextWhatsApp(text) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Voice Note Tester",
    Body: text,
    NumMedia: "0",
  };
  const bodyEncoded = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body: bodyEncoded,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function sendImageWhatsApp(mediaUrl) {
  const full = {
    MessageSid: nextSid(),
    AccountSid: "ACtest",
    From: `whatsapp:${BUYER}`,
    To: `whatsapp:${SANDBOX_NUMBER}`,
    ProfileName: "Voice Note Tester",
    Body: "",
    NumMedia: "1",
    MediaUrl0: mediaUrl,
    MediaContentType0: "image/jpeg",
  };
  const bodyEncoded = new URLSearchParams(full).toString();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Source": "twilio-whatsapp",
      "X-Twilio-Signature": signTwilio(ENDPOINT, full),
    },
    body: bodyEncoded,
    redirect: "manual",
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function cleanBuyerState(businessId) {
  const { data: customers } = await admin
    .from("customers")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", BUYER);
  const ids = (customers ?? []).map((c) => c.id);
  if (!ids.length) return;

  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("business_id", businessId)
    .in("customer_id", ids);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length) {
    await admin.from("order_items").delete().in("order_id", orderIds);
    await admin.from("order_status_history").delete().in("order_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
  await admin.from("messages").delete().in("customer_id", ids);
  await admin
    .from("customers")
    .update({ ai_paused_until: null })
    .in("id", ids);
}

async function loadMessage(messageId) {
  const { data } = await admin
    .from("messages")
    .select(
      "id, normalised_text, source_kind, media_urls, ai_parse_result, direction",
    )
    .eq("id", messageId)
    .maybeSingle();
  return data;
}

async function latestOutbound(threadId) {
  const { data } = await admin
    .from("messages")
    .select("id, normalised_text")
    .eq("thread_id", threadId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function main() {
  const { data: business } = await admin
    .from("businesses")
    .select("id, name, whatsapp_phone_e164")
    .eq("name", "EK-Pousser_D")
    .maybeSingle();
  if (!business) throw new Error("EK-Pousser_D not found");
  if (business.whatsapp_phone_e164 !== SANDBOX_NUMBER) {
    throw new Error("Sandbox number not mapped to EK-Pousser_D");
  }

  const { data: audioConfig } = await admin
    .from("ai_model_config")
    .select("task_key, provider, model, max_tokens, is_active")
    .eq("task_key", "audio_transcribe")
    .maybeSingle();
  record(
    "0. audio_transcribe config seeded",
    Boolean(audioConfig?.is_active) && audioConfig?.provider === "gemini",
    JSON.stringify(audioConfig),
  );

  const orderMugPath = join(FIXTURES, "two-blue-mugs.wav");
  const frenchPath = join(FIXTURES, "french-order.wav");
  const spokenEn = synthesizeWav("I'd like two blue mugs", orderMugPath);
  const spokenFr = synthesizeWav(
    "Bonjour, je voudrais deux tasses bleues",
    frenchPath,
  );
  const silent = silentWav(2);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024, 1);
  const longOgg = longDurationOggClaim(120);
  const tinyJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xd9, // minimal JPEG SOI/EOI
  ]);

  const media = await startMediaServer({
    "two-blue-mugs.wav": {
      buffer: spokenEn,
      contentType: "audio/wav",
    },
    "silent.wav": { buffer: silent, contentType: "audio/wav" },
    "french.wav": { buffer: spokenFr, contentType: "audio/wav" },
    "oversized.bin": {
      buffer: oversized,
      contentType: "audio/ogg",
    },
    "long.ogg": { buffer: longOgg, contentType: "audio/ogg" },
    "photo.jpg": { buffer: tinyJpeg, contentType: "image/jpeg" },
  });

  console.log(`Media server on ${media.urlFor("two-blue-mugs.wav")}`);
  console.log(`Business: ${business.name} (${business.id})\n`);

  try {
    await cleanBuyerState(business.id);

    // --- 1. Spoken English order ---
    {
      const send = await sendAudioWhatsApp({
        mediaUrl: media.urlFor("two-blue-mugs.wav"),
        contentType: "audio/wav",
      });
      const msg = await loadMessage(send.json.messageId);
      const outbound = await latestOutbound(send.json.threadId);
      const transcript = msg?.normalised_text ?? "";
      const confirmation =
        typeof send.json?.draft?.confirmationMessage === "string"
          ? send.json.draft.confirmationMessage
          : outbound?.normalised_text ?? "";
      const draftOk =
        send.json?.draft?.action === "draft_created" ||
        send.json?.draft?.action === "draft_updated";
      const heard = /I heard:/i.test(confirmation);
      const twilioCapped = /50 daily messages limit/i.test(
        String(send.json?.draft?.sendError ?? ""),
      );
      record(
        "1. Spoken 'two blue mugs' → transcript + prefixed draft",
        send.status === 200 &&
          msg?.source_kind === "voice_note" &&
          /two|2/i.test(transcript) &&
          /mug/i.test(transcript) &&
          draftOk &&
          heard &&
          /mug/i.test(confirmation),
        `transcript=${JSON.stringify(transcript)} confirmation=${JSON.stringify(confirmation)} draft=${JSON.stringify(send.json?.draft)} twilioCapped=${twilioCapped} voice=${JSON.stringify(send.json?.voice)}`,
      );
      console.log("EXACT transcript:", transcript);
      console.log("EXACT reply/confirmation:", confirmation);
      if (twilioCapped) {
        console.log(
          "NOTE: Twilio 50 messages/day trial cap blocked WhatsApp delivery; confirmation text still built correctly.",
        );
      }
    }

    await cleanBuyerState(business.id);

    // --- 2. Silent / noise-only ---
    {
      const send = await sendAudioWhatsApp({
        mediaUrl: media.urlFor("silent.wav"),
        contentType: "audio/wav",
      });
      const msg = await loadMessage(send.json.messageId);
      const outbound = await latestOutbound(send.json.threadId);
      const noParse =
        send.json.parseStored !== true &&
        !send.json?.draft &&
        (send.json?.voice?.kind === "unclear" ||
          msg?.ai_parse_result?.skipped_order_parse === true);
      const outboundText = outbound?.normalised_text ?? "";
      const sendFailedUnclear =
        send.json?.voice?.kind === "unclear" &&
        send.json?.voice?.buyerSend?.ok === false;
      record(
        "2. Silent clip → resend message, no order_parse/draft",
        send.status === 200 &&
          noParse &&
          (/voice note|couldn't make out|send it again|type your order/i.test(
            outboundText,
          ) ||
            sendFailedUnclear),
        `voice=${JSON.stringify(send.json?.voice)} outbound=${JSON.stringify(outboundText)} parse=${JSON.stringify(msg?.ai_parse_result)}`,
      );
    }

    await cleanBuyerState(business.id);

    // --- 3. Oversized (no transcription) ---
    {
      const send = await sendAudioWhatsApp({
        mediaUrl: media.urlFor("oversized.bin"),
        contentType: "audio/ogg",
      });
      const outbound = await latestOutbound(send.json.threadId);
      const outboundText = outbound?.normalised_text ?? "";
      const rejected = send.json?.voice?.kind === "rejected_too_long";
      const sendFailed =
        rejected && send.json?.voice?.buyerSend?.ok === false;
      record(
        "3. Oversize clip → 'a bit long', no transcription gateway success",
        send.status === 200 &&
          rejected &&
          (/bit long/i.test(outboundText) || sendFailed),
        `voice=${JSON.stringify(send.json?.voice)} outbound=${JSON.stringify(outboundText)}`,
      );
    }

    await cleanBuyerState(business.id);

    // --- 4. Over-duration OGG claim ---
    {
      const send = await sendAudioWhatsApp({
        mediaUrl: media.urlFor("long.ogg"),
        contentType: "audio/ogg",
      });
      const outbound = await latestOutbound(send.json.threadId);
      const outboundText = outbound?.normalised_text ?? "";
      const rejected = send.json?.voice?.kind === "rejected_too_long";
      const sendFailed =
        rejected && send.json?.voice?.buyerSend?.ok === false;
      record(
        "4. Over-duration clip → 'a bit long', no transcription",
        send.status === 200 &&
          rejected &&
          (/bit long/i.test(outboundText) || sendFailed),
        `voice=${JSON.stringify(send.json?.voice)} outbound=${JSON.stringify(outboundText)}`,
      );
    }

    await cleanBuyerState(business.id);

    // --- 5. French voice note (report only) ---
    {
      const send = await sendAudioWhatsApp({
        mediaUrl: media.urlFor("french.wav"),
        contentType: "audio/wav",
      });
      const msg = await loadMessage(send.json.messageId);
      const outbound = await latestOutbound(send.json.threadId);
      record(
        "5. French voice note (report)",
        send.status === 200 && msg?.source_kind === "voice_note",
        `transcript=${JSON.stringify(msg?.normalised_text)} voice=${JSON.stringify(send.json?.voice)} draft=${JSON.stringify(send.json?.draft)} support=${JSON.stringify(send.json?.support)} reply=${JSON.stringify(outbound?.normalised_text)}`,
      );
      console.log("FRENCH transcript:", msg?.normalised_text);
      console.log("FRENCH pipeline draft/support:", {
        draft: send.json?.draft,
        support: send.json?.support,
      });
    }

    await cleanBuyerState(business.id);

    // --- 6. Image-only unchanged (no voice path) ---
    {
      const send = await sendImageWhatsApp(media.urlFor("photo.jpg"));
      record(
        "6. Image-only message unchanged (no voice path)",
        send.status === 200 &&
          !send.json?.voice &&
          (send.json?.support?.action === "fallback" ||
            send.json?.parseStored === true),
        `voice=${JSON.stringify(send.json?.voice)} support=${JSON.stringify(send.json?.support)} parseStored=${send.json?.parseStored}`,
      );
    }

    await cleanBuyerState(business.id);

    // --- 7. Normal text unchanged ---
    {
      const send = await sendTextWhatsApp("I'd like 2 of the blue mug");
      record(
        "7. Normal text message unchanged",
        send.status === 200 &&
          !send.json?.voice &&
          (send.json?.draft?.action === "draft_created" ||
            send.json?.draft?.action === "draft_updated"),
        `draft=${JSON.stringify(send.json?.draft)}`,
      );
    }

    await cleanBuyerState(business.id);

    // --- 8. AI paused + voice note ---
    {
      const { data: customer } = await admin
        .from("customers")
        .upsert(
          {
            business_id: business.id,
            phone_e164: BUYER,
            channel_identifiers: { whatsapp: BUYER },
            ai_paused_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          { onConflict: "business_id,phone_e164" },
        )
        .select("id")
        .single();

      // upsert may not return on some schemas — ensure pause set
      if (customer?.id) {
        await admin
          .from("customers")
          .update({
            ai_paused_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          })
          .eq("id", customer.id);
      } else {
        const { data: existing } = await admin
          .from("customers")
          .select("id")
          .eq("business_id", business.id)
          .eq("phone_e164", BUYER)
          .maybeSingle();
        await admin
          .from("customers")
          .update({
            ai_paused_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          })
          .eq("id", existing.id);
      }

      const beforeCount = await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("business_id", business.id)
        .eq("direction", "outbound");

      const send = await sendAudioWhatsApp({
        mediaUrl: media.urlFor("two-blue-mugs.wav"),
        contentType: "audio/wav",
      });
      const msg = await loadMessage(send.json.messageId);
      const afterOutbound = await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("business_id", business.id)
        .eq("direction", "outbound");

      record(
        "8. AI-paused voice note → transcript stored, no automated reply",
        send.status === 200 &&
          send.json?.aiPaused === true &&
          msg?.source_kind === "voice_note" &&
          (msg?.normalised_text ?? "").length > 0 &&
          (afterOutbound.count ?? 0) === (beforeCount.count ?? 0),
        `transcript=${JSON.stringify(msg?.normalised_text)} aiPaused=${send.json?.aiPaused} outboundDelta=${(afterOutbound.count ?? 0) - (beforeCount.count ?? 0)}`,
      );
    }

    await cleanBuyerState(business.id);

    // --- 9. Gateway regression: order_parse + support_reply still work ---
    {
      const textOrder = await sendTextWhatsApp("I'd like 1 Classic Blue Mug please");
      await cleanBuyerState(business.id);
      const textQ = await sendTextWhatsApp("what are your opening hours?");
      record(
        "9. Existing order_parse / support_reply still work",
        textOrder.status === 200 &&
          (textOrder.json?.draft?.action === "draft_created" ||
            textOrder.json?.parseStored) &&
          textQ.status === 200 &&
          (textQ.json?.support?.action === "answered" ||
            textQ.json?.support?.action === "escalated" ||
            textQ.json?.parseStored),
        `order=${JSON.stringify(textOrder.json?.draft)} q=${JSON.stringify(textQ.json?.support)}`,
      );
    }
  } finally {
    await media.close();
    await cleanBuyerState(business.id);
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
