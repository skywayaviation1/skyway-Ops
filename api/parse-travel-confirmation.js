// Vercel serverless function: parse travel confirmations (hotel or commercial
// flight) using Anthropic Claude vision/document API.
//
// Accepts JPEG/PNG images or PDFs of confirmation emails, screenshots, or
// vendor itinerary pages.
//
// Body shape:
//   { imageBase64: '...', mediaType: 'image/jpeg' | 'image/png' | 'application/pdf', expectedType?: 'flight' | 'hotel' }
//
// Returns:
//   { ok: true, parsed: { type: 'flight' | 'hotel', ...fields } }

export const config = { runtime: 'nodejs' };

const SYSTEM_PROMPT = `You extract structured booking data from travel confirmations for a Part 135 charter aviation operator. Crew members travel commercially between assignments and stay in hotels; ops uploads their confirmations to keep records.

Output ONLY valid JSON matching ONE of these two schemas, depending on the document type. No markdown, no commentary, no code fences.

If the document is a COMMERCIAL FLIGHT confirmation:
{
  "type": "flight",
  "airline": "string — full airline name (e.g., 'American Airlines')",
  "airlineCode": "string — IATA code (e.g., 'AA')",
  "confirmationCode": "string — booking reference / record locator (PNR)",
  "tripName": "string or null — display name if shown (e.g., 'CLT/TPA')",
  "passengerName": "string — primary passenger name as printed",
  "ticketNumber": "string or null",
  "fromAirport": "string — departure airport IATA code (e.g., 'CLT')",
  "fromCity": "string — departure city name",
  "toAirport": "string — destination airport IATA code (e.g., 'TPA')",
  "toCity": "string — destination city name",
  "departureDate": "YYYY-MM-DD",
  "departureTime": "HH:MM in 24-hour local time at departure airport",
  "arrivalDate": "YYYY-MM-DD",
  "arrivalTime": "HH:MM in 24-hour local time at arrival airport",
  "flightNumber": "string or null (e.g., 'AA1234')",
  "seat": "string or null",
  "class": "string or null — e.g., 'Economy', 'Main Cabin', 'First'",
  "status": "string or null — e.g., 'Ticketed', 'Confirmed'",
  "confidence": "high | medium | low",
  "notes": "any unusual details — short string or null"
}

If the document is a HOTEL confirmation:
{
  "type": "hotel",
  "hotelName": "string — full hotel name",
  "hotelBrand": "string or null — brand if visible (e.g., 'Marriott', 'Hilton')",
  "confirmationCode": "string — confirmation number",
  "guestName": "string — primary guest name",
  "checkInDate": "YYYY-MM-DD",
  "checkOutDate": "YYYY-MM-DD",
  "address": "string — full street address of the property",
  "city": "string",
  "state": "string or null",
  "phone": "string or null — hotel phone number",
  "roomType": "string or null",
  "rate": "string or null — per-night rate if visible",
  "totalPrice": "string or null",
  "confidence": "high | medium | low",
  "notes": "any unusual details — short string or null"
}

If the document is NEITHER (or you cannot tell):
{
  "type": "unknown",
  "confidence": "low",
  "notes": "Brief description of what the document appears to be"
}

Rules:
- Read text EXACTLY as printed.
- Convert all dates to YYYY-MM-DD.
- Convert all times to HH:MM 24-hour. "3:25 PM" -> "15:25".
- For airports, use IATA 3-letter codes when shown.
- If both a city name and airport code are shown, capture both.
- Set confidence "high" only when text is clearly legible and unambiguous.
- NEVER invent data. If a field is unreadable, return null with a note.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  const { imageBase64, mediaType, expectedType } = body || {};
  if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

  const allowedMedia = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  const mt = mediaType || 'image/jpeg';
  if (!allowedMedia.includes(mt)) {
    return res.status(400).json({ error: `Unsupported mediaType: ${mt}` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const userPrompt = expectedType === 'flight'
    ? 'Extract the COMMERCIAL FLIGHT data from this confirmation. Return only the JSON.'
    : expectedType === 'hotel'
    ? 'Extract the HOTEL booking data from this confirmation. Return only the JSON.'
    : 'Determine if this is a commercial flight or hotel confirmation and extract the data per the schema. Return only the JSON.';

  // Build the content block — different shape for PDFs vs images
  const sourceBlock = mt === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mt, data: imageBase64 } };

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [sourceBlock, { type: 'text', text: userPrompt }],
          },
        ],
      }),
    });

    const upstreamData = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[parse-travel] Anthropic error:', upstream.status, upstreamData);
      return res.status(502).json({
        error: `AI extraction failed: ${upstreamData?.error?.message || upstream.status}`,
      });
    }

    const textBlock = (upstreamData.content || []).find(c => c.type === 'text');
    let cleaned = (textBlock?.text || '').trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[parse-travel] JSON parse failed:', cleaned.slice(0, 500));
      return res.status(502).json({
        error: 'AI returned unparseable response',
        rawText: cleaned.slice(0, 500),
      });
    }

    return res.status(200).json({ ok: true, parsed });
  } catch (err) {
    console.error('[parse-travel] exception:', err);
    return res.status(500).json({ error: err.message || 'AI extraction failed' });
  }
}
