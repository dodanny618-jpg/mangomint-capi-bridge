// server.js — Bridge Render (ESM, Express, CORS, /webhooks + /webhooks/mangomint)

import { createHash } from "node:crypto";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// ------- Hashing + normalization -------
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

// ------- App & CORS -------
const app = express();
const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];
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

// ------- Env -------
const {
  PORT = 8080,
  META_PIXEL_ID,            // ex: 1214969237001592
  META_ACCESS_TOKEN,        // Meta long-lived token
  MANGOMINT_WEBHOOK_SECRET, // optional shared secret
} = process.env;
if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN (Render → Environment)");
  process.exit(1);
}
const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ------- Helpers -------
const toNumber = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket.remoteAddress ||
  "";

app.get("/", (_req, res) => res.send("Mangomint → Meta CAPI bridge OK"));

// ===================================================================
// Route 1 — /webhooks  (InitiateCheckout depuis le site - FRONT → CAPI)
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

// ===================================================================
// Route 2 — /webhooks/mangomint  (Purchase SERVER → CAPI)
// Supporte :
//  - Appointment webhook (booking created)
//  - SaleCompleted webhook (vente clôturée)
// ===================================================================

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

function mapMangoMintToPurchase(mm, { ip, ua, test_event_code } = {}) {
  // ---- Préfère le webhook de vente si présent ----
  const sale = mm.sale || {};
  const lineItem = (mm.lineItems && mm.lineItems[0]) || {};
  const saleClient = sale.client || lineItem.client || {};

  // ---- Fallback si c'est un webhook d'appointment (booking créé) ----
  const appt = mm.appointment || {};
  const apptClient =
    appt.onlineBookingClientInfo || appt.clientInfo || {};

  // ---- Client fields (priorité sale.client > appointment.clientInfo) ----
  const client = Object.keys(saleClient).length ? saleClient : apptClient;

  // ---- Valeur & devise ----
  const value =
    toNumber(sale.total, NaN) ??
    toNumber(lineItem.finalPrice, NaN) ??
    toNumber(appt.services?.[0]?.price, 0);
  const currency = sale.currency || "CAD";

  // ---- Libellé du contenu ----
  const contentName =
    lineItem.name ||
    appt.services?.[0]?.service?.name ||
    "MangoMint Purchase";

  // ---- Horodatage (sale.closedAt > sale.createdAt > appt.createdAt > now) ----
  const createdAt =
    mm.timeStamp || // top-level in SaleCompleted
    sale.closedAt ||
    sale.createdAt ||
    appt.createdAt ||
    Date.now();
  const event_time = safeEventTime(createdAt);

  // ---- event_id stable (sale.id prioritaire) ----
  const event_id = String(
    mm.event_id || sale.id || appt.id || Date.now()
  );

  // ---- user_data : IP/UA + hashed IDs + fbp/fbc si dispo ----
  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };

  if (client.email) user_data.em = sha256(normalizeEmail(client.email));
  if (client.phone) user_data.ph = sha256(normalizePhone(client.phone));
  if (client.firstName) user_data.fn = sha256(lower(client.firstName));
  if (client.lastName) user_data.ln = sha256(lower(client.lastName));

  // Bonus : si MangoMint renseigne un address
  const zip =
    client.zipcode || client.postal_code || client.postalCode || null;
  const city = client.city || null;
  const province = client.state || client.province || null;
  const country = client.country || null;

  if (zip) user_data.zp = sha256(normalizePostal(zip));
  if (city) user_data.ct = sha256(lower(city));
  if (province) user_data.st = sha256(lower(province));
  if (country) user_data.country = sha256(lower(country || "CA"));

  // Browser IDs si tu les fais passer un jour
  const fbp = mm.fbp || mm.browser_id?.fbp || mm.query?.fbp;
  const fbc = mm.fbc || mm.browser_id?.fbc || mm.query?.fbc;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  // ---- event_source_url : priorité au receiptUrl, sinon domaine ----
  const event_source_url =
    sale.receiptUrl ||
    mm.event_source_url ||
    "https://altheatherapie.ca";

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
          value: Number.isFinite(value) ? value : 0,
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

app.post("/webhooks/mangomint", async (req, res) => {
  try {
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const test_event_code = payload.test_event_code || req.query.test_event_code;

    const ip = clientIp(req);
    const ua = req.headers["user-agent"] || "unknown";

    const metaBody = mapMangoMintToPurchase(payload, { ip, ua, test_event_code });

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

// ------- Start -------
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
