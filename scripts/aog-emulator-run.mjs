// Click through the AOG Coverage page against the Firebase emulators.
// Run under: firebase emulators:exec --config firebase.emulator.json --project skyway-ops-app
// Synthetic data only.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.AOG_LOCAL_STORAGE = process.env.AOG_LOCAL_STORAGE || '/tmp/aog-emulator-storage';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'skyway-ops-app';
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;

const EMAIL = 'ops@example-charter.test';
const PASSWORD = 'synthetic-ops-pass';
const API_PORT = 8787;
const WEB_PORT = 5199;
const SHOT = '/opt/cursor/artifacts/screenshots';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Start this script from firebase emulators:exec so the emulator hosts are set.');
  process.exit(1);
}

function contractPdf(lines) {
  const stream = lines.map((line) => `(${String(line).replace(/[()\\]/g, '')}) Tj`).join('\n');
  return Buffer.from(`%PDF-1.4\n${stream}\n%%EOF\n`);
}

function leg(db, { id, tripId, start, end, from, to, tail, aircraft, customer, email, contract }) {
  return db.collection('trip-state').doc(id).set({
    tripSheetData: { tripCode: tripId, tail, client: customer, aircraftType: aircraft },
    tripMeta: { tail, from, to, start },
    brokerEmail: email,
    ...(contract ? { charterContract: contract } : {}),
  });
}

