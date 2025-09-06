// server.js — Bridge Render (ESM, Express, CORS, /webhooks + /webhooks/mangomint)

// --- Hashing + normalization (for higher EMQ) ---
import { createHash } from "node:crypto";
const sha256 = (s = "") =>
  createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
// Convert to E.164 before hashing (defaults to +1 for 10-digit CA/US)
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
const normalizeLower = (v) => String(v || "").trim().toLowerCase();

// ---------- Core deps ----------
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// ---------- App & CORS ----------
const app = express();

const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];

const corsOptions = {
  origin(origin, cb) {
    // Autorise Postman/curl (pas d'Origin) + tes domaines
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Webhook-Secret"], // allow secret header
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.options("/webhooks", cors(corsOptions));
app.options("/webhooks/mangomint", cors(corsOptions));

app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

// ---------- Env ----------
const {
  PORT = 8080,
  META_PIXEL_ID,            // ex: 1214969237001592
  META_ACCESS_TOKEN,        // long Meta token
  MANGOMINT_WEBHOOK_SECRET, // optional: secure MM webhook
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN (Render → Environment)");
  process.exit(1);
}

const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ---------- Helpers ----------
const toNumber = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket.remoteAddress ||
  "";

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.send("Mangomint → Meta CAPI bridge OK");
});

// ===================================================================
//  Route 1 — /webhooks  (InitiateCheckout depuis le site - FRONT → CAPI)
// ===================================================================
app.post("/webhooks", async (req, res) => {
  try {
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = "website",
      custom_data = { currency: "CAD", value: 0 },
      test_event_code, // visible en Test Events si présent
    } = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const metaBody = {
      data: [
        {
          event_name: event_name || "InitiateCheckout",
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: event_source_url || "https://altheatherapie.ca",
          action_source,
          event_id, // doit matcher le Pixel pour déduplication
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
//  Route 2 — /webhooks/mangomint  (Purchase depuis MangoMint - SERVER → CAPI)
// ===================================================================

// Mapper MangoMint -> Meta Purchase (EMQ boosted: hashed em/ph/fn/ln + fbp/fbc)
function mapMangoMintToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const client = mm.client || mm.customer || {};
  const appt   = mm.appointment || mm.booking || {};
  const sale   = mm.sale || mm.payment || mm.order || {};

  // --- fields confirmed by MangoMint for you ---
  const email = client.email;
  const phone = client.phone || client.mobile;
  const first = client.first_name || client.firstName || client.given_name;
  const last  = client.last_name  || client.lastName  || client.family_name;
  const externalId = client.id || client.customer_id || client.customerId; // optional

  // Build user_data (minimum + hashed identifiers)
  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };

  // Keep browser IDs if you pass them through booking link
  const fbp = mm.fbp || mm.browser_id?.fbp || mm.query?.fbp;
  const fbc = mm.fbc || mm.browser_id?.fbc || mm.query?.fbc;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  // Hashed IDs (only if present)
  if (email)   user_data.em = sha256(normalizeEmail(email));
  if (phone)   user_data.ph = sha256(normalizePhone(phone));
  if (first)   user_data.fn = sha256(normalizeLower(first));
  if (last)    user_data.ln = sha256(normalizeLower(last));
  if (externalId) user_data.external_id = sha256(String(externalId));

  // Value & context
  const value = toNumber(
    sale.amount ?? sale.total ?? mm.total_amount ?? mm.amount ?? appt.price ?? 0,
    0
  );
  const currency = sale.currency || mm.currency || "CAD";

  const contentName =
    appt.service_name || appt.service || sale.item_name || "MangoMint Purchase";

  const createdAt =
    sale.created_at || sale.timestamp || appt.start_time || mm.timestamp || Date.now();
  const event_time = Math.floor(new Date(createdAt).getTime() / 1000);

  // Use stable id for dedup (prefer sale.id / appt.id)
  const event_id = String(mm.event_id || sale.id || appt.id || mm.id || Date.now());

  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time,
        action_source: "website",
        event_source_url: mm.event_source_url || "https://altheatherapie.ca",
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

app.post("/webhooks/mangomint", async (req, res) => {
  try {
    // simple optional auth
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
    // 200 to avoid aggressive retries; we log the error
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
