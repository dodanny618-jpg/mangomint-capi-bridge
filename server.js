// server.js — Bridge Render (ESM, Express, CORS, /webhooks)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// ---------- Config ----------
const app = express();

// Autoriser ton site (CORS)
const allowedOrigins = [
  "https://altheatherapie.ca",
  "https://www.altheatherapie.ca",
];

// CORS options
const corsOptions = {
  origin(origin, cb) {
    // Autorise Postman/curl (sans Origin) et tes domaines
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204,
};

// Middlewares
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

// Variables d'environnement (à définir sur Render)
const {
  PORT = 8080,
  META_PIXEL_ID,          // ex: 1214969237001592
  META_ACCESS_TOKEN,      // ton long access token Meta
} = process.env;

if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
  console.error("❌ Missing META_PIXEL_ID or META_ACCESS_TOKEN (set in Render → Environment)");
  process.exit(1);
}

const META_ENDPOINT = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.send("Mangomint → Meta CAPI bridge OK");
});

/**
 * Reçoit le payload de ton site (InitiateCheckout) et le relaie à Meta CAPI.
 * Le front envoie: { event_name, event_id, event_source_url, action_source, custom_data, test_event_code? }
 */
app.post("/webhooks", async (req, res) => {
  try {
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = "website",
      custom_data = { currency: "CAD", value: 0 },
      test_event_code, // optionnel (visible dans Test Events si fourni)
    } = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Construit le payload conforme Meta CAPI
    const metaBody = {
      data: [
        {
          event_name: event_name || "InitiateCheckout",
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: event_source_url || "https://altheatherapie.ca",
          action_source,
          event_id, // Doit matcher l'event_id du Pixel pour la déduplication
          user_data: {
            // Minimum viable: ip + ua (Meta améliorera l’attribution)
            client_ip_address: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "",
            client_user_agent: req.headers["user-agent"] || "unknown",
          },
          custom_data,
        },
      ],
      access_token: META_ACCESS_TOKEN,
    };

    if (test_event_code) {
      metaBody.test_event_code = test_event_code; // rend "Server" visible dans Test Events
    }

    // Appel Meta CAPI
    const r = await fetch(META_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metaBody),
    });

    const j = await r.json();
    // Répond au navigateur
    return res.status(200).json({ ok: true, meta: j });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Bridge listening on port ${PORT}`);
});
