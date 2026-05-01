// Vercel serverless function: send transactional email via Resend.
//
// Called by the frontend whenever a status button fires. The Resend API key
// lives only on the server — never exposed to the browser.
//
// Body shape:
//   { to: ['ops@example.com', 'broker@example.com'], subject: '...', text: '...' }
//
// Returns { ok: true, id: 'resend-message-id' } on success, error otherwise.
//
// Runtime note: uses Node serverless (not Edge). Edge runtime had intermittent
// "RESEND_API_KEY not configured" errors where env vars would propagate to
// some invocations but not others depending on Edge region cold-start state.
// Node serverless reads env vars reliably. Email is not latency-critical.

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[send-email] RESEND_API_KEY missing from env');
    return res.status(500).json({ error: 'RESEND_API_KEY not configured on server' });
  }

  // Body parsing — Vercel Node runtime auto-parses JSON when Content-Type is application/json
  // but be defensive in case it's already a string
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { to, subject, text } = body;
  if (!Array.isArray(to) || to.length === 0 || !subject || !text) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, text' });
  }

  // Validate recipient email format (basic check)
  const validRecipients = to.filter(
    (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  );
  if (validRecipients.length === 0) {
    return res.status(400).json({ error: 'No valid recipient email addresses' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skyway Ops <noreply@send.flyskyway.com>',
        to: validRecipients,
        subject: String(subject).slice(0, 200),
        text: String(text).slice(0, 10000),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      console.error('[send-email] Resend upstream error:', upstream.status, data);
      return res.status(upstream.status).json({
        error: data.message || `Resend returned ${upstream.status}`,
        details: data,
      });
    }

    console.log('[send-email] Sent OK, id:', data.id, 'to:', validRecipients.join(','));
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[send-email] Network/timeout error:', err.message);
    return res.status(502).json({ error: `Send failed: ${err.message}` });
  }
}
