// server.js — Bridge Render (ESM, Express, CORS, /webhooks + /webhooks/mangomint)

import { createHash } from "node:crypto";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

/* ===================== Hashing + Normalization ===================== */
const sha256 = (s = "") =>
  createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
// E.164 before hashing (defaults to +1 for 10-digit CA/US)
const normalizePhone = (ph) => {
  if (!ph) return "";
  let x = String(ph).replace(/[^\d+]/g, "");
  if (!x.startsWith("+")) {
    if (x.length === 10) x = `+1${x}`;
    else if (x.length === 11 && x.startsWith("1")) x = `+${x}`;
    else x = `+${x}`;
  }
  return x;
};
const lower = (v) => String(v || "").trim().toLowerCase();
const normalizePostal = (v) => String(v || "").replace(/\s+/g, "").trim().toLowerCase();

/* ===================== App & CORS ===================== */
const app = express();
const allowedOrigins = ["https://altheatherapie.ca", "https://www.altheatherapie.ca"];
const corsOptions = {
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Webhook-Secret"],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.options("/webhooks", cors(corsOptions));
app.options("/webhooks/mangomint", cors(corsOptions));
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

/* ===================== Env ===================== */
const {
  PORT = 8080,
  META_PIXEL_ID,             // ex: 1214969237001592
  META_ACCESS_TOKEN,         // Meta long-lived token
  MANGOMINT_WEBHOOK_SECRET,  // optional shared secret
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN (Render → Environment)");
  process.exit(1);
}
const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

/* ===================== Helpers ===================== */
const toNumber = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";

/** safeEventTime: garantit un timestamp en secondes, jamais futur, pas plus vieux que 7 jours */
function safeEventTime(createdAtLike) {
  let ms = new Date(createdAtLike || Date.now()).getTime();
  if (!Number.isFinite(ms)) ms = Date.now();
  let ts = Math.floor(ms / 1000);
  const now = Math.floor(Date.now() / 1000);
  const sevenDays = 7 * 24 * 60 * 60;
  if (ts > now) ts = now;                // jamais dans le futur
  if (ts < now - sevenDays) ts = now;    // pas plus vieux que 7 jours
  return ts;
}

/* ===================== Health ===================== */
app.get("/", (_req, res) => res.send("Mangomint → Meta CAPI bridge OK"));

/* ===================== /webhooks (InitiateCheckout Browser→Server) ===================== */
app.post("/webhooks", async (req, res) => {
  try {
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = "website",
      custom_data = { currency: "CAD", value: 0 },
      test_event_code,
    } = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const metaBody = {
      data: [
        {
          event_name: event_name || "InitiateCheckout",
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: event_source_url || "https://altheatherapie.ca",
          action_source,
          event_id,
          user_data: {
            client_ip_address: clientIp(req),
            client_user_agent: req.headers["user-agent"] || "unknown",
          },
          custom_data,
        },
      ],
      access_token: META_ACCESS_TOKEN,
    };
    if (test_event_code) metaBody.test_event_code = test_event_code;

    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });
    console.log("META /webhooks status:", r.status);
    const j = await r.json().catch(() => ({}));
    console.log("META /webhooks body  :", j);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR (/webhooks):", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ===================== Mapper SALE → Purchase (CAPI) ===================== */
function mapMangoMintToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const sale = mm.sale || {};
  const lineItem = (mm.lineItems && mm.lineItems[0]) || {};
  const saleClient = sale.client || lineItem.client || {};

  // Valeur & devise (priorité sale.total, sinon lineItem.finalPrice)
  const value = toNumber(sale.total ?? lineItem.finalPrice ?? 0, 0);
  const currency = sale.currency || "CAD";

  // Libellé
  const contentName = lineItem.name || "MangoMint Purchase";

  // Horodatage (sale.closedAt > sale.createdAt > mm.timeStamp > now)
  const createdAt = mm.timeStamp || sale.closedAt || sale.createdAt || Date.now();
  const event_time = safeEventTime(createdAt);

  // event_id stable
  const event_id = String(mm.event_id || sale.id || Date.now());

  // user_data : IP/UA + IDs hashés
  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };
  if (saleClient.email) user_data.em = sha256(normalizeEmail(saleClient.email));
  if (saleClient.phone) user_data.ph = sha256(normalizePhone(saleClient.phone));
  if (saleClient.firstName) user_data.fn = sha256(lower(saleClient.firstName));
  if (saleClient.lastName) user_data.ln = sha256(lower(saleClient.lastName));

  // Bonus si dispo
  const zip = saleClient.zipcode || saleClient.postal_code || saleClient.postalCode || null;
  const city = saleClient.city || null;
  const province = saleClient.state || saleClient.province || null;
  const country = saleClient.country || null;
  if (zip) user_data.zp = sha256(normalizePostal(zip));
  if (city) user_data.ct = sha256(lower(city));
  if (province) user_data.st = sha256(lower(province));
  if (country) user_data.country = sha256(lower(country || "CA"));

  // Browser IDs si tu les fais passer un jour
  const fbp = mm.fbp || mm.browser_id?.fbp || mm.query?.fbp;
  const fbc = mm.fbc || mm.browser_id?.fbc || mm.query?.fbc;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  // event_source_url enrichi si reçu
  const event_source_url = sale.receiptUrl || mm.event_source_url || "https://altheatherapie.ca";

  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time,
        action_source: "website",
        event_source_url,
        event_id,
        user_data,
        custom_data: {
          value,
          currency,
          content_name: contentName,
        },
      },
    ],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

