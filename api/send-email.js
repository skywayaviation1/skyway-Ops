// Vercel serverless function: send transactional email via Resend.
//
// Called by the frontend whenever a status button fires. The Resend API key
// lives only on the server — never exposed to the browser.
//
// Body shape:
//   { to: ['ops@example.com', 'broker@example.com'], subject: '...', text: '...' }
//
// Returns { ok: true, id: 'resend-message-id' } on success, error otherwise.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'RESEND_API_KEY not configured on server' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const { to, subject, text } = body;
  if (!Array.isArray(to) || to.length === 0 || !subject || !text) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: to, subject, text' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  // Validate recipient email format (basic check)
  const validRecipients = to.filter(
    (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  );
  if (validRecipients.length === 0) {
    return new Response(
      JSON.stringify({ error: 'No valid recipient email addresses' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skyway Ops <noreply@send.flyskyway.com>',
        to: validRecipients,
        subject: subject.slice(0, 200),
        text: text.slice(0, 10000),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({
          error: data.message || `Resend returned ${upstream.status}`,
          details: data,
        }),
        { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ok: true, id: data.id }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Send failed: ${err.message}` }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }
}
