// Vercel serverless function: parse receipt image/PDF using Anthropic Claude vision.
//
// The Claude API key lives only on the server — never exposed to the browser.
// Required environment variable: ANTHROPIC_API_KEY
//
// Body shape:
//   { imageBase64: '...', mediaType: 'image/jpeg' | 'image/png' | 'application/pdf' }
//
// Returns:
//   {
//     ok: true,
//     parsed: {
//       vendor, transactionDate, totalAmount, currency, subtotal, tax, tip,
//       category, lineItems: [{ description, qty, unitPrice, amount }],
//       confidence: 'high' | 'medium' | 'low',
//       notes,
//     }
//   }
//
// Runtime: Node serverless (not Edge) — same reasoning as send-email handler:
// Edge runtime had intermittent env var propagation issues.
//
// AUTH GATE (added): this endpoint spends the org's ANTHROPIC_API_KEY on every
// call. It is now gated to authenticated Skyway users only. The caller must
// include `idToken` in the body — the Firebase ID token of the logged-in user,
// obtained on the frontend via auth.currentUser.getIdToken(). We verify it
// server-side with the Firebase Admin SDK before making any Claude call. No
// role check: any authenticated user may parse their own receipts (crew submit
// their own expenses). This mirrors the gate pattern in api/delete-user.js.
//
//   { idToken: '...', imageBase64: '...', mediaType: '...' }

export const config = { runtime: 'nodejs' };

// --- Firebase Admin (cached across warm invocations) -----------------------
// Identical pattern to api/delete-user.js — verifies caller ID tokens.
let cachedAdmin = null;

async function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const admin = await import('firebase-admin');
  if (!admin.apps || admin.apps.length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured on server');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    admin.default.initializeApp({
      credential: admin.default.credential.cert(parsed),
    });
  }
  cachedAdmin = admin.default;
  return cachedAdmin;
}

const SYSTEM_PROMPT = `You are a receipt-parsing assistant for a Part 135 charter aviation operator. Your job is to extract structured data from receipt images for expense reporting.

Output ONLY valid JSON matching this schema (no markdown, no commentary):
{
  "vendor": "string — business name",
  "transactionDate": "YYYY-MM-DD or null if unreadable",
  "totalAmount": "number — final amount paid, decimal",
  "currency": "USD by default unless clearly otherwise",
  "subtotal": "number or null",
  "tax": "number or null",
  "tip": "number or null",
  "category": "one of: Fuel, Catering, FBO Fees, Hangar, Ground Transport, Crew Meals, Crew Lodging, Supplies, Maintenance, Office, Other",
  "lineItems": [{ "description": "string", "qty": "number or 1", "unitPrice": "number or null", "amount": "number" }],
  "confidence": "high | medium | low",
  "notes": "any unusual details (handwritten, illegible portions, missing data) — short string or null"
}

Category guidelines:
- "Fuel" — Jet-A, Avgas, fuel uplifts at FBOs (Atlantic, Signature, Wilson, Avfuel, Titan, etc.)
- "FBO Fees" — landing fees, ramp/parking fees, ground handling, infrastructure fees from FBOs
- "Hangar" — overnight hangar storage
- "Catering" — flight catering vendors, meals provisioned for passengers
- "Ground Transport" — Uber, taxi, rental car, limo for crew or pax
- "Crew Meals" — restaurant meals for crew during a trip
- "Crew Lodging" — hotels for crew overnight stays
- "Supplies" — pilot supplies, oxygen, lavatory consumables, cleaning, anything onboard consumables
- "Maintenance" — A&P labor, parts, MRO invoices
- "Office" — admin, software subscriptions, anything non-flight
- "Other" — only when nothing else fits

If multiple categories apply, pick the dominant one. If image is unreadable or not a receipt, set vendor to null and confidence to "low".`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[parse-receipt] ANTHROPIC_API_KEY missing from env');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // --- AUTH GATE: verified Skyway user only (fails closed before any
  //     Anthropic call, so an unauthenticated request never bills us) ---
  const { idToken } = body;
  if (!idToken || typeof idToken !== 'string') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const admin = await getAdmin();
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    if (/FIREBASE_SERVICE_ACCOUNT_JSON/.test(err.message)) {
      console.error('[parse-receipt] admin init failed:', err.message);
      return res.status(500).json({ error: 'Auth not configured on server' });
    }
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing imageBase64' });
  }
  const allowedMedia = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  const cleanedMediaType = (mediaType || 'image/jpeg').replace('image/jpg', 'image/jpeg');
  if (!allowedMedia.includes(cleanedMediaType)) {
    return res.status(400).json({ error: `Unsupported mediaType: ${cleanedMediaType}` });
  }

  // Roughly check size — base64 is ~33% larger than binary, cap at ~7MB binary
  if (imageBase64.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large for parsing' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    // Build the Claude API request. Vision works for images directly.
    // For PDFs we use Claude's PDF support (also via the same content array).
    const contentBlockType = cleanedMediaType === 'application/pdf' ? 'document' : 'image';
    const userContent = [
      {
        type: contentBlockType,
        source: {
          type: 'base64',
          media_type: cleanedMediaType,
          data: imageBase64,
        },
      },
      {
        type: 'text',
        text: 'Extract this receipt into the JSON schema above. Output ONLY the JSON object, no other text.',
      },
    ];

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const upstreamData = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[parse-receipt] Claude upstream error:', upstream.status, upstreamData);
      return res.status(upstream.status).json({
        error: upstreamData.error?.message || `Claude returned ${upstream.status}`,
      });
    }

    // Extract text from Claude's content blocks
    const blocks = upstreamData.content || [];
    const textBlock = blocks.find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      return res.status(502).json({ error: 'Claude returned no text content' });
    }

    // Strip ```json ... ``` fences if Claude wrapped it
    let raw = textBlock.text.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[parse-receipt] JSON parse failed. Raw text:', raw.slice(0, 500));
      return res.status(502).json({
        error: 'Could not parse AI response as JSON',
        rawPreview: raw.slice(0, 500),
      });
    }

    // Sanitize / coerce
    const safeNum = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v !== 'string') return null;
      const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
      return isNaN(n) ? null : n;
    };
    const cleaned = {
      vendor: parsed.vendor || null,
      transactionDate: parsed.transactionDate || null,
      totalAmount: safeNum(parsed.totalAmount),
      currency: parsed.currency || 'USD',
      subtotal: safeNum(parsed.subtotal),
      tax: safeNum(parsed.tax),
      tip: safeNum(parsed.tip),
      category: parsed.category || 'Other',
      lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems.slice(0, 50).map((li) => ({
        description: String(li.description || '').slice(0, 200),
        qty: safeNum(li.qty) || 1,
        unitPrice: safeNum(li.unitPrice),
        amount: safeNum(li.amount),
      })) : [],
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      notes: parsed.notes || null,
    };

    console.log('[parse-receipt] Parsed:', cleaned.vendor, cleaned.totalAmount, cleaned.category);
    return res.status(200).json({ ok: true, parsed: cleaned });
  } catch (err) {
    console.error('[parse-receipt] Network/timeout error:', err.message);
    return res.status(502).json({ error: `Parse failed: ${err.message}` });
  }
}
