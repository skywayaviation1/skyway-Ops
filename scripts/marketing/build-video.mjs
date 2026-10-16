// Builds the Skyway Ops marketing film from the local preview harness.
//
//   npm run preview:surfaces
//   npm run marketing:video
//
// The harness serves invented tails, 6-character trip IDs, and fictional
// brokers. This script never calls a mail or push provider. Share-dialog
// email is not submitted. Production hosts are blocked in the browser.
//
// Outputs (overridable with OUT_DIR):
//   skyway_marketing_1080p.mp4
//   skyway_marketing_vertical.mp4
//   four still frames

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { applySkywaySignature, textToHtml } from '../../api/_email-signature.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:4178';
const TENANT = 'film';
const WORK = process.env.WORK_DIR || '/tmp/skyway-marketing';
const OUT = process.env.OUT_DIR || '/opt/cursor/artifacts';
const ONLY = process.env.SCENE || '';
const FADE = 0.45;
const X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p'];

const W = 1920;
const H = 1080;
const INTER = '/usr/share/fonts/truetype/macos/Inter-Medium.ttf';
const INTER_SEMI = '/usr/share/fonts/truetype/macos/Inter-SemiBold.ttf';
const MONO = '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Medium.ttf';

const LOGO = `data:image/png;base64,${readFileSync(resolve(root, 'public/skyway-logo.png')).toString('base64')}`;

mkdirSync(`${WORK}/raw`, { recursive: true });
mkdirSync(`${WORK}/clips`, { recursive: true });
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
        cwd: root,
        detached: true,
        stdio: 'ignore',
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
    throw new Error(`${cmd} ${args.slice(0, 8).join(' ')} failed\n${result.stderr || result.stdout}`);
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

const HIDE_CURSOR = () => {
  const apply = () => {
    if (document.getElementById('mkt-cursor')) return;
    const style = document.createElement('style');
    style.id = 'mkt-cursor';
    style.textContent = '*,*::before,*::after{cursor:none !important}';
    document.documentElement.appendChild(style);
  };
  if (document.documentElement) apply();
  else document.addEventListener('DOMContentLoaded', apply);
};

async function blockProduction(context) {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const blocked = /(^|\.)resend\.com$|(^|\.)googleapis\.com$|(^|\.)skyway\.app$|(^|\.)flyskyway\.com$|(^|\.)firebaseio\.com$|(^|\.)flightaware\.com$/i;
    if (blocked.test(host)) return route.abort();
    return route.continue();
  });
}

async function quietClick(locator) {
  const target = locator.first();
  await target.waitFor({ state: 'attached', timeout: 20000 });
  await target.evaluate((el) => el.click());
}

/** Secondary tabs select on pointerup, not click. Dispatch a tap without moving the cursor. */
async function quietPress(locator) {
  const target = locator.first();
  await target.waitFor({ state: 'attached', timeout: 20000 });
  await target.evaluate((el) => {
    const event = (type) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, pointerId: 1,
    });
    el.dispatchEvent(event('pointerdown'));
    el.dispatchEvent(event('pointerup'));
  });
}

async function smoothScroll(page, delta, ms = 1600) {
  await page.evaluate(async ({ delta, ms }) => {
    const nodes = [...document.querySelectorAll('div')].filter((n) => (
      n.scrollHeight > n.clientHeight + 120 && n.clientHeight > 400
    ));
    const el = nodes.sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;
    const start = el.scrollTop;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        const p = Math.min(1, (now - t0) / ms);
        const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
        el.scrollTop = start + delta * e;
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }, { delta, ms });
}

async function recordScene(browser, name, viewport, shoot) {
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: `${WORK}/raw`, size: viewport },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  });
  await context.addInitScript(HIDE_CURSOR);
  await blockProduction(context);
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.dismiss());
  const started = Date.now();
  let ready = started;
  try {
    await shoot(page, () => { ready = Date.now(); });
  } catch (error) {
    await page.screenshot({ path: `${WORK}/${name}-failed.png` }).catch(() => {});
    await context.close().catch(() => {});
    throw error;
  }
  const video = page.video();
  await context.close();
  const src = await video.path();
  const dest = `${WORK}/raw/${name}.webm`;
  renameSync(src, dest);
  return { name, src: dest, trim: Math.max(0, (ready - started) / 1000) };
}