async function seed() {
  const { Timestamp } = await import('firebase-admin/firestore');
  const { getAdmin, recoveryDb, savePdf } = await import('../api/_aog-recovery.js');
  const admin = (await import('firebase-admin')).default;
  const auth = admin.auth(getAdmin());
  let user;
  try {
    user = await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'Synthetic Ops' });
  } catch (err) {
    if (!/already exists/i.test(String(err.message))) throw err;
    user = await auth.getUserByEmail(EMAIL);
  }
  const db = recoveryDb();
  await db.collection('users').doc(user.uid).set({
    email: EMAIL,
    name: 'Synthetic Ops',
    role: 'ops',
    active: true,
    approved: true,
  });

  const writes = [];
  writes.push(leg(db, {
    id: 'leg-3001-a', tripId: 'WEQVQD', start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T16:00:00.000Z',
    from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Charter Group', email: 'broker@example-charter.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3001-b', tripId: 'WEQVQD', start: '2026-10-14T18:00:00.000Z', end: '2026-10-14T20:00:00.000Z',
    from: 'KTEB', to: 'KAPF', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Charter Group', email: 'broker@example-charter.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3002', tripId: 'M4PQ8K', start: '2026-08-01T14:00:00.000Z', end: '2026-08-01T16:00:00.000Z',
    from: 'KTEB', to: 'KMIA', tail: 'N200TS', aircraft: 'Learjet 60', customer: 'Northwind Example Jets', email: 'past@example-past.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3003', tripId: 'H7N2QD', start: '2026-10-20T14:00:00.000Z', end: '2026-10-22T14:00:00.000Z',
    from: 'KTEB', to: 'KMIA', tail: 'N200TS', aircraft: 'Learjet 60', customer: 'Northwind Example Jets', email: 'dispatch@example-lear.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3004', tripId: 'R2K8LM', start: '2026-10-21T14:00:00.000Z', end: '2026-10-21T18:00:00.000Z',
    from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Gift Jets', email: 'gift@example-gift.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3005', tripId: 'B6TQ9N', start: '2026-10-22T14:00:00.000Z', end: '2026-10-22T18:00:00.000Z',
    from: 'KMIA', to: 'KTEB', tail: 'N200TS', aircraft: 'Learjet 60', customer: 'Example Other Jets', email: 'other@example-other.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3006', tripId: 'C8W4PL', start: '2026-10-23T14:00:00.000Z', end: '2026-10-23T18:00:00.000Z',
    from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example History Jets', email: 'history@example-history.test',
    contract: { path: 'trip-contracts/C8W4PL/charter-contract.pdf', fingerprint: 'synthetic-fingerprint' },
  }));
  writes.push(leg(db, {
    id: 'leg-3020', tripId: 'F5H9RT', start: '2026-09-20T14:00:00.000Z', end: '2026-09-20T16:00:00.000Z',
    from: 'KTEB', to: 'KAPF', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Recent Jets', email: 'recent@example-recent.test',
  }));
  for (let i = 1; i <= 45; i += 1) {
    const n = String(i).padStart(5, '0');
    writes.push(leg(db, {
      id: `leg-fill-${n}`, tripId: `F${n}`, start: '2026-10-15T12:00:00.000Z', end: '2026-10-15T15:00:00.000Z',
      from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Fill Broker', email: 'fill@example-fill.test',
    }));
  }
  writes.push(leg(db, {
    id: 'leg-q4', tripId: 'Q4M8LN', start: '2026-10-18T14:00:00.000Z', end: '2026-10-18T16:00:00.000Z',
    from: 'KACY', to: 'KSYR', tail: 'N286N', aircraft: '', customer: '', email: '',
  }));
  writes.push(leg(db, {
    id: 'leg-k9', tripId: 'K9P2DX', start: '2026-10-19T14:00:00.000Z', end: '2026-10-19T16:00:00.000Z',
    from: 'KMIA', to: 'KTEB', tail: 'N444AM', aircraft: 'Citation CJ3', customer: 'Kept Broker Co', email: 'kept@example-broker.test',
  }));
  await Promise.all(writes);
  await db.collection('manual-trips').doc('leg-3007').set({
    uid: 'leg-3007',
    tripCode: 'D3Y7KS',
    start: '2026-10-24T14:00:00.000Z',
    end: '2026-10-24T18:00:00.000Z',
    info: {
      tail: 'N100TS', from: 'KAPF', to: 'KBOS', aircraft: 'Citation CJ3',
      customer: 'Example Manual Jets', brokerEmail: 'manual@example-manual.test',
    },
  });

  const created = Timestamp.fromDate(new Date('2026-09-20T15:00:00.000Z'));
  await db.collection('aogRecovery').doc('cov-3006').set({
    source: 'inbox',
    tripId: 'C8W4PL',
    brokerCompany: 'Example History Jets',
    checkoutEmail: 'history@example-history.test',
    brokerEmail: 'history@example-history.test',
    tail: 'N100TS',
    aircraftType: 'Citation CJ3',
    route: 'KAPF → KTEB',
    datesLabel: '2026-10-23',
    tripTotal: 18500,
    coverageLevel: 'included_50',
    paymentStatus: 'offer_pending',
    premium: 277.5,
    upgradeAvailable: true,
    charterContractPath: 'aog-recovery/cov-3006/charter-contract.pdf',
    charterContractFilename: 'synthetic-charter.pdf',
    contractAttachStatus: 'attached',
    matchStatus: 'linked',
    linkedTripUid: 'leg-3006',
    offerSentAt: '2026-09-20T15:05:00.000Z',
    createdAt: created,
    currency: 'usd',
  });
  await db.collection('aogRecovery').doc('cov-3006').collection('coverageEvents').doc('offer_sent').set({
    type: 'offer_sent',
    at: Timestamp.fromDate(new Date('2026-09-20T15:05:00.000Z')),
    atUtc: '2026-09-20T15:05:00.000Z',
    actor: 'history@example-history.test',
    coverageLevel: 'included_50',
    paymentStatus: 'offer_pending',
    currency: 'usd',
    amountCents: 27750,
  });
  await savePdf('aog-recovery/cov-3006/charter-contract.pdf', contractPdf(['Charter contract', 'Trip ID: C8W4PL']));

  await db.collection('aogRecovery').doc('unmatched_synthetic').set({
    source: 'inbox',
    tripId: 'P2L6VX',
    brokerCompany: 'Example Charter Group',
    checkoutEmail: 'broker@example-charter.test',
    brokerEmail: 'broker@example-charter.test',
    tail: 'N100TS',
    aircraftType: 'Citation CJ3',
    route: 'KAPF → KTEB',
    datesLabel: '2026-11-02 – 2026-11-04',
    tripTotal: 18500,
    coverageLevel: 'included_50',
    paymentStatus: 'offer_pending',
    premium: 277.5,
    charterContractPath: 'aog-recovery/unmatched_synthetic/charter-contract.pdf',
    charterContractFilename: 'synthetic-unmatched.pdf',
    contractAttachStatus: 'unmatched',
    contractSource: { messageId: 'graph-synthetic-unmatched', receivedAt: '2026-09-01T15:00:00.000Z', sender: 'broker@example-charter.test' },
    matchStatus: 'unmatched',
    createdAt: Timestamp.fromDate(new Date('2026-09-01T15:00:00.000Z')),
    currency: 'usd',
  });
  await savePdf('aog-recovery/unmatched_synthetic/charter-contract.pdf', contractPdf([
    'Charter contract',
    'Trip ID: P2L6VX',
    'Charter total: $18,500.00',
  ]));

  const uploadPdf = contractPdf([
    'Charter contract',
    'Trip ID: H7N2QD',
    'Company: Northwind Example Jets',
    'Checkout email: dispatch@example-lear.test',
    'Aircraft type: Learjet 60',
    'Registration: N200TS',
    'Itinerary: KTEB → KMIA',
    'Depart: 2026-10-20',
    'Return: 2026-10-22',
    'Charter total: $24,000.00',
  ]);
  await writeFile('/tmp/synthetic-charter-3003.pdf', uploadPdf);
  await writeFile('/tmp/synthetic-charter-q4.pdf', contractPdf([
    'Charter contract',
    'Trip ID: Q4M8LN',
    'Company: New Broker Jets',
    'Checkout email: newbroker@example-charter.test',
    'Broker phone: (305) 555-0148',
    'Aircraft type: Citation CJ3',
    'Registration: N286N',
    'Itinerary: KACY → KSYR',
    'Depart: 2026-10-18',
    'Charter total: $12,000.00',
  ]));
  await writeFile('/tmp/synthetic-charter-k9.pdf', contractPdf([
    'Charter contract',
    'Trip ID: K9P2DX',
    'Company: Other Jets',
    'Checkout email: other@example-other.test',
    'Aircraft type: Citation CJ3',
    'Registration: N444AM',
    'Itinerary: KMIA → KTEB',
    'Depart: 2026-10-19',
    'Charter total: $15,000.00',
  ]));
  console.log('seeded synthetic trips');
}

