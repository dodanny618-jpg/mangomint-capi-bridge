// server.js — MangoMint → Meta CAPI bridge (IC + Purchase, PII fallback, prod-safe)
// - IC (clic "Book Now" depuis Framer) → Pixel + CAPI (dédup par event_id)
// - Purchase (RDV en ligne MangoMint) → CAPI si attribuable pub Meta (eid OU PII fallback≤6h)
// - Pas de custom_data sur IC (évite warnings "fixed value/currency")
// - Purchase: value = DEFAULT_APPT_VALUE (CAD) + contents
// - Filtre manuel/admin; pas d’exigence "confirmed" (booked/scheduled suffisent)
// - Caches: IC (eid→user_data) 6h, PII index 6h, dédup Purchase 24h
// - Secret de webhook: header X-Webhook-Secret OU query ?key=...
// - ENV (Render): META_PIXEL_ID, META_ACCESS_TOKEN, DEFAULT_APPT_VALUE (ex: 100),
//                 DEFAULT_CURRENCY (ex: CAD), EVENT_SOURCE_URL ou EVENT_SOURCE_URL_BOOK,
//                 MM_WEBHOOK_KEY ou MANGOMINT_WEBHOOK_SECRET, PORT, DEBUG_LOGS
// - Debug: GET /debug/ping, /debug/ic-cache

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash, timingSafeEqual } from "node:crypto";

const app = express();

/* ======================= LOGGING ======================= */
const DEBUG = String(process.env.DEBUG_LOGS || "0") === "1";
const ts = () => new Date().toISOString();
const log = (...a) => { if (DEBUG) console.log(`[${ts()}]`, ...a); };

/* ======================= CORS ======================= */
const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];
const corsOptions = {
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || !origin) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Webhook-Secret"],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

/* ======================= ENV ======================= */
const {
  PORT = 10000,
  META_PIXEL_ID,
  META_ACCESS_TOKEN,
  DEFAULT_APPT_VALUE = "100",
  DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "CAD",
  EVENT_SOURCE_URL: ENV_EVENT_URL,
  EVENT_SOURCE_URL_BOOK: ENV_EVENT_URL_BOOK,
} = process.env;

const EVENT_SOURCE_URL_BOOK =
  ENV_EVENT_URL || ENV_EVENT_URL_BOOK || "https://altheatherapie.ca/en/book";

// Secret: MM_WEBHOOK_KEY (préféré) ou MANGOMINT_WEBHOOK_SECRET
const WEBHOOK_SECRET =
  process.env.MM_WEBHOOK_KEY || process.env.MANGOMINT_WEBHOOK_SECRET || "";

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN");
  process.exit(1);
}
const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;
const APPT_VALUE_NUM = Number(DEFAULT_APPT_VALUE) || 100;

/* ======================= Utils ======================= */
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

/* ======================= Tiny retry to Meta ======================= */
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

/* ======================= Health ======================= */
app.get("/", (_req, res) => res.status(200).send("Mangomint → Meta CAPI OK"));
app.get("/webhooks", (_req, res) => res.status(200).send("POST /webhooks alive"));
app.get("/webhooks/mangomint", (_req, res) => res.status(200).send("POST /webhooks/mangomint alive"));
app.get("/webhooks/sale", (_req, res) => res.status(200).send("POST /webhooks/sale alive"));
app.get("/debug/ping", (_req, res) => res.status(200).json({ ok: true, now: ts() }));

/* ======================= IC Cache (eid → user_data) ======================= */
const IC_CACHE = new Map();
const IC_TTL_MS = 6 * 60 * 60 * 1000; // 6h
function icSet(eid, data) { IC_CACHE.set(eid, { ...data, ts: Date.now() }); log("IC_CACHE set", eid, Object.keys(data)); }
function icGet(eid) {
  const v = IC_CACHE.get(eid);
  if (!v) return null;
  if (Date.now() - v.ts > IC_TTL_MS) { IC_CACHE.delete(eid); return null; }
  return v;
}
app.get("/debug/ic-cache", (_req, res) => {
  const out = [];
  for (const [k, v] of IC_CACHE.entries()) out.push({ eid: k, age_ms: Date.now() - v.ts, keys: Object.keys(v) });
  res.status(200).json({ size: out.length, items: out.slice(0, 50) });
});

