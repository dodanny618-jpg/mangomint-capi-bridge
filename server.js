// server.js — Render (ESM) : /webhooks (IC) + /webhooks/mangomint (Schedule/Purchase) + CORS + logs
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
  META_ACCESS_TOKEN,        // ton long token Meta
  MANGOMINT_WEBHOOK_SECRET, // optionnel
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN (Render → Environment)");
  process.exit(1);
}

const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ---------- Helpers ----------
const clientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket.remoteAddress || "";

const toNumber = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};

const safeEventTime = (ts) => {
  let t = Math.floor(new Date(ts || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || t > now) t = now;
  return t;
};

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.status(200).send("Mangomint → Meta CAPI bridge OK");
});

// (Confort) éviter le “Cannot GET/POST”
app.get("/webhooks", (_req, res) => {
  res.status(200).send("POST /webhooks is alive (use POST)");
});
app.get("/webhooks/mangomint", (_req, res) => {
  res.status(200).send("POST /webhooks/mangomint is alive (use POST)");
});

// ===================================================================
// Route 1 — /webhooks : InitiateCheckout (front → CAPI)
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
      user_data, // facultatif: { fbp, fbc, em, ph, fn, ln }
    } = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const metaBody = {
      data: [{
        event_name: event_name || "InitiateCheckout",
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || "https://altheatherapie.ca",
        action_source,
        event_id, // DOIT matcher le Pixel
        user_data: {
          client_ip_address: clientIp(req),
          client_user_agent: req.headers["user-agent"] || "unknown",
          ...(user_data || {})
        },
        custom_data,
      }],
      access_token: META_ACCESS_TOKEN,
    };
    if (test_event_code) metaBody.test_event_code = test_event_code;

    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });
    const j = await r.json().catch(()=> ({}));
    console.log("META /webhooks status:", r.status, j);
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR (/webhooks):", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ===================================================================
// Route 2 — /webhooks/mangomint : Schedule / Purchase (MangoMint → CAPI)
// ===================================================================

function mapAppointmentToSchedule(mm, { ip, ua, test_event_code } = {}) {
  const appt = mm.appointment || {};
  const client = appt.clientInfo || appt.onlineBookingClientInfo || {};
  const serviceName = appt.services?.[0]?.service?.name || "Appointment";

  const event_id = String(appt.id || Date.now());
  const event_time = safeEventTime(appt.createdAt);

  const body = {
    data: [{
      event_name: "Schedule",
      event_time,
      action_source: "website",
      event_source_url: "https://altheatherapie.ca/book",
      event_id,
      user_data: {
        client_ip_address: ip || "",
        client_user_agent: ua || "unknown",
        // (optionnel) ajoute ici em/ph/fn/ln hashés si tu les reçois
      },
      custom_data: {
        currency: "CAD",
        value: 0,
        content_name: serviceName,
      },
    }],
    access_token: META_ACCESS_TOKEN,
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

function mapMangoMintToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const sale = mm.sale || {};
  const appt = mm.appointment || {};
  const client = sale.client || mm.client || {};

  const value = toNumber(sale.total ?? sale.amount ?? 0, 0);
  const currency = sale.currency || "CAD";
  const contentName = appt.services?.[0]?.service?.name || "Purchase";

  const event_id = String(sale.id || appt.id || Date.now());
  const event_time = safeEventTime(sale.createdAt || sale.closedAt);

  const body = {
    data: [{
      event_name: "Purchase",
      event_time,
      action_source: "website",
      event_source_url: "https://altheatherapie.ca",
      event_id,
      user_data: {
        client_ip_address: ip || "",
        client_user_agent: ua || "unknown",
        // (optionnel) fbp/fbc si tu les fais remonter
      },
      custom_data: { value, currency, content_name: contentName },
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

    const hasSale = !!payload.sale;
    const hasAppointment = !!payload.appointment;

    const metaBody = hasSale
      ? mapMangoMintToPurchase(payload, { ip, ua, test_event_code })
      : hasAppointment
      ? mapAppointmentToSchedule(payload, { ip, ua, test_event_code })
      : null;

    if (!metaBody) return res.status(200).json({ ok: false, msg: "Ignored payload" });

    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });
    const j = await r.json().catch(()=> ({}));
    console.log("META /webhooks/mangomint status:", r.status, j);

    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
