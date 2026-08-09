/* Captures marketing screenshots of the real application screens.
 *
 * Prerequisite: the harness dev server is running on :5199 with
 * TZ=America/New_York (see README.md in this directory).
 *
 * Usage:
 *   node capture.mjs            capture everything
 *   node capture.mjs duty home  capture only the named shots
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../marketing/assets/screens');
const BASE = 'http://localhost:5199';

const DESKTOP = { width: 1560, height: 980, deviceScaleFactor: 2 };
const PHONE = { width: 402, height: 860, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const SHOTS = [
  {
    name: 'command-center',
    viewport: DESKTOP,
    nav: [],
    settle: 5200,
  },
  {
    name: 'command-center-weather',
    viewport: DESKTOP,
    nav: [],
    settle: 5200,
    scrollTo: 'Airport weather',
  },
  {
    name: 'schedule-trip-detail',
    viewport: DESKTOP,
    nav: ['Flights', 'Schedule'],
    settle: 3200,
    async prepare(page) {
      await clickMatching(page, (text) => text.includes('TEB') && text.includes('PBI') && text.includes('Airborne'));
      await wait(3200);
    },
  },
  {
    name: 'trip-passengers',
    viewport: DESKTOP,
    nav: ['Flights', 'Schedule'],
    settle: 3000,
    async prepare(page) {
      await clickMatching(page, (text) => text.includes('TEB') && text.includes('PBI') && text.includes('Airborne'));
      await wait(2600);
      await clickText(page, 'Passengers');
      await wait(2000);
    },
  },
  {
    name: 'trip-weather',
    viewport: DESKTOP,
    nav: ['Flights', 'Schedule'],
    settle: 3000,
    async prepare(page) {
      await clickMatching(page, (text) => text.includes('HPN') && text.includes('MVY'));
      await wait(2600);
      await clickText(page, 'Operations');
      await wait(900);
      await clickText(page, 'Weather');
      await wait(3200);
    },
  },
  {
    name: 'dispatch-console',
    viewport: DESKTOP,
    nav: ['Flights', 'Dispatch'],
    settle: 4200,
  },
  {
    name: 'live-tracking',
    viewport: DESKTOP,
    nav: ['Flights', 'Tracking'],
    settle: 7000,
    async prepare(page) {
      // Open the airborne aircraft rather than whichever tail sorts first.
      await clickMatching(page, (text) => text.startsWith('N444AM'));
      await wait(6000);
    },
  },
  {
    name: 'flight-board',
    viewport: DESKTOP,
    url: '/?board=1',
    settle: 9000,
  },
  {
    name: 'duty-rest',
    viewport: DESKTOP,
    nav: ['Crew', 'Duty'],
    settle: 4200,
  },
  {
    name: 'crew-duty-board',
    viewport: DESKTOP,
    nav: [],
    settle: 5200,
    scrollTo: 'CREW · DUTY STATUS',
  },
  {
    name: 'currency-matrix',
    viewport: DESKTOP,
    nav: ['Crew', 'Currency'],
    settle: 4200,
  },
  {
    name: 'maintenance-log',
    viewport: DESKTOP,
    nav: ['Aircraft', 'Maintenance'],
    settle: 4200,
  },
  {
    name: 'expenses',
    viewport: DESKTOP,
    nav: ['Crew', 'Expenses'],
    settle: 3600,
    async prepare(page) {
      await clickText(page, 'ALL');
      await wait(2000);
      await clickMatching(page, (text) => text.includes('Atlantic Aviation PBI'));
      await wait(2200);
    },
  },
  {
    name: 'wear-watch',
    viewport: DESKTOP,
    nav: ['Crew', 'Wear'],
    settle: 3600,
  },
  {
    name: 'lodging',
    viewport: DESKTOP,
    nav: ['Flights', 'Lodging'],
    settle: 3600,
    async prepare(page) {
      await clickText(page, 'ALL');
      await wait(2000);
    },
  },
  {
    name: 'wallet',
    viewport: DESKTOP,
    nav: ['Admin', 'Wallet'],
    settle: 3200,
  },
  {
    name: 'squawks',
    viewport: DESKTOP,
    nav: ['Aircraft', 'Maintenance'],
    settle: 3400,
    async prepare(page) {
      await clickText(page, 'SQUAWKS');
      await wait(2400);
    },
  },
  {
    name: 'aml-log',
    viewport: DESKTOP,
    nav: ['Aircraft', 'Maintenance'],
    settle: 3400,
    async prepare(page) {
      await clickText(page, 'AML LOG');
      await wait(2600);
    },
  },
  {
    name: 'aog-events',
    viewport: DESKTOP,
    nav: ['Aircraft', 'Maintenance'],
    settle: 3400,
    async prepare(page) {
      await clickText(page, 'AOG EVENTS');
      await wait(2200);
      await clickMatching(page, (text) => text.startsWith('AOG N20UF'));
      await wait(2600);
    },
  },
  {
    name: 'duty-calendar',
    viewport: DESKTOP,
    nav: ['Crew', 'Duty'],
    settle: 3600,
    async prepare(page) {
      await clickText(page, 'Calendar');
      await wait(3000);
    },
  },
  {
    name: 'malfunction-reports',
    viewport: DESKTOP,
    nav: ['Crew', 'Reports'],
    settle: 3400,
  },
  {
    name: 'broker-tracking',
    viewport: DESKTOP,
    url: '/?view=broker',
    settle: 9000,
  },
  {
    name: 'phone-broker-tracking',
    viewport: PHONE,
    url: '/?view=broker',
    settle: 9000,
  },
  {
    name: 'phone-pilot-home',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 5000,
  },
  {
    name: 'phone-duty',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await scrollContainer(page, 520);
      await wait(1400);
    },
  },
  {
    name: 'phone-trip-status',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await clickText(page, 'Flights');
      await wait(2200);
      await clickMatching(page, (text) => text.includes('TEB') && text.includes('PBI'));
      await wait(3000);
    },
  },
  {
    name: 'phone-schedule',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await clickText(page, 'Flights');
      await wait(2800);
    },
  },
  {
    name: 'phone-passengers',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await clickText(page, 'Flights');
      await wait(2200);
      await clickMatching(page, (text) => text.includes('TEB') && text.includes('PBI'));
      await wait(2600);
      await clickText(page, 'Passengers');
      await wait(2400);
    },
  },
  {
    name: 'phone-expenses',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await clickText(page, 'More');
      await wait(1600);
      await clickText(page, 'Expenses');
      await wait(2800);
    },
  },
  {
    name: 'phone-wear',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await clickText(page, 'More');
      await wait(1600);
      await clickText(page, 'Wear');
      await wait(2400);
      await clickText(page, 'CREATE INSPECTION');
      await wait(3000);
    },
  },
  {
    name: 'phone-currency',
    viewport: PHONE,
    url: '/?as=crew',
    settle: 4200,
    async prepare(page) {
      await clickText(page, 'More');
      await wait(1600);
      await clickText(page, 'Currency');
      await wait(2400);
      await clickMatching(page, (text) => text.startsWith('Ken Alvarez'));
      await wait(2600);
    },
  },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* The app renders desktop and mobile navigation simultaneously and hides one
 * with CSS, so every click has to filter for what is actually on screen. */
