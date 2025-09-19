// server.js — Clean CAPI bridge for MangoMint + Framer IC (optimisé)
// - IC cache (eid → attribution) 6h
// - Manual vs Online filter (ignore manual/admin)
// - event_id dedup (Purchase réutilise le même eid que l'IC)
// - Attribution stricte (eid ou fbp/fbc requis)
// - Hash PII (SHA-256), normalise phone
// - Purchase (Server) formaté comme le Test A (event_time=now) pour visibilité Test Events
// - Endpoint sale optionnel (désactivé par défaut côté MangoMint)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash } from "node:crypto";

const app = express();

/* ======================= CORS ======================= */
const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];
const corsOptions = {
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
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
  MANGOMINT_WEBHOOK_SECRET,
  DEFAULT_CURRENCY = "CAD",
  EVENT_SOURCE_URL_BOOK = "https://altheatherapie.ca/en/book",
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN");
  process.exit(1);
}
const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

/* ======================= Utils ======================= */
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";

const safeEventTime = (ts) => {
  let t = Math.floor(new Date(ts || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || t > now) t = now;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;
  if (t < sevenDaysAgo) t = now;
  return t;
};

const sha256 = (s = "") => createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
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
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    console.log(`META attempt ${attempt} →`, res.status, json);
    if (res.ok) return json;
    if (res.status >= 500 || res.status === 429) {
      await new Promise(r => setTimeout(r, 300 * attempt));
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

/* ======================= IC Cache (eid → attribution) ======================= */
const IC_CACHE = new Map();
const IC_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function icSet(eid, data) {
  IC_CACHE.set(eid, { ...data, ts: Date.now() });
}
function icGet(eid) {
  const v = IC_CACHE.get(eid);
  if (!v) return null;
  if (Date.now() - v.ts > IC_TTL_MS) { IC_CACHE.delete(eid); return null; }
  return v;
}

/* ======================= Helpers: MangoMint parsing (MAJ) ======================= */
function extractReferrer(appt = {}) {
  return (
    appt?.onlineBookingClientInfo?.referrerUrl ||
    appt?.referrerUrl ||
    appt?.notes ||
    appt?.clientNotes ||
    ""
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

// Online vs Manual
function isOnlineBooking(appt = {}) {
  if (appt.onlineBookingClientInfo) return true; // on exige ce flag pour être sûrs
  const src = (appt.source || appt.createdBy?.type || appt.channel || "").toString().toLowerCase();
  if (src.includes("admin") || src.includes("manual") || src.includes("staff")) return false;
  return false; // par défaut, on NE compte pas sans preuve online
}
function isConfirmed(appt = {}) {
  const st = String(appt.status || "").toLowerCase();
  return ["booked", "confirmed", "scheduled"].includes(st);
}

// Merge IC user_data → purchase
function buildUserDataFromIC(eid, fallbackUD = {}) {
  const fromIC = eid ? icGet(eid) : null;
  const ud = { ...fallbackUD };
  if (fromIC?.fbp) ud.fbp = fromIC.fbp;
  if (fromIC?.fbc) ud.fbc = fromIC.fbc;
  if (fromIC?.em && !ud.em) ud.em = fromIC.em;
  if (fromIC?.ph && !ud.ph) ud.ph = fromIC.ph;
  if (fromIC?.fn && !ud.fn) ud.fn = fromIC.fn;
  if (fromIC?.ln && !ud.ln) ud.ln = fromIC.ln;
  return ud;
}

/* ======================= /webhooks (IC depuis Framer) ======================= */
app.post("/webhooks", async (req, res) => {
  try {
    const bodyIn = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = "website",
      custom_data = { currency: DEFAULT_CURRENCY, value: 0 },
      test_event_code,
      user_data = {},
    } = bodyIn;

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
    }

    const metaBody = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000), // now
        event_source_url: event_source_url || EVENT_SOURCE_URL_BOOK,
        action_source,
        event_id,
        user_data: ud,
        custom_data,
      }],
      access_token: META_ACCESS_TOKEN,
    };
    if (test_event_code) metaBody.test_event_code = test_event_code;

    const j = await sendToMeta(metaBody);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR (/webhooks):", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ========== Formatter Purchase comme le Test A (garantie de visibilité Test Events) ========== */
function mapAppointmentToPurchase(appt, { user_data, test_event_code } = {}) {
  const serviceName =
    appt?.services?.[0]?.service?.name ||
    appt?.services?.[0]?.name ||
    "Appointment";

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000), // now → visible en Test Events
      action_source: "website",
      event_source_url: EVENT_SOURCE_URL_BOOK,
      event_id: appt.__eid__ || String(appt.id || Date.now()),
      user_data,
      custom_data: {
        currency: DEFAULT_CURRENCY,
        value: 0,
        content_name: serviceName
      }
    }],
    access_token: META_ACCESS_TOKEN
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

