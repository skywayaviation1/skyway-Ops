// Vercel serverless function: parse government-issued ID images using
// Anthropic Claude vision.
//
// Used as the AI fallback for the passenger ID scanner when the PDF417
// barcode either:
//   - couldn't be read (3-second timeout)
//   - doesn't exist (passport, international ID, paper documents)
//
// Body shape:
//   { imageBase64: '...', mediaType: 'image/jpeg' | 'image/png' }
//
// Returns:
//   {
//     ok: true,
//     parsed: {
//       documentType: 'us_drivers_license' | 'us_state_id' | 'passport' | 'international_id' | 'unknown',
//       firstName, middleName, lastName,
//       dob: 'YYYY-MM-DD' | null,
//       documentNumber,
//       expiration: 'YYYY-MM-DD' | null,
//       issuingAuthority,
//       confidence: 'high' | 'medium' | 'low',
//       notes
//     }
//   }
//
// SECURITY NOTE: ID images contain PII. The image is sent to Anthropic for
// processing per their API terms. The image is not retained by us beyond the
// request lifetime. The caller is responsible for storing the image in
// Firebase Storage if they want a retained record.

export const config = { runtime: 'nodejs' };

const SYSTEM_PROMPT = `You extract structured data from government-issued ID documents for a Part 135 charter aviation operator. Your output is used to verify passenger identity against trip manifests.

Output ONLY valid JSON matching this exact schema. No markdown. No commentary. No code fences.

{
  "documentType": "one of: us_drivers_license, us_state_id, passport, international_id, unknown",
  "firstName": "string — given/first name as printed",
  "middleName": "string or null — middle name or initial if present",
  "lastName": "string — family/surname as printed",
  "dob": "YYYY-MM-DD or null if unreadable",
  "documentNumber": "string — license number, passport number, or document ID",
  "expiration": "YYYY-MM-DD or null",
  "issuingAuthority": "string — issuing state, country, or authority (e.g., 'CA', 'USA', 'GBR')",
  "confidence": "high | medium | low",
  "notes": "any unusual details or extraction issues — short string or null"
}

Rules:
- Read names EXACTLY as printed on the document. Preserve hyphens, apostrophes, accented characters.
- For passports: read the MRZ (machine-readable zone at the bottom) for highest accuracy. The MRZ has standardized format.
- For US driver's licenses: read the printed name, not the signature.
- Dates: convert any format to YYYY-MM-DD. If you see "MAR 15, 1965" return "1965-03-15".
- If an ID has both English and another script, return the English/Latin version.
- Set confidence "high" only when text is clearly legible. Set "medium" if some characters are uncertain. Set "low" if you had to guess significant fields.
- If the image isn't a government ID at all, set documentType: "unknown" and put "Image does not appear to be a government ID" in notes.
- NEVER invent data. If a field is unreadable, return null for that field with a note.`;

const USER_PROMPT = 'Extract the data from this ID document and return only the JSON object per the schema. Do not include any other text.';

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
  const { imageBase64, mediaType } = body || {};
  if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

  // Validate media type — Claude vision supports jpeg, png, gif, webp
  const allowedMedia = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mt = mediaType || 'image/jpeg';
  if (!allowedMedia.includes(mt)) {
    return res.status(400).json({ error: `Unsupported mediaType: ${mt}` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mt,
                  data: imageBase64,
                },
              },
              { type: 'text', text: USER_PROMPT },
            ],
          },
        ],
      }),
    });

    const upstreamData = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[parse-id] Anthropic error:', upstream.status, upstreamData);
      return res.status(502).json({
        error: `AI extraction failed: ${upstreamData?.error?.message || upstream.status}`,
      });
    }

    // Extract text from response
    const textBlock = (upstreamData.content || []).find(c => c.type === 'text');
    const rawText = textBlock?.text || '';

    // Strip any code fences if Claude added them despite instructions
    let cleaned = rawText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[parse-id] JSON parse failed. Raw text:', rawText);
      return res.status(502).json({
        error: 'AI returned unparseable response',
        rawText: rawText.slice(0, 500),
      });
    }

    return res.status(200).json({ ok: true, parsed });
  } catch (err) {
    console.error('[parse-id] exception:', err);
    return res.status(500).json({ error: err.message || 'AI extraction failed' });
  }
}