/* ===================== Mapper APPOINTMENT → Schedule (CAPI) ===================== */
function mapAppointmentToSchedule(mm, { ip, ua, test_event_code } = {}) {
  const appt = mm.appointment || {};
  const client = appt.onlineBookingClientInfo || appt.clientInfo || {};
  const service0 = (appt.services && appt.services[0]) || {};
  const price = service0.price ? Number(service0.price) : 0;
  const serviceName = service0.service?.name || "Appointment booked";

  // user_data (IP/UA + hash IDs)
  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };
  if (client.email) user_data.em = sha256(normalizeEmail(client.email));
  if (client.phone) user_data.ph = sha256(normalizePhone(client.phone));
  if (client.firstName) user_data.fn = sha256(lower(client.firstName));
  if (client.lastName) user_data.ln = sha256(lower(client.lastName));

  const event_time = safeEventTime(appt.createdAt || mm.createdAt || Date.now());
  const event_id = String(appt.id || Date.now());

  const body = {
    data: [
      {
        event_name: "Schedule",
        event_time,
        action_source: "website",
        event_source_url: "https://altheatherapie.ca/book",
        event_id,
        user_data,
        custom_data: {
          value: Number.isFinite(price) ? price : 0,
          currency: "CAD",
          content_name: serviceName,
        },
      },
    ],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

/* ===================== /webhooks/mangomint (Server→CAPI) ===================== */
app.post("/webhooks/mangomint", async (req, res) => {
  try {
    // Secret optionnel
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const test_event_code = payload.test_event_code || req.query.test_event_code;
    const ip = clientIp(req);
    const ua = req.headers["user-agent"] || "unknown";

    // Choix dynamique du mapper selon la forme du payload
    const hasSale = !!payload.sale;
    const hasAppointment = !!payload.appointment;

    const metaBody = hasSale
      ? mapMangoMintToPurchase(payload, { ip, ua, test_event_code })    // → Purchase
      : hasAppointment
      ? mapAppointmentToSchedule(payload, { ip, ua, test_event_code })  // → Schedule
      : null;

    if (!metaBody) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });
    console.log("META /webhooks/mangomint status:", r.status);
    const j = await r.json().catch(() => ({}));
    console.log("META /webhooks/mangomint body  :", j);

    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

/* ===================== Start ===================== */
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
