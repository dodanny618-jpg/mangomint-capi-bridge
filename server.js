// server.js — Option A (Appointment → Purchase, ignore real Sale)
// Routes: /webhooks (IC from site) + /webhooks/mangomint (appointment-as-purchase)
// CORS • Safe time • Hashed identifiers • Simple retry

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash } from "node:crypto";

const app = express();

// --- CORS (allow your site + server-to-server) ---
const allowedOrigins = ["https://altheatherapie.ca", "https://www.altheatherapie.ca"];
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

// --- ENV ---
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

// --- Helpers: time, ids, hashing ---
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
const lower = (v) => String(v || "").trim().toLowerCase();

// --- Sender with tiny retry/backoff ---
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

// --- Health & comfort ---
app.get("/", (_req, res) => res.status(200).send("Mangomint → Meta CAPI (Option A) OK"));
app.get("/webhooks", (_req, res) => res.status(200).send("POST /webhooks is alive (use POST)"));
app.get("/webhooks/mangomint", (_req, res) => res.status(200).send("POST /webhooks/mangomint is alive (use POST)"));

// ===================================================================
// Route 1 — /webhooks : InitiateCheckout (front → CAPI)
// (unchanged; still forwards IC with ip/ua & optional user_data)
// ===================================================================
app.post("/webhooks", async (req, res) => {
  try {
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = "website",
      custom_data = { currency: DEFAULT_CURRENCY, value: 0 },
      test_event_code,
      user_data = {}, // may contain fbp/fbc/em/ph/fn/ln (raw or hashed)
    } = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

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

    const body = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || EVENT_SOURCE_URL_BOOK,
        action_source,
        event_id,           // must match Pixel for Both
        user_data: ud,
        custom_data,
      }],
      access_token: META_ACCESS_TOKEN,
    };
    if (test_event_code) body.test_event_code = test_event_code;

    const j = await sendToMeta(body);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR (/webhooks):", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ===================================================================
// Route 2 — /webhooks/mangomint : Appointment → Purchase (value=0)
//            SaleCompleted  → IGNORED  (no duplicate Purchases)
// ===================================================================
function mapAppointmentToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const appt   = mm.appointment || {};
  const client = appt.clientInfo || appt.onlineBookingClientInfo || {};
  const serviceName =
    appt.services?.[0]?.service?.name ||
    appt.services?.[0]?.name ||
    "Appointment";

  const event_id   = String(appt.id || Date.now());
  const event_time = safeEventTime(appt.createdAt || appt.dateTime);

  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };
  if (client.email)     user_data.em = sha256(normEmail(client.email));
  if (client.phone)     user_data.ph = sha256(normPhone(client.phone));
  if (client.firstName) user_data.fn = sha256(lower(client.firstName));
  if (client.lastName)  user_data.ln = sha256(lower(client.lastName));

  const body = {
    data: [{
      event_name: "Purchase",                 // <-- key change (Option A)
      event_time,
      action_source: "website",
      event_source_url: EVENT_SOURCE_URL_BOOK,
      event_id,
      user_data,
      custom_data: { value: 0, currency: DEFAULT_CURRENCY, content_name: serviceName },
    }],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

app.post("/webhooks/mangomint", async (req, res) => {
  try {
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const ip = clientIp(req);
    const ua = req.headers["user-agent"] || "unknown";
    const test_event_code = payload.test_event_code || req.query.test_event_code;

    // If MangoMint sent a SaleCompleted payload, IGNORE it.
    if (payload.sale) {
      console.log("Skipping SaleCompleted (Option A)");
      return res.status(200).json({ ok: true, skipped: "sale" });
    }

    // Only process Appointment (Created / Updated / Deleted → we use Created)
    if (payload.appointment) {
      const body = mapAppointmentToPurchase(payload, { ip, ua, test_event_code });
      const j = await sendToMeta(body);
      return res.status(200).json({ ok: true, meta: j });
    }

    return res.status(200).json({ ok: false, msg: "Ignored payload" });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// --- Start ---
app.listen(PORT, () => console.log(`✅ Option A bridge listening on ${PORT}`));
