// Renders the real FBO email builders through the Skyway signature wrapper.
// Usage: node scripts/fbo-email-preview.mjs [output-dir]

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applySkywaySignature } from '../api/_email-signature.js';
import {
  FBO_TEST_RECIPIENT,
  buildArrivalEmail,
  buildArrivalTimeChangeEmail,
  buildArrivalUpdateEmail,
  buildDepartureEmail,
  buildInboundEmail,
  composeFboHtml,
  confirmPagePath,
} from '../src/fbo-notify.js';

const outDir = path.resolve(process.argv[2] || 'artifacts/fbo-emails');

const revenue = {
  tail: 'N444AM',
  tripId: 'WEQVQD',
  from: 'KAPF',
  to: 'KTEB',
  arrivalAirportName: 'Teterboro',
  start: '2026-10-12T18:30:00.000Z',
  end: '2026-10-12T21:10:00.000Z',
  pax: 4,
  legType: 'REVENUE',
  departure: { name: 'Signature Aviation', email: 'apf.csr@signatureflight.com' },
  arrival: {
    name: 'Signature Flight Support',
    email: 'teb.csr@signatureflight.com',
    services: 'GPU, coffee, ice',
    opsNotes: 'Crew will call 20 minutes out.',
  },
};

const empty = {
  ...revenue,
  tail: 'N168ZZ',
  tripId: 'M4R8KQ',
  from: 'KPBI',
  to: 'KAPF',
  arrivalAirportName: 'Naples',
  pax: 0,
  legType: 'REPO',
  departure: { name: 'Atlantic Aviation', email: 'pbi.csr@atlanticaviation.com' },
};

function page(title, subject, intended, html) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { margin: 0; background: #e5e7eb; font-family: -apple-system, Segoe UI, sans-serif; }
    .meta { max-width: 680px; margin: 0 auto; padding: 16px 16px 0; color: #374151; font-size: 13px; }
    .meta strong { color: #111827; }
  </style>
</head>
<body>
  <div class="meta">
    <div><strong>Subject:</strong> ${subject}</div>
    <div><strong>From:</strong> Skyway Ops &lt;charters@flyskyway.com&gt;</div>
    <div><strong>Test delivery:</strong> ${FBO_TEST_RECIPIENT}</div>
    <div><strong>Intended FBO:</strong> ${intended}</div>
  </div>
  ${html}
</body>
</html>`;
}

const departure = buildDepartureEmail(revenue, { timeZone: 'America/New_York' });
const arrival = buildArrivalEmail(
  revenue,
  confirmPagePath('https://www.skyway.app', 'preview-token'),
  { timeZone: 'America/New_York' },
);
const reposition = buildDepartureEmail(empty, { timeZone: 'America/New_York' });
const link = confirmPagePath('https://www.skyway.app', 'preview-token');
const update = buildArrivalUpdateEmail(revenue, link, {
  timeZone: 'America/New_York',
  previousEta: '2026-10-12T20:10:00.000Z',
});
const timeChange = buildArrivalTimeChangeEmail(revenue, link, {
  timeZone: 'America/New_York',
  previousEta: '2026-10-12T20:10:00.000Z',
});
const inbound = buildInboundEmail(revenue, link, {
  timeZone: 'America/New_York',
  originTimeZone: 'America/New_York',
  departedAt: '2026-10-12T18:42:00.000Z',
});

const files = [
  ['departure-reminder.html', departure, 'apf.csr@signatureflight.com'],
  ['arrival-schedule.html', arrival, 'teb.csr@signatureflight.com'],
  ['arrival-update.html', update, 'teb.csr@signatureflight.com'],
  ['arrival-time-change.html', timeChange, 'teb.csr@signatureflight.com'],
  ['inbound-departed.html', inbound, 'teb.csr@signatureflight.com'],
  ['departure-empty-reposition.html', reposition, 'pbi.csr@atlanticaviation.com'],
];

await mkdir(outDir, { recursive: true });
for (const [name, built, intended] of files) {
  const html = applySkywaySignature(composeFboHtml({
    html: built.html,
    testMode: true,
    intendedTo: intended,
  }));
  const file = path.join(outDir, name);
  await writeFile(file, page(built.subject, built.subject, intended, html));
  console.log(file);
}
