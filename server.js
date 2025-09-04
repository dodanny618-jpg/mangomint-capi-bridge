import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
// Helpers for normalizing + hashing customer data

function sha256(str) {
  return globalThis.crypto
    ? crypto.createHash('sha256').update(str).digest('hex')
    : require('crypto').createHash('sha256').update(str).digest('hex');
}

function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) {
    digits = '+1' + digits; // assume Canada if no country code
  }
  return digits;
}
const app = express();
app.use(express.json({ type: ["application/json", "text/plain"] })); // accept JSON or text

// ---- env ----
const {
  PORT = 8080,
  META_PIXEL_ID,
  META_ACCESS_TOKEN,
  EVENT_SOURCE_URL,
  DEFAULT_CURRENCY = "CAD",
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("Missing META_PIXEL_ID or META_ACCESS_TOKEN");
  process.exit(1);
}

const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ---- helpers ----
const sha256 = (s) =>
  crypto.createHash("sha256").update((s || "").trim().toLowerCase()).digest("hex");

const normalizePhone = (ph) => {
  if (!ph) return "";
  const digits = ph.replace(/\D+/g, "");
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (ph.startsWith("+")) return ph;
  return `+${digits}`;
};

// Map Mangomint webhook → Meta event
function mapToMetaEvent(mm, test_event_code) {
  const evt = (mm.event || mm.type || "").toLowerCase();
  const client = mm.client || mm.customer || {};
  const appt = mm.appointment || mm.booking || {};
  const sale  = mm.sale || mm.payment || {};

  const email = client.email;
  const phone = client.phone || client.mobile;
  const value = Number(sale.amount || appt.price || mm.amount || 0);

  const event = {
    event_name: "Purchase", // hardcoding purchase for now
    event_time: Math.floor(Date.now() / 1000), // seconds
    action_source: "website",
    user_data: buildUserData({ email, phone }),
    custom_data: { value, currency: "CAD" }
  };

  // 👇 Only include if you pass it in from the handler
  if (test_event_code) {
    event.test_event_code = test_event_code;
  }

  return { data: [event] };
}

  let event_name = "Schedule"; // default for appointments
  if (value > 0 && /paid|payment|completed|sale/.test(evt)) event_name = "Purchase";
  else if (/cancell?ed|void/.test(evt)) event_name = "AppointmentCanceled"; // custom

  const event_id = appt.id || sale.id || mm.id || `${Date.now()}-${Math.random()}`;

  const payload = {
    event_name,
    event_time: Math.floor(new Date(mm.timestamp || appt.start_time || Date.now()).getTime() / 1000),
    action_source: "website",
    event_source_url: EVENT_SOURCE_URL, // your /book page
    event_id,
    user_data: {
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(normalizePhone(phone))] : undefined
      // You can add fn, ln, ct, st, zp, country, external_id if available
    },
    custom_data: {
      currency: DEFAULT_CURRENCY,
      value: isFinite(value) ? value : undefined,
      content_name: appt.service_name || appt.service
    }
  };

  // remove empty sub-objects
  if (payload.user_data && !payload.user_data.em && !payload.user_data.ph) delete payload.user_data;
  if (payload.custom_data && !payload.custom_data.value && !payload.custom_data.content_name) delete payload.custom_data;

  return payload;
}

async function sendToMeta(metaEvent) {
  const res = await fetch(`${META_ENDPOINT}?access_token=${META_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [metaEvent] })
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Meta CAPI error:", res.status, text);
  } else {
    console.log("Meta CAPI ok:", text);
  }
}

// Healthcheck
app.get("/", (_req, res) => res.send("Mangomint → Meta CAPI bridge OK"));

// Webhook receiver (give this URL to Mangomint)
app.post("/webhooks/mangomint", async (req, res) => {
  try {
    const mm = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const test_event_code = req.query.test_event_code || req.body?.test_event_code;
console.log('test_event_code:', test_event_code);
    const metaEvent = mapToMetaEvent(mm, test_event_code);
    res.status(200).send("ok"); // acknowledge immediately
    await sendToMeta(metaEvent); // send to Meta
  } catch (e) {
    console.error("Webhook processing error:", e);
    res.status(200).send("ok");
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
