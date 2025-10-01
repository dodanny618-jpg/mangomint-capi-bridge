// server.js — MangoMint ↔ Meta CAPI bridge (IC + Purchase) — v2
// Changes from your version:
// - Graph API bumped to v21.0
// - access_token + test_event_code appended to URL query (required by Meta)
// - CORS widened to include Framer preview domains (keep/adjust as you like)
// - Extra logs and stricter JSON handling kept lightweight

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash, timingSafeEqual } from "node:crypto";

const app = express();

/* ============ LOGS ============ */
const DEBUG = String(process.env.DEBUG_LOGS || "0") === "1";
const ts = () => new Date().toISOString();
const log = (...a) => { if (DEBUG) console.log(`[${ts()}]`, ...a); };

/* ============ CORS ============ */
// Allow your prod domain + Framer previews. Tighten if needed.
const allowedOrigins = new Set([
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
]);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server / health
    if (allowedOrigins.has(origin)) return cb(null, true);
    // Allow Framer preview & share links (adjust if you know your exact preview origin)
    if (/^https:\/\/.*\.(framer\.app|framer\.website)$/.test(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
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
  DEFAULT_CURRENCY = "CAD",
  EVENT_SOURCE_URL: ENV_EVENT_URL,
  EVENT_SOURCE_URL_BOOK: ENV_EVENT_URL_BOOK,
  DEFAULT_APPT_VALUE = "100",
  MM_WEBHOOK_KEY,
  MANGOMINT_WEBHOOK_SECRET,
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN");
  process.exit(1);
}

const EVENT_SOURCE_URL_BOOK =
  ENV_EVENT_URL || ENV_EVENT_URL_BOOK || "https://altheatherapie.ca/en/book";

// Use latest version
const GRAPH_VER = "v21.0";
const META_BASE = `https://graph.facebook.com/${GRAPH_VER}/${META_PIXEL_ID}/events`;
const APPT_VALUE_NUM = Number(DEFAULT_APPT_VALUE) || 100;
const WEBHOOK_SECRET = MM_WEBHOOK_KEY || MANGOMINT_WEBHOOK_SECRET || "";

/* ============ Utils ============ */
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket?.remoteAddress || "";

const safeEventTime = (tsIn) => {
  let t = Math.floor(new Date(tsIn || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || t > now) t = now;
  if (t < now - 7 * 24 * 60 * 60) t = now;
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

/* ============ Tiny retry to Meta (token in URL) ============ */
async function sendToMeta(body, test_event_code) {
  const qs = new URLSearchParams({ access_token: META_ACCESS_TOKEN });
  if (test_event_code) qs.set("test_event_code", String(test_event_code));
  const url = `${META_BASE}?${qs.toString()}`;

  const headers = { "Content-Type": "application/json" };
  const payload = JSON.stringify(body);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: payload });
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
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/webhooks", (_req, res) => res.status(200).send("POST /webhooks alive"));
app.get("/webhooks/mangomint", (_req, res) => res.status(200).send("POST /webhooks/mangomint alive"));
app.get("/webhooks/sale", (_req, res) => res.status(200).send("POST /webhooks/sale alive"));

/* ============ IC Cache (eid → attribution) ============ */
const IC_CACHE = new Map(); // key: eid → { fbp,fbc,em,ph,fn,ln, ts }
const IC_TTL_MS = 24 * 60 * 60 * 1000;

function icSet(eid, data) { IC_CACHE.set(eid, { ...data, ts: Date.now() }); }
function icGet(eid) {
  const v = IC_CACHE.get(eid);
  if (!v) return null;
  if (Date.now() - v.ts > IC_TTL_MS) { IC_CACHE.delete(eid); return null; }
  return v;
}
function icFindByPII({ em, ph }) {
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
  for (const [k, v] of IC_CACHE.entries()) out.push({ eid: k, age_ms: Date.now() - v.ts, keys: Object.keys(v) });
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

/* ============ Idempotency on appointment.id ============ */
const APPT_SENT = new Map(); // apptId -> ts
const APPT_TTL_MS = 24 * 60 * 60 * 1000;
function apptAlreadySent(id) {
  const v = id && APPT_SENT.get(String(id));
  if (!v) return false;
  if (Date.now() - v > APPT_TTL_MS) { APPT_SENT.delete(String(id)); return false; }
  return true;
}
function markApptSent(id) { if (id) APPT_SENT.set(String(id), Date.now()); }
app.get("/debug/appt-cache", (_req, res) => {
  const out = [];
  for (const [k, v] of APPT_SENT.entries()) out.push({ appt_id: k, age_ms: Date.now() - v });
  res.status(200).json({ size: out.length, items: out.slice(0, 50) });
});

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
  if (appt?.onlineBookingClientInfo) return true;
  const createdByName = (appt?.createdBy?.name || "").toLowerCase();
  if (createdByName.includes("online booking")) return true;
  const src = (appt?.source || appt?.createdBy?.type || appt?.channel || "").toString().toLowerCase();
  if (src.includes("admin") || src.includes("manual") || src.includes("staff")) return false;
  if (src.includes("online") || src.includes("web")) return true;
  return false;
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

    // Cache IC for later Purchase enrichment
    if (event_id) icSet(event_id, { fbp: ud.fbp, fbc: ud.fbc, em: ud.em, ph: ud.ph, fn: ud.fn, ln: ud.ln });

    const body = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || EVENT_SOURCE_URL_BOOK,
        action_source,
        event_id,
        user_data: ud,
        custom_data: { value: 0, currency: DEFAULT_CURRENCY, content_type: "product", contents: [{ id: "massage", quantity: 1 }] }
      }]
    };

    const j = await sendToMeta(body, test_event_code);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR (/webhooks):", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ============ Build Purchase payload ============ */
