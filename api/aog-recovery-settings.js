// Rate table and complimentary-domain list. Ops and admin, same gate as the
// coverage tab. Writes go through the Admin SDK so the browser cannot set
// the premium a broker is charged.

import { notifyTestModeEnabled, notifyTestRecipient } from './_notify-test-mode.js';
import { assertStripeTestKey } from './_aog-stripe.js';
import { isSharedMailConfigured } from './_charter-mail.js';
import { normalizeDomains } from '../src/aog-recovery.js';
import {
  applyComplimentaryDomain,
  authorizeOps,
  complimentaryCandidates,
  loadSettings,
  publicBaseUrl,
  readJson,
  recoveryDb,
  saveSettings,
} from './_aog-recovery.js';

export const config = { runtime: 'nodejs' };

function stripeReady() {
  try {
    assertStripeTestKey();
    return { configured: true, liveKeyRejected: false };
  } catch (err) {
    return { configured: false, liveKeyRejected: /Live Stripe keys/.test(err.message), message: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = readJson(req);
    const actor = await authorizeOps(body.idToken);
    const db = recoveryDb();
    if (body.action === 'save' || body.action === 'save-rates') {
      const settings = await saveSettings(db, {
        rates: body.rates,
        complimentaryDomains: body.action === 'save' ? body.complimentaryDomains : undefined,
        complimentaryDomainRecords: body.complimentaryDomainRecords,
        includedMultiplier: body.includedMultiplier,
        upgradeMultiplier: body.upgradeMultiplier,
        cfsStaff: body.cfsStaff,
        actor,
      });
      res.status(200).json({ ok: true, settings });
      return;
    }
    if (body.action === 'add-domain') {
      const [domain] = normalizeDomains([body.domain]);
      const existing = await loadSettings(db);
      const already = existing.domainRecords.some((row) => row.domain === domain);
      const now = new Date().toISOString();
      const records = already
        ? existing.domainRecords
        : [...existing.domainRecords, { domain, addedBy: actor.email, addedAt: now }];
      const settings = already
        ? existing
        : await saveSettings(db, { complimentaryDomainRecords: records, actor });
      const candidates = await complimentaryCandidates(db, domain);
      res.status(200).json({ ok: true, settings, domain, already, candidates });
      return;
    }
    if (body.action === 'remove-domain') {
      const [domain] = normalizeDomains([body.domain]);
      const existing = await loadSettings(db);
      const records = existing.domainRecords.filter((row) => row.domain !== domain);
      const settings = await saveSettings(db, { complimentaryDomainRecords: records, actor });
      res.status(200).json({ ok: true, settings });
      return;
    }
    if (body.action === 'add-cfs-staff') {
      const existing = await loadSettings(db);
      const settings = await saveSettings(db, {
        cfsStaff: [...existing.cfsStaff, { email: body.email }],
        actor,
      });
      res.status(200).json({ ok: true, settings });
      return;
    }
    if (body.action === 'remove-cfs-staff') {
      const existing = await loadSettings(db);
      const email = String(body.email || '').trim().toLowerCase();
      const settings = await saveSettings(db, {
        cfsStaff: existing.cfsStaff.filter((row) => row.email !== email),
        actor,
      });
      res.status(200).json({ ok: true, settings });
      return;
    }
    if (body.action === 'apply-domain') {
      const [domain] = normalizeDomains([body.domain]);
      const result = await applyComplimentaryDomain(db, {
        domain,
        tripIds: body.tripIds,
        actor,
        baseUrl: publicBaseUrl(req),
      });
      const settings = await loadSettings(db);
      res.status(200).json({ ok: true, settings, ...result });
      return;
    }
    const settings = await loadSettings(db);
    res.status(200).json({
      ok: true,
      settings,
      notifyTestMode: notifyTestModeEnabled(),
      notifyTestRecipient: notifyTestRecipient(),
      graphConfigured: isSharedMailConfigured(),
      stripe: stripeReady(),
      webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Settings failed' });
  }
}
