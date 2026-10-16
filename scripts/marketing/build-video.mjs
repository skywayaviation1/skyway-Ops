// Feature walkthrough of Skyway Ops, recorded from the local preview harness.
//
//   npm run preview:surfaces
//   npm run marketing:video
//
// Demo data only. The script never submits share mail, AOG offers, FBO
// notices, or push. Production hosts are blocked in the browser.
//
// Outputs (OUT_DIR overrides the directory):
//   skyway_walkthrough_1080p.mp4
//   skyway_walkthrough_vertical.mp4
//   skyway_walkthrough_chapters.txt

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { applySkywaySignature, textToHtml } from '../../api/_email-signature.js';
import { computeCoverage, fmtCurrency } from '../../src/aog-utils.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:4178';
const TENANT = 'film';
const WORK = process.env.WORK_DIR || '/tmp/skyway-walkthrough';
const OUT = process.env.OUT_DIR || '/opt/cursor/artifacts';
const ONLY = process.env.SCENE || '';
const FADE = 0.22;
const X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
const EDGE = process.env.EDGE_TTS || `${process.env.HOME}/.local/bin/edge-tts`;
const VOICE = 'en-US-AndrewNeural';

const W = 1920;
const H = 1080;
const MONO = '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Medium.ttf';
const INTER = '/usr/share/fonts/truetype/macos/Inter-Medium.ttf';
const LOGO = `data:image/png;base64,${readFileSync(resolve(root, 'public/skyway-logo.png')).toString('base64')}`;

mkdirSync(`${WORK}/raw`, { recursive: true });
mkdirSync(`${WORK}/clips`, { recursive: true });
mkdirSync(`${WORK}/vo`, { recursive: true });
mkdirSync(OUT, { recursive: true });

