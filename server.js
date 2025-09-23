// server.js — MangoMint ↔ Meta CAPI bridge (with PII fallback + external_id)
// - IC (click "Book Now") → Pixel+CAPI; cache IC (eid, fbp/fbc, PII-hash) 6h
// - Purchase sent ONLY for online bookings (onlineBookingClientInfo present)
//   • prefer eid from referrer/metadata
//   • else fallback by matching hashed email/phone to IC cache (≤6h)
// - Skip manual/admin bookings; no "confirmed" requirement (per request)
// - Dedup 24h on event_id
// - Webhook secret optional: header X-Webhook-Secret OR query ?key=…
// - ENV (Render): META_PIXEL_ID, META_ACCESS_TOKEN, DEFAULT_APPT_VALUE, DEFAULT_CURRENCY,
//                 EVENT_SOURCE_URL (or EVENT_SOURCE_URL_BOOK), MM_WEBHOOK_KEY (or MANGOMINT_WEBHOOK_SECRET),
//                 DEBUG_LOGS, PORT

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash, timingSafeEqual } from "node:crypto";

const app = express();

/* ============ LOGGING ============ */
const DEBUG = String(process.env.DEBUG_LOGS || "0") === "1";
const ts = () => new Date().toISOString();
const log = (...a) => { if (DEBUG) console.log(`[${ts()}]`, ...a); };

/* ============ CORS ============ */
const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Webhook-Secret"],
  optionsSuccessStatus: 204,
}));
app.options("*", cors());
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

/* ============ ENV ============ */
const {
  PORT = 10000,
  META_PIXEL_ID,
  META_ACCESS_TOKEN,
  DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "CAD",
  EVENT_SOURCE_URL: ENV_EVENT_URL,
  EVENT_SOURCE_URL_BOOK: ENV_EVENT_URL_BOOK,
  DEFAULT_APPT_VALUE = "100",
} = process.env;

const EVENT_SOURCE_URL_BOOK =
  ENV_EVENT_URL || ENV_EVENT_URL_BOOK || "https://altheatherapie.ca/en/book";

// Secret can be provided as MM_WEBHOOK_KEY or MANGOMINT_WEBHOOK_SECRET
const WEBHOOK_SECRET =
  process.env.MM_WEBHOOK_KEY || process.env.MANGOMINT_WEBHOOK_SECRET || "";

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN");
  process.exit(1);
}
const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;
const APPT_VALUE_NUM = Number(DEFAULT_APPT_VALUE) || 100;

/* ============ Utils ============ */
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket.remoteAddress || "";

const safeEventTime = (tsIn) => {
  let t = Math.floor(new Date(tsIn || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || t > now) t = now;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;
  if (t < sevenDaysAgo) t = now;
  return t;
};

const sha256 = (s = "") =>
  createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const normEmail = (v) => String(v || "").trim().toLowerCase();
const lower = (v) => String(v || "").trim().toLowerCase();
const normPhone = (v) => {
  if (!v) return "";
  let x = String(v).replace(/[^\d+]/g, "");
  if (!x.startsWith("+")) {
    if (x.length === 10) x = `+1${x}`;
    else if (x.length === 11 && x.startsWith("1")) x = `+${x}`;
    else x = `+${x}`;
  }
  return x;
};

/* ============ Tiny retry to Meta ============ */
async function sendToMeta(body) {
  const headers = { "Content-Type": "application/json" };
  const payload = JSON.stringify(body);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(META_ENDPOINT, { method: "POST", headers, body: payload });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    log(`META attempt ${attempt} →`, res.status, json);
    if (res.ok) return json;
    if (res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
      continue;
    }
    throw new Error(`Meta error ${res.status}: ${text}`);
  }
  throw new Error("Meta unknown error");
}

/* ============ Health ============ */
app.get("/", (_req, res) => res.status(200).send("Mangomint → Meta CAPI OK"));
app.get("/webhooks", (_req, res) => res.status(200).send("POST /webhooks alive"));
app.get("/webhooks/mangomint", (_req, res) => res.status(200).send("POST /webhooks/mangomint alive"));
app.get("/webhooks/sale", (_req, res) => res.status(200).send("POST /webhooks/sale alive"));
app.get("/debug/ping", (_req, res) => res.status(200).json({ ok: true, now: ts() }));