const VISIBLE_CLICK = `
  function harnessVisibleTargets() {
    return Array.from(document.querySelectorAll('button, [role="button"], a')).filter((node) => {
      if (!node.offsetParent && getComputedStyle(node).position !== 'fixed') return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      return getComputedStyle(node).visibility !== 'hidden';
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
`;

/* Tabs support long-press-to-reorder, so they listen for pointer events rather
 * than click. Driving the real mouse is the only reliable way in. */
async function clickBox(page, box) {
  if (!box) return false;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(70);
  await page.mouse.up();
  return true;
}

async function clickText(page, label) {
  const box = await page.evaluate((text, helper) => {
    // eslint-disable-next-line no-eval
    eval(helper);
    // eslint-disable-next-line no-undef
    const nodes = harnessVisibleTargets();
    const name = (node) => node.innerText.replace(/\s+/g, ' ').trim().toUpperCase();
    const target = nodes.find((n) => name(n) === text.toUpperCase())
      || nodes.find((n) => name(n).startsWith(text.toUpperCase()));
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 18) };
  }, label, VISIBLE_CLICK);
  const ok = await clickBox(page, box);
  if (!ok) console.warn(`  ! could not click "${label}"`);
  return ok;
}

async function clickMatching(page, predicate) {
  const source = predicate.toString();
  const box = await page.evaluate((fnSource, helper) => {
    // eslint-disable-next-line no-eval
    eval(helper);
    // eslint-disable-next-line no-new-func
    const test = new Function(`return (${fnSource})`)();
    // eslint-disable-next-line no-undef
    const target = harnessVisibleTargets().find((n) => test(n.innerText.replace(/\s+/g, ' ').trim()));
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 18) };
  }, source, VISIBLE_CLICK);
  const ok = await clickBox(page, box);
  if (!ok) console.warn('  ! could not click predicate target');
  return ok;
}

/* On mobile the app scrolls an inner element, so window.scrollBy is a no-op. */
async function scrollContainer(page, pixels) {
  await page.evaluate((amount) => {
    const scrollable = Array.from(document.querySelectorAll('div, main, section'))
      .filter((n) => n.scrollHeight - n.clientHeight > 200)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (scrollable) scrollable.scrollTop += amount;
    else window.scrollBy(0, amount);
  }, pixels);
}

async function scrollToText(page, label) {
  const found = await page.evaluate((text) => {
    const matches = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span,p,td,th'))
      .filter((n) => n.textContent.replace(/\s+/g, ' ').trim().toUpperCase() === text.toUpperCase());
    const node = matches[matches.length - 1];
    if (!node) return false;
    node.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -90);
    return true;
  }, label);
  if (!found) console.warn(`  ! could not scroll to "${label}"`);
  return found;
}

async function run() {
  const only = process.argv.slice(2);
  await fs.mkdir(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--font-render-hinting=none'],
    env: { ...process.env, TZ: 'America/New_York' },
  });

  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.name)) continue;
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.setViewport(shot.viewport);
    await page.goto(`${BASE}${shot.url || '/'}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await wait(shot.settle || 3000);

    for (const label of shot.nav || []) {
      await clickText(page, label);
      await wait(1600);
    }
    if (shot.prepare) await shot.prepare(page);
    if (shot.scrollTo) {
      await scrollToText(page, shot.scrollTo);
      await wait(1800);
    }

    const file = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`captured ${shot.name}${errors.length ? ` (page errors: ${errors.slice(0, 2).join('; ')})` : ''}`);
    await page.close();
  }

  await browser.close();
}

await run();
