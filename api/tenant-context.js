// Edge route: public brand for a hostname.
//
// Phase 1 pins www.skyway.app, skyway.app, and 135ops.app to Skyway and
// returns 404 for every other host. The payload is hardcoded from src/brand.js
// so a database outage cannot attach the live site to another company.
//
// The UI does not call this route yet. Do not theme the app from it.

import { requestHostname, resolvePinnedTenant } from '../lib/control-plane/hosts.js';

export const config = {
  runtime: 'edge',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const host = requestHostname(request);
  const tenant = resolvePinnedTenant(host);
  console.log(`[tenant-context] host=${host || '(none)'} result=${tenant ? tenant.slug : '404'}`);

  if (!tenant) {
    return json({ error: 'Not found' }, 404);
  }
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return json({ tenant }, 200);
}