function shellPage(title, body, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#070b10;color:#e7eef3;font-family:Inter,system-ui,sans-serif;}
    ${extra}
  </style></head><body>${body}</body></html>`;
}

/* ── Real email bodies ────────────────────────────────────────────────── */

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

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mirrors the HTML assembled in api/trip-share.js, then the enqueue wrapper. */
function trackingEmail({ tripCode, tail, url, message }) {
  const htmlParts = [
    `<p style="margin:0 0 16px 0; font-size:15px; color:#1f2937;">You have a live tracking link for your upcoming Skyway charter.</p>`,
  ];
  htmlParts.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">');
  htmlParts.push(`<tr><td style="padding:2px 12px 2px 0; color:#6b7280; font-size:13px;">Trip</td><td style="padding:2px 0; color:#1f2937; font-size:14px; font-weight:500;">${esc(tripCode)}</td></tr>`);
  htmlParts.push(`<tr><td style="padding:2px 12px 2px 0; color:#6b7280; font-size:13px;">Aircraft</td><td style="padding:2px 0; color:#1f2937; font-size:14px; font-weight:500;">${esc(tail)}</td></tr>`);
  htmlParts.push('</table>');
  htmlParts.push(`<p style="margin:0 0 12px 0; font-size:14px; color:#1f2937;">Track aircraft position, repositioning leg, and live status:</p>`);
  htmlParts.push(
    `<p style="margin:0 0 24px 0;">` +
    `<a href="${esc(url)}" style="display:inline-block; background:#1ec0e9; color:#0a0a0a; padding:12px 24px; font-weight:600; text-decoration:none; font-size:14px; letter-spacing:0.02em;">TRACK FLIGHT</a>` +
    `</p>`,
  );
  htmlParts.push(`<p style="margin:0 0 16px 0; font-size:12px; color:#6b7280; word-break:break-all;">Or paste this link: <a href="${esc(url)}" style="color:#1ec0e9; text-decoration:none;">${esc(url)}</a></p>`);
  if (message) {
    htmlParts.push(`<div style="margin:24px 0 16px 0; padding:12px 16px; background:#f9fafb; border-left:3px solid #1ec0e9; font-size:14px; color:#1f2937; white-space:pre-wrap;">${esc(message)}</div>`);
  }
  htmlParts.push(`<p style="margin:24px 0 0 0; font-size:12px; color:#6b7280;">The link expires 24 hours after the final leg lands.</p>`);
  const subject = `Skyway tracking link — ${tripCode} (${tail})`;
  return { subject, html: applySkywaySignature(htmlParts.join('\n')) };
}

function statusEmail(eventType) {
  const when = new Date();
  const off = new Date(when.getTime() - 35 * 60_000).toISOString();
  const eta = new Date(when.getTime() + 22 * 60_000).toISOString();
  const on = new Date(when.getTime() - 4 * 60_000).toISOString();
  const { subject, body } = buildBrokerEmail({
    tail: 'N444AM',
    eventType,
    originCode: 'IAD',
    destCode: 'HYA',
    originTz: 'America/New_York',
    destTz: 'America/New_York',
    estimatedOn: eventType === 'wheels_up' ? eta : null,
    actualOff: off,
    actualOn: eventType === 'landed' ? on : null,
    scheduledArrivalIso: null,
  });
  return { subject, html: applySkywaySignature(textToHtml(body)) };
}

/** Mirrors the offer document in api/aog-offer-send.js. It is not signature-wrapped there. */
function aogOfferEmail() {
  const money = (n) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
  const tripDate = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const expires = new Date(Date.now() + 14 * 86400000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const c = {
    tail: 'N444AM',
    class: 'Midsize',
    routeFrom: 'IAD',
    routeTo: 'HYA',
    tripTotal: 24800,
    fetAmount: 1860,
    netAmount: 22940,
    rate: 0.035,
    coverageCost: 802.9,
  };
  const acceptUrl = 'https://skyway.app/aog-response.html?token=demo&action=accept';
  const declineUrl = 'https://skyway.app/aog-response.html?token=demo&action=decline';
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;color:#0f172a;background:#ffffff">
  <div style="border-bottom:2px solid #0ea5e9;padding-bottom:16px;margin-bottom:24px">
    <div style="font-size:11px;letter-spacing:0.15em;color:#64748b;text-transform:uppercase;font-family:ui-monospace,monospace">Skyway Aviation Services · Charter Flight Support</div>
    <h1 style="font-size:22px;font-weight:600;margin:8px 0 0;color:#0f172a">AOG Additional Coverage Offer</h1>
  </div>
  <p style="line-height:1.6;color:#334155;margin:0 0 20px">
    Your booked charter with Skyway Aviation is automatically covered up to <strong>50%</strong> of AOG (Aircraft on Ground) recovery cost through our JetSure / Charter Flight Support policy.
  </p>
  <p style="line-height:1.6;color:#334155;margin:0 0 20px">
    For an additional cost, you may elect to purchase the remaining <strong>50%</strong> of AOG coverage, bringing your protection to 100% of AOG recovery cost in the event Skyway's aircraft becomes unavailable due to a mechanical or operational issue.
  </p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:24px 0">
    <div style="font-size:11px;letter-spacing:0.1em;color:#64748b;text-transform:uppercase;margin-bottom:12px">Trip Detail</div>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 0;color:#64748b;width:40%">Aircraft</td><td style="padding:4px 0;color:#0f172a;font-family:ui-monospace,monospace">${c.tail} (${c.class})</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Route</td><td style="padding:4px 0;color:#0f172a;font-family:ui-monospace,monospace">${c.routeFrom} → ${c.routeTo}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Trip Date</td><td style="padding:4px 0;color:#0f172a">${tripDate}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Trip Total</td><td style="padding:4px 0;color:#0f172a">${money(c.tripTotal)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Less FET</td><td style="padding:4px 0;color:#0f172a">−${money(c.fetAmount)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Net (basis for coverage)</td><td style="padding:4px 0;color:#0f172a">${money(c.netAmount)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Coverage rate (${c.class})</td><td style="padding:4px 0;color:#0f172a">${(c.rate * 100).toFixed(2)}%</td></tr>
    </table>
    <div style="border-top:1px solid #e2e8f0;margin-top:16px;padding-top:16px">
      <div style="font-size:11px;letter-spacing:0.1em;color:#64748b;text-transform:uppercase">Additional Coverage Cost</div>
      <div style="font-size:24px;font-weight:600;color:#0ea5e9">${money(c.coverageCost)}</div>
    </div>
  </div>
  <p style="line-height:1.6;color:#334155;margin:24px 0">
    If accepted, this amount will be added to your JetInsight invoice for this trip. Please review the terms below and select your response.
  </p>
  <div style="text-align:center;margin:32px 0">
    <a href="${acceptUrl}" style="display:inline-block;background:#0ea5e9;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;margin:0 8px">Accept Coverage — ${money(c.coverageCost)}</a>
    <a href="${declineUrl}" style="display:inline-block;background:transparent;color:#64748b;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:500;border:1px solid #cbd5e1;margin:0 8px">Decline</a>
  </div>
  <p style="font-size:11px;color:#94a3b8;line-height:1.5;margin:0">This offer expires ${expires}. Questions? Reply to this email or call Skyway Aviation Ops.</p>
</div>`.trim();
  return {
    subject: `AOG Additional Coverage Offer — N444AM · IAD → HYA · ${tripDate}`,
    html,
  };
}

