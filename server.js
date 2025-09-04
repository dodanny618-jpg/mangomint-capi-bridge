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

// ---- mapper: MangoMint webhook -> Meta CAPI Purchase (ENRICHED) ----
function mapToMetaEvent(mm, { test_event_code, ip, ua } = {}) {
  // Likely shapes from MangoMint
  const client = mm.client || mm.customer || {};
  const appt   = mm.appointment || mm.booking || {};
  const sale   = mm.sale || mm.payment || {};

  // Core identifiers
  const email = client.email;
  const phone = client.phone || client.mobile;

  // Extra identifiers (common key variants)
  const fn      = client.first_name || client.firstName || client.given_name;
  const ln      = client.last_name  || client.lastName  || client.family_name;
  const city    = client.city;
  const state   = client.state || client.province || client.region;
  const country = client.country || "CA";
  const zip     = client.zip || client.postal_code || client.postalCode || client.postcode;
  const externalId = client.id || client.customer_id || client.customerId; // optional

  // Build user_data (normalize + SHA256 hash where required)
  const user_data = {};
  if (email)   user_data.em = sha256(normalizeEmail(email));
  if (phone)   user_data.ph = sha256(normalizePhone(phone));
  if (fn)      user_data.fn = sha256(String(fn).trim().toLowerCase());
  if (ln)      user_data.ln = sha256(String(ln).trim().toLowerCase());
  if (city)    user_data.ct = sha256(String(city).trim().toLowerCase());
  if (state)   user_data.st = sha256(String(state).trim().toLowerCase());
  if (country) user_data.country = sha256(String(country).trim().toLowerCase());
  if (zip)     user_data.zp = sha256(String(zip).replace(/\s+/g, "").toLowerCase()); // e.g., H2X1Y4
  if (externalId) user_data.external_id = sha256(String(externalId)); // optional but boosts match

  // Network/browser matchers
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;

  // Click/browser IDs (from your site)
  if (mm.fbp) user_data.fbp = mm.fbp;
  if (mm.fbc) user_data.fbc = mm.fbc;

  // Value & timing
  const value = Number(sale.amount ?? appt.price ?? mm.total_amount ?? mm.amount ?? 0) || 0;
  const createdAt  = mm.timestamp || appt.start_time || appt.created_at || sale.created_at || Date.now();
  const event_time = Math.floor(new Date(createdAt).getTime() / 1000);

  // Build event
  const event = {
    event_name: "Purchase",
    event_time,
    action_source: "website",
    event_source_url: EVENT_SOURCE_URL, // your domain, not mangomint.com
    event_id: String(mm.id || appt.id || sale.id || Date.now()),
    user_data,
    custom_data: {
      value,
      currency: DEFAULT_CURRENCY,
      content_name: appt.service_name || appt.service || "Massage booking",
    },
};

  // test_event_code must be top-level
  const body = { data: [event] };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
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