/* ======================= PII Index (fallback attribution ≤6h) ======================= */
const PII_TTL_MS = IC_TTL_MS;
const PII_INDEX = {
  em: new Map(),   // hash(em)    -> [{ eid, ts }]
  ph: new Map(),   // hash(ph)    -> [{ eid, ts }]
  nm: new Map(),   // hash(fn+ln) -> [{ eid, ts }]
};
function piiclean() {
  const lim = Date.now() - PII_TTL_MS;
  for (const m of [PII_INDEX.em, PII_INDEX.ph, PII_INDEX.nm]) {
    for (const [k, arr] of m.entries()) {
      const next = arr.filter(x => x.ts >= lim);
      if (next.length) m.set(k, next); else m.delete(k);
    }
  }
}
function piiadd(keyMap, key, eid) {
  if (!key || !eid) return;
  const arr = keyMap.get(key) || [];
  arr.push({ eid, ts: Date.now() });
  keyMap.set(key, arr);
}
function piiindexFromUD(eid, ud = {}) {
  const { em, ph, fn, ln } = ud;
  if (em) piiadd(PII_INDEX.em, em, eid);
  if (ph) piiadd(PII_INDEX.ph, ph, eid);
  if (fn && ln) piiadd(PII_INDEX.nm, sha256(`${fn}${ln}`), eid);
  piiclean();
}
function piimatchFromClient(cli = {}) {
  const em = cli.email ? sha256(normEmail(cli.email)) : null;
  const ph = cli.phone ? sha256(normPhone(cli.phone)) : null;
  const fn = cli.firstName ? sha256(lower(cli.firstName)) : null;
  const ln = cli.lastName ? sha256(lower(cli.lastName)) : null;
  const nm = (fn && ln) ? sha256(`${fn}${ln}`) : null;

  piiclean();
  let candidates = [];
  if (em && PII_INDEX.em.get(em)) candidates = candidates.concat(PII_INDEX.em.get(em));
  if (ph && PII_INDEX.ph.get(ph)) candidates = candidates.concat(PII_INDEX.ph.get(ph));
  if (nm && PII_INDEX.nm.get(nm)) candidates = candidates.concat(PII_INDEX.nm.get(nm));
  if (!candidates.length) return null;
  candidates.sort((a,b) => b.ts - a.ts);
  return candidates[0]?.eid || null;
}

/* ======================= De-dup cache (24h) ======================= */
const SENT_CACHE = new Map(); // event_id → ts
const SENT_TTL_MS = 24 * 60 * 60 * 1000;
function alreadySent(eventId) {
  const v = eventId && SENT_CACHE.get(eventId);
  if (!v) return false;
  if (Date.now() - v > SENT_TTL_MS) { SENT_CACHE.delete(eventId); return false; }
  return true;
}
function markSent(eventId) { if (eventId) SENT_CACHE.set(eventId, Date.now()); }

/* ======================= MangoMint helpers ======================= */
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
  if (appt.onlineBookingClientInfo) return true; // preuve online
  const src = (appt.source || appt.createdBy?.type || appt.channel || "").toString().toLowerCase();
  if (src.includes("admin") || src.includes("manual") || src.includes("staff")) return false;
  return false; // on ne compte pas sans signal clair online
}
function isBookedOrScheduled(appt = {}) {
  const st = String(appt.status || "").toLowerCase();
  if (["canceled","cancelled","declined","no_show","no-show","noshow"].includes(st)) return false;
  return ["booked","scheduled","confirmed","pending"].includes(st || "booked");
}
function buildUserDataFromIC(eid, fallbackUD = {}) {
  const fromIC = eid ? icGet(eid) : null;
  const ud = { ...fallbackUD };
  if (fromIC?.fbp && !ud.fbp) ud.fbp = fromIC.fbp;
  if (fromIC?.fbc && !ud.fbc) ud.fbc = fromIC.fbc;
  if (fromIC?.em  && !ud.em ) ud.em  = fromIC.em;
  if (fromIC?.ph  && !ud.ph ) ud.ph  = fromIC.ph;
  if (fromIC?.fn  && !ud.fn ) ud.fn  = fromIC.fn;
  if (fromIC?.ln  && !ud.ln ) ud.ln  = fromIC.ln;
  return ud;
}

/* ======================= /webhooks (IC from Framer) ======================= */
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

    if (event_id) {
      icSet(event_id, { fbp: ud.fbp, fbc: ud.fbc, em: ud.em, ph: ud.ph, fn: ud.fn, ln: ud.ln });
      piiindexFromUD(event_id, ud); // index PII → fallback attribution
    }

    const metaBody = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || EVENT_SOURCE_URL_BOOK,
        action_source,
        event_id,
        user_data: ud,
        // pas de custom_data ici (évite warnings value/currency)
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

