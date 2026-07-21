// api/mx-due-list-parse.js
// Parse Veryon Maintenance Due List PDF via Claude API, write structured items to Firestore.
// POST { pdfBase64: string, filename?: string }
// Returns { count: number, tails: string[] }

const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function getDb() {
  const apps = getApps();
  const app = apps.length
    ? getApp()
    : initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
      });
  return getFirestore(app, 'appusers');
}

const EXTRACTION_PROMPT = `Extract EVERY maintenance item from this Veryon Maintenance Due List PDF.

Return ONLY a JSON array wrapped in <items></items> tags. No prose, no markdown, just the array inside the tags.

For each item, extract these fields exactly:
- tail: N-number of the aircraft the item belongs to (e.g. "N168ZZ"). The tail appears in the page header top-right and in a section header row like "Maintenance Due List N168ZZ". Every item belongs to whichever tail's section it appears under.
- itemId: The number after # (e.g. "1447" from "#1447")
- ata: The ATA/Type/Group code from column 1 (e.g. "77 0001", "AD 1998-16-18 AMD 2", "SB 5X-55-11 R1", "AD 2013-08-05 AMD PARA (H)")
- component: One of "Airframe", "Engine 1", "Engine 2", "Air Conditioner 1", "Propeller 1"
- categoryType: One of "INSPECTION", "INSPECTION - Life Limited", "AD - Recurring", "AD - Open", "PART - Life Limited", "PART - Overhaul", "PART - Expiration", "PART", "SB - Recurring", "SB - Open", "MAINTENANCE"
- description: Text from DESCRIPTION column, single line, no newlines
- compliedAt: object with { date: "YYYY-MM-DD" or null, hours: number or null, landings: number or null, cycles: number or null }
- interval: object { days, months, hours, landings, cycles } - all numbers or null. Parse "D: 30" as days=30. "M: 12" as months=12. "H: 300.00" as hours=300. "L: 1000" as landings=1000. "C: 100" as cycles=100.
- tolerance: same shape as interval, all null if not present
- nextDue: { date: "YYYY-MM-DD" or null, hours: number or null, landings: number or null, cycles: number or null }
- remaining: { months: number or null, days: number or null, hours: number or null, landings: number or null }

For "Remaining" column: "M: 5 D: 23" means months=5, days=23. "H: 264.80" means hours=264.80. "L: 573" means landings=573. Negative values (overdue) should be preserved.

Compliance dates like "13-JUL-2026" convert to "2026-07-13".

If an item spans multiple lines (has notes, part numbers), still extract it as ONE item. Skip the notes/part number rows.

Include EVERY item across ALL tails in the PDF. Do not truncate or summarize.

<items>
[ ...items array... ]
</items>`;

async function parsePdfWithClaude(pdfBase64) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64,
              },
            },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const json = await res.json();
  const text = json.content?.map(c => c.type === 'text' ? c.text : '').join('') || '';

  const match = text.match(/<items>\s*([\s\S]*?)\s*<\/items>/);
  if (!match) {
    // Try fallback: raw array
    const arrMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
    throw new Error('No <items> block or JSON array found in Claude response');
  }

  return JSON.parse(match[1]);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  try {
    const { pdfBase64, filename } = req.body || {};
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({ error: 'pdfBase64 (string) required' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    }
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON not set' });
    }

    const items = await parsePdfWithClaude(pdfBase64);
    if (!Array.isArray(items)) {
      throw new Error('Parsed result is not an array');
    }

    const db = getDb();
    const tails = new Set();
    const importedAt = new Date().toISOString();

    // Write in chunks (Firestore batch limit is 500 ops)
    const CHUNK = 400;
    let written = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      const batch = db.batch();
      const slice = items.slice(i, i + CHUNK);
      for (const item of slice) {
        if (!item.tail || !item.itemId) continue;
        tails.add(item.tail);
        const docId = `${item.tail}_${String(item.itemId).replace(/[^\w-]/g, '_')}`;
        const ref = db.collection('mxDueItems').doc(docId);
        batch.set(
          ref,
          {
            ...item,
            importedAt,
            importedFrom: filename || 'upload',
          },
          { merge: true }
        );
        written++;
      }
      await batch.commit();
    }

    return res.status(200).json({
      count: written,
      tails: [...tails].sort(),
    });
  } catch (e) {
    console.error('mx-due-list-parse error:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};

module.exports.config = {
  maxDuration: 120,
  api: {
    bodyParser: { sizeLimit: '30mb' },
  },
};