function demoMessages() {
  const trackUrl = 'https://skyway.app/trip-track?token=demo-weqvqd';
  const wheels = statusEmail('wheels_up');
  const landed = statusEmail('landed');
  const link = trackingEmail({
    tripCode: 'WEQVQD',
    tail: 'N444AM',
    url: trackUrl,
    message: 'N444AM is airborne IAD to HYA. This link follows the entire trip.',
  });
  const aog = aogOfferEmail();
  const stamp = (min) => {
    const d = new Date(Date.now() - min * 60000);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  return [
    { id: 'up', folder: 'Inbox', time: stamp(8), unread: true, ...wheels },
    { id: 'down', folder: 'Inbox', time: stamp(2), unread: true, ...landed },
    { id: 'link', folder: 'Inbox', time: stamp(40), unread: false, ...link },
    { id: 'aog', folder: 'Inbox', time: stamp(180), unread: false, ...aog },
  ].map((message) => ({
    ...message,
    html: message.html.replaceAll('https://www.skyway.app/skyway-logo.png', LOGO),
  }));
}

function inboxHtml(messages) {
  const rows = messages.map((m, i) => `
    <button class="row ${i === 0 ? 'on' : ''}" data-id="${m.id}">
      <span class="from">Skyway Ops</span>
      <span class="time">${m.time}</span>
      <span class="subj">${esc(m.subject)}</span>
      <span class="addr">to dispatch@northline.example</span>
    </button>`).join('');
  const frames = messages.map((m, i) => `
    <iframe class="mail ${i === 0 ? 'on' : ''}" data-id="${m.id}" srcdoc="${esc(m.html)}"></iframe>`).join('');
  return shellPage('Inbox', `
    <div class="app">
      <aside>
        <img src="${LOGO}" alt="Skyway">
        <div class="box on">Inbox <b>4</b></div>
        <div class="box">Charters</div>
        <div class="box">Sent</div>
      </aside>
      <section class="list">${rows}</section>
      <section class="read">
        <header id="head">
          <div id="subject"></div>
          <div class="meta"><span class="avatar">S</span><div><strong>Skyway Ops</strong><br>noreply@send.flyskyway.com<span> to dispatch@northline.example</span></div></div>
        </header>
        <div class="frame">${frames}</div>
      </section>
    </div>
    <script>
      const messages = ${JSON.stringify(messages.map(({ id, subject }) => ({ id, subject })))};
      const rows = [...document.querySelectorAll('.row')];
      const frames = [...document.querySelectorAll('.mail')];
      function open(id) {
        rows.forEach((row) => row.classList.toggle('on', row.dataset.id === id));
        frames.forEach((frame) => frame.classList.toggle('on', frame.dataset.id === id));
        document.getElementById('subject').textContent = messages.find((m) => m.id === id).subject;
      }
      rows.forEach((row) => row.addEventListener('click', () => open(row.dataset.id)));
      window.openMail = open;
      open('up');
    </script>
  `, `
    .app{display:grid;grid-template-columns:240px 420px 1fr;height:100%;}
    aside{background:#0c1218;border-right:1px solid #1c2833;padding:28px 18px;}
    aside img{width:168px;margin:8px 0 28px;}
    .box{color:#8ea0b0;padding:10px 12px;border-radius:8px;font-size:14px;}
    .box.on{background:#14303a;color:#e7eef3;}
    .box b{float:right;color:#3FA9CC;}
    .list{background:#10161c;border-right:1px solid #1c2833;overflow:auto;}
    .row{display:block;width:100%;text-align:left;background:transparent;color:inherit;border:0;border-bottom:1px solid #1c2833;padding:16px 18px;}
    .row.on{background:#17303a;}
    .from{font-weight:600;font-size:14px;}
    .time{float:right;color:#8ea0b0;font-size:12px;font-family:"JetBrains Mono",monospace;}
    .subj{display:block;margin-top:6px;font-size:14px;color:#d5dee6;}
    .addr{display:block;margin-top:4px;font-size:12px;color:#8ea0b0;}
    .read{display:flex;flex-direction:column;background:#161d24;min-width:0;}
    header{padding:22px 28px 12px;border-bottom:1px solid #1c2833;}
    #subject{font-size:22px;font-weight:600;line-height:1.3;}
    .meta{display:flex;gap:12px;align-items:center;margin-top:14px;color:#8ea0b0;font-size:13px;}
    .meta strong{color:#e7eef3;}
    .avatar{width:36px;height:36px;border-radius:50%;background:#3FA9CC;color:#06171E;display:grid;place-items:center;font-weight:700;}
    .frame{position:relative;flex:1;margin:16px;background:#fff;border-radius:10px;overflow:hidden;}
    .mail{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;opacity:0;pointer-events:none;}
    .mail.on{opacity:1;pointer-events:auto;}
  `);
}

function advanceBroker(page) {
  return page.evaluate(() => {
    const orig = window.fetch.bind(window);
    if (window.__brokerWrapped) return;
    window.__brokerWrapped = true;
    window.__p = 0.62;
    window.fetch = async (input, init) => {
      const res = await orig(input, init);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!String(url).includes('/api/trip-public')) return res;
      const data = await res.json();
      const pos = data.position || {};
      const p = window.__p;
      const oLat = pos.originLat;
      const oLon = pos.originLon;
      const dLat = pos.destinationLat;
      const dLon = pos.destinationLon;
      if ([oLat, oLon, dLat, dLon].every((n) => Number.isFinite(n))) {
        const lat = oLat + (dLat - oLat) * p;
        const lon = oLon + (dLon - oLon) * p;
        const trail = [];
        for (let t = 0; t <= p + 0.001; t += 0.08) {
          trail.push({
            lat: oLat + (dLat - oLat) * t,
            lon: oLon + (dLon - oLon) * t,
            altitude_ft: t < 0.08 ? 1400 : 41000,
            groundspeed_kt: t < 0.08 ? 180 : 448,
            time: Date.now() - Math.round((p - t) * 70) * 60000,
          });
        }
        pos.latitude = p >= 0.98 ? dLat : lat;
        pos.longitude = p >= 0.98 ? dLon : lon;
        pos.progressPercent = Math.round(Math.min(1, p) * 100);
        pos.airborne = p < 0.98;
        pos.heading = 62;
        data.position = pos;
        data.trail = trail;
        if (p >= 0.98 && data.trip?.legs?.[0]) {
          data.trip.legs[0].status = {
            ...(data.trip.legs[0].status || {}),
            landed: { at: Date.now() },
          };
        }
      }
      if (data.trip) data.trip.tripCode = data.trip.tripCode && data.trip.tripCode.length <= 7
        ? data.trip.tripCode
        : 'WEQVQD';
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });
}

async function refreshBroker(page, progress) {
  await page.evaluate((p) => { window.__p = p; }, progress);
  await page.locator('[aria-label="Refresh"]').evaluate((el) => el.click());
  await page.waitForTimeout(900);
}

/* ── Scenes ───────────────────────────────────────────────────────────── */

async function sceneTitle(page, markReady) {
  await page.setContent(shellPage('Skyway Ops', `
    <div class="card">
      <img src="${LOGO}" alt="Skyway Aviation Services">
      <div class="kicker">SKYWAY OPS</div>
      <h1>Charter operations, in real time.</h1>
    </div>`, `
    body{display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% 40%, #12323c 0%, #070b10 62%);}
    .card{text-align:center;animation:rise 1.1s ease both;}
    img{width:460px;height:auto;}
    .kicker{margin-top:28px;letter-spacing:.42em;font-family:"JetBrains Mono",monospace;color:#3FA9CC;font-size:14px;}
    h1{margin:14px 0 0;font-weight:500;font-size:40px;letter-spacing:-0.02em;}
    @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  `));
  markReady();
  await page.waitForTimeout(5200);
}

async function sceneFleet(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  const map = page.locator('.leaflet-container').first();
  await map.waitFor({ timeout: 30000 });
  await page.getByText('Live fleet tracking').first().waitFor({ timeout: 30000 });
  await map.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await page.waitForTimeout(1600);
  const inView = await map.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 280 && r.top < window.innerHeight * 0.72 && r.bottom > window.innerHeight * 0.35;
  });
  if (!inView) throw new Error('Fleet map is not in the kept frame');
  const airborne = page.locator('button').filter({ hasText: 'N444AM' }).filter({ hasText: /AIRBORNE|IN FLIGHT/i });
  if (await airborne.count()) await quietClick(airborne);
  markReady();
  await page.waitForTimeout(6800);
}

