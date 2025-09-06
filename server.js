// server.js — Bridge Render (ESM, Express, CORS, /webhooks + /webhooks/mangomint)

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
  allowedHeaders: ["Content-Type", "X-Webhook-Secret"], // <- micro-amélioration #3
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
// Pré-vol ciblé (micro-amélioration #2)
app.options("/webhooks", cors(corsOptions));
app.options("/webhooks/mangomint", cors(corsOptions));

app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

// ---------- Env ----------
const {
  PORT = 8080,
  META_PIXEL_ID,          // ex: 1214969237001592
  META_ACCESS_TOKEN,      // long token Meta
  MANGOMINT_WEBHOOK_SECRET, // optionnel: pour sécuriser /webhooks/mangomint
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
    } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const metaBody = {
      data: [
        {
          event_name: event_name || "InitiateCheckout",
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: event_source_url || "https://altheatherapie.ca",
          action_source,
          event_id, // doit matcher le Pixel pour Both (déduplication)
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

    // micro-amélioration #1 : logs utiles
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

// Mapper MangoMint -> Meta Purchase
function mapMangoMintToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const client = mm.client || mm.customer || {};
  const appt = mm.appointment || mm.booking || {};
  const sale = mm.sale || mm.payment || mm.order || {};

  const value = toNumber(
    sale.amount ?? sale.total ?? mm.total_amount ?? mm.amount ?? appt.price ?? 0,
    0
  );
  const currency = sale.currency || mm.currency || "CAD";

  const contentName =
    appt.service_name || appt.service || sale.item_name || "MangoMint Purchase";

  const createdAt =
    sale.created_at ||
    sale.timestamp ||
    appt.start_time ||
    mm.timestamp ||
    Date.now();
  const event_time = Math.floor(new Date(createdAt).getTime() / 1000);

  // FBP/FBC si propagés depuis le site vers MangoMint
  const fbp = mm.fbp || mm.browser_id?.fbp || mm.query?.fbp;
  const fbc = mm.fbc || mm.browser_id?.fbc || mm.query?.fbc;

  const event_id = String(mm.event_id || sale.id || appt.id || mm.id || Date.now());

  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time,
        action_source: "website",
        event_source_url: mm.event_source_url || "https://altheatherapie.ca",
        event_id,
        user_data: {
          client_ip_address: ip || "",
          client_user_agent: ua || "unknown",
          ...(fbp ? { fbp } : {}),
          ...(fbc ? { fbc } : {}),
          // OPTIONNEL: ajouter ici em/ph/fn/ln/ct/st/country/zp hashés (SHA-256) si MangoMint les fournit.
        },
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
    // sécurité optionnelle
    if (MANGOMINT_WEBHOOK_SECRET) {
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
      }
    }

    const payload =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const test_event_code =
      payload.test_event_code || req.query.test_event_code;

    const ip = clientIp(req);
    const ua = req.headers["user-agent"] || "unknown";

    const metaBody = mapMangoMintToPurchase(payload, { ip, ua, test_event_code });

    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });

    // micro-amélioration #1 : logs utiles
    console.log("META /webhooks/mangomint status:", r.status);
    const j = await r.json().catch(() => ({}));
    console.log("META /webhooks/mangomint body  :", j);

    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    // 200 pour éviter des retries agressifs; on log l’erreur
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
