// Admin: save / clear ForeFlight Dispatch credentials and register the webhook.

import {
  authorizeForeFlightCaller,
  defaultVendorId,
  defaultWebhookUrl,
  getApiKeyInfo,
  publicForeFlightConfig,
  randomWebhookSecret,
  readConfig,
  registerWebhook,
  writeConfig,
} from './_foreflight.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const caller = await authorizeForeFlightCaller(req.body?.idToken, ['admin']);
    const {
      action = 'save',
      apiKey,
      vendorId,
      enabled,
      registerWebhook: shouldRegisterWebhook = true,
      rotateWebhookSecret = false,
    } = req.body || {};

    if (action === 'clear') {
      await writeConfig({
        apiKey: null,
        vendorId: null,
        webhookSecret: null,
        webhookUrl: null,
        organisationUUID: null,
        organisationName: null,
        enabled: false,
        updatedByUid: caller.uid,
        updatedByName: caller.name,
        clearedAt: Date.now(),
      });
      res.status(200).json({ ok: true, ...publicForeFlightConfig(await readConfig()) });
      return;
    }

    const existing = (await readConfig()) || {};
    const nextKey = apiKey != null && String(apiKey).trim()
      ? String(apiKey).trim()
      : existing.apiKey;
    if (!nextKey) {
      res.status(400).json({ error: 'apiKey is required (generate one in ForeFlight Dispatch → Tools → API Console)' });
      return;
    }

    const nextVendor = vendorId != null
      ? (String(vendorId).trim() || null)
      : (existing.vendorId || defaultVendorId());

    let webhookSecret = existing.webhookSecret || null;
    if (rotateWebhookSecret || !webhookSecret) {
      webhookSecret = randomWebhookSecret();
    }

    const draft = {
      ...existing,
      apiKey: nextKey,
      vendorId: nextVendor,
      webhookSecret,
      enabled: enabled !== false,
      updatedByUid: caller.uid,
      updatedByName: caller.name,
    };

    // Validate the key against Dispatch before persisting org metadata.
    let info = null;
    try {
      info = await getApiKeyInfo(draft);
    } catch (err) {
      res.status(err.status || 400).json({
        error: err.message || 'ForeFlight rejected the API key',
        foreflight: err.foreflight || null,
      });
      return;
    }

    const webhookUrl = defaultWebhookUrl(req);
    let webhookOk = false;
    let webhookError = null;
    if (shouldRegisterWebhook) {
      try {
        await registerWebhook(draft, { url: webhookUrl, secret: webhookSecret });
        webhookOk = true;
        draft.webhookUrl = webhookUrl;
      } catch (err) {
        webhookError = err.message || 'Webhook registration failed';
        // Keep the key even if webhook registration fails — admin can retry.
      }
    }

    draft.organisationUUID = info?.organisationUUID || existing.organisationUUID || null;
    draft.organisationName = info?.organisationName || existing.organisationName || null;
    draft.lastTestAt = Date.now();
    draft.lastTestOk = true;
    draft.storageAccountUUID = info?.storageAccountUUID || existing.storageAccountUUID || null;

    const saved = await writeConfig(draft);
    res.status(200).json({
      ok: true,
      webhookRegistered: webhookOk,
      webhookError,
      webhookUrl: saved.webhookUrl || webhookUrl,
      ...publicForeFlightConfig(saved),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save ForeFlight config' });
  }
}
