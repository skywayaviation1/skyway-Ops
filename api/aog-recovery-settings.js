// Rate table and complimentary-domain list. Ops and admin, same gate as the
// coverage tab. Writes go through the Admin SDK so the browser cannot set
// the premium a broker is charged.

import { notifyTestModeEnabled, notifyTestRecipient } from './_notify-test-mode.js';
import { assertStripeTestKey } from './_aog-stripe.js';
import { isSharedMailConfigured } from './_charter-mail.js';
import {
  authorizeOps,
  loadSettings,
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
    if (body.action === 'save') {
      const settings = await saveSettings(db, {
        rates: body.rates,
        complimentaryDomains: body.complimentaryDomains,
        actor,
      });
      res.status(200).json({ ok: true, settings });
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