function adapt(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  res.send = (body) => {
    res.end(body);
  };
  return res;
}

async function startApi() {
  const ops = (await import('../api/aog-recovery-ops.js')).default;
  const settings = (await import('../api/aog-recovery-settings.js')).default;
  const gift = (await import('../api/aog-recovery-gift.js')).default;
  const file = (await import('../api/aog-recovery-file.js')).default;
  const scan = (await import('../api/aog-recovery-inbox-scan.js')).default;
  const routes = {
    '/api/aog-recovery-ops': ops,
    '/api/aog-recovery-settings': settings,
    '/api/aog-recovery-gift': gift,
    '/api/aog-recovery-file': file,
    '/api/aog-recovery-inbox-scan': scan,
  };
  const server = createServer((req, res) => {
    adapt(res);
    if (req.url === '/health') {
      res.status(200).end('ok');
      return;
    }
    const handler = routes[req.url.split('?')[0]];
    if (!handler) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) res.status(500).json({ error: err.message || 'failed' });
      });
    });
  });
  await new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', resolve));
  return server;
}

function waitForHttp(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.status < 500) {
          resolve();
          return;
        }
      } catch {
        // server still booting
      }
      if (Date.now() - started > 30000) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function scrollSheetBody(locator) {
  return locator.evaluate(async (el) => {
    let top = 0;
    let max = 0;
    for (let i = 0; i < 6; i += 1) {
      el.scrollTop = el.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      max = el.scrollHeight - el.clientHeight;
      top = el.scrollTop;
      if (max <= 20 || top >= max - 8) break;
    }
    return { top, max };
  });
}

