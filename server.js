// server.js — Render (ESM) : /webhooks (IC) + /webhooks/mangomint (Schedule & Purchase)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { createHash } from "node:crypto";

const app = express();

/* ===== CORS (allow your site + server-to-server) ===== */
const allowedOrigins = ["https://altheatherapie.ca","https://www.altheatherapie.ca"];
app.use(cors({
  origin(origin, cb){ if(!origin || allowedOrigins.includes(origin)) return cb(null,true); return cb(new Error("Not allowed by CORS")); },
  methods:["GET","POST","OPTIONS"],
  allowedHeaders:["Content-Type","X-Webhook-Secret"],
  optionsSuccessStatus:204
}));
app.options("*", cors());

/* ===== ENV ===== */
const {
  PORT = 8080,
  META_PIXEL_ID,            // e.g. 1214969237001592
  META_ACCESS_TOKEN,        // your long-lived token
  MANGOMINT_WEBHOOK_SECRET, // optional
} = process.env;
if (!META_PIXEL_ID || !META_ACCESS_TOKEN){ console.error("Missing META_PIXEL_ID or META_ACCESS_TOKEN"); process.exit(1); }
const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

/* ===== Small helpers ===== */
const clientIp = (req) => req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
const safeEventTime = (ts) => {
  let t = Math.floor(new Date(ts || Date.now()).getTime() / 1000);
  const now = Math.floor(Date.now()/1000);
  if (!Number.isFinite(t) || t > now) t = now;
  if (t < now - 7*24*60*60) t = now; // clamp to last 7 days
  return t;
};
const sha256 = (s="") => createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const normEmail = (v) => String(v||"").trim().toLowerCase();
const normPhone = (v) => {
  if(!v) return "";
  let x = String(v).replace(/[^\d+]/g,"");
  if(!x.startsWith("+")){
    if(x.length===10) x = `+1${x}`;
    else if(x.length===11 && x.startsWith("1")) x = `+${x}`;
    else x = `+${x}`;
  }
  return x;
};