const appUrl = (extra = '') =>
  `${BASE}/?surface=app&role=admin&tenant=${TENANT}&demoLink=1${extra}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${BASE}/?surface=dashboard&tenant=${TENANT}`);
      if (res.ok) return;
    } catch { /* starting */ }
    if (i === 0) {
      const child = spawn('npm', ['run', 'preview:surfaces'], {
        cwd: root, detached: true, stdio: 'ignore',
      });
      child.unref();
    }
    await sleep(500);
  }
  throw new Error(`Preview server did not answer at ${BASE}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function probe(file) {
  const out = run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1', file,
  ]);
  return Number(out.trim());
}

const CURSOR_SCRIPT = () => {
  const draw = () => {
    if (document.getElementById('demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'width:28px', 'height:28px',
      'pointer-events:none', 'left:-40px', 'top:-40px',
      'filter:drop-shadow(0 1px 1px rgba(0,0,0,.55))',
    ].join(';');
    cursor.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 2l14 9.2-6.2 1.2L10 20z" fill="#fff" stroke="#111" stroke-width="1.2"/></svg>';
    document.documentElement.appendChild(cursor);
    window.addEventListener('mousemove', (event) => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
    }, true);
  };
  if (document.documentElement) draw();
  else document.addEventListener('DOMContentLoaded', draw);
};

const AVIO_FIXTURE = () => {
  window.__AVIOWIKI_FIXTURE__ = {
    airportByIcao: {
      KIAD: {
        ok: true,
        configured: true,
        source: 'aviowiki',
        airport: {
          icao: 'KIAD',
          name: 'Washington Dulles International',
          servedCity: 'Washington',
          elevationFt: 312,
          timezone: 'America/New_York',
        },
        runways: [{ identifier: '01L/19R', lengthFt: 11500, widthFt: 150, surface: 'ASP' }],
        notes: [{
          notes: 'Preview sample. Confirm with the FBO before dispatch.',
          criticality: 'info',
          category: 'ops',
          source: 'preview',
        }],
        availability: {
          hoursSummary: '24 hours',
          hours: [],
          customs: [{ fromClock: '0600', toClock: '2200', status: 'LIMITED', detail: 'Preview sample' }],
        },
      },
    },
    fbos: {
      ok: true,
      configured: true,
      source: 'aviowiki',
      airports: [{
        airport: 'KIAD',
        airportName: 'Washington Dulles International',
        fbos: [{
          aid: 'demo-iad',
          name: 'Northline Ramp',
          phone: '(703) 555-0148',
          email: 'desk@northlineramp.example',
          address: '1 Aviation Circle, Dulles',
          vhf: '130.85',
          services: ['GPU', 'Lavatory', 'Coffee'],
          paymentMethods: ['Contract fuel'],
          fuelPrices: [{ fuelType: 'Jet-A', price: 6.42, pricePerGal: 6.42, service: 'Full service', currency: 'USD' }],
          fbo: true,
        }],
      }],
    },
    iflight: {
      ok: true,
      configured: true,
      source: 'iFlightPlanner',
      fetchedAt: Date.now(),
      recordCount: 1,
      disclaimer: 'Preview retail price. Confirm with the FBO before dispatch.',
      airports: [{
        airport: 'KIAD',
        fbos: [{
          name: 'Northline Ramp',
          fuelBrand: 'Demo',
          fuelPrices: [{ fuelType: 'Jet-A', price: 6.42, service: 'Full service' }],
        }],
      }],
    },
  };
};

async function prepare(context) {
  await context.addInitScript(CURSOR_SCRIPT);
  await context.addInitScript(AVIO_FIXTURE);
  await context.route('**/*', (route) => {
    const url = route.request().url();
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    const allowed = /^(127\.0\.0\.1|localhost)$|arcgisonline\.com$|arcgis\.com$|unpkg\.com$|openstreetmap\.org$|cartocdn\.com$/i;
    if (host && !allowed.test(host)) return route.abort();
    return route.continue();
  });
}

async function glide(page, locator) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout: 20000 });
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const box = await target.boundingBox();
  if (!box) throw new Error('Element has no box to click');
  const x = Math.round(box.x + Math.min(Math.max(box.width / 2, 8), box.width - 8));
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y, { steps: 18 });
  await page.waitForTimeout(160);
  return { x, y };
}

async function clickAt(page, locator) {
  const pos = await glide(page, locator);
  await page.mouse.click(pos.x, pos.y, { delay: 70 });
  await page.waitForTimeout(280);
}

async function typeInto(page, locator, text) {
  await clickAt(page, locator);
  await page.keyboard.type(text, { delay: 55 });
}

const TAB_LABEL = {
  schedule: 'Schedule',
  ops: 'Dispatch',
  'airport-data': 'Airport & Fuel',
  fbo: 'FBO desk',
  manifests: 'Manifests',
  duty: 'Duty',
  aog: 'AOG',
};

async function nav(page, group, tab) {
  await clickAt(page, page.getByRole('button', { name: group, exact: true }));
  if (!tab) return;
  const byId = page.locator(`[data-tab-id="${tab}"]`).first();
  if (await byId.isVisible().catch(() => false)) {
    await clickAt(page, byId);
    return;
  }
  const label = TAB_LABEL[tab];
  if (label) await clickAt(page, page.getByRole('button', { name: label, exact: true }));
}

async function openLeadTrip(page) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights', exact: true }).waitFor({ timeout: 30000 });
  await nav(page, 'Flights', 'schedule');
  const search = page.getByRole('button', { name: 'Search flights' });
  await clickAt(page, search);
  await typeInto(page, page.getByPlaceholder('Tail, route, customer, crew…'), 'N444AM');
  await page.waitForTimeout(400);
  const card = page.locator('button').filter({ hasText: 'IAD' }).filter({ hasText: 'HYA' }).first();
  await clickAt(page, card);
  await page.getByText('Flight progress').first().waitFor({ timeout: 15000 });
}

async function recordScene(browser, chapter, shoot) {
  const context = await browser.newContext({
    viewport: chapter.viewport || { width: W, height: H },
    recordVideo: { dir: `${WORK}/raw`, size: chapter.viewport || { width: W, height: H } },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  });
  await prepare(context);
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const started = Date.now();
  let ready = started;
  try {
    await shoot(page, () => { ready = Date.now(); });
  } catch (error) {
    await page.screenshot({ path: `${WORK}/${chapter.id}-failed.png` }).catch(() => {});
    await context.close().catch(() => {});
    throw error;
  }
  const video = page.video();
  await context.close();
  const src = await video.path();
  const dest = `${WORK}/raw/${chapter.id}.webm`;
  renameSync(src, dest);
  return { src: dest, trim: Math.max(0, (ready - started) / 1000) };
}

function shellPage(title, body, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    html,body{margin:0;height:100%;background:#070b10;color:#e7eef3;font-family:Inter,system-ui,sans-serif;}
    ${extra}
  </style></head><body>${body}</body></html>`;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadBrokerEmailBuilder() {
  const src = readFileSync(resolve(root, 'api/flightaware-cron-poll.js'), 'utf8');
  const fmt = src.slice(src.indexOf('function fmtTime'), src.indexOf('// === Fetch current FA position'));
  const build = src.slice(src.indexOf('function buildBrokerEmail'), src.indexOf('// === Crew / dispatcher push'));
  return new Function(`${fmt}\n${build}\nreturn buildBrokerEmail;`)();
}

function loadFlightPushText() {
  const cron = readFileSync(resolve(root, 'api/flightaware-cron-poll.js'), 'utf8');
  const fleet = readFileSync(resolve(root, 'src/fleet-tracking.js'), 'utf8');
  const read = fleet
    .slice(fleet.indexOf('const TRIP_ID_PATTERN'), fleet.indexOf('function stateForTrip'))
    .replace(/^export /gm, '');
  const copy = cron
    .slice(cron.indexOf('const PUSH_ZONE_LABEL'), cron.indexOf('export function resolveFlightPushContext'))
    .replace(/^export /gm, '');
  return new Function(`${read}\n${copy}\nreturn buildFlightStatusPushText;`)();
}

const buildBrokerEmail = loadBrokerEmailBuilder();
const buildFlightStatusPushText = loadFlightPushText();

function trackingEmail() {
  const url = 'https://skyway.app/trip-track?token=demo-weqvqd';
  const html = applySkywaySignature([
    `<p style="margin:0 0 16px 0;font-size:15px;color:#1f2937;">You have a live tracking link for your upcoming Skyway charter.</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">`,
    `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;font-size:13px;">Trip</td><td style="padding:2px 0;font-weight:500;">WEQVQD</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;font-size:13px;">Aircraft</td><td style="padding:2px 0;font-weight:500;">N444AM</td></tr>`,
    `</table>`,
    `<p style="margin:0 0 12px 0;font-size:14px;">Track aircraft position, repositioning leg, and live status:</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${url}" style="display:inline-block;background:#1ec0e9;color:#0a0a0a;padding:12px 24px;font-weight:600;text-decoration:none;">TRACK FLIGHT</a></p>`,
    `<p style="margin:0 0 16px 0;font-size:12px;color:#6b7280;">Or paste this link: ${url}</p>`,
    `<p style="margin:24px 0 0 0;font-size:12px;color:#6b7280;">The link expires 24 hours after the final leg lands.</p>`,
  ].join('\n'));
  return { subject: 'Skyway tracking link — WEQVQD (N444AM)', html };
}

function statusEmail(eventType) {
  const when = new Date();
  const { subject, body } = buildBrokerEmail({
    tail: 'N444AM',
    eventType,
    originCode: 'IAD',
    destCode: 'HYA',
    originTz: 'America/New_York',
    destTz: 'America/New_York',
    estimatedOn: eventType === 'wheels_up' ? new Date(when.getTime() + 22 * 60000).toISOString() : null,
    actualOff: new Date(when.getTime() - 35 * 60000).toISOString(),
    actualOn: eventType === 'landed' ? new Date(when.getTime() - 4 * 60000).toISOString() : null,
    scheduledArrivalIso: null,
  });
  return { subject, html: applySkywaySignature(textToHtml(body)) };
}

function aogOfferEmail() {
  const coverage = computeCoverage({ tail: 'N444AM', tripTotal: 24800 });
  const money = (n) => fmtCurrency(n);
  const tripDate = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;color:#0f172a;background:#fff">
  <div style="border-bottom:2px solid #0ea5e9;padding-bottom:16px;margin-bottom:24px">
    <div style="font-size:11px;letter-spacing:.15em;color:#64748b;text-transform:uppercase">Skyway Aviation Services · Charter Flight Support</div>
    <h1 style="font-size:22px;margin:8px 0 0">AOG Additional Coverage Offer</h1>
  </div>
  <p>Your booked charter is automatically covered up to <strong>50%</strong> of AOG recovery cost. This offer is the remaining 50%.</p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:24px 0">
    <div>Aircraft ${coverage.class ? `N444AM (${coverage.class})` : 'N444AM'}</div>
    <div>Route IAD → HYA</div>
    <div>Trip date ${tripDate}</div>
    <div>Trip total ${money(coverage.tripTotal)}</div>
    <div>Less FET −${money(coverage.fetAmount)}</div>
    <div>Net ${money(coverage.netAmount)}</div>
    <div>Rate ${((coverage.rate || 0) * 100).toFixed(2)}%</div>
    <div style="font-size:22px;color:#0ea5e9;margin-top:12px">Additional coverage ${money(coverage.coverageCost)}</div>
  </div>
  <p>Accept and decline stay on this page. Nothing is sent from the preview.</p>
</div>`;
  return { subject: `AOG Additional Coverage Offer — N444AM · IAD → HYA · ${tripDate}`, html };
}

function demoMessages() {
  return [statusEmail('wheels_up'), statusEmail('landed'), trackingEmail(), aogOfferEmail()]
    .map((message, index) => ({
      ...message,
      id: ['up', 'down', 'link', 'aog'][index],
      html: message.html.replaceAll('https://www.skyway.app/skyway-logo.png', LOGO),
    }));
}

function inboxHtml(messages) {
  const rows = messages.map((m, i) => `
    <button class="row ${i === 0 ? 'on' : ''}" data-id="${m.id}">
      <span class="from">Skyway Ops</span>
      <span class="subj">${esc(m.subject)}</span>
      <span class="addr">to dispatch@northline.example</span>
    </button>`).join('');
  const frames = messages.map((m, i) => `
    <iframe class="mail ${i === 0 ? 'on' : ''}" data-id="${m.id}" srcdoc="${esc(m.html)}"></iframe>`).join('');
  return shellPage('Inbox', `
    <div class="app">
      <aside><img src="${LOGO}" alt=""><div class="box on">Inbox</div><div class="box">Charters</div></aside>
      <section class="list">${rows}</section>
      <section class="read"><header id="subject"></header><div class="frame">${frames}</div></section>
    </div>
    <script>
      const messages = ${JSON.stringify(messages.map(({ id, subject }) => ({ id, subject })))};
      const rows = [...document.querySelectorAll('.row')];
      const frames = [...document.querySelectorAll('.mail')];
      window.openMail = (id) => {
        rows.forEach((row) => row.classList.toggle('on', row.dataset.id === id));
        frames.forEach((frame) => frame.classList.toggle('on', frame.dataset.id === id));
        document.getElementById('subject').textContent = messages.find((m) => m.id === id).subject;
      };
      rows.forEach((row) => row.addEventListener('click', () => window.openMail(row.dataset.id)));
      window.openMail('up');
    </script>
  `, `
    .app{display:grid;grid-template-columns:220px 420px 1fr;height:100%;}
    aside{background:#0c1218;border-right:1px solid #1c2833;padding:28px 18px;}
    aside img{width:160px;margin-bottom:24px;}
    .box{color:#8ea0b0;padding:10px 12px;border-radius:8px;}
    .box.on{background:#14303a;color:#fff;}
    .list{background:#10161c;border-right:1px solid #1c2833;}
    .row{display:block;width:100%;text-align:left;background:transparent;color:inherit;border:0;border-bottom:1px solid #1c2833;padding:16px 18px;}
    .row.on{background:#17303a;}
    .subj{display:block;margin-top:6px;}
    .addr{display:block;margin-top:4px;color:#8ea0b0;font-size:12px;}
    .read{display:flex;flex-direction:column;background:#161d24;}
    header{padding:22px 28px;border-bottom:1px solid #1c2833;font-size:22px;font-weight:600;}
    .frame{position:relative;flex:1;margin:16px;background:#fff;border-radius:10px;overflow:hidden;}
    .mail{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;opacity:0;}
    .mail.on{opacity:1;}
  `);
}

async function advanceBroker(page) {
  await page.evaluate(() => {
    if (window.__brokerWrapped) return;
    window.__brokerWrapped = true;
    window.__p = 0.55;
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await orig(input, init);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!String(url).includes('/api/trip-public')) return res;
      const data = await res.json();
      const pos = data.position || {};
      const p = window.__p;
      const { originLat: oLat, originLon: oLon, destinationLat: dLat, destinationLon: dLon } = pos;
      if ([oLat, oLon, dLat, dLon].every((n) => Number.isFinite(n))) {
        pos.latitude = oLat + (dLat - oLat) * p;
        pos.longitude = oLon + (dLon - oLon) * p;
        pos.progressPercent = Math.round(p * 100);
        pos.airborne = p < 0.98;
        pos.heading = 62;
        data.position = pos;
        if (p >= 0.98 && data.trip?.legs?.[0]) {
          data.trip.legs[0].status = { ...(data.trip.legs[0].status || {}), landed: { at: Date.now() } };
        }
      }
      if (data.trip) data.trip.tripCode = 'WEQVQD';
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
}

async function refreshBroker(page, progress) {
  await page.evaluate((p) => { window.__p = p; }, progress);
  const refresh = page.locator('[aria-label="Refresh"]');
  if (await refresh.count()) await clickAt(page, refresh);
  await page.waitForTimeout(700);
}

/* ── Chapters ─────────────────────────────────────────────────────────── */

async function sceneTitle(page, markReady) {
  await page.setContent(shellPage('Title', `
    <div class="card">
      <img src="${LOGO}" alt="Skyway">
      <div class="kicker">A DAY ON THE DESK</div>
      <h1>How Skyway Ops is used.</h1>
    </div>`, `
    body{display:grid;place-items:center;background:radial-gradient(1000px 520px at 50% 40%, #12323c, #070b10 64%);}
    .card{text-align:center;} img{width:420px;}
    .kicker{margin-top:26px;letter-spacing:.34em;color:#3FA9CC;font-family:"JetBrains Mono",monospace;font-size:13px;}
    h1{font-weight:500;font-size:40px;margin:12px 0 0;}
  `));
  markReady();
  await page.waitForTimeout(5200);
}

async function sceneLogin(page, markReady) {
  await page.goto(`${appUrl('&auth=signed-out')}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const button = page.getByRole('button', { name: 'Continue with Microsoft' });
  await button.waitFor({ timeout: 20000 });
  markReady();
  await page.waitForTimeout(700);
  await glide(page, button);
  await page.waitForTimeout(2800);
}

async function sceneHome(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByText('Fleet status').first().waitFor({ timeout: 30000 });
  markReady();
  await page.waitForTimeout(900);
  await glide(page, page.getByText('Live fleet tracking').first());
  await page.waitForTimeout(2600);
}

async function sceneDispatch(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights', exact: true }).waitFor({ timeout: 30000 });
  await nav(page, 'Flights', 'ops');
  await page.getByText('OPS CONSOLE').first().waitFor({ timeout: 20000 });
  markReady();
  await page.waitForTimeout(800);
  await glide(page, page.getByRole('button', { name: 'OPEN TRIP' }).first());
  await page.waitForTimeout(2400);
}

async function expandHero(page) {
  const expand = page.getByRole('button', { name: /Expand trip details/ });
  if (await expand.isVisible().catch(() => false)) await clickAt(page, expand);
}

async function sceneSchedule(page, markReady) {
  await openLeadTrip(page);
  await expandHero(page);
  markReady();
  await page.waitForTimeout(500);
  await glide(page, page.locator('strong').filter({ hasText: 'PIC' }).first());
  await page.waitForTimeout(2400);
}

async function sceneTrip(page, markReady) {
  await openLeadTrip(page);
  markReady();
  await page.waitForTimeout(700);
  await glide(page, page.getByText('WHEELS UP').first());
  await page.waitForTimeout(900);
  const next = page.locator('button').filter({ hasText: 'HYA' }).filter({ hasText: 'TEB' }).first();
  await clickAt(page, next);
  const step = page.getByRole('button', { name: 'Mark AIRCRAFT READY' });
  await step.waitFor({ timeout: 12000 });
  await clickAt(page, step);
  await page.getByRole('button', { name: 'Clear AIRCRAFT READY' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1600);
}

async function scenePush(page, markReady) {
  const wheels = buildFlightStatusPushText({
    tail: 'N444AM', stepId: 'wheels_up', from: 'IAD', to: 'HYA', tripId: 'WEQVQD',
    etaIso: new Date(Date.now() + 48 * 60000).toISOString(), timeZone: 'America/New_York',
  });
  await page.setContent(shellPage('Lock', `
    <div class="phone">
      <div class="lock"><div class="date">Friday, October 16</div><div class="clock">9:41</div></div>
      <div class="note first">
        <img src="${LOGO}" alt=""><div>
          <div class="top"><b>SKYWAY</b><span>now</span></div>
          <div class="title">N444AM · IAD→HYA</div>
          <div class="body">AIRCRAFT READY · by Jim Skyway</div>
        </div>
      </div>
      <div class="note second">
        <img src="${LOGO}" alt=""><div>
          <div class="top"><b>SKYWAY</b><span>now</span></div>
          <div class="title">Wheels up</div>
          <div class="body">${esc(wheels)}</div>
        </div>
      </div>
    </div>`, `
    body{display:grid;place-items:center;background:radial-gradient(900px 700px at 50% 30%, #1a3340, #05070b 70%);}
    .phone{width:420px;height:860px;border-radius:48px;background:linear-gradient(#10202c,#070d14);border:2px solid #243140;position:relative;overflow:hidden;}
    .lock{padding-top:88px;text-align:center;}
    .date{letter-spacing:.14em;text-transform:uppercase;color:#9fb0bf;font-size:14px;}
    .clock{font-size:88px;letter-spacing:-.04em;}
    .note{position:absolute;left:18px;right:18px;display:flex;gap:12px;background:rgba(255,255,255,.14);border-radius:22px;padding:14px;}
    .first{top:250px;animation:drop .6s ease both;}
    .second{top:360px;opacity:0;animation:drop .6s 1.4s ease forwards;}
    .note img{width:42px;height:42px;object-fit:contain;background:#0a0a0a;border-radius:10px;padding:4px;}
    .top{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.12em;color:#d5dee6;}
    .title{font-weight:650;margin-top:3px;}
    .body{color:#d5dee6;font-size:14px;margin-top:2px;}
    @keyframes drop{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:none}}
  `));
  markReady();
  await page.waitForTimeout(6200);
}

async function sceneFleet(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  const map = page.locator('.leaflet-container').first();
  await map.waitFor({ timeout: 30000 });
  await map.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  markReady();
  await page.waitForTimeout(800);
  const row = page.locator('button').filter({ hasText: 'N444AM' }).filter({ hasText: /AIRBORNE|IN FLIGHT/i });
  if (await row.count()) await clickAt(page, row);
  await page.waitForTimeout(2800);
}

async function sceneWeather(page, markReady) {
  await openLeadTrip(page);
  await clickAt(page, page.getByRole('button', { name: 'Operations', exact: true }));
  await clickAt(page, page.locator('[data-tab-id="weather"]'));
  markReady();
  await page.waitForTimeout(1600);
  const notam = page.getByRole('button', { name: /NOTAM/ }).first();
  if (await notam.count()) {
    await clickAt(page, notam);
    await page.waitForTimeout(1800);
  } else {
    await page.waitForTimeout(1800);
  }
}

async function sceneAirport(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights', exact: true }).waitFor();
  await nav(page, 'Flights', 'airport-data');
  await page.getByRole('heading', { name: /Airport, FBO/ }).waitFor({ timeout: 20000 });
  markReady();
  const airport = page.getByPlaceholder('APF, TEB, HPN');
  await clickAt(page, airport);
  await airport.fill('');
  await page.keyboard.type('KIAD', { delay: 90 });
  await typeInto(page, page.getByPlaceholder('Optional'), '800');
  await clickAt(page, page.getByRole('button', { name: /CHECK FBOS/ }));
  await page.getByText('Northline Ramp').first().waitFor({ timeout: 15000 });
  await page.getByText('Northline Ramp').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(2200);
}

async function sceneFbo(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights', exact: true }).waitFor();
  await nav(page, 'Flights', 'fbo');
  await page.getByText(/Need confirmation|FBO/i).first().waitFor({ timeout: 20000 });
  markReady();
  await page.waitForTimeout(700);
  const confirm = page.locator('div').filter({ hasText: 'N444AM' }).getByRole('button', { name: 'Confirm / email' }).first();
  if (await confirm.count()) await clickAt(page, confirm);
  await page.waitForTimeout(2200);
}

async function sceneDuty(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Crew', exact: true }).waitFor({ timeout: 30000 });
  await nav(page, 'Crew', 'duty');
  await page.getByRole('button', { name: 'Calendar', exact: true }).waitFor({ timeout: 20000 });
  markReady();
  await page.waitForTimeout(800);
  await clickAt(page, page.getByRole('button', { name: 'Calendar', exact: true }));
  await page.waitForTimeout(2200);
}

async function sceneHandoff(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  const box = page.getByPlaceholder('What should the next shift know?');
  await box.waitFor({ timeout: 30000 });
  await box.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  markReady();
  await typeInto(page, box, 'N444AM is airborne IAD to HYA. Northline is on the live link.');
  await page.waitForTimeout(1800);
}

async function sceneNotes(page, markReady) {
  await openLeadTrip(page);
  await clickAt(page, page.getByRole('button', { name: 'Operations', exact: true }));
  await clickAt(page, page.locator('[data-tab-id="notes"]'));
  const add = page.getByRole('button', { name: '+ ADD' }).first();
  await add.waitFor({ timeout: 15000 });
  markReady();
  await clickAt(page, add);
  await typeInto(page, page.locator('textarea').first(), 'Helena Voss party of 4. Tracking link is with Northline.');
  await page.waitForTimeout(1600);
}

async function sceneShare(page, markReady) {
  await openLeadTrip(page);
  await expandHero(page);
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await share.waitFor({ timeout: 15000 });
  markReady();
  await clickAt(page, share);
  await page.getByText('INCLUDE ENTIRE TRIP').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await clickAt(page, page.getByText(/INCLUDE ENTIRE TRIP/).first());
  await page.waitForTimeout(2600);
}

async function sceneBroker(page, markReady) {
  await page.goto(`${BASE}/?surface=broker&tenant=${TENANT}&brokerState=entire&demoLink=1`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.getByText('WEQVQD').first().waitFor({ timeout: 20000 });
  await advanceBroker(page);
  markReady();
  await refreshBroker(page, 0.72);
  await refreshBroker(page, 0.9);
  await page.waitForTimeout(1200);
}

async function sceneBrokerPhone(page, markReady) {
  await page.goto(`${BASE}/?surface=broker&tenant=${TENANT}&brokerState=entire&demoLink=1`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.getByText('WEQVQD').first().waitFor({ timeout: 20000 });
  await advanceBroker(page);
  markReady();
  await refreshBroker(page, 0.8);
  await page.waitForTimeout(1800);
}

async function sceneEmail(page, markReady) {
  const messages = demoMessages();
  await page.setContent(inboxHtml(messages), { waitUntil: 'domcontentloaded' });
  markReady();
  await page.waitForTimeout(1400);
  for (const id of ['down', 'link', 'aog']) {
    await clickAt(page, page.locator(`.row[data-id="${id}"]`));
    await page.waitForTimeout(id === 'aog' ? 2200 : 1600);
  }
}

async function sceneAog(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Aircraft', exact: true }).waitFor({ timeout: 30000 });
  await nav(page, 'Aircraft', 'aog');
  await page.getByRole('heading', { name: 'AOG Coverage' }).waitFor({ timeout: 20000 });
  markReady();
  await clickAt(page, page.getByRole('button', { name: '+ New Coverage' }));
  await page.getByRole('heading', { name: 'Track AOG Coverage' }).waitFor({ timeout: 10000 });
  const tail = page.locator('select').filter({ has: page.locator('option[value="N444AM"]') });
  await tail.selectOption('N444AM');
  await page.waitForTimeout(300);
  await typeInto(page, page.getByPlaceholder('KAPF'), 'IAD');
  await typeInto(page, page.getByPlaceholder('KTEB'), 'HYA');
  await typeInto(page, page.getByPlaceholder('Broker Company Name'), 'Northline Charter');
  await typeInto(page, page.getByPlaceholder('ops@broker.com'), 'dispatch@northline.example');
  await typeInto(page, page.getByPlaceholder('0.00'), '24800');
  await page.getByText('Coverage Cost').waitFor({ timeout: 8000 });
  await page.waitForTimeout(1800);
}

async function sceneManifest(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights', exact: true }).waitFor();
  await nav(page, 'Flights', 'manifests');
  await page.getByText('LOAD MANIFESTS').first().waitFor({ timeout: 20000 });
  markReady();
  const existing = page.locator('button').filter({ hasText: 'N444AM' }).first();
  if (await existing.count()) {
    await clickAt(page, existing);
    await page.waitForTimeout(1400);
  }
  await clickAt(page, page.getByRole('button', { name: '+ NEW' }));
  await page.waitForTimeout(1800);
}

async function sceneBoard(page, markReady) {
  await page.goto(appUrl('&board=1'), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByText('N444AM').first().waitFor({ timeout: 20000 });
  markReady();
  await page.waitForTimeout(5200);
}

async function sceneBrand(page, markReady) {
  await page.goto(`${BASE}/?surface=app&role=admin&tenant=elite&board=1&demoLink=1`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.getByText('N880EJ').first().waitFor({ timeout: 20000 });
  markReady();
  await page.waitForTimeout(4200);
}

async function scenePhone(page, markReady) {
  await page.goto(`${BASE}/?surface=app&role=crew&tenant=${TENANT}&demoLink=1`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.getByRole('button', { name: 'Flights', exact: true }).waitFor({ timeout: 30000 });
  await nav(page, 'Flights', 'schedule');
  const card = page.locator('button').filter({ hasText: 'HYA' }).filter({ hasText: 'TEB' }).first();
  await card.waitFor({ timeout: 20000 });
  await clickAt(page, card);
  const step = page.getByRole('button', { name: 'Mark AIRCRAFT READY' });
  await step.waitFor({ timeout: 15000 });
  markReady();
  await clickAt(page, step);
  await page.getByRole('button', { name: 'Clear AIRCRAFT READY' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1600);
}

async function sceneEnd(page, markReady) {
  await page.setContent(shellPage('End', `
    <div class="card">
      <img src="${LOGO}" alt="Skyway">
      <div class="url">skyway.app</div>
      <div class="copy">© 2026 SkyVia Ops</div>
    </div>`, `
    body{display:grid;place-items:center;background:radial-gradient(1000px 520px at 50% 45%, #12323c, #070b10 64%);}
    .card{text-align:center;} img{width:400px;}
    .url{margin-top:26px;font-size:40px;}
    .copy{margin-top:12px;color:#8ea0b0;letter-spacing:.16em;font-size:14px;font-family:"JetBrains Mono",monospace;}
  `));
  markReady();
  await page.waitForTimeout(4800);
}

const CHAPTERS = [
  { id: 'title', kicker: '', benefit: '', narration: 'Skyway Ops. This is a day on the dispatch desk, and how the app is actually used.', shoot: sceneTitle },
  { id: 'login', kicker: 'SIGN IN', benefit: 'Company Microsoft account. Then the desk.', narration: 'A controller signs in with the company Microsoft account.', shoot: sceneLogin },
  { id: 'home', kicker: 'HOME', benefit: 'The fleet, today\'s legs, and what needs attention.', narration: 'Home is the live desk. The fleet, today\'s legs, and anything that needs a controller.', shoot: sceneHome },
  { id: 'dispatch', kicker: 'DISPATCH', benefit: 'Every leg, ready to open.', narration: 'Dispatch is the working board. Each leg can be opened the moment it needs a decision.', shoot: sceneDispatch },
  { id: 'schedule', kicker: 'SCHEDULE', benefit: 'Find the flight. The leg opens with crew and route.', narration: 'Search the tail on the schedule. The leg opens with the route, the crew, and the customer.', shoot: sceneSchedule },
  { id: 'trip', kicker: 'TRIP STATUS', benefit: 'Logged times stay on the leg. The next one is a tap.', narration: 'Status steps run down the leg. This flight already shows crew onsite through wheels up. The next leg is still ahead, so the controller marks the aircraft ready, and the time is logged.', shoot: sceneTrip, highlight: true },
  { id: 'push', kicker: 'CREW NOTIFICATION', benefit: 'The tap, and wheels-up, land on the lock screen.', narration: 'The crew phone gets the status tap, and wheels up when the aircraft is airborne. Trip ID WEQVQD, not a trip number.', shoot: scenePush },
  { id: 'fleet', kicker: 'LIVE FLEET', benefit: 'Select an aircraft. ETA is on the map.', narration: 'On the fleet map, select the airborne aircraft. Position and ETA sit beside the track.', shoot: sceneFleet, highlight: true },
  { id: 'weather', kicker: 'WEATHER AND NOTAMS', benefit: 'METAR on the leg. Open the NOTAM.', narration: 'Weather for the city pair is on the trip. A significant NOTAM opens in place.', shoot: sceneWeather },
  { id: 'airport', kicker: 'AIRPORT AND FBO', benefit: 'aviowiki contacts, fuel, and the uplift cost.', narration: 'Airport and fuel pulls the FBO from aviowiki and prices the planned uplift.', shoot: sceneAirport },
  { id: 'fbo', kicker: 'FBO DESK', benefit: 'Handling status for the leg, before anyone is notified.', narration: 'The FBO desk shows which handling stops still need a confirmation. Nothing is sent from here.', shoot: sceneFbo },
  { id: 'duty', kicker: 'CREW DUTY', benefit: 'The duty report, then the calendar.', narration: 'Crew duty is the oversight view. Switch to the calendar to see who is on the clock.', shoot: sceneDuty },
  { id: 'handoff', kicker: 'SHIFT HANDOFF', benefit: 'Write what the next controller needs.', narration: 'At the end of the shift, the controller writes the handoff on the home desk.', shoot: sceneHandoff },
  { id: 'notes', kicker: 'TRIP NOTES', benefit: 'Crew notes stay on the leg.', narration: 'Notes live on the trip, with the passengers and the tracking link the broker already has.', shoot: sceneNotes },
  { id: 'share', kicker: 'SHARE WITH BROKER', benefit: 'Include the entire trip on one link.', narration: 'Share with the broker, and include the entire trip. One link covers every leg of trip ID WEQVQD.', shoot: sceneShare, highlight: true },
  { id: 'broker', kicker: 'BROKER TRACKING', benefit: 'No login. The page moves with the flight.', narration: 'The broker opens the link. No login. The map updates as the flight moves.', shoot: sceneBroker, highlight: true },
  { id: 'brokerphone', kicker: 'ON THEIR PHONE', benefit: 'The same link, in their hand.', narration: 'The same live page is what they open on a phone.', shoot: sceneBrokerPhone, viewport: { width: 390, height: 844 }, framed: true },
  { id: 'email', kicker: 'BROKER EMAIL', benefit: 'Wheels up, landed, the tracking link, and AOG.', narration: 'The broker inbox gets wheels up, landed, the tracking link, and the AOG coverage offer.', shoot: sceneEmail, highlight: true },
  { id: 'aog', kicker: 'AOG COVERAGE', benefit: 'Enter the trip. The premium calculates.', narration: 'AOG coverage starts as a record. Enter the tail and the trip total, and the premium calculates before anything is saved.', shoot: sceneAog },
  { id: 'manifest', kicker: 'MANIFESTS', benefit: 'A load manifest per tail, per day.', narration: 'Load manifests are one per tail, per day. New opens the manifest for that flying day.', shoot: sceneManifest },
  { id: 'board', kicker: 'OFFICE BOARD', benefit: 'The wall display for the operation.', narration: 'The office TV board is the same day, sized for the wall. Tails, trip IDs, and ETAs.', shoot: sceneBoard, highlight: true },
  { id: 'brand', kicker: 'WHITE LABEL', benefit: 'The same board, under another operator.', narration: 'The same board runs under another operator\'s brand. Elite Jets, same product.', shoot: sceneBrand },
  { id: 'phone', kicker: 'CREW IPHONE', benefit: 'The pilot opens the next leg and taps status.', narration: 'On the crew iPhone, the pilot opens the next leg and taps aircraft ready. The same time lands on the trip.', shoot: scenePhone, viewport: { width: 390, height: 844 }, framed: true },
  { id: 'end', kicker: '', benefit: '', narration: 'Skyway Ops. Charter operations, in real time. skyway.app.', shoot: sceneEnd, highlight: true },
];

function burnLowerThird(src, dest, chapter) {
  if (!chapter.kicker) {
    run('ffmpeg', ['-y', '-i', src, '-an', ...X264, '-r', '30', dest]);
    return;
  }
  const kicker = `${WORK}/clips/${chapter.id}-kicker.txt`;
  const line = `${WORK}/clips/${chapter.id}-line.txt`;
  writeFileSync(kicker, chapter.kicker);
  writeFileSync(line, chapter.benefit);
  const vf = [
    'drawbox=x=48:y=ih-118:w=980:h=86:color=0x071018E6:t=fill',
    'drawbox=x=48:y=ih-118:w=6:h=86:color=0x3FA9CC:t=fill',
    `drawtext=fontfile=${MONO}:textfile=${kicker}:fontsize=16:fontcolor=0x3FA9CC:x=72:y=h-100`,
    `drawtext=fontfile=${INTER}:textfile=${line}:fontsize=26:fontcolor=white:x=72:y=h-68`,
  ].join(',');
  run('ffmpeg', ['-y', '-i', src, '-vf', vf, '-an', ...X264, '-r', '30', dest]);
}

async function phonePlate() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(shellPage('Phone', `
    <img class="logo" src="${LOGO}" alt="">
    <div class="side"><div class="k">CREW AND BROKER</div><h2>The same trip,<br>on a phone.</h2></div>
    <div class="device"><div class="glass"></div></div>
  `, `
    body{background:radial-gradient(900px 640px at 70% 50%, #143844, #070b10 60%);}
    .logo{position:absolute;left:80px;top:64px;width:220px;}
    .side{position:absolute;left:80px;top:380px;width:560px;}
    .k{color:#3FA9CC;letter-spacing:.28em;font-family:"JetBrains Mono",monospace;font-size:14px;}
    h2{font-weight:500;font-size:48px;line-height:1.15;margin:12px 0 0;}
    .device{position:absolute;left:1080px;top:70px;width:430px;height:900px;border-radius:54px;background:#0c1116;border:3px solid #2c3a48;}
    .glass{position:absolute;left:16px;top:16px;width:398px;height:868px;border-radius:40px;background:#020617;}
  `));
  await page.screenshot({ path: `${WORK}/phone-plate.png` });
  await browser.close();
}

function framePhone(src, dest) {
  run('ffmpeg', [
    '-y', '-loop', '1', '-i', `${WORK}/phone-plate.png`, '-i', src,
    '-filter_complex',
    '[1:v]scale=398:868:flags=lanczos,format=yuv420p[phone];[0:v][phone]overlay=1096:86:shortest=1,fps=30,format=yuv420p[v]',
    '-map', '[v]', '-an', ...X264, dest,
  ]);
}

function speak(text, dest) {
  run(EDGE, ['--voice', VOICE, '--rate=-6%', '--text', text, '--write-media', dest]);
}

function writeMusic(duration, dest) {
  const py = `${WORK}/bed.py`;
  writeFileSync(py, `
import math, struct, wave, sys
sr, dur = 44100, float(sys.argv[1])
n = int(sr * dur)
freqs = [110.0, 130.81, 164.81, 196.0, 220.0]
frames = bytearray()
for i in range(n):
    t = i / sr
    env = min(1.0, t / 1.6) * min(1.0, max(0.0, (dur - t) / 2.2))
    s = 0.0
    for k, f in enumerate(freqs):
        s += math.sin(2 * math.pi * f * t) * (0.14 if k < 4 else 0.04)
    s *= env * 0.22
    v = int(max(-1.0, min(1.0, s)) * 32767)
    frames += struct.pack('<hh', v, v)
with wave.open(sys.argv[2], 'w') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(frames)
`);
  run('python3', [py, String(duration + 1), dest]);
}

function fitAudio(video, narration, dest) {
  const vd = probe(video);
  const ad = probe(narration);
  const length = Math.max(vd, ad);
  run('ffmpeg', [
    '-y', '-i', video, '-i', narration,
    '-filter_complex',
    `[0:v]tpad=stop_mode=clone:stop_duration=${Math.max(0, length - vd).toFixed(3)},fps=30,format=yuv420p[v];` +
    `[1:a]apad=pad_dur=${Math.max(0, length - ad).toFixed(3)},atrim=0:${length.toFixed(3)}[a]`,
    '-map', '[v]', '-map', '[a]', ...X264, '-c:a', 'aac', '-b:a', '160k', '-t', length.toFixed(3), dest,
  ]);
}

function assemble(clips, dest, { vertical = false } = {}) {
  if (clips.length === 1) {
    run('ffmpeg', ['-y', '-i', clips[0].file, '-c', 'copy', dest]);
    return probe(dest);
  }
  const filters = [];
  let cursor = clips[0].duration - FADE;
  let prevV = '[0:v]';
  let prevA = '[0:a]';
  for (let i = 1; i < clips.length; i += 1) {
    const last = i === clips.length - 1;
    const outV = last ? '[vout]' : `[vx${i}]`;
    const outA = last ? '[aout]' : `[ax${i}]`;
    filters.push(`${prevV}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${cursor.toFixed(3)}${outV}`);
    filters.push(`${prevA}[${i}:a]acrossfade=d=${FADE}:c1=tri:c2=tri${outA}`);
    prevV = outV;
    prevA = outA;
    cursor += clips[i].duration - FADE;
  }
  const silent = `${WORK}/mix-${vertical ? 'v' : 'h'}.mp4`;
  run('ffmpeg', [
    '-y', ...clips.flatMap((clip) => ['-i', clip.file]),
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...X264, '-c:a', 'aac', '-b:a', '160k', '-r', '30', silent,
  ]);
  const total = probe(silent);
  const music = `${WORK}/bed.wav`;
  writeMusic(total, music);
  const videoFilter = vertical
    ? '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=22:2[bg];' +
      '[0:v]scale=1080:-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,fps=30,format=yuv420p[v]'
    : null;
  if (vertical) {
    run('ffmpeg', [
      '-y', '-i', silent, '-i', music,
      '-filter_complex',
      `${videoFilter};[0:a]volume=1[vo];[1:a]volume=0.16,atrim=0:${total.toFixed(3)}[bed];[vo][bed]amix=inputs=2:duration=first:normalize=0[a]`,
      '-map', '[v]', '-map', '[a]',
      ...X264, '-c:a', 'aac', '-b:a', '160k', '-t', '62', '-movflags', '+faststart', dest,
    ]);
  } else {
    run('ffmpeg', [
      '-y', '-i', silent, '-i', music,
      '-filter_complex',
      `[0:a]volume=1[vo];[1:a]volume=0.16,atrim=0:${total.toFixed(3)}[bed];[vo][bed]amix=inputs=2:duration=first:normalize=0[a]`,
      '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', dest,
    ]);
  }
  return probe(dest);
}

function highlightEdits(clips, target = 60) {
  const fadeLoss = FADE * Math.max(0, clips.length - 1);
  const durations = clips.map((clip) => clip.duration);
  const minimums = clips.map((clip, index) => (
    index === clips.length - 1 ? Math.min(clip.duration, 4.2) : Math.min(3.4, clip.duration)
  ));
  let total = durations.reduce((sum, value) => sum + value, 0) - fadeLoss;
  while (total > target + 0.25) {
    let index = -1;
    let slack = 0;
    durations.forEach((value, i) => {
      const room = value - minimums[i];
      if (room > slack) {
        slack = room;
        index = i;
      }
    });
    if (index < 0 || slack < 0.05) break;
    const cut = Math.min(slack, total - target);
    durations[index] -= cut;
    total -= cut;
  }
  return durations;
}

async function main() {
  await ensureServer();
  if (process.env.PROBE === '1') {
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const failures = [];
    const only = (process.env.PROBE_ONLY || '').split(',').map((id) => id.trim()).filter(Boolean);
    for (const chapter of CHAPTERS.filter((chapter) => !only.length || only.includes(chapter.id))) {
      const context = await browser.newContext({
        viewport: chapter.viewport || { width: W, height: H },
        deviceScaleFactor: 1,
      });
      await prepare(context);
      const page = await context.newPage();
      page.on('dialog', (dialog) => dialog.accept());
      page.on('pageerror', (error) => console.log(`  pageerror ${chapter.id}: ${error.message}`));
      const started = Date.now();
      try {
        await chapter.shoot(page, () => {});
        console.log(`ok ${chapter.id} ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (error) {
        failures.push(chapter.id);
        await page.screenshot({ path: `${WORK}/probe-${chapter.id}.png` }).catch(() => {});
        console.log(`FAIL ${chapter.id}: ${error.message.split('\n')[0]}`);
      }
      await context.close();
    }
    await browser.close();
    if (failures.length) throw new Error(`Probe failed: ${failures.join(', ')}`);
    return;
  }
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const selected = CHAPTERS.filter((chapter) => !ONLY || chapter.id === ONLY);
  const recorded = [];
  for (const chapter of selected) {
    console.log(`recording ${chapter.id}`);
    const clip = await recordScene(browser, chapter, chapter.shoot);
    recorded.push({ ...chapter, ...clip });
    console.log(`  ${chapter.id} trim ${clip.trim.toFixed(2)}s`);
  }
  await browser.close();
  if (ONLY) {
    console.log('Single chapter captured. Skipping assembly.');
    return;
  }

  await phonePlate();
  const normalized = [];
  for (const clip of recorded) {
    const plain = `${WORK}/clips/${clip.id}-plain.mp4`;
    const dur = probe(clip.src);
    const keep = Math.max(0.4, dur - clip.trim);
    run('ffmpeg', [
      '-y', '-ss', clip.trim.toFixed(3), '-i', clip.src, '-t', keep.toFixed(3),
      '-vf', `fps=30,scale=${clip.viewport?.width || W}:${clip.viewport?.height || H},format=yuv420p`,
      '-an', ...X264, plain,
    ]);
    let framed = plain;
    if (clip.framed) {
      framed = `${WORK}/clips/${clip.id}-framed.mp4`;
      framePhone(plain, framed);
    }
    const burned = `${WORK}/clips/${clip.id}-burn.mp4`;
    burnLowerThird(framed, burned, clip);
    const voice = `${WORK}/vo/${clip.id}.mp3`;
    speak(clip.narration, voice);
    const mixed = `${WORK}/clips/${clip.id}.mp4`;
    fitAudio(burned, voice, mixed);
    const actual = probe(mixed);
    normalized.push({ ...clip, file: mixed, duration: actual });
    console.log(`clip ${clip.id} ${actual.toFixed(2)}s`);
  }

  const landscape = `${OUT}/skyway_walkthrough_1080p.mp4`;
  const duration = assemble(normalized, landscape);

  const picked = normalized.filter((clip) => clip.highlight);
  const keeps = highlightEdits(picked, 60);
  const highlight = [];
  for (let i = 0; i < picked.length; i += 1) {
    const keep = keeps[i];
    const start = Math.max(0, picked[i].duration - keep);
    const file = `${WORK}/clips/${picked[i].id}-highlight.mp4`;
    if (start > 0.15 || keep < picked[i].duration - 0.15) {
      run('ffmpeg', [
        '-y', '-i', picked[i].file, '-ss', start.toFixed(3), '-t', keep.toFixed(3),
        ...X264, '-c:a', 'aac', '-b:a', '160k', '-r', '30', file,
      ]);
      highlight.push({ ...picked[i], file, duration: probe(file) });
    } else {
      highlight.push(picked[i]);
    }
  }
  const vertical = `${OUT}/skyway_walkthrough_vertical.mp4`;
  const verticalDuration = assemble(highlight, vertical, { vertical: true });

  const marks = [];
  let at = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const start = at;
    const end = at + normalized[i].duration - (i === normalized.length - 1 ? 0 : FADE);
    marks.push({
      id: normalized[i].id,
      title: normalized[i].kicker || normalized[i].id,
      narration: normalized[i].narration,
      start, end,
    });
    at = end;
  }
  const lines = marks.map((mark) => {
    const stamp = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return `${stamp(mark.start)}–${stamp(mark.end)}  ${mark.title || 'TITLE'}  ${mark.narration}`;
  });
  writeFileSync(`${OUT}/skyway_walkthrough_chapters.txt`, `${lines.join('\n')}\n`);
  writeFileSync(`${WORK}/storyboard.json`, JSON.stringify({
    duration, vertical: verticalDuration, marks,
  }, null, 2));
  console.log(lines.join('\n'));
  console.log(`landscape ${duration.toFixed(2)}s vertical ${verticalDuration.toFixed(2)}s`);
  if (duration < 150 || duration > 240) {
    throw new Error(`Walkthrough ${duration.toFixed(1)}s is outside 2.5–4 minutes`);
  }
}

await main();
