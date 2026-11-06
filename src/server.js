require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "messages.jsonl");

fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultState = {
  availability: "unavailable",
  aiEnabled: true,
  businessName: process.env.BUSINESS_NAME || "Dr Huxtable",
  greeting: "Hello! Welcome to Dr Huxtable's office. How may I help you today?",
  awayMessage: "Dr Huxtable is currently unavailable. I am his virtual assistant and can help with general enquiries. He will respond as soon as possible.",
  handoverMessage: "Thank you. I have passed your message to Dr Huxtable, who will respond when available.",
  systemPrompt: "You are the polite, professional virtual receptionist for Dr Huxtable. Be concise, helpful and respectful. Never claim to be Dr Huxtable; identify yourself as the virtual assistant when appropriate. Answer only using the business information supplied below. If you do not know something, say you will pass the question to Dr Huxtable. Do not diagnose, prescribe, or provide emergency medical advice. For urgent medical emergencies, tell the person to contact local emergency services or attend the nearest emergency facility.",
  knowledgeBase: "Business information has not been added yet. Do not invent services, prices, opening hours, qualifications, addresses, or appointment availability.",
  humanTakeover: false,
  greetedNumbers: []
};

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...defaultState, ...parsed };
  } catch {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
    return { ...defaultState };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function logMessage(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
let state = readState();

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: "Set ADMIN_PASSWORD in .env first." });
  const supplied = req.headers["x-admin-password"] || req.query.password;
  if (typeof supplied !== "string" ||
      !crypto.timingSafeEqual(Buffer.from(supplied.padEnd(128).slice(0, 128)),
                              Buffer.from(expected.padEnd(128).slice(0, 128)))) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true, service: "Dr Huxtable WhatsApp Assistant" }));

app.get("/api/admin/state", adminAuth, (req, res) => {
  const safe = { ...state };
  delete safe.greetedNumbers;
  res.json(safe);
});

app.post("/api/admin/state", adminAuth, (req, res) => {
  const allowed = ["availability", "aiEnabled", "greeting", "awayMessage", "handoverMessage",
    "systemPrompt", "knowledgeBase", "humanTakeover", "businessName"];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) state[key] = req.body[key];
  }
  if (!["available", "busy", "unavailable"].includes(state.availability)) state.availability = "unavailable";
  saveState(state);
  res.json({ ok: true });
});

app.get("/api/admin/messages", adminAuth, (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json([]);
  const rows = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  res.json(rows.slice(-100).reverse().map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean));
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

function validMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // Configure META_APP_SECRET to enable signature verification.
  const signature = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody || "").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.post("/webhook", async (req, res) => {
  if (!validMetaSignature(req)) return res.sendStatus(401);
  // Acknowledge quickly; process the webhook asynchronously.
  res.sendStatus(200);
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        for (const message of (value.messages || [])) {
          await handleIncomingMessage(message, value.contacts?.[0]?.profile?.name || "");
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

async function handleIncomingMessage(message, contactName) {
  const from = message.from;
  if (!from) return;
  if (message.type !== "text") {
    await sendWhatsAppText(from, "Thanks for your message. I can currently process text enquiries. Please describe what you need help with.");
    return;
  }
  const text = message.text?.body?.trim();
  if (!text) return;

  logMessage({ direction: "inbound", from, contactName, text });

  if (state.humanTakeover) return;

  if (!state.greetedNumbers.includes(from)) {
    state.greetedNumbers.push(from);
    state.greetedNumbers = state.greetedNumbers.slice(-2000);
    saveState(state);
    await sendWhatsAppText(from, state.greeting);
  }

  if (state.availability === "unavailable") {
    await sendWhatsAppText(from, state.awayMessage);
  }

  if (!state.aiEnabled) return;

  const answer = await askGemini(text, contactName);
  if (answer) await sendWhatsAppText(from, answer);
}

async function askGemini(userText, contactName) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "Thank you for your message. The virtual assistant is not fully configured yet. Your enquiry has been recorded for follow-up.";
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt = [
    state.systemPrompt,
    `Business name: ${state.businessName}`,
    `Availability: ${state.availability}`,
    `Business knowledge base:\n${state.knowledgeBase}`,
    `Client name (if provided): ${contactName || "Not provided"}`,
    `Client message: ${userText}`,
    "Write one helpful WhatsApp reply. Do not invent facts."
  ].join("\n\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 350 } })
  });
  if (!response.ok) {
    console.error("Gemini error:", response.status, await response.text());
    return "Thank you for your message. I have received your enquiry and will pass it to Dr Huxtable for follow-up.";
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim()
    || "Thank you for your message. I will pass your enquiry to Dr Huxtable.";
}

async function sendWhatsAppText(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log(`[DEMO MODE] Would send to ${to}: ${body}`);
    logMessage({ direction: "outbound-demo", to, text: body });
    return;
  }
  const version = process.env.WHATSAPP_API_VERSION || "v23.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } })
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("WhatsApp send error:", result);
    logMessage({ direction: "send-error", to, error: result });
    return;
  }
  logMessage({ direction: "outbound", to, text: body, messageId: result.messages?.[0]?.id });
}

app.listen(PORT, () => console.log(`Assistant running on http://localhost:${PORT}`));
