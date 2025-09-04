// --- server.js (clean, ESM-safe) ---
import express from "express";
import { createHash } from "node:crypto";

// Use Node's built-in fetch (Node 18+). If you prefer node-fetch, you can import it.

const app = express();
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

// ---- env ----
const {
  PORT = 8080,
  META_PIXEL_ID,
  META_ACCESS_TOKEN,
  EVENT_SOURCE_URL = "https://example.com/booking/thank-you",
  DEFAULT_CURRENCY = "CAD",
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("Missing META_PIXEL_ID or META_ACCESS_TOKEN");
  process.exit(1);
}

const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ---- helpers ----
const sha256 = (s = "") => createHash("sha256").update(s).digest("hex");

const normalizeEmail = (email) => (email ?? "").trim().toLowerCase();

const normalizePhone = (ph) => {
  if (!ph) return "";
  // keep digits and +, coerce to E.164 (+1 for CA if missing)
  let x = String(ph).replace(/[^\d+]/g, "");
  if (!x.startsWith("+")) x = x.length === 10 ? `+1${x}` : `+${x}`;
  return x;
};

// ---- mapper: MangoMint webhook -> Meta CAPI Purchase ----
function mapToMetaEvent(mm, { test_event_code, ip, ua } = {}) {
  const client = mm.client || mm.customer || {};
  const appt = mm.appointment || mm.booking || {};
  const sale = mm.sale || mm.payment || {};

  const email = client.email;
  const phone = client.phone || client.mobile;

  // Hash identifiers (normalized)
  const user_data = {};
  if (email) user_data.em = sha256(normalizeEmail(email));
  if (phone) user_data.ph = sha256(normalizePhone(phone));
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  // If you capture these on the browser and pipe them through, include them:
  if (mm.fbp) user_data.fbp = mm.fbp;
  if (mm.fbc) user_data.fbc = mm.fbc;

  // Determine value and timestamp
  const value =
    Number(sale.amount ?? appt.price ?? mm.total_amount ?? mm.amount ?? 0) || 0;

  // event_time must be seconds
  const createdAt =
    mm.timestamp || appt.start_time || appt.created_at || sale.created_at || Date.now();
  const event_time = Math.floor(new Date(createdAt).getTime() / 1000);

  const event = {
    event_name: "Purchase",
    event_time,
    action_source: "website",
    event_source_url: EVENT_SOURCE_URL,
    event_id: String(mm.id || appt.id || sale.id || Date.now()),
    user_data,
    custom_data: {
      value,
      currency: DEFAULT_CURRENCY,
      content_name: appt.service_name || appt.service || "Massage booking",
    },
  };

  if (test_event_code) event.test_event_code = test_event_code;

  // Meta expects { data: [ { ...event } ] }
  return { data: [event] };
}

// ---- sender ----
async function sendToMeta(body) {
  const url = `${META_ENDPOINT}?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("Meta response status:", res.status);
  console.log("Meta response body  :", text);
  if (!res.ok) throw new Error(`Meta CAPI error ${res.status}: ${text}`);
}

// ---- routes ----
app.get("/", (_req, res) => res.send("Mangomint → Meta CAPI bridge OK"));

app.post("/webhooks/mangomint", async (req, res) => {
  try {
    const mm = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // read test_event_code from query or body
    const test_event_code = req.query.test_event_code || mm?.test_event_code;
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .toString()
      .split(",")[0]
      .trim();
    const ua = req.headers["user-agent"] || "unknown";

    const payload = mapToMetaEvent(mm, { test_event_code, ip, ua });

    // Acknowledge immediately, then send async (keeps MangoMint fast)
    res.status(200).send("ok");
    await sendToMeta(payload);
  } catch (e) {
    console.error("Webhook processing error:", e);
    // Still return 200 so MangoMint doesn't retry forever
    res.status(200).send("ok");
  }
});

// ---- start ----
app.listen(PORT, () => console.log(`Listening on ${PORT}`));