/* ============ IC Cache (eid → attribution) ============ */
const IC_CACHE = new Map(); // key: eid → { fbp,fbc,em,ph,fn,ln, ts }
const IC_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function icSet(eid, data) {
  IC_CACHE.set(eid, { ...data, ts: Date.now() });
  log("IC_CACHE set", eid, Object.keys(data));
}
function icGet(eid) {
  const v = IC_CACHE.get(eid);
  if (!v) return null;
  if (Date.now() - v.ts > IC_TTL_MS) { IC_CACHE.delete(eid); return null; }
  return v;
}
function icFindByPII({ em, ph }) {
  // em / ph are expected to be SHA-256 hashes here
  const now = Date.now();
  for (const [eid, v] of IC_CACHE.entries()) {
    if (now - v.ts > IC_TTL_MS) continue;
    const emMatch = em && v.em && v.em === em;
    const phMatch = ph && v.ph && v.ph === ph;
    if (emMatch || phMatch) return { eid, cached: v };
  }
  return null;
}
app.get("/debug/ic-cache", (_req, res) => {
  const out = [];
  for (const [k, v] of IC_CACHE.entries()) {
    out.push({ eid: k, age_ms: Date.now() - v.ts, keys: Object.keys(v) });
  }
  res.status(200).json({ size: out.length, items: out.slice(0, 50) });
});

/* ============ De-dup (24h) ============ */
const SENT_CACHE = new Map(); // event_id → ts
const SENT_TTL_MS = 24 * 60 * 60 * 1000;
function alreadySent(eventId) {
  const v = eventId && SENT_CACHE.get(eventId);
  if (!v) return false;
  if (Date.now() - v > SENT_TTL_MS) { SENT_CACHE.delete(eventId); return false; }
  return true;
}
function markSent(eventId) { if (eventId) SENT_CACHE.set(eventId, Date.now()); }

/* ============ Helpers: MangoMint parsing ============ */
function extractReferrer(appt = {}) {
  return (
    appt?.onlineBookingClientInfo?.referrerUrl ||
    appt?.referrerUrl ||
    appt?.notes ||
    appt?.clientNotes || ""
  );
}
function extractEidFromString(s) {
  if (!s) return null;
  try {
    const u = new URL(s, "https://dummy/");
    const p = u.searchParams.get("eid");
    if (p) return p;
  } catch {}
  const m = String(s).match(/(?:^|[?&])eid=([^&\s]+)/);
  return m ? m[1] : null;
}
function getEidFromAppointment(appt = {}) {
  return appt?.metadata?.eid || appt?.meta?.eid || extractEidFromString(extractReferrer(appt));
}
function isOnlineBooking(appt = {}) {
  if (appt?.onlineBookingClientInfo) return true; // clear online signal
  const src = (appt?.source || appt?.createdBy?.type || appt?.channel || "").toString().toLowerCase();
  if (src.includes("admin") || src.includes("manual") || src.includes("staff")) return false;
  return false; // default: don't count without explicit online proof
}