/* ======================= Build Purchase payload ======================= */
function mapAppointmentToPurchase(appt, { user_data, test_event_code } = {}) {
  const serviceName =
    appt?.services?.[0]?.service?.name ||
    appt?.services?.[0]?.name ||
    "Appointment";

  const contents = [{
    id: `service:${serviceName}`,
    quantity: 1,
    item_price: APPT_VALUE_NUM,
  }];

  const srcUrl =
    extractReferrer(appt) && extractReferrer(appt).startsWith("http")
      ? extractReferrer(appt)
      : EVENT_SOURCE_URL_BOOK;

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000), // visibile dans Test Events
      action_source: "website",
      event_source_url: srcUrl,
      event_id: appt.__eid__ || String(appt.id || Date.now()),
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

/* ======================= /webhooks/mangomint (Appointment → Purchase) ======================= */
app.post("/webhooks/mangomint", async (req, res) => {
  log("HIT /webhooks/mangomint ip=", clientIp(req));
  try {
    // Secret hybride: header OU query (?key=)
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

    // Diagnostics utiles
    log("DIAG.appt?         =", !!appt);
    log("DIAG.hasOnlineInfo =", !!appt?.onlineBookingClientInfo);
    log("DIAG.referrer      =", extractReferrer(appt || ""));
    if (!appt) return res.status(200).json({ ok: false, msg: "Ignored: no appointment" });
    if (!isOnlineBooking(appt)) return res.status(200).json({ ok: true, skipped: "manual_booking" });
    if (!isBookedOrScheduled(appt)) return res.status(200).json({ ok: true, skipped: "bad_status" });

    // 1) On essaie avec l'eid transmis/URL
    let eid = getEidFromAppointment(appt);

    // 2) Fallback par PII si pas d'eid
    if (!eid) {
      const cliForMatch = appt.clientInfo || appt.onlineBookingClientInfo || {};
      const m = piimatchFromClient(cliForMatch);
      if (m) { eid = m; log("ATTR-FALLBACK → matched IC by PII within 6h:", eid); }
    }

    // User data (merge avec IC si on a un eid)
    const ua = req.headers["user-agent"] || "unknown";
    const baseUD = { client_ip_address: clientIp(req), client_user_agent: ua };
    const cli = appt.clientInfo || appt.onlineBookingClientInfo || {};
    if (cli.email)     baseUD.em = sha256(normEmail(cli.email));
    if (cli.phone)     baseUD.ph = sha256(normPhone(cli.phone));
    if (cli.firstName) baseUD.fn = sha256(lower(cli.firstName));
    if (cli.lastName)  baseUD.ln = sha256(lower(cli.lastName));

    const user_data = buildUserDataFromIC(eid, baseUD);
    const hasAttribution = !!(eid || user_data.fbp || user_data.fbc);
    if (!hasAttribution) { log("SKIP → no attribution (not from Meta ad)"); return res.status(200).json({ ok: true, skipped: "no_attribution" }); }

    // event_id pour Purchase (on privilégie l'eid attribué)
    appt.__eid__ = eid || String(appt.id || Date.now());
    if (alreadySent(appt.__eid__)) {
      log("Dedup: Purchase already sent for", appt.__eid__);
      return res.status(200).json({ ok: true, skipped: "duplicate_event" });
    }

    const body = mapAppointmentToPurchase(appt, { user_data, test_event_code });
    log("SEND → Meta Purchase", { event_id: appt.__eid__, has_eid: !!eid, has_fbp: !!user_data.fbp, has_fbc: !!user_data.fbc });
    const j = await sendToMeta(body);
    markSent(appt.__eid__);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ======================= /webhooks/sale (désactivé par défaut) ======================= */
// Laisse ce endpoint actif mais inutilisé pour éviter d'enregistrer les paiements terminal
app.post("/webhooks/sale", async (req, res) => {
  log("HIT /webhooks/sale ip=", clientIp(req));
  return res.status(200).json({ ok: true, skipped: "sale_endpoint_disabled_for_terminal" });
});

/* ======================= Start ======================= */
app.listen(PORT, () =>
  console.log(`✅ CAPI bridge listening on ${PORT} (value=${APPT_VALUE_NUM} ${DEFAULT_CURRENCY}, DEBUG_LOGS=${DEBUG ? "1":"0"})`)
);
