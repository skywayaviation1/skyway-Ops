// Vercel serverless function: server-side iCal proxy.
//
// Why this exists: browsers block cross-origin fetches from skyway-ops.vercel.app
// to portal.jetinsight.com (CORS). By fetching server-side from this same Vercel
// deployment, we avoid CORS entirely — server-to-server fetches have no such
// restriction.
//
// Usage from frontend: fetch('/api/ical?url=' + encodeURIComponent(feedUrl))
//
// The function only proxies known iCal-serving hosts (jetinsight, google calendar)
// to prevent it being abused as an open relay.

export const config = {
  runtime: 'edge',
};

const ALLOWED_HOSTS = [
  'portal.jetinsight.com',
  'calendar.google.com',
  'p44-caldav.icloud.com',
  'caldav.icloud.com',
];

export default async function handler(request) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');

  // CORS headers so the frontend can read responses from us
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (!target) {
    return new Response('Missing url parameter', {
      status: 400,
      headers: cors,
    });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('Invalid url', { status: 400, headers: cors });
  }

  // Allow only known iCal hosts
  const hostMatch = ALLOWED_HOSTS.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h)
  );
  if (!hostMatch) {
    return new Response(`Host not allowed: ${parsed.hostname}`, {
      status: 403,
      headers: cors,
    });
  }

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        // Some servers require a User-Agent
        'User-Agent': 'SkywayOps/1.0 (iCal proxy)',
        Accept: 'text/calendar, text/plain, */*',
      },
      // 25 second timeout via AbortSignal
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok) {
      return new Response(
        `Upstream ${upstream.status}: ${upstream.statusText}`,
        { status: upstream.status, headers: cors }
      );
    }

    const text = await upstream.text();

    return new Response(text, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/calendar; charset=utf-8',
      },
    });
  } catch (err) {
    return new Response(`Fetch failed: ${err.message}`, {
      status: 502,
      headers: cors,
    });
  }
}