function mapAppointmentToPurchase(appt, { user_data, event_id, test_event_code } = {}) {
  const srcRef = extractReferrer(appt);
  const srcUrl = (srcRef && /^https?:\/\//i.test(srcRef) ? srcRef : null) || EVENT_SOURCE_URL_BOOK;

  const services = Array.isArray(appt?.services) ? appt.services : [];
  const contents = services.length
    ? services.map((s, idx) => ({
        id: String(s?.service?.id ?? `svc-${idx}`),
        quantity: 1,
        item_price: Number(s?.price) || APPT_VALUE_NUM,
      }))
    : [{ id: "service:Appointment", quantity: 1, item_price: APPT_VALUE_NUM }];

  const totalValue = contents.reduce((sum, c) => sum + (Number(c.item_price) || 0), 0) || APPT_VALUE_NUM;
  const currency = (appt?.currency || DEFAULT_CURRENCY || "CAD").toUpperCase();
  const contentName = services?.[0]?.service?.name || services?.[0]?.name || "Appointment";
  const contentCategory = services?.[0]?.service?.category?.name || undefined;

  const data = [{
    event_name: "Purchase",
    event_time: safeEventTime(appt?.createdAt || appt?.dateTime || Date.now()),
    action_source: "website",
    event_source_url: srcUrl,
    event_id,
    user_data,
    custom_data: {
      currency,
      value: totalValue,
      content_type: "product",
      contents,
      content_name: contentName,
      content_category: contentCategory,
      order_id: String(appt?.id || ""),
      booking_time: appt?.dateTime || undefined,
    },
  }];

  return { data };
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
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const appt = payload.appointment;
    const test_event_code = payload.test_event_code || req.query.test_event_code;
    if (!appt) return res.status(200).json({ ok: false, msg: "Ignored: no appointment" });

    // Idempotency by appointment.id
    if (apptAlreadySent(appt?.id)) {
      log("Dedup: appointment already processed", appt?.id);
      return res.status(200).json({ ok: true, skipped: "duplicate_appointment" });
    }

    // Online bookings only
    if (!isOnlineBooking(appt)) return res.status(200).json({ ok: true, skipped: "manual_booking" });

    // Extract/derive eid
    let eid = getEidFromAppointment(appt);

    // Build user_data (hashed)
    const ua = req.headers["user-agent"] || "unknown";
    const baseUD = { client_ip_address: clientIp(req), client_user_agent: ua };
    const cli = appt.clientInfo || appt.onlineBookingClientInfo || {};
    const em_h = cli.email ? sha256(normEmail(cli.email)) : undefined;
    const ph_h = cli.phone ? sha256(normPhone(cli.phone)) : undefined;
    if (em_h) baseUD.em = em_h;
    if (ph_h) baseUD.ph = ph_h;
    if (cli.firstName) baseUD.fn = sha256(lower(cli.firstName));
    if (cli.lastName)  baseUD.ln = sha256(lower(cli.lastName));
    // external_id best practice
    const possibleExternal = (cli?.id ? String(cli.id) : null) || (appt?.id ? String(appt.id) : null);
    if (possibleExternal) baseUD.external_id = sha256(String(possibleExternal));

    // If no eid, try to match recent IC by PII
    if (!eid) {
      const match = icFindByPII({ em: em_h, ph: ph_h });
      if (match) {
        eid = match.eid;
        if (match.cached?.fbp && !baseUD.fbp) baseUD.fbp = match.cached.fbp;
        if (match.cached?.fbc && !baseUD.fbc) baseUD.fbc = match.cached.fbc;
        log("ATTR-FALLBACK → matched IC by PII within TTL:", eid);
      }
    }

    // Require eid or external_id
    if (!eid && !baseUD.external_id) {
      log("SKIP → no attribution (no eid and no external_id/PII match)");
      return res.status(200).json({ ok: true, skipped: "no_attribution" });
    }

    const event_id = eid || `appt-${String(appt?.id || Date.now())}`;
    if (alreadySent(event_id)) {
      log("Dedup: Purchase already sent for", event_id);
      return res.status(200).json({ ok: true, skipped: "duplicate_event" });
    }

    const cached = eid ? icGet(event_id) : null;
    const user_data = { ...baseUD };
    if (cached?.fbp && !user_data.fbp) user_data.fbp = cached.fbp;
    if (cached?.fbc && !user_data.fbc) user_data.fbc = cached.fbc;

    const body = mapAppointmentToPurchase(appt, { user_data, event_id, test_event_code });
    const j = await sendToMeta(body, test_event_code);

    markSent(event_id);
    markApptSent(appt?.id);

    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`✅ CAPI bridge listening on ${PORT} (value=${APPT_VALUE_NUM} ${DEFAULT_CURRENCY}, DEBUG_LOGS=${DEBUG ? "1":"0"})`);
});