/* ============ /webhooks (IC from Framer) ============ */
app.post("/webhooks", async (req, res) => {
  log("HIT /webhooks (IC) ip=", clientIp(req), "ua=", req.headers["user-agent"] || "?");
  try {
    const bodyIn = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { event_name, event_id, event_source_url, action_source = "website", test_event_code, user_data = {} } = bodyIn;

    const ud = {
      client_ip_address: clientIp(req),
      client_user_agent: req.headers["user-agent"] || "unknown",
    };
    if (user_data.fbp) ud.fbp = user_data.fbp;
    if (user_data.fbc) ud.fbc = user_data.fbc;
    if (user_data.em) ud.em = /^[a-f0-9]{64}$/.test(user_data.em) ? user_data.em : sha256(normEmail(user_data.em));
    if (user_data.ph) ud.ph = /^[a-f0-9]{64}$/.test(user_data.ph) ? user_data.ph : sha256(normPhone(user_data.ph));
    if (user_data.fn) ud.fn = /^[a-f0-9]{64}$/.test(user_data.fn) ? user_data.fn : sha256(lower(user_data.fn));
    if (user_data.ln) ud.ln = /^[a-f0-9]{64}$/.test(user_data.ln) ? user_data.ln : sha256(lower(user_data.ln));

    // Store IC info in cache for PII fallback / enrichment
    if (event_id) icSet(event_id, { fbp: ud.fbp, fbc: ud.fbc, em: ud.em, ph: ud.ph, fn: ud.fn, ln: ud.ln });

    const metaBody = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || EVENT_SOURCE_URL_BOOK,
        action_source,
        event_id,
        user_data: ud,
        // no custom_data here to avoid "fixed value/currency" warnings
      }],
      access_token: META_ACCESS_TOKEN,
    };
    if (test_event_code) metaBody.test_event_code = test_event_code;

    log("SEND → Meta IC", { event_id, has_fbp: !!ud.fbp, has_fbc: !!ud.fbc });
    const j = await sendToMeta(metaBody);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR (/webhooks):", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ============ Build Purchase payload ============ */
function mapAppointmentToPurchase(appt, { user_data, event_id, test_event_code } = {}) {
  const serviceName =
    appt?.services?.[0]?.service?.name ||
    appt?.services?.[0]?.name ||
    "Appointment";

  const srcRef = extractReferrer(appt);
  const srcUrl =
    srcRef && /^https?:\/\//i.test(srcRef) ? srcRef : EVENT_SOURCE_URL_BOOK;

  const contents = [{
    id: `service:${serviceName}`,
    quantity: 1,
    item_price: APPT_VALUE_NUM,
  }];

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: safeEventTime(appt?.createdAt || Date.now()),
      action_source: "website",
      event_source_url: srcUrl,
      event_id,
      user_data,
      custom_data: {
        currency: DEFAULT_CURRENCY,
        value: APPT_VALUE_NUM,
        content_type: "product",
        contents,
        content_name: serviceName,
      },
    }],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