async function sendToMeta(body){
  const res = await fetch(META_ENDPOINT, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(()=>({}));
  console.log("META status:", res.status, j);
  return j;
}

/* ===== Health ===== */
app.get("/", (_req,res)=> res.status(200).send("Mangomint → Meta CAPI bridge OK"));
app.get("/webhooks", (_req,res)=> res.status(200).send("POST /webhooks is alive"));
app.get("/webhooks/mangomint", (_req,res)=> res.status(200).send("POST /webhooks/mangomint is alive"));

app.use(express.json({ limit:"1mb", type:["application/json","text/plain"] }));

/* ===================================================================
   Route 1 — /webhooks : InitiateCheckout (front → CAPI)
   - expects { event_name, event_id, event_source_url, action_source, custom_data, user_data?, test_event_code? }
   - we add ip/ua; pass through fbp/fbc from user_data if sent
=================================================================== */
app.post("/webhooks", async (req,res)=>{
  try{
    const {
      event_name = "InitiateCheckout",
      event_id,
      event_source_url = "https://altheatherapie.ca",
      action_source = "website",
      custom_data = { currency:"CAD", value:0 },
      user_data = {},                    // may include { fbp, fbc, em, ph, fn, ln } (raw or hashed; we’ll just pass through)
      test_event_code
    } = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const metaBody = {
      data:[{
        event_name,
        event_time: Math.floor(Date.now()/1000),
        event_source_url,
        action_source,
        event_id, // MUST match Pixel for Both
        user_data: {
          client_ip_address: clientIp(req),
          client_user_agent: req.headers["user-agent"] || "unknown",
          ...user_data
        },
        custom_data
      }],
      access_token: META_ACCESS_TOKEN
    };
    if (test_event_code) metaBody.test_event_code = test_event_code;

    const j = await sendToMeta(metaBody);
    return res.status(200).json({ ok:true, meta:j });
  }catch(err){
    console.error("WEBHOOK /webhooks error:", err);
    return res.status(500).json({ ok:false, error:String(err) });
  }
});

/* ===================================================================
   Route 2 — /webhooks/mangomint : Appointment → Schedule, Sale → Purchase
   - Appointment Created  → Schedule (value=0)
   - Sale Completed       → Purchase (value>0)
   - include ip/ua; add hashed em/ph/fn/ln when present to improve EMQ
=================================================================== */
function mapAppointmentToSchedule(mm, {ip, ua, test_event_code}={}){
  const appt   = mm.appointment || {};
  const client = appt.clientInfo || appt.onlineBookingClientInfo || {};
  const serviceName = appt.services?.[0]?.service?.name || appt.services?.[0]?.name || "Appointment";

  const event_id   = String(appt.id || Date.now());
  const event_time = safeEventTime(appt.createdAt || appt.dateTime);

  const ud = { client_ip_address: ip || "", client_user_agent: ua || "unknown" };
  if (client.email)     ud.em = sha256(normEmail(client.email));
  if (client.phone)     ud.ph = sha256(normPhone(client.phone));
  if (client.firstName) ud.fn = sha256(client.firstName);
  if (client.lastName)  ud.ln = sha256(client.lastName);

  const body = {
    data:[{
      event_name: "Schedule",
      event_time,
      action_source: "website",
      event_source_url: "https://altheatherapie.ca/book",
      event_id,
      user_data: ud,
      custom_data: { currency:"CAD", value:0, content_name: serviceName }
    }],
    access_token: META_ACCESS_TOKEN
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

function mapSaleToPurchase(mm, {ip, ua, test_event_code}={}){
  const sale   = mm.sale || {};
  const appt   = mm.appointment || {};
  const client = sale.client || mm.client || {};
  const value      = Number(sale.total ?? sale.amount ?? 0) || 0;
  const currency   = sale.currency || "CAD";
  const contentName = appt.services?.[0]?.service?.name || appt.services?.[0]?.name || "Purchase";

  const event_id   = String(sale.id || appt.id || Date.now());
  const event_time = safeEventTime(sale.createdAt || sale.closedAt || mm.timeStamp);

  const ud = { client_ip_address: ip || "", client_user_agent: ua || "unknown" };
  if (client.email)     ud.em = sha256(normEmail(client.email));
  if (client.phone)     ud.ph = sha256(normPhone(client.phone));
  if (client.firstName) ud.fn = sha256(client.firstName);
  if (client.lastName)  ud.ln = sha256(client.lastName);

  const body = {
    data:[{
      event_name: "Purchase",
      event_time,
      action_source: "website",
      event_source_url: "https://altheatherapie.ca",
      event_id,
      user_data: ud,
      custom_data: { value, currency, content_name: contentName }
    }],
    access_token: META_ACCESS_TOKEN
  };
  if (test_event_code) body.test_event_code = test_event_code;
  return body;
}

app.post("/webhooks/mangomint", async (req,res)=>{
  try{
    if (MANGOMINT_WEBHOOK_SECRET){
      const got = req.headers["x-webhook-secret"];
      if (got !== MANGOMINT_WEBHOOK_SECRET) return res.status(401).json({ ok:false, error:"Invalid webhook secret" });
    }
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const ip = clientIp(req);
    const ua = req.headers["user-agent"] || "unknown";
    const test_event_code = payload.test_event_code || req.query.test_event_code;

    const metaBody =
      payload.sale ? mapSaleToPurchase(payload, {ip,ua,test_event_code}) :
      payload.appointment ? mapAppointmentToSchedule(payload, {ip,ua,test_event_code}) :
      null;

    if (!metaBody) return res.status(200).json({ ok:false, msg:"Ignored payload" });

    const j = await sendToMeta(metaBody);
    return res.status(200).json({ ok:true, meta:j });
  }catch(err){
    console.error("MangoMint webhook error:", err);
    return res.status(200).json({ ok:false, error:String(err) });
  }
});

/* ===== Start ===== */
app.listen(PORT, ()=> console.log(`✅ Bridge listening on ${PORT}`));