/* ======================= /webhooks/mangomint (Appointment → Purchase) ======================= */
app.post("/webhooks/mangomint", async (req, res) => {
  try {
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const appt = payload.appointment;
    const test_event_code = payload.test_event_code || req.query.test_event_code;

    if (payload.sale) {
      return res.status(200).json({ ok: true, skipped: "sale_payload_use_/webhooks/sale" });
    }
    if (!appt) return res.status(200).json({ ok: false, msg: "Ignored: no appointment" });

    // 1) Online confirmé uniquement
    if (!isOnlineBooking(appt)) {
      return res.status(200).json({ ok: true, skipped: "manual_booking" });
    }
    if (!isConfirmed(appt)) {
      return res.status(200).json({ ok: true, skipped: "not_confirmed" });
    }

    // 2) Attribution & dédup
    const eid = getEidFromAppointment(appt);
    const ua = req.headers["user-agent"] || "unknown";
    const baseUD = { client_ip_address: clientIp(req), client_user_agent: ua };

    const cli = appt.clientInfo || appt.onlineBookingClientInfo || {};
    if (cli.email) baseUD.em = sha256(normEmail(cli.email));
    if (cli.phone) baseUD.ph = sha256(normPhone(cli.phone));
    if (cli.firstName) baseUD.fn = sha256(lower(cli.firstName));
    if (cli.lastName) baseUD.ln = sha256(lower(cli.lastName));

    const user_data = buildUserDataFromIC(eid, baseUD);

    const hasAttribution = !!(eid || user_data.fbp || user_data.fbc);
    if (!hasAttribution) {
      return res.status(200).json({ ok: true, skipped: "no_attribution" });
    }

    // 3) Evenement formaté comme le Test A (event_time = now)
    appt.__eid__ = eid || String(appt.id || Date.now());
    const body = mapAppointmentToPurchase(appt, { user_data, test_event_code });

    const j = await sendToMeta(body);
    return res.status(200).json({ ok: true, meta: j });

  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ======================= (Optionnel) /webhooks/sale (real paid sale) ======================= */
app.post("/webhooks/sale", async (req, res) => {
  try {
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const sale = payload.sale;
    const appt = payload.appointment;

    if (!sale) return res.status(200).json({ ok: false, msg: "Ignored: no sale" });

    const amount = Number(sale.total || sale.amount || 0) || 0;
    const when = sale.createdAt || sale.dateTime || appt?.createdAt || Date.now();
    const ua = req.headers["user-agent"] || "unknown";

    const eid = appt ? getEidFromAppointment(appt) : null;

    const baseUD = { client_ip_address: clientIp(req), client_user_agent: ua };
    const cli = appt?.clientInfo || appt?.onlineBookingClientInfo || sale?.client || {};
    if (cli.email) baseUD.em = sha256(normEmail(cli.email));
    if (cli.phone) baseUD.ph = sha256(normPhone(cli.phone));
    if (cli.firstName) baseUD.fn = sha256(lower(cli.firstName));
    if (cli.lastName) baseUD.ln = sha256(lower(cli.lastName));

    const user_data = buildUserDataFromIC(eid, baseUD);

    if (!(eid || user_data.fbp || user_data.fbc)) {
      return res.status(200).json({ ok: true, skipped: "no_attribution" });
    }

    const metaBody = {
      data: [{
        event_name: "Purchase",
        event_time: safeEventTime(when),
        action_source: "website",
        event_source_url: EVENT_SOURCE_URL_BOOK,
        event_id: eid || String(sale.id || sale.invoiceId || Date.now()),
        user_data,
        custom_data: { value: amount, currency: DEFAULT_CURRENCY, content_name: "SaleCompleted" },
      }],
      access_token: META_ACCESS_TOKEN,
    };

    const j = await sendToMeta(metaBody);
    return res.status(200).json({ ok: true, meta: j });

  } catch (err) {
    console.error("SALE webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ======================= Start ======================= */
app.listen(PORT, () => console.log(`✅ CAPI bridge listening on ${PORT}`));
