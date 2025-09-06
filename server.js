// server.js — Bridge Render (ESM, Express, CORS, Schedule + Purchase)

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

// ---------- Env ----------
const {
  PORT = 8080,
  META_PIXEL_ID,            
  META_ACCESS_TOKEN,        
  MANGOMINT_WEBHOOK_SECRET, 
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN");
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
const safeEventTime = (ts) => {
  let time = Math.floor(new Date(ts || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(time) || time > now) time = now;
  return time;
};

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.send("Mangomint → Meta CAPI bridge OK");
});

// ===================================================================
//  Mapper: Appointment Created → Schedule
// ===================================================================
function mapAppointmentToSchedule(mm, { ip, ua, test_event_code } = {}) {
  const appt = mm.appointment || {};
  const client = appt.clientInfo || appt.onlineBookingClientInfo || {};
  const service = appt.services?.[0]?.service?.name || "Appointment";

  const event_id = String(appt.id || Date.now());
  const event_time = safeEventTime(appt.createdAt);

  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };
  if (client.email) user_data.em = sha256(normalizeEmail(client.email));
  if (client.phone) user_data.ph = sha256(normalizePhone(client.phone));
  if (client.firstName) user_data.fn = sha256(normalizeLower(client.firstName));
  if (client.lastName) user_data.ln = sha256(normalizeLower(client.lastName));

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
          currency: "CAD",
          value: 0,
          content_name: service,
        },
      },
    ],
    access_token: META_ACCESS_TOKEN,
  };

  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

// ===================================================================
//  Mapper: Sale Completed → Purchase
// ===================================================================
function mapMangoMintToPurchase(mm, { ip, ua, test_event_code } = {}) {
  const sale = mm.sale || {};
  const appt = mm.appointment || {};
  const client = sale.client || mm.client || {};

  const email = client.email;
  const phone = client.phone;
  const first = client.firstName;
  const last = client.lastName;

  const user_data = {
    client_ip_address: ip || "",
    client_user_agent: ua || "unknown",
  };
  if (email) user_data.em = sha256(normalizeEmail(email));
  if (phone) user_data.ph = sha256(normalizePhone(phone));
  if (first) user_data.fn = sha256(normalizeLower(first));
  if (last) user_data.ln = sha256(normalizeLower(last));

  const value = toNumber(sale.total ?? sale.amount ?? appt.price ?? 0, 0);
  const currency = sale.currency || "CAD";
  const contentName = appt.services?.[0]?.service?.name || "Purchase";

  const event_id = String(sale.id || appt.id || Date.now());
  const event_time = safeEventTime(sale.createdAt || sale.closedAt);

  const body = {
    data: [
      {
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
      },
    ],
    access_token: META_ACCESS_TOKEN,
  };

  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

// ===================================================================
//  Route — MangoMint Webhook Handler
// ===================================================================
app.post("/webhooks/mangomint", async (req, res) => {
  try {
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

    // Detect event type
    const hasSale = !!payload.sale;
    const hasAppointment = !!payload.appointment;

    const metaBody = hasSale
      ? mapMangoMintToPurchase(payload, { ip, ua, test_event_code })
      : hasAppointment
      ? mapAppointmentToSchedule(payload, { ip, ua, test_event_code })
      : null;

    if (!metaBody) {
      return res.status(200).json({ ok: false, msg: "Ignored payload" });
    }

    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });
    const j = await r.json().catch(() => ({}));
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
