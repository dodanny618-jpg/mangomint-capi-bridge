// server.js — Render (ESM) : /webhooks (IC) + /webhooks/mangomint (Booking→Purchase & Sale→Purchase)
// CORS • Hashing (EMQ) • Safe time • Retry • Logs

// ---------- Core deps ----------
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash } from "node:crypto";

// ---------- App & CORS ----------
const app = express();

const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];

const corsOptions = {
  origin(origin, cb) {
    // Allow server-to-server (no Origin) + your domains
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

// ---------- Env ----------
const {
  PORT = 8080,
  META_PIXEL_ID,            // ex: 1214969237001592
  META_ACCESS_TOKEN,        // long-lived Meta token
  MANGOMINT_WEBHOOK_SECRET, // optional: simple auth for MangoMint webhook
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN (Render → Environment)");
  process.exit(1);
}

const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ---------- Helpers: hashing / normalize ----------
const sha256 = (s = "") =>
  createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

const normEmail = (v) => String(v || "").trim().toLowerCase();
const normPhone = (v) => {
  if (!v) return "";
  let x = String(v).replace(/[^\d+]/g, "");
  if (!x.startsWith("+")) {
    if (x.length === 10) x = `+1${x}`;              // CA/US default
    else if (x.length === 11 && x.startsWith("1")) x = `+${x}`;
    else x = `+${x}`;
  }
  return x;
};
const lower = (v) => String(v || "").trim().toLowerCase();

const isSha256 = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const ensureHashed = (key, raw) => {
  if (!raw) return undefined;
  // Meta expects lowercase SHA-256 of normalized values
  if (isSha256(raw)) return raw;
  if (key === "em") return sha256(normEmail(raw));
  if (key === "ph") return sha256(normPhone(raw));
  return sha256(lower(raw));
};

const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket.remoteAddress ||
  "";

const toNumber = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};

const safeEventTime = (ts) => {
  let t = Math.floor(new Date(ts || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || t > now) t = now;
  // (Optional) clamp to last 7 days if you ever pass historical
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;
  if (t < sevenDaysAgo) t = now;
  return t;
};

// ---------- Meta sender with small retry ----------
async function sendToMeta(body) {
  const url = `${META_ENDPOINT}`;
  const payload = JSON.stringify(body);
  const headers = { "Content-Type": "application/json" };

  let attempt = 0;
  let lastErr;
  while (attempt < 3) {
    attempt++;
    const res = await fetch(`${url}`, { method: "POST", headers, body: payload });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    console.log(`META send attempt ${attempt} status:`, res.status, json);

    if (res.ok) return json;

    // Retry on transient server errors 5xx or rate limiting 4xx specific
    if (res.status >= 500 || res.status === 429) {
      await new Promise(r => setTimeout(r, 300 * attempt)); // simple backoff
      lastErr = new Error(`Meta transient error ${res.status}`);
      continue;
    }
    // For 4xx functional errors, don't retry
    throw new Error(`Meta error ${res.status}: ${text}`);
  }
  throw lastErr || new Error("Meta unknown error");
}

// ---------- Health & comfort ----------
app.get("/", (_req, res) => {
  res.status(200).send("Mangomint → Meta CAPI bridge OK");
});
app.get("/webhooks", (_req, res) => {
  res.status(200).send("POST /webhooks is alive (use POST)");
});
app.get("/webhooks/mangomint", (_req, res) => {
  res.status(200).send("POST /webhooks/mangomint is alive (use POST)");
});

// ===================================================================
// Route 1 — /webhooks : InitiateCheckout (front → CAPI)
//  - Accepts optional user_data { fbp, fbc, em, ph, fn, ln } (raw or hashed)
//  - We always add ip/ua and ensure hashing if raw
// ===================================================================
app.post("/webhooks", async (req, res) => {
  try {
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = "website",
      custom_data = { currency: "CAD", value: 0 },
      test_event_code,
      user_data = {}, // may contain raw or hashed fields
    } = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Build user_data with guaranteed ip/ua and hashed identifiers if present
    const ud = {
      client_ip_address: clientIp(req),
      client_user_agent: req.headers["user-agent"] || "unknown",
    };
    if (user_data.fbp) ud.fbp = user_data.fbp;
    if (user_data.fbc) ud.fbc = user_data.fbc;
    if (user_data.em) ud.em = ensureHashed("em", user_data.em);
    if (user_data.ph) ud.ph = ensureHashed("ph", user_data.ph);
    if (user_data.fn) ud.fn = ensureHashed("fn", user_data.fn);
    if (user_data.ln) ud.ln = ensureHashed("ln", user_data.ln);

    const metaBody = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || "https://altheatherapie.ca",
        action_source,
        event_id, // MUST match Pixel for Both
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

// ===================================================================
// Route 2 — /webhooks/mangomint : Appointment→Purchase & Sale→Purchase
//  - Appointment Created  → Purchase (value=0, booking intent)  [Option B]
//  - Sale Completed       → Purchase (value>0, actual payment)
//  - Adds hashed em/ph/fn/ln when present to boost EMQ
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

  // If you later pass fbp/fbc via MangoMint payload/query, keep them:
  if (mm.fbp) user_data.fbp = mm.fbp;
  if (mm.fbc) user_data.fbc = mm.fbc;

  const body = {
    data: [{
      event_name: "Purchase",                 // 👈 Option B: treat booking as Purchase
      event_time,
      action_source: "website",
      event_source_url: "https://altheatherapie.ca/book",
      event_id,
      user_data,
      custom_data: {
        currency: "CAD",
        value: 0,                             // intent only (no charge)
        content_name: serviceName,
      },
    }],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

function mapSaleToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const sale   = mm.sale || {};
  const appt   = mm.appointment || {};
  const client = sale.client || mm.client || {};

  const value      = toNumber(sale.total ?? sale.amount ?? 0, 0);
  const currency   = sale.currency || "CAD";
  const contentName =
    appt.services?.[0]?.service?.name ||
    appt.services?.[0]?.name ||
    "Purchase";

  const event_id   = String(sale.id || appt.id || Date.now());
  const event_time = safeEventTime(sale.createdAt || sale.closedAt || mm.timeStamp);

  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };
  if (client.email)     user_data.em = sha256(normEmail(client.email));
  if (client.phone)     user_data.ph = sha256(normPhone(client.phone));
  if (client.firstName) user_data.fn = sha256(lower(client.firstName));
  if (client.lastName)  user_data.ln = sha256(lower(client.lastName));

  if (mm.fbp) user_data.fbp = mm.fbp;
  if (mm.fbc) user_data.fbc = mm.fbc;

  const body = {
    data: [{
      event_name: "Purchase",
      event_time,
      action_source: "website",
      event_source_url: "https://altheatherapie.ca",
      event_id,
      user_data,
      custom_data: {
        value,
        currency,
        content_name: contentName,
      },
    }],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

app.post("/webhooks/mangomint", async (req, res) => {
  try {
    // Optional simple auth
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const ip = clientIp(req);
    const ua = req.headers["user-agent"] || "unknown";
    const test_event_code = payload.test_event_code || req.query.test_event_code;

    const hasSale        = !!payload.sale;
    const hasAppointment = !!payload.appointment;

    const metaBody = hasSale
      ? mapSaleToPurchase(payload, { ip, ua, test_event_code })
      : hasAppointment
      ? mapAppointmentToPurchase(payload, { ip, ua, test_event_code })
      : null;

    if (!metaBody) return res.status(200).json({ ok: false, msg: "Ignored payload" });

    const j = await sendToMeta(metaBody);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    // Return 200 to avoid aggressive retries from sources, but log error
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