async function sceneOps(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights' }).waitFor({ timeout: 30000 });
  await quietClick(page.getByRole('button', { name: 'Flights' }));
  await quietPress(page.locator('[data-tab-id="ops"]'));
  await page.getByText('OPS CONSOLE').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  markReady();
  await page.waitForTimeout(1800);
  await smoothScroll(page, 420, 2200);
  await page.waitForTimeout(2600);
}

async function sceneBoard(page, markReady) {
  await page.goto(appUrl('&board=1'), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3500);
  markReady();
  await page.waitForTimeout(7600);
}

async function sceneShare(page, markReady) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('button', { name: 'Flights' }).waitFor({ timeout: 30000 });
  await quietClick(page.getByRole('button', { name: 'Flights' }));
  await quietPress(page.locator('[data-tab-id="ops"]'));
  await page.getByText('OPS CONSOLE').first().waitFor();
  const buttons = page.getByRole('button', { name: 'OPEN TRIP' });
  const n = await buttons.count();
  let opened = false;
  for (let i = 0; i < n; i += 1) {
    const text = await buttons.nth(i).evaluate((el) => {
      let node = el;
      for (let d = 0; d < 4 && node.parentElement; d += 1) node = node.parentElement;
      return node.innerText || '';
    });
    if (text.includes('N444AM') && text.includes('IAD') && text.includes('HYA') && /IN PROGRESS|AIRBORNE/i.test(text)) {
      await quietClick(buttons.nth(i));
      opened = true;
      break;
    }
  }
  if (!opened) throw new Error('Could not open the N444AM IAD–HYA trip');
  await page.waitForTimeout(1200);
  const expand = page.getByRole('button', { name: /Expand trip details/ });
  if (await expand.count()) await quietClick(expand);
  await page.getByRole('button', { name: 'Share', exact: true }).waitFor({ timeout: 15000 });
  markReady();
  await page.waitForTimeout(1200);
  await quietClick(page.getByRole('button', { name: 'Share', exact: true }));
  await page.getByText('INCLUDE ENTIRE TRIP').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1600);
  const box = page.locator('label').filter({ hasText: 'INCLUDE ENTIRE TRIP' }).locator('input[type="checkbox"]');
  await box.evaluate((el) => { if (!el.checked) el.click(); });
  await page.waitForTimeout(4200);
}