async function shot(page, name) {
  await mkdir(SHOT, { recursive: true });
  const file = path.join(SHOT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('screenshot', file);
}

async function clickThrough() {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (err) => console.log('PAGE', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE', msg.text());
  });
  try {
    await page.goto(`http://127.0.0.1:${WEB_PORT}/aog-emulator`, { waitUntil: 'domcontentloaded' });
    await page.getByText('WEQVQD').first().waitFor({ timeout: 25000 });
    await page.getByText('Email test mode is on').waitFor();
    await page.getByText('2 legs').waitFor();
    await shot(page, 'aog-trips-list');

    await page.getByLabel('Trip window').selectOption('past');
    await page.getByText('M4PQ8K').waitFor();
    if (await page.getByText('WEQVQD').count()) throw new Error('upcoming trip still visible in past view');
    await shot(page, 'aog-trips-past-filter');
    await page.getByLabel('Trip window').selectOption('current');
    await page.getByLabel('Search trips').fill('H7N2QD');
    await page.getByLabel('Contract').selectOption('missing');
    await page.getByText('H7N2QD').waitFor();
    await page.getByText('H7N2QD').click();
    await page.getByRole('dialog', { name: 'Trip H7N2QD' }).waitFor();
    await page.locator('input[type=file]').setInputFiles('/tmp/synthetic-charter-3003.pdf');
    await page.getByRole('button', { name: 'Save contract' }).waitFor({ timeout: 20000 });
    const total = page.getByRole('dialog').getByLabel('Trip total');
    const parsedTotal = await total.inputValue();
    if (!String(parsedTotal).includes('24000') && parsedTotal !== '24000') {
      throw new Error(`parser did not fill trip total (got ${parsedTotal})`);
    }
    const email = await page.getByRole('dialog').getByLabel('Broker email').inputValue();
    if (email !== 'dispatch@example-lear.test') throw new Error(`parser email ${email}`);
    await shot(page, 'aog-contract-review');
    await page.getByRole('button', { name: 'Save contract' }).click();
    await page.getByText(/Contract saved/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByLabel('Contract').selectOption('attached');
    await page.getByText('H7N2QD').waitFor();
    await shot(page, 'aog-contract-saved');

    await page.getByLabel('Search trips').fill('R2K8LM');
    await page.getByLabel('Contract').selectOption('');
    await page.getByText('R2K8LM').click();
    await page.getByRole('button', { name: 'Gift 100%' }).click();
    const confirmGift = page.getByRole('button', { name: 'Confirm gift' });
    await confirmGift.waitFor();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await confirmGift.click({ timeout: 8000 });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }
    await page.getByText(/Gifted 100%/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('cell', { name: /100% gifted by Skyway/ }).waitFor({ timeout: 15000 });
    await shot(page, 'aog-gift');

    await page.getByLabel('Search trips').fill('C8W4PL');
    await page.getByText('C8W4PL').click();
    await page.getByText('offer_sent').waitFor();
    await page.getByRole('button', { name: 'View charter' }).click();
    await shot(page, 'aog-event-history');
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('tab', { name: 'Settings' }).click();
    const lear = page.getByLabel('Rate percent Learjet 60');
    await lear.waitFor();
    await lear.fill('2.5');
    await page.getByRole('button', { name: 'Save rates' }).click();
    await page.getByText('Aircraft rates saved.').waitFor();
    await shot(page, 'aog-rates');

    await page.getByLabel('Complimentary domain').fill('example-charter.test');
    await page.getByRole('button', { name: 'Add domain' }).click();
    await page.getByLabel('Apply to WEQVQD').waitFor();
    await page.locator('li').filter({ hasText: 'example-charter.test' }).getByText(/ops@example-charter\.test/).waitFor();
    await shot(page, 'aog-domain-apply');
    await page.getByRole('button', { name: 'Apply complimentary 100%' }).click();
    await page.getByText(/Complimentary 100% applied/).waitFor({ timeout: 20000 });

    await page.getByRole('tab', { name: 'Trips' }).click();
    await page.getByLabel('Search trips').fill('WEQVQD');
    await page.getByLabel('Trip window').selectOption('all');
    await page.getByLabel('Contract').selectOption('');
    await page.getByRole('cell', { name: /100% complimentary domain/ }).waitFor({ timeout: 15000 });
    await shot(page, 'aog-complimentary-applied');

    await page.getByRole('tab', { name: /Unmatched contracts/ }).click();
    await page.getByText('P2L6VX').waitFor();
    await page.getByLabel('Trip for P2L6VX').selectOption('B6TQ9N');
    await shot(page, 'aog-unmatched');
    await page.getByRole('button', { name: 'Attach to trip' }).click();
    await page.getByText(/Charter contract attached/).waitFor({ timeout: 20000 });

    await page.getByRole('tab', { name: 'Trips' }).click();
    await page.getByLabel('Search trips').fill('');
    await page.getByLabel('Trip window').selectOption('current');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    const csv = await readFile(await download.path(), 'utf8');
    if (!csv.includes('Trip ID,Dates,Route')) throw new Error('csv header missing');
    if (!csv.includes('WEQVQD')) throw new Error('csv missing synthetic trip');
    await writeFile(path.join(SHOT, 'aog-coverage.csv'), csv);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByText(/Page 2 of/).waitFor();
    await shot(page, 'aog-trips-page-2');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Trips' }).click();
    await page.getByLabel('Search trips').fill('WEQVQD');
    await page.getByLabel('Trip window').selectOption('current');
    await page.getByLabel('Contract').selectOption('');
    await page.getByText('WEQVQD').first().waitFor();
    await shot(page, 'aog-trip-ids-iphone');

    await page.getByLabel('Search trips').fill('Q4M8LN');
    await page.getByLabel('Contract').selectOption('missing');
    await page.getByText('Q4M8LN').click();
    await page.getByRole('dialog', { name: 'Trip Q4M8LN' }).waitFor();
    await page.locator('input[type=file]').setInputFiles('/tmp/synthetic-charter-q4.pdf');
    await page.getByRole('button', { name: 'Save contract' }).waitFor({ timeout: 20000 });
    const backfillEmail = await page.getByRole('dialog').getByLabel('Broker email').inputValue();
    if (backfillEmail !== 'newbroker@example-charter.test') throw new Error(`backfill email ${backfillEmail}`);
    const backfillAircraft = await page.getByRole('dialog').getByLabel('Aircraft').inputValue();
    if (!String(backfillAircraft).includes('Citation')) throw new Error(`aircraft prefill ${backfillAircraft}`);
    await page.getByText('saved onto the trip').waitFor();
    await shot(page, 'aog-broker-backfill-review');
    await page.getByRole('button', { name: 'Save contract' }).click();
    await page.getByText(/Contract saved/).waitFor({ timeout: 20000 });
    const drawer = page.locator('.sw-sheet-body').last();
    const scrolled = await scrollSheetBody(drawer);
    await page.getByText('End of trip details').waitFor();
    if (scrolled.max > 20 && scrolled.top < scrolled.max - 8) throw new Error(`drawer did not reach the bottom ${JSON.stringify(scrolled)}`);
    await shot(page, 'aog-drawer-scrolled-iphone-390');
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByLabel('Search trips').fill('K9P2DX');
    await page.getByText('K9P2DX').click();
    await page.locator('input[type=file]').setInputFiles('/tmp/synthetic-charter-k9.pdf');
    await page.getByText('does not match this contract').waitFor({ timeout: 20000 });
    const keptEmail = await page.getByRole('dialog').getByLabel('Broker email').inputValue();
    if (keptEmail !== 'kept@example-broker.test') throw new Error(`mismatch overwrote broker ${keptEmail}`);
    await shot(page, 'aog-broker-mismatch');
    await page.getByRole('button', { name: 'Close' }).click();

    await page.setViewportSize({ width: 375, height: 667 });
    await page.getByLabel('Contract').selectOption('');
    await page.getByLabel('Search trips').fill('Q4M8LN');
    await page.getByText('Q4M8LN').click();
    const shortDrawer = page.locator('.sw-sheet-body').last();
    const shortScrolled = await scrollSheetBody(shortDrawer);
    await page.getByText('End of trip details').waitFor();
    if (shortScrolled.max > 20 && shortScrolled.top < shortScrolled.max - 8) throw new Error(`short drawer did not reach the bottom ${JSON.stringify(shortScrolled)}`);
    await shot(page, 'aog-drawer-scrolled-iphone-375');
    await page.getByRole('button', { name: 'Close' }).click();

    const opened = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const described = buttons.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          top: Math.round(rect.top),
        };
      });
      const target = described.filter((item) => item.text === 'More').pop();
      if (!target) {
        return {
          ok: false,
          width: window.innerWidth,
          navs: [...document.querySelectorAll('nav')].map((nav) => ({
            label: nav.getAttribute('aria-label'),
            hidden: getComputedStyle(nav).display,
            texts: [...nav.querySelectorAll('button')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
          })),
          texts: described.map((item) => item.text).filter(Boolean).slice(-20),
        };
      }
      target.el.click();
      return { ok: true, top: target.top, w: target.w, h: target.h };
    });
    console.log('more click', JSON.stringify(opened));
    if (!opened.ok) throw new Error(`More tab is not on screen ${JSON.stringify(opened)}`);
    const more = page.getByRole('dialog', { name: 'More destinations' });
    await more.waitFor();
    const moreBody = more.locator('.sw-sheet-body');
    const moreScrolled = await scrollSheetBody(moreBody);
    await more.getByText('End of menu').waitFor();
    if (moreScrolled.max > 20 && moreScrolled.top < moreScrolled.max - 8) throw new Error(`more sheet did not reach the bottom ${JSON.stringify(moreScrolled)}`);
    await shot(page, 'more-sheet-scrolled-iphone');
    console.log('click-through ok');
  } catch (err) {
    await shot(page, 'aog-failure').catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

const children = [];
let api;
try {
  await seed();
  api = await startApi();
  const viteBin = path.resolve(import.meta.dirname, '../node_modules/vite/bin/vite.js');
  const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      VITE_FIREBASE_EMULATORS: '1',
      AOG_API_PROXY: `http://127.0.0.1:${API_PORT}`,
    },
    stdio: 'inherit',
  });
  children.push(vite);
  await waitForHttp(`http://127.0.0.1:${API_PORT}/health`);
  await waitForHttp(`http://127.0.0.1:${WEB_PORT}/aog-emulator`);
  await clickThrough();
} finally {
  for (const child of children) child.kill('SIGKILL');
  if (api) await new Promise((resolve) => api.close(resolve));
}
