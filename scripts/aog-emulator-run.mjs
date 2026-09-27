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
    id: 'leg-3001-a', tripId: 'SKY-TEST-3001', start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T16:00:00.000Z',
    from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Charter Group', email: 'broker@example-charter.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3001-b', tripId: 'SKY-TEST-3001', start: '2026-10-14T18:00:00.000Z', end: '2026-10-14T20:00:00.000Z',
    from: 'KTEB', to: 'KAPF', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Charter Group', email: 'broker@example-charter.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3002', tripId: 'SKY-TEST-3002', start: '2026-08-01T14:00:00.000Z', end: '2026-08-01T16:00:00.000Z',
    from: 'KTEB', to: 'KMIA', tail: 'N200TS', aircraft: 'Learjet 60', customer: 'Northwind Example Jets', email: 'past@example-past.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3003', tripId: 'SKY-TEST-3003', start: '2026-10-20T14:00:00.000Z', end: '2026-10-22T14:00:00.000Z',
    from: 'KTEB', to: 'KMIA', tail: 'N200TS', aircraft: 'Learjet 60', customer: 'Northwind Example Jets', email: 'dispatch@example-lear.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3004', tripId: 'SKY-TEST-3004', start: '2026-10-21T14:00:00.000Z', end: '2026-10-21T18:00:00.000Z',
    from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Gift Jets', email: 'gift@example-gift.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3005', tripId: 'SKY-TEST-3005', start: '2026-10-22T14:00:00.000Z', end: '2026-10-22T18:00:00.000Z',
    from: 'KMIA', to: 'KTEB', tail: 'N200TS', aircraft: 'Learjet 60', customer: 'Example Other Jets', email: 'other@example-other.test',
  }));
  writes.push(leg(db, {
    id: 'leg-3006', tripId: 'SKY-TEST-3006', start: '2026-10-23T14:00:00.000Z', end: '2026-10-23T18:00:00.000Z',
    from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example History Jets', email: 'history@example-history.test',
    contract: { path: 'trip-contracts/SKY-TEST-3006/charter-contract.pdf', fingerprint: 'synthetic-fingerprint' },
  }));
  writes.push(leg(db, {
    id: 'leg-3020', tripId: 'SKY-TEST-3020', start: '2026-09-20T14:00:00.000Z', end: '2026-09-20T16:00:00.000Z',
    from: 'KTEB', to: 'KAPF', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Recent Jets', email: 'recent@example-recent.test',
  }));
  for (let i = 1; i <= 45; i += 1) {
    const n = String(i).padStart(3, '0');
    writes.push(leg(db, {
      id: `leg-fill-${n}`, tripId: `SKY-FILL-${n}`, start: '2026-10-15T12:00:00.000Z', end: '2026-10-15T15:00:00.000Z',
      from: 'KAPF', to: 'KTEB', tail: 'N100TS', aircraft: 'Citation CJ3', customer: 'Example Fill Broker', email: 'fill@example-fill.test',
    }));
  }
  await Promise.all(writes);
  await db.collection('manual-trips').doc('leg-3007').set({
    uid: 'leg-3007',
    tripCode: 'SKY-TEST-3007',
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
    tripId: 'SKY-TEST-3006',
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
  await savePdf('aog-recovery/cov-3006/charter-contract.pdf', contractPdf(['Charter contract', 'Trip ID: SKY-TEST-3006']));

  await db.collection('aogRecovery').doc('unmatched_synthetic').set({
    source: 'inbox',
    tripId: 'SKY-TEST-4040',
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
    'Trip ID: SKY-TEST-4040',
    'Charter total: $18,500.00',
  ]));

  const uploadPdf = contractPdf([
    'Charter contract',
    'Trip ID: SKY-TEST-3003',
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
    await page.getByText('SKY-TEST-3001').first().waitFor({ timeout: 25000 });
    await page.getByText('Email test mode is on').waitFor();
    await page.getByText('2 legs').waitFor();
    await shot(page, 'aog-trips-list');

    await page.getByLabel('Trip window').selectOption('past');
    await page.getByText('SKY-TEST-3002').waitFor();
    if (await page.getByText('SKY-TEST-3001').count()) throw new Error('upcoming trip still visible in past view');
    await shot(page, 'aog-trips-past-filter');
    await page.getByLabel('Trip window').selectOption('current');
    await page.getByLabel('Search trips').fill('SKY-TEST-3003');
    await page.getByLabel('Contract').selectOption('missing');
    await page.getByText('SKY-TEST-3003').waitFor();
    await page.getByText('SKY-TEST-3003').click();
    await page.getByRole('dialog', { name: 'Trip SKY-TEST-3003' }).waitFor();
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
    await page.getByText('SKY-TEST-3003').waitFor();
    await shot(page, 'aog-contract-saved');

    await page.getByLabel('Search trips').fill('SKY-TEST-3004');
    await page.getByLabel('Contract').selectOption('');
    await page.getByText('SKY-TEST-3004').click();
    await page.getByRole('button', { name: 'Gift 100%' }).click();
    await page.getByRole('button', { name: 'Confirm gift' }).click();
    await page.getByText(/Gifted 100%/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('cell', { name: /100% gifted by Skyway/ }).waitFor({ timeout: 15000 });
    await shot(page, 'aog-gift');

    await page.getByLabel('Search trips').fill('SKY-TEST-3006');
    await page.getByText('SKY-TEST-3006').click();
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
    await page.getByLabel('Apply to SKY-TEST-3001').waitFor();
    await page.locator('li').filter({ hasText: 'example-charter.test' }).getByText(/ops@example-charter\.test/).waitFor();
    await shot(page, 'aog-domain-apply');
    await page.getByRole('button', { name: 'Apply complimentary 100%' }).click();
    await page.getByText(/Complimentary 100% applied/).waitFor({ timeout: 20000 });

    await page.getByRole('tab', { name: 'Trips' }).click();
    await page.getByLabel('Search trips').fill('SKY-TEST-3001');
    await page.getByLabel('Trip window').selectOption('all');
    await page.getByLabel('Contract').selectOption('');
    await page.getByRole('cell', { name: /100% complimentary domain/ }).waitFor({ timeout: 15000 });
    await shot(page, 'aog-complimentary-applied');

    await page.getByRole('tab', { name: /Unmatched contracts/ }).click();
    await page.getByText('SKY-TEST-4040').waitFor();
    await page.getByLabel('Trip for SKY-TEST-4040').selectOption('SKY-TEST-3005');
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
    if (!csv.includes('SKY-TEST-3001')) throw new Error('csv missing synthetic trip');
    await writeFile(path.join(SHOT, 'aog-coverage.csv'), csv);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByText(/Page 2 of/).waitFor();
    await shot(page, 'aog-trips-page-2');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Trips' }).click();
    await shot(page, 'aog-trips-mobile');
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