async function sceneBroker(page, markReady) {
  await page.goto(`${BASE}/?surface=broker&tenant=${TENANT}&brokerState=entire`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.getByText('WEQVQD').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1600);
  await advanceBroker(page);
  markReady();
  await page.waitForTimeout(1200);
  for (const p of [0.74, 0.86, 0.99]) {
    await refreshBroker(page, p);
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(800);
}

async function scenePhone(page, markReady) {
  await page.goto(`${BASE}/?surface=broker&tenant=${TENANT}&brokerState=entire`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.getByText('WEQVQD').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await advanceBroker(page);
  markReady();
  await refreshBroker(page, 0.7);
  await page.waitForTimeout(1100);
  await refreshBroker(page, 0.99);
  await page.waitForTimeout(3200);
}

async function sceneEmail(page, markReady) {
  const messages = demoMessages();
  await page.setContent(inboxHtml(messages), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  markReady();
  await page.waitForTimeout(1600);
  for (const id of ['down', 'link', 'aog']) {
    await page.evaluate((mailId) => window.openMail(mailId), id);
    await page.waitForTimeout(id === 'aog' ? 3400 : 2400);
  }
}

async function scenePush(page, markReady) {
  const pushTitle = 'Wheels up';
  const pushBody = buildFlightStatusPushText({
    tail: 'N444AM',
    stepId: 'wheels_up',
    from: 'IAD',
    to: 'HYA',
    tripId: 'WEQVQD',
    etaIso: new Date(Date.now() + 48 * 60_000).toISOString(),
    timeZone: 'America/New_York',
  });
  await page.setContent(shellPage('Lock screen', `
    <div class="phone">
      <div class="notch"></div>
      <div class="lock">
        <div class="date">Friday, October 16</div>
        <div class="clock" id="clock">9:41</div>
      </div>
      <div class="note" id="note">
        <img src="${LOGO}" alt="">
        <div>
          <div class="top"><b>SKYWAY</b><span>now</span></div>
          <div class="title">${esc(pushTitle)}</div>
          <div class="body">${esc(pushBody)}</div>
        </div>
      </div>
    </div>`, `
    body{display:grid;place-items:center;background:radial-gradient(900px 700px at 50% 30%, #1a3340, #05070b 70%);}
    .phone{width:420px;height:860px;border-radius:48px;background:linear-gradient(#10202c,#070d14);position:relative;box-shadow:0 40px 90px rgba(0,0,0,.45);overflow:hidden;border:2px solid #243140;}
    .notch{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:126px;height:28px;background:#05070b;border-radius:20px;}
    .lock{padding-top:92px;text-align:center;}
    .date{letter-spacing:.14em;text-transform:uppercase;color:#9fb0bf;font-size:14px;}
    .clock{font-size:92px;font-weight:560;letter-spacing:-0.04em;margin-top:4px;}
    .note{position:absolute;left:18px;right:18px;top:250px;display:flex;gap:12px;background:rgba(255,255,255,.14);backdrop-filter:blur(16px);border-radius:22px;padding:14px;transform:translateY(-24px);opacity:0;animation:drop .7s .6s ease forwards;}
    .note img{width:44px;height:44px;object-fit:contain;background:#0a0a0a;border-radius:10px;padding:4px;}
    .top{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.14em;color:#d5dee6;}
    .title{font-weight:650;margin-top:3px;}
    .body{color:#d5dee6;font-size:14px;margin-top:2px;}
    @keyframes drop{to{opacity:1;transform:none}}
  `));
  markReady();
  await page.waitForTimeout(6400);
}

async function sceneEnd(page, markReady) {
  await page.setContent(shellPage('End', `
    <div class="card">
      <img src="${LOGO}" alt="Skyway Aviation Services">
      <div class="url">skyway.app</div>
      <div class="copy">© 2026 SkyVia Ops</div>
    </div>`, `
    body{display:grid;place-items:center;background:radial-gradient(1000px 520px at 50% 45%, #12323c, #070b10 64%);}
    .card{text-align:center;animation:rise 1s ease both;}
    img{width:420px;}
    .url{margin-top:28px;font-size:42px;letter-spacing:.04em;}
    .copy{margin-top:12px;color:#8ea0b0;letter-spacing:.18em;font-size:14px;font-family:"JetBrains Mono",monospace;}
    @keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  `));
  markReady();
  await page.waitForTimeout(5600);
}

const SCENES = [
  { name: 'title', size: { width: W, height: H }, caption: null, shoot: sceneTitle },
  { name: 'fleet', size: { width: W, height: H }, caption: ['LIVE FLEET', 'Aircraft, ETAs, and the map in one view.'], shoot: sceneFleet },
  { name: 'ops', size: { width: W, height: H }, caption: ['OPS CONSOLE', 'Every leg, ready to dispatch.'], shoot: sceneOps },
  { name: 'board', size: { width: W, height: H }, caption: ['OFFICE BOARD', 'The wall display for the operation.'], shoot: sceneBoard },
  { name: 'share', size: { width: W, height: H }, caption: ['SHARE WITH BROKER', 'Include the entire trip on one link.'], shoot: sceneShare },
  { name: 'broker', size: { width: W, height: H }, caption: ['BROKER TRACKING', 'A live page. No login. It updates as the flight moves.'], shoot: sceneBroker },
  { name: 'phone', size: { width: 390, height: 844 }, caption: ['ON THEIR PHONE', 'The same link, in their hand.'], shoot: scenePhone, framed: true },
  { name: 'email', size: { width: W, height: H }, caption: ['BROKER EMAIL', 'Wheels up, landed, the tracking link, and AOG coverage.'], shoot: sceneEmail },
  { name: 'push', size: { width: W, height: H }, caption: ['CREW NOTIFICATION', 'Wheels up lands on the lock screen.'], shoot: scenePush },
  { name: 'end', size: { width: W, height: H }, caption: null, shoot: sceneEnd },
];

function captionFiles(name, kicker, line) {
  const k = `${WORK}/clips/${name}-kicker.txt`;
  const l = `${WORK}/clips/${name}-line.txt`;
  writeFileSync(k, kicker);
  writeFileSync(l, line);
  return [k, l];
}

function burnCaption(src, dest, name, caption) {
  if (!caption) {
    run('ffmpeg', ['-y', '-i', src, '-an', ...X264, '-r', '30', dest]);
    return;
  }
  const [kicker, line] = captionFiles(name, caption[0], caption[1]);
  const vf = [
    'drawbox=x=72:y=ih-128:w=980:h=92:color=0x071018E8:t=fill',
    'drawbox=x=72:y=ih-128:w=6:h=92:color=0x3FA9CC:t=fill',
    `drawtext=fontfile=${MONO}:textfile=${kicker}:fontsize=18:fontcolor=0x3FA9CC:x=100:y=h-108`,
    `drawtext=fontfile=${INTER}:textfile=${line}:fontsize=30:fontcolor=white:x=100:y=h-74`,
  ].join(',');
  run('ffmpeg', ['-y', '-i', src, '-vf', vf, '-an', ...X264, '-r', '30', dest]);
}

async function phonePlate() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(shellPage('Phone', `
    <img class="logo" src="${LOGO}" alt="">
    <div class="side">
      <div class="k">THE BROKER LINK</div>
      <h2>Live position,<br>without a login.</h2>
    </div>
    <div class="device"><div class="glass"></div></div>
  `, `
    body{background:radial-gradient(900px 640px at 70% 50%, #143844, #070b10 60%);}
    .logo{position:absolute;left:80px;top:64px;width:220px;}
    .side{position:absolute;left:80px;top:360px;width:520px;}
    .k{color:#3FA9CC;letter-spacing:.28em;font-family:"JetBrains Mono",monospace;font-size:14px;}
    h2{font-weight:500;font-size:48px;line-height:1.15;margin:12px 0 0;}
    .device{position:absolute;left:1080px;top:70px;width:430px;height:900px;border-radius:54px;background:#0c1116;border:3px solid #2c3a48;box-shadow:0 30px 80px rgba(0,0,0,.45);}
    .glass{position:absolute;left:16px;top:16px;width:398px;height:868px;border-radius:40px;background:#020617;}
  `));
  await page.screenshot({ path: `${WORK}/phone-plate.png` });
  await browser.close();
}

function framePhone(src, dest) {
  // Screen cutout matches .glass: left 1096, top 86, 398x868.
  run('ffmpeg', [
    '-y', '-loop', '1', '-i', `${WORK}/phone-plate.png`, '-i', src,
    '-filter_complex',
    '[1:v]scale=398:868:flags=lanczos,format=yuv420p[phone];[0:v][phone]overlay=1096:86:shortest=1,fps=30,format=yuv420p[v]',
    '-map', '[v]', '-an', ...X264, dest,
  ]);
}

function writeMusic(duration, dest) {
  const py = `${WORK}/bed.py`;
  writeFileSync(py, `
import math, struct, wave, sys
sr = 44100
dur = float(sys.argv[1])
n = int(sr * dur)
freqs = [110.0, 130.81, 164.81, 196.0, 220.0, 329.63]
frames = bytearray()
for i in range(n):
    t = i / sr
    env = min(1.0, t / 1.8) * min(1.0, max(0.0, (dur - t) / 2.4))
    lfo = 0.82 + 0.18 * math.sin(2 * math.pi * 0.06 * t)
    s = 0.0
    for k, f in enumerate(freqs):
        amp = 0.16 if k < 4 else 0.05
        s += math.sin(2 * math.pi * f * t + k) * amp
        s += math.sin(2 * math.pi * f * 2 * t) * amp * 0.15
    s *= env * lfo * 0.35
    s = max(-1.0, min(1.0, s))
    v = int(s * 32767)
    frames += struct.pack('<hh', v, v)
with wave.open(sys.argv[2], 'w') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(frames)
`);
  run('python3', [py, String(duration), dest]);
}

async function main() {
  await ensureServer();
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const selected = SCENES.filter((scene) => !ONLY || scene.name === ONLY);
  const recorded = [];
  for (const scene of selected) {
    console.log(`recording ${scene.name}`);
    const clip = await recordScene(browser, scene.name, scene.size, scene.shoot);
    recorded.push({ ...scene, ...clip });
    console.log(`  ${scene.name} trim ${clip.trim.toFixed(2)}s`);
  }
  await browser.close();
  if (ONLY) {
    console.log('Single scene captured. Skipping assembly.');
    return;
  }

  await phonePlate();
  const normalized = [];
  for (const clip of recorded) {
    const plain = `${WORK}/clips/${clip.name}-plain.mp4`;
    const dur = probe(clip.src);
    const keep = Math.max(0.4, dur - clip.trim);
    run('ffmpeg', [
      '-y', '-ss', clip.trim.toFixed(3), '-i', clip.src, '-t', keep.toFixed(3),
      '-vf', `fps=30,scale=${clip.size.width}:${clip.size.height},format=yuv420p`,
      '-an', ...X264, plain,
    ]);
    let framed = plain;
    if (clip.framed) {
      framed = `${WORK}/clips/${clip.name}-framed.mp4`;
      framePhone(plain, framed);
    }
    const burned = `${WORK}/clips/${clip.name}.mp4`;
    burnCaption(framed, burned, clip.name, clip.caption);
    const actual = probe(burned);
    normalized.push({ ...clip, file: burned, duration: actual });
    console.log(`clip ${clip.name} ${actual.toFixed(2)}s`);
  }

  const filters = [];
  let cursor = normalized[0].duration - FADE;
  let prev = '[0:v]';
  for (let i = 1; i < normalized.length; i += 1) {
    const out = i === normalized.length - 1 ? '[vout]' : `[vx${i}]`;
    filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${cursor.toFixed(3)}${out}`);
    prev = out;
    cursor += normalized[i].duration - FADE;
  }
  const total = cursor + FADE;
  const silent = `${WORK}/master-silent.mp4`;
  run('ffmpeg', [
    '-y',
    ...normalized.flatMap((clip) => ['-i', clip.file]),
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    ...X264, '-r', '30', '-movflags', '+faststart',
    silent,
  ]);

  const music = `${WORK}/bed.wav`;
  writeMusic(total + 0.4, music);
  const landscape = `${OUT}/skyway_marketing_1080p.mp4`;
  run('ffmpeg', [
    '-y', '-i', silent, '-i', music,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart',
    landscape,
  ]);

  const vertical = `${OUT}/skyway_marketing_vertical.mp4`;
  run('ffmpeg', [
    '-y', '-i', landscape,
    '-filter_complex',
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bg];' +
    '[0:v]scale=1080:-2:flags=lanczos[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,fps=30,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a:0?',
    ...X264, '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', vertical,
  ]);

  const marks = [];
  let at = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const start = at;
    const end = at + normalized[i].duration - (i === normalized.length - 1 ? 0 : FADE);
    marks.push({ name: normalized[i].name, start, end, mid: (start + end) / 2 });
    at = end;
  }
  const stills = [
    ['fleet', 'skyway_frame_fleet.png', 0.45],
    ['board', 'skyway_frame_board.png', 0.45],
    ['share', 'skyway_frame_share.png', 0.84],
    ['broker', 'skyway_frame_broker.png', 0.7],
  ];
  for (const [name, file, ratio] of stills) {
    const mark = marks.find((item) => item.name === name);
    const at = mark.start + (mark.end - mark.start) * ratio;
    run('ffmpeg', [
      '-y', '-i', landscape, '-ss', at.toFixed(3), '-frames:v', '1', '-update', '1',
      `${OUT}/${file}`,
    ]);
  }

  const duration = probe(landscape);
  const verticalDuration = probe(vertical);
  writeFileSync(`${WORK}/storyboard.json`, JSON.stringify({
    duration, vertical: verticalDuration, marks,
  }, null, 2));
  console.log(readFileSync(`${WORK}/storyboard.json`, 'utf8'));
  if (duration < 60 || duration > 90) {
    throw new Error(`Landscape duration ${duration.toFixed(1)}s is outside 60–90s`);
  }
}

await main();
