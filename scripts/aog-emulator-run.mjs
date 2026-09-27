// Click through the AOG Coverage page against the Firebase emulators.
// Run under: firebase emulators:exec --config firebase.emulator.json --project skyway-ops-app
// Synthetic data only.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { bindLetterContent, cfsBrokerLetter, cfsOpsLetter } from '../src/aog-cfs.js';

process.env.AOG_LOCAL_STORAGE = process.env.AOG_LOCAL_STORAGE || '/tmp/aog-emulator-storage';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'skyway-ops-app';
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;

const EMAIL = 'ops@example-charter.test';
const PASSWORD = 'synthetic-ops-pass';
const CFS_ACK_TOKEN = 'synthetic-cfs-ack-token-0123456789abcd';
const OFFER_TOKEN = 'synthetic-offer-token-0123456789abcd';
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
  writes.push(leg(db, {
    id: 'leg-cfs-a', tripId: 'M8CFS2', start: '2026-11-02T14:00:00.000Z', end: '2026-11-02T17:00:00.000Z',
    from: 'KTEB', to: 'KPBI', tail: 'N318CS', aircraft: 'Citation CJ3', customer: 'Example Charter Group', email: 'broker@example-charter.test',
  }));
  writes.push(leg(db, {
    id: 'leg-cfs-b', tripId: 'M8CFS2', start: '2026-11-04T18:00:00.000Z', end: '2026-11-04T21:00:00.000Z',
    from: 'KPBI', to: 'KTEB', tail: 'N318CS', aircraft: 'Citation CJ3', customer: 'Example Charter Group', email: 'broker@example-charter.test',
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
  await db.collection('aogRecovery').doc('cov-m8cfs2').set({
    source: 'gift',
    tripId: 'M8CFS2',
    brokerCompany: 'Example Charter Group',
    checkoutEmail: 'broker@example-charter.test',
    brokerEmail: 'broker@example-charter.test',
    tail: 'N318CS',
    aircraftType: 'Citation CJ3',
    route: 'KTEB → KPBI',
    datesLabel: '2026-11-02 – 2026-11-04',
    departDate: '2026-11-02',
    returnDate: '2026-11-04',
    legCount: 2,
    tripTotal: 20000,
    tripTotalCents: 2000000,
    premium: 300,
    premiumCents: 30000,
    ratePercent: 1.5,
    coverageLimitCents: 4000000,
    coverageMultiplier: 2,
    coverageLevel: 'gifted_100',
    paymentStatus: 'gifted',
    electionSource: 'gifted',
    currency: 'usd',
    matchStatus: 'linked',
    contractAttachStatus: 'attached',
    linkedTripUids: ['leg-cfs-a', 'leg-cfs-b'],
    contractLegIds: ['leg-cfs-a', 'leg-cfs-b'],
    bindEmailSentAt: '2026-11-01T15:00:00.000Z',
    createdAt: Timestamp.fromDate(new Date('2026-11-01T15:00:00.000Z')),
    updatedAt: '2026-11-01T15:00:00.000Z',
    ackTokenHash: createHash('sha256').update(CFS_ACK_TOKEN).digest('hex'),
    ackTokenExpiresAt: '2026-12-31T00:00:00.000Z',
    charterContractPath: 'trip-contracts/M8CFS2/charter-contract.pdf',
  });
  const portalBase = {
    source: 'gift',
    brokerCompany: 'Example Charter Group',
    tail: 'N318CS',
    aircraftType: 'Citation CJ3',
    route: 'KTEB → KPBI',
    routeFrom: 'KTEB',
    routeTo: 'KPBI',
    tripTotal: 20000,
    tripTotalCents: 2000000,
    includedMultiplier: 1,
    upgradeMultiplier: 2,
    coverageLimitCents: 4000000,
    coverageMultiplier: 2,
    coverageLevel: 'gifted_100',
    paymentStatus: 'gifted',
    currency: 'usd',
    bindEmailSentAt: '2026-09-25T12:00:00.000Z',
  };
  const portalAck = (label) => ({
    ackTokenHash: createHash('sha256').update(`synthetic-portal-ack-${label}`).digest('hex'),
    ackTokenExpiresAt: '2026-12-31T00:00:00.000Z',
  });
  await db.collection('aogRecovery').doc('cov-urgent').set({
    ...portalBase,
    ...portalAck('V3K8QM'),
    tripId: 'V3K8QM',
    datesLabel: '2026-09-29 – 2026-09-30',
    departDate: '2026-09-29',
    departAtUtc: '2026-09-29T14:00:00.000Z',
    returnDate: '2026-09-30',
    createdAt: Timestamp.fromDate(new Date('2026-09-25T12:00:00.000Z')),
  });
  await db.collection('aogRecovery').doc('cov-bulk').set({
    ...portalBase,
    ...portalAck('L4P9HX'),
    tripId: 'L4P9HX',
    datesLabel: '2026-10-08 – 2026-10-09',
    departDate: '2026-10-08',
    departAtUtc: '2026-10-08T14:00:00.000Z',
    returnDate: '2026-10-09',
    createdAt: Timestamp.fromDate(new Date('2026-09-24T12:00:00.000Z')),
  });
  await db.collection('aogRecovery').doc('cov-bound').set({
    ...portalBase,
    ...portalAck('N6C2WT'),
    tripId: 'N6C2WT',
    datesLabel: '2026-10-02 – 2026-10-03',
    departDate: '2026-10-02',
    departAtUtc: '2026-10-02T14:00:00.000Z',
    returnDate: '2026-10-03',
    cfsStatus: 'cfs_confirmed',
    cfsConfirmedAt: '2026-09-20T15:00:00.000Z',
    cfsConfirmedByName: 'Casey Stone',
    cfsConfirmedByEmail: 'charter@charterflightsupport.com',
    cfsCostCents: 64000,
    cfsReference: 'CFS-4491',
    createdAt: Timestamp.fromDate(new Date('2026-09-20T12:00:00.000Z')),
  });
  await db.collection('aogRecovery').doc('cov-offer').set({
    source: 'checkout',
    tripId: 'T8R4WQ',
    brokerCompany: 'Example Charter Group',
    checkoutEmail: 'broker@example-charter.test',
    tail: 'N318CS',
    aircraftType: 'Citation CJ3',
    route: 'KTEB → KPBI',
    datesLabel: '2026-11-02 – 2026-11-04',
    departDate: '2026-11-02',
    returnDate: '2026-11-04',
    tripTotal: 20000,
    tripTotalCents: 2000000,
    premium: 300,
    premiumCents: 30000,
    ratePercent: 1.5,
    includedMultiplier: 1,
    upgradeMultiplier: 2,
    coverageLimitCents: 2000000,
    coverageMultiplier: 1,
    coverageLevel: 'included_50',
    paymentStatus: 'offer_pending',
    upgradeAvailable: true,
    currency: 'usd',
    createdAt: Timestamp.fromDate(new Date('2026-09-01T12:00:00.000Z')),
    offerTokenHash: createHash('sha256').update(OFFER_TOKEN).digest('hex'),
  });
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
  const cfs = (await import('../api/aog-recovery-cfs.js')).default;
  const offer = (await import('../api/aog-recovery-public.js')).default;
  const portal = (await import('../api/cfs-portal.js')).default;
  const routes = {
    '/api/aog-recovery-ops': ops,
    '/api/aog-recovery-settings': settings,
    '/api/aog-recovery-gift': gift,
    '/api/aog-recovery-file': file,
    '/api/aog-recovery-inbox-scan': scan,
    '/api/aog-recovery-cfs': cfs,
    '/api/aog-recovery-public': offer,
    '/api/cfs-portal': portal,
  };
  const server = createServer((req, res) => {
    adapt(res);
    const url = new URL(req.url, 'http://127.0.0.1');
    req.query = Object.fromEntries(url.searchParams);
    if (url.pathname === '/health') {
      res.status(200).end('ok');
      return;
    }
    const handler = routes[url.pathname];
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const confirmGift = page.getByRole('button', { name: 'Confirm gift' });
      try {
        await confirmGift.waitFor({ timeout: 4000 });
        await confirmGift.click({ timeout: 5000 });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        const arm = page.getByRole('button', { name: 'Gift 100%' });
        if (await arm.count()) await arm.click().catch(() => {});
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

    const cfsRecord = {
      tripId: 'M8CFS2',
      aircraftType: 'Citation CJ3',
      tail: 'N318CS',
      route: 'KTEB → KPBI',
      datesLabel: '2026-11-02 – 2026-11-04',
      legCount: 2,
      brokerCompany: 'Example Charter Group',
      coverageLevel: 'gifted_100',
      tripTotal: 20000,
      tripTotalCents: 2000000,
      premium: 300,
      premiumCents: 30000,
      ratePercent: 1.5,
    };
    const ackUrl = `http://127.0.0.1:${WEB_PORT}/aog-cfs?token=${encodeURIComponent(CFS_ACK_TOKEN)}`;
    const bind = bindLetterContent(cfsRecord, { ackUrl, attachmentNotes: 'Charter contract is attached.' });
    const bindBody = `${bind.html}\n${bind.text}`;
    if (/premium/i.test(bindBody)) throw new Error('bind email still names the premium');
    if (bindBody.includes('1.5') || bindBody.includes('$300') || bindBody.includes('$360')) throw new Error('bind email still names the rate or premium amount');
    if (!bind.html.includes('Acknowledge coverage')) throw new Error('bind email is missing the acknowledge button');
    if (!bindBody.includes('Coverage value: up to $40,000.00')) throw new Error('bind email is missing the coverage value');
    if (!bindBody.includes('$20,000.00')) throw new Error('bind email is missing the trip total');
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${bind.html}</body></html>`);
    await shot(page, 'aog-bind-email');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ackUrl, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Your name').waitFor({ timeout: 20000 });
    const formText = await page.locator('body').innerText();
    if (/premium/i.test(formText)) throw new Error('acknowledgement page shows the premium');
    if (!formText.includes('100%') || !formText.includes('$20,000.00') || !formText.includes('up to $40,000.00')) {
      throw new Error(`acknowledgement page is missing the fixed coverage value: ${formText.slice(0, 500)}`);
    }
    if (await page.getByLabel('Accepted coverage percent').count()) throw new Error('percent field is still on the form');
    if (await page.getByLabel('Coverage limit').count()) throw new Error('coverage limit field is still on the form');
    await page.getByLabel('Your name').fill('Casey Stone');
    await page.getByLabel('Your email').fill('casey@charterflightsupport.com');
    await page.getByLabel('CFS cost').fill('640.00');
    await page.getByLabel('Policy or reference number').fill('CFS-4491');
    await page.locator('.sw-sheet-body').evaluate((el) => { el.scrollTop = 0; });
    await page.getByText('Coverage', { exact: true }).first().waitFor();
    await page.getByText('up to $40,000.00').first().waitFor();
    await shot(page, 'aog-cfs-form-iphone');
    await page.getByRole('button', { name: 'Acknowledge coverage' }).click();
    await page.getByText('Coverage acknowledged').waitFor({ timeout: 20000 });
    await page.getByText('Already acknowledged by Casey Stone').waitFor();

    await page.setViewportSize({ width: 375, height: 667 });
    const ackBody = page.locator('.sw-sheet-body');
    const ackScrolled = await scrollSheetBody(ackBody);
    const ackEnd = page.getByText('End of acknowledgement');
    await ackEnd.waitFor();
    const ackBox = await ackEnd.boundingBox();
    const ackViewport = page.viewportSize();
    console.log('ack scroll', JSON.stringify({ ackScrolled, ackBox, ackViewport }));
    if (!ackBox || ackBox.y < 0 || ackBox.y + ackBox.height > ackViewport.height + 2) {
      throw new Error(`acknowledgement page did not reach the bottom ${JSON.stringify({ ackScrolled, ackBox })}`);
    }
    await shot(page, 'aog-cfs-form-iphone-375');

    const ackFields = {
      name: 'Casey Stone',
      email: 'casey@charterflightsupport.com',
      cfsCostCents: 64000,
      reference: 'CFS-4491',
      notes: '',
    };
    const opsLetter = cfsOpsLetter(cfsRecord, ackFields);
    const opsBody = `${opsLetter.html}\n${opsLetter.text}`;
    if (!/640/.test(opsBody) || !/CFS cost/i.test(opsBody)) throw new Error('ops email is missing the CFS cost');
    if (!/up to \$40,000\.00/.test(opsBody)) throw new Error('ops email is missing the coverage value');
    if (/below what was requested/i.test(opsBody)) throw new Error('ops email still flags a shortfall');
    const brokerLetter = cfsBrokerLetter(cfsRecord);
    const brokerBody = `${brokerLetter.html}\n${brokerLetter.text}`;
    if (/\$640|640\.00|CFS cost/i.test(brokerBody)) {
      throw new Error('broker email includes the CFS cost');
    }
    if (!/Included: 50%, up to \$20,000\.00/.test(brokerBody) || !/premium \$300\.00/.test(brokerBody)) {
      throw new Error('broker email is missing the included 50% and 100% upgrade');
    }
    if (!/up to \$40,000\.00/.test(brokerBody) || !/100%/.test(brokerBody)) {
      throw new Error('broker email is missing 100% coverage value');
    }
    await page.setViewportSize({ width: 720, height: 900 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${opsLetter.html}</body></html>`);
    await shot(page, 'aog-cfs-ops-email');
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${brokerLetter.html}</body></html>`);
    await shot(page, 'aog-cfs-broker-email');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/aog-emulator`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('region', { name: 'Trip detail' }).getByText('AOG coverage confirmed by Charter Flight Support').first().waitFor({ timeout: 25000 });
    await page.getByText('Coverage value: up to $40,000.00').first().waitFor();
    await page.getByText('This leg: KTEB → KPBI').waitFor();
    await page.getByText('This leg: KPBI → KTEB').waitFor();
    await shot(page, 'aog-trip-detail-cfs');

    await page.getByLabel('Search trips').fill('M8CFS2');
    await page.getByRole('cell', { name: /100% gifted by Skyway/ }).waitFor({ timeout: 15000 });
    await page.getByLabel('CFS confirmation').selectOption('confirmed');
    const badge = page.getByText('Confirmed', { exact: true });
    await badge.waitFor({ timeout: 15000 });
    await badge.evaluate((el) => {
      const scroller = el.closest('.overflow-x-auto') || el.parentElement;
      if (scroller) scroller.scrollLeft = scroller.scrollWidth;
      el.scrollIntoView({ block: 'center', inline: 'center' });
    });
    await shot(page, 'aog-cfs-confirmed-badge');
    await page.getByRole('cell', { name: 'M8CFS2' }).click();
    const cfsDrawer = page.locator('.sw-sheet-body').last();
    await cfsDrawer.getByText('CFS cost').waitFor();
    await cfsDrawer.getByText('$640.00').waitFor();
    const coverageValue = cfsDrawer.getByText('Coverage value: up to $40,000.00').first();
    await coverageValue.waitFor();
    await page.getByRole('button', { name: 'Resend bind email' }).waitFor();
    await scrollSheetBody(cfsDrawer);
    await page.getByText('End of trip details').waitFor();
    await coverageValue.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'aog-cfs-drawer-iphone');
    await portalShots(page);
    console.log('click-through ok');
  } catch (err) {
    await shot(page, 'aog-failure').catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

async function portalShots(page) {
  const offerUrl = `http://127.0.0.1:${WEB_PORT}/aog-coverage?token=${encodeURIComponent(OFFER_TOKEN)}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(offerUrl, { waitUntil: 'domcontentloaded' });
  const included = page.getByText('Included: 50%, up to $20,000.00');
  const upgrade = page.getByText('Upgrade: 100%, up to $40,000.00, premium $300.00');
  await included.waitFor({ timeout: 20000 });
  await upgrade.waitFor();
  await included.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'aog-offer-comparison-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  const offerSheet = page.locator('.aog-public-sheet .sw-sheet-body');
  await upgrade.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const includedBox = await included.boundingBox();
  const upgradeBox = await upgrade.boundingBox();
  const offerViewport = page.viewportSize();
  if (!includedBox || !upgradeBox
    || includedBox.y < 0
    || upgradeBox.y + upgradeBox.height > offerViewport.height + 2) {
    throw new Error(`offer comparison is outside the iPhone viewport ${JSON.stringify({ includedBox, upgradeBox, offerViewport })}`);
  }
  await shot(page, 'aog-offer-comparison-iphone');
  await page.setViewportSize({ width: 375, height: 667 });
  const offerScrolled = await scrollSheetBody(offerSheet);
  const offerEnd = page.getByText('End of offer');
  await offerEnd.waitFor();
  const offerEndBox = await offerEnd.boundingBox();
  const offerSmall = page.viewportSize();
  if (!offerEndBox || offerEndBox.y < 0 || offerEndBox.y + offerEndBox.height > offerSmall.height + 2) {
    throw new Error(`offer page did not reach the bottom ${JSON.stringify({ offerScrolled, offerEndBox })}`);
  }

  const { offerLetter } = await import('../api/_aog-recovery.js');
  const letter = offerLetter({
    tripId: 'T8R4WQ',
    tripTotal: 20000,
    tripTotalCents: 2000000,
    premium: 300,
    ratePercent: 1.5,
    coverageLevel: 'included_50',
    upgradeAvailable: true,
    includedMultiplier: 1,
    upgradeMultiplier: 2,
    tail: 'N318CS',
    route: 'KTEB → KPBI',
    datesLabel: '2026-11-02 – 2026-11-04',
  }, offerUrl);
  const offerBody = `${letter.html}\n${letter.text}`;
  if (!offerBody.includes('Included: 50%, up to $20,000.00')) throw new Error('offer email is missing included 50%');
  if (!offerBody.includes('Upgrade: 100%, up to $40,000.00, premium $300.00')) throw new Error('offer email is missing the 100% upgrade');
  await page.setViewportSize({ width: 720, height: 900 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${letter.html}</body></html>`);
  await shot(page, 'aog-offer-email');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/cfs`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Email me a sign-in link' }).waitFor({ timeout: 20000 });
  await shot(page, 'cfs-sign-in');

  const linkResponse = await fetch(`http://127.0.0.1:${API_PORT}/api/cfs-portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'request-link', email: 'charter@charterflightsupport.com' }),
  });
  const linkBody = await linkResponse.json();
  if (!linkBody.devLink) throw new Error(`magic link was not issued: ${JSON.stringify(linkBody)}`);
  const dev = new URL(linkBody.devLink);
  dev.protocol = 'http:';
  dev.host = `127.0.0.1:${WEB_PORT}`;
  await page.goto(dev.href, { waitUntil: 'domcontentloaded' });
  await page.getByText('Awaiting acknowledgement').first().waitFor({ timeout: 20000 });
  await page.getByText('Needs action').waitFor();
  if (await page.getByText('T8R4WQ').count()) throw new Error('50% trip is visible in the CFS portal');
  if (/premium|gifted|complimentary/i.test(await page.locator('body').innerText())) {
    throw new Error('CFS dashboard shows Skyway-only wording');
  }
  await page.getByText('Signed in.').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  await shot(page, 'cfs-dashboard-desktop');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await page.locator('.cfs-portal[data-theme="dark"]').waitFor();
  await shot(page, 'cfs-dashboard-dark');
  await page.getByRole('button', { name: 'Light mode' }).click();
  await page.locator('.cfs-portal[data-theme="light"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const portalBody = page.locator('.cfs-portal .sw-sheet-body');
  await portalBody.evaluate((el) => { el.scrollTop = 0; });
  await shot(page, 'cfs-dashboard-iphone');

  async function assertPortalEnd(label) {
    const portalScrolled = await scrollSheetBody(portalBody);
    const portalEnd = page.getByText('End of portal');
    await portalEnd.waitFor();
    const portalBox = await portalEnd.boundingBox();
    const portalViewport = page.viewportSize();
    console.log(label, JSON.stringify({ portalScrolled, portalBox, portalViewport }));
    if (!portalBox || portalBox.y < 0 || portalBox.y + portalBox.height > portalViewport.height + 2) {
      throw new Error(`CFS portal did not reach the bottom at ${label} ${JSON.stringify({ portalScrolled, portalBox })}`);
    }
  }
  await assertPortalEnd('portal-390');
  await page.setViewportSize({ width: 375, height: 667 });
  await assertPortalEnd('portal-375');
  await portalBody.evaluate((el) => { el.scrollTop = 0; });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole('button', { name: /V3K8QM/ }).first().click();
  await page.getByLabel('Your name').waitFor({ timeout: 15000 });
  await page.getByText('Coverage: 100%').waitFor();
  await page.getByText(/Coverage value: up to \$40,000\.00/).waitFor();
  await portalBody.evaluate((el) => { el.scrollTop = 0; });
  await shot(page, 'cfs-trip-iphone-top');
  await page.getByLabel('Your name').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'cfs-trip-acknowledge');
  await page.getByLabel('Your name').fill('Casey Stone');
  await page.getByLabel('Your email').fill('charter@charterflightsupport.com');
  await page.getByLabel('CFS cost').fill('640.00');
  page.on('response', async (response) => {
    const posted = response.request().postData() || '';
    if (response.request().method() !== 'POST' || !posted.includes('"acknowledge"')) return;
    const text = await response.text().catch(() => '');
    console.log('ACK', response.status(), text.slice(0, 500));
  });
  await page.getByRole('button', { name: 'Acknowledge coverage' }).click();
  const acknowledged = page.getByRole('heading', { name: 'Coverage acknowledged' });
  await acknowledged.waitFor({ timeout: 20000 });
  await page.locator('.cfs-success').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.getByText('Signed in.').waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {});
  await shot(page, 'cfs-ack-success');

  await page.getByRole('button', { name: 'Back to trips' }).click();
  await page.getByLabel('Select V3K8QM').check();
  await page.getByLabel('Select L4P9HX').check();
  await page.getByLabel('Same CFS cost').fill('640.00');
  await page.getByRole('button', { name: 'Apply same cost' }).click();
  await page.getByRole('button', { name: 'Review bulk acknowledgement' }).click();
  const bulkCost = page.getByLabel('CFS cost V3K8QM');
  await bulkCost.waitFor();
  await bulkCost.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, 'cfs-bulk-acknowledge');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Monthly statement' }).click();
  await page.getByRole('button', { name: 'Show statement' }).click();
  const statementId = page.locator('.cfs-table .cfs-trip-id', { hasText: 'N6C2WT' });
  await statementId.waitFor({ timeout: 15000 });
  await page.locator('.cfs-totals').getByText(/Coverage value total/).waitFor();
  await page.locator('.cfs-table').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'cfs-statement');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/aog-emulator`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('50% multiplier').waitFor({ timeout: 20000 });
  await page.getByLabel('100% multiplier').waitFor();
  const staffRow = page.locator('li').filter({ hasText: 'charter@charterflightsupport.com' });
  await staffRow.waitFor();
  const preview = page.getByRole('button', { name: 'CFS portal preview' });
  await preview.waitFor();
  await page.getByRole('heading', { name: 'Charter Flight Support portal' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'aog-cfs-allowlist-preview');
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
