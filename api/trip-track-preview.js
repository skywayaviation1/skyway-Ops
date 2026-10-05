// /api/trip-track-preview.js
//
// HTML shell for link-unfurl bots (iMessage, Slack, Teams, and the rest).
// They do not run the tracking page's JavaScript, so the title, description,
// and image have to be in the first response. Humans stay on the SPA; Vercel
// sends only matching crawler user-agents here.
//
// The page is unindexed. The image URL is the same token-gated logo route
// the tracking page uses, so a preview never exposes a storage path.

import { publicBrandingForTrip, loadTripForPublicToken } from './_broker-brand-store.js';
import { trackingPageMeta } from '../src/broker-brand.js';
import { brand } from '../src/brand.js';

export const config = { runtime: 'nodejs' };

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function originFrom(req) {
  const host = req.headers?.host || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'skyway-ops.vercel.app';
  const proto = String(host).includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

export function renderTrackingPreview({ meta, token }) {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const image = meta.image ? escapeHtml(meta.image) : '';
  const theme = escapeHtml(meta.themeColor || '#0A0B0D');
  const page = token
    ? `/trip-track?token=${encodeURIComponent(token)}`
    : '/trip-track';
  const imageTags = image
    ? `<meta property="og:image" content="${image}" />\n<meta name="twitter:image" content="${image}" />`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="${theme}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  ${imageTags}
  <meta name="twitter:card" content="${image ? 'summary' : 'summary'}" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  ${image ? `<link rel="icon" href="${image}" />` : ''}
  <link rel="canonical" href="${escapeHtml(page)}" />
</head>
<body>
  <p><a href="${escapeHtml(page)}">${title}</a></p>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const token = String(req.query?.token || '');
  const operator = brand();
  let branding = null;
  if (token) {
    try {
      const trip = await loadTripForPublicToken(token);
      if (!trip.error) branding = await publicBrandingForTrip(trip.data, token);
    } catch (e) {
      console.warn('[trip-track-preview] branding lookup skipped:', e?.message || e);
    }
  }
  const meta = trackingPageMeta({
    branding,
    operator,
    origin: originFrom(req),
  });
  if (meta.image && token) {
    meta.image = `${originFrom(req)}/api/broker-logo?token=${encodeURIComponent(token)}`;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(renderTrackingPreview({ meta, token }));
}
