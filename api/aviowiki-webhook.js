/**
 * aviowiki DATA_CHANGE receiver.
 *
 * Register: https://www.skyway.app/api/aviowiki-webhook
 *
 * AVIOWIKI_WEBHOOK_SECRET must be the subscription `secret` returned when the
 * webhook is created. Deliveries are authenticated by the Aviowiki-Signature
 * header (t=<unix-ms>,v1=<hex hmac-sha256 of `${t}.${rawBody}`>). When that
 * header is absent, the same secret is accepted as Authorization: Bearer, as
 * x-aviowiki-webhook-secret, or as ?token=.
 */

import {
  aidsFromWebhookPayload,
  invalidateAviowikiCache,
  readRawBody,
  sharedSecretMatches,
  verifyAviowikiSignature,
} from './_aviowiki.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
  api: { bodyParser: false },
};

function queryToken(req) {
  if (req.query?.token) return String(req.query.token);
  try {
    const url = new URL(req.url || '/', 'https://www.skyway.app');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function headerValue(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function handleAviowikiWebhook(req, res, deps = {}) {
  const env = deps.env || process.env;
  const invalidate = deps.invalidate || invalidateAviowikiCache;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      endpoint: 'aviowiki-webhook',
      secretConfigured: Boolean(String(env.AVIOWIKI_WEBHOOK_SECRET || '').trim()),
    });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = String(env.AVIOWIKI_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({
      error: 'AVIOWIKI_WEBHOOK_SECRET is not configured',
      code: 'aviowiki_webhook_not_configured',
    });
  }

  const rawBody = await readRawBody(req);
  const signature = headerValue(req, 'aviowiki-signature');
  let authorized = false;
  if (signature) {
    authorized = verifyAviowikiSignature(rawBody, signature, secret);
  } else {
    authorized = sharedSecretMatches(headerValue(req, 'authorization'), secret)
      || sharedSecretMatches(headerValue(req, 'x-aviowiki-webhook-secret'), secret)
      || sharedSecretMatches(queryToken(req), secret);
  }
  if (!authorized) return res.status(401).json({ error: 'invalid webhook signature' });

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' });
  }

  if (payload?.event && payload.event !== 'DATA_CHANGE') {
    return res.status(200).json({ ok: true, ignored: payload.event });
  }

  const aids = aidsFromWebhookPayload(payload);
  console.info(
    '[aviowiki-webhook]',
    payload?.event || 'DATA_CHANGE',
    payload?.data?.type || '',
    payload?.data?.action || '',
    aids.length,
  );
  try {
    const deleted = await invalidate(aids);
    return res.status(200).json({ ok: true, invalidated: deleted.length });
  } catch (error) {
    console.error('[aviowiki-webhook] invalidate failed', error.message);
    return res.status(500).json({ error: 'cache invalidation failed' });
  }
}

export default function handler(req, res) {
  return handleAviowikiWebhook(req, res);
}