/* ============ /webhooks/mangomint (Appointment → Purchase) ============ */
app.post("/webhooks/mangomint", async (req, res) => {
  log("HIT /webhooks/mangomint ip=", clientIp(req));
  try {
    // Optional secret: header OR query (?key=)
    if (WEBHOOK_SECRET) {
      const gotHeader = req.headers["x-webhook-secret"] || req.headers["X-Webhook-Secret"];
      const gotQuery = req.query.key || req.query.secret;
      let ok = false;

      if (gotHeader) {
        const a = Buffer.from(String(gotHeader), "utf8");
        const b = Buffer.from(String(WEBHOOK_SECRET), "utf8");
        ok = a.length === b.length && timingSafeEqual(a, b);
      } else if (gotQuery) {
        ok = String(gotQuery) === String(WEBHOOK_SECRET);
      }

      if (!ok) {
        log("SKIP → invalid secret (header/query mismatch)");
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const appt = payload.appointment;
    const test_event_code = payload.test_event_code || req.query.test_event_code;

    // REQUIRED: online booking only
    if (!appt)               return res.status(200).json({ ok: false, msg: "Ignored: no appointment" });
    if (!isOnlineBooking(appt)) return res.status(200).json({ ok: true, skipped: "manual_booking" });
    // (No "confirmed" requirement per request)

    // Extract eid directly if present
    let eid = getEidFromAppointment(appt);

    // Build base user_data from MangoMint payload (hashed)
    const ua = req.headers["user-agent"] || "unknown";
    const baseUD = { client_ip_address: clientIp(req), client_user_agent: ua };
    const cli = appt.clientInfo || appt.onlineBookingClientInfo || {};
    const em_h = cli.email ? sha256(normEmail(cli.email)) : undefined;
    const ph_h = cli.phone ? sha256(normPhone(cli.phone)) : undefined;
    if (em_h) baseUD.em = em_h;
    if (ph_h) baseUD.ph = ph_h;
    if (cli.firstName) baseUD.fn = sha256(lower(cli.firstName));
    if (cli.lastName)  baseUD.ln = sha256(lower(cli.lastName));

    // Add external_id if available (helps server-side matching)
    // prefer clientInfo.id, else appointment.id
    const possibleExternal = (cli && cli.id) ? String(cli.id) : (appt && appt.id ? String(appt.id) : undefined);
    if (possibleExternal) baseUD.external_id = possibleExternal;

    // If no eid, try PII fallback to recent IC
    if (!eid) {
      const match = icFindByPII({ em: em_h, ph: ph_h });
      if (match) {
        eid = match.eid; // adopt the IC's eid
        // enrich with IC's fbp/fbc if missing
        if (match.cached?.fbp) baseUD.fbp = match.cached.fbp;
        if (match.cached?.fbc) baseUD.fbc = match.cached.fbc;
        log("ATTR-FALLBACK → matched IC by PII within 6h:", eid);
      }
    }

    // Require eid (preferred). Without eid, we still allow if external_id exists?
    // Decision: require eid or external_id (your choice). Here we accept external_id as fallback to send a purchase.
    // If you strictly want only eid-driven purchases, replace next condition with `if (!eid) { skip }`.
    if (!eid && !baseUD.external_id) {
      log("SKIP → no attribution (no eid and no external_id/PII match)");
      return res.status(200).json({ ok: true, skipped: "no_attribution" });
    }

    // Use eid if present for event_id; otherwise use external_id (prefixed) to dedup
    const event_id = eid || `external-${baseUD.external_id}`;

    if (alreadySent(event_id)) {
      log("Dedup: Purchase already sent for", event_id);
      return res.status(200).json({ ok: true, skipped: "duplicate_event" });
    }

    // Enrich user_data with anything stored under eid (fbp/fbc, etc.) if eid exists
    const cached = eid ? icGet(event_id) : null;
    const user_data = { ...baseUD };
    if (cached?.fbp && !user_data.fbp) user_data.fbp = cached.fbp;
    if (cached?.fbc && !user_data.fbc) user_data.fbc = cached.fbc;

    log("SEND → Meta Purchase", {
      event_id,
      has_eid: !!eid,
      has_external_id: !!baseUD.external_id,
      has_fbp: !!user_data.fbp,
      has_fbc: !!user_data.fbc,
      has_pii: !!(user_data.em || user_data.ph),
    });

    const body = mapAppointmentToPurchase(appt, { user_data, event_id, test_event_code });
    const j = await sendToMeta(body);
    markSent(event_id);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ============ (Optional) /webhooks/sale — disabled for POS/terminal payments ============ */
// Kept for completeness; intentionally not mapping terminal sales to Website Purchase to avoid double-counting.
app.post("/webhooks/sale", async (req, res) => {
  log("HIT /webhooks/sale ip=", clientIp(req));
  try {
    if (WEBHOOK_SECRET) {
      const gotHeader = req.headers["x-webhook-secret"] || req.headers["X-Webhook-Secret"];
      const gotQuery = req.query.key || req.query.secret;
      let ok = false;
      if (gotHeader) {
        const a = Buffer.from(String(gotHeader), "utf8");
        const b = Buffer.from(String(WEBHOOK_SECRET), "utf8");
        ok = a.length === b.length && timingSafeEqual(a, b);
      } else if (gotQuery) {
        ok = String(gotQuery) === String(WEBHOOK_SECRET);
      }
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
    }

    // Intentionally skipping sending to Meta here to avoid POS/terminal signals.
    return res.status(200).json({ ok: true, skipped: "sale_signals_disabled" });
  } catch (err) {
    console.error("SALE webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`✅ CAPI bridge listening on ${PORT} (value=${APPT_VALUE_NUM} ${DEFAULT_CURRENCY}, DEBUG_LOGS=${DEBUG ? "1":"0"})`);
});
