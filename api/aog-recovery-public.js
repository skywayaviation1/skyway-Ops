// Public, unguessable-token page API. No Skyway login. The token is the
// credential. Amounts are never taken from the browser.

import { buildCheckoutSessionParams, stripeClient } from './_aog-stripe.js';
import { requestInvoice } from './_aog-invoice.js';
import {
  applySignature,
  findByToken,
  loadSettings,
  persistIncludedCoverage,
  publicBaseUrl,
  publicCoverageView,
  readJson,
  recoveryDb,
  reportingPatch,
  requestClient,
} from './_aog-recovery.js';

export const config = { runtime: 'nodejs' };

function tokenFrom(req, body) {
  const query = req.query || {};
  return String(body?.token || query.token || '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.method === 'POST' ? readJson(req) : {};
    const token = tokenFrom(req, body);
    if (!token || token.length < 20) {
      res.status(400).json({ error: 'This coverage link is missing or invalid' });
      return;
    }
    const db = recoveryDb();
    const found = await findByToken(db, token);
    if (!found) {
      res.status(404).json({ error: 'This coverage link is not valid' });
      return;
    }
    const stored = await persistIncludedCoverage(found.ref, found.data);
    const record = { id: found.id, ...stored };

    if (req.method === 'GET') {
      res.status(200).json({ ok: true, coverage: publicCoverageView(record) });
      return;
    }

    const action = String(body.action || '').trim();
    if (action === 'sign') {
      await applySignature(db, found.ref, record, {
        fullName: body.fullName,
        agreed: body.agreed === true,
        ...requestClient(req),
      });
      const fresh = await found.ref.get();
      res.status(200).json({ ok: true, coverage: publicCoverageView({ id: found.id, ...fresh.data() }) });
      return;
    }

    if (action === 'invoice') {
      let current = (await found.ref.get()).data() || {};
      if (!current.signedAt) {
        await applySignature(db, found.ref, { id: found.id, ...current }, {
          fullName: body.fullName,
          agreed: body.agreed === true,
          ...requestClient(req),
        });
        current = (await found.ref.get()).data() || current;
      }
      const settings = await loadSettings(db);
      const result = await requestInvoice(db, found.ref, { id: found.id, ...current }, {
        name: body.fullName || current.signedName,
        email: body.email,
        settings,
        baseUrl: publicBaseUrl(req),
      });
      const fresh = await found.ref.get();
      res.status(200).json({
        ok: true,
        duplicate: result.duplicate === true,
        autoApproved: result.autoApproved === true,
        coverage: publicCoverageView({ id: found.id, ...(fresh.data() || result.record) }),
      });
      return;
    }

    if (action === 'checkout') {
      const current = (await found.ref.get()).data() || {};
      if (!current.signedAt) {
        res.status(400).json({ error: 'Sign the election before paying' });
        return;
      }
      if (current.paymentStatus === 'paid' || current.paymentStatus === 'invoice_unpaid' || current.paymentStatus === 'invoice_paid' || current.coverageLevel === 'purchased_100') {
        res.status(200).json({ ok: true, alreadyPaid: true, coverage: publicCoverageView({ id: found.id, ...current }) });
        return;
      }
      if (current.upgradeAvailable !== true || !Number.isInteger(current.premiumCents)) {
        res.status(400).json({ error: '100% coverage is not available for purchase on this trip' });
        return;
      }
      const base = publicBaseUrl(req);
      const params = buildCheckoutSessionParams({
        record: { ...current, id: found.id },
        amountCents: current.premiumCents,
        successUrl: `${base}/aog-coverage?token=${encodeURIComponent(token)}&result=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/aog-coverage?token=${encodeURIComponent(token)}&result=cancel`,
      });
      const session = await stripeClient().checkout.sessions.create(params);
      await found.ref.set({
        ...reportingPatch({
          ...current,
          paymentStatus: 'awaiting_payment',
          stripeCheckoutSessionId: session.id,
          createdAt: current.createdAt,
        }),
        stripeAmountCents: current.premiumCents,
      }, { merge: true });
      res.status(200).json({ ok: true, url: session.url });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Request failed' });
  }
}
