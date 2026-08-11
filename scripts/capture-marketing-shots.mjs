// Captures every screenshot the marketing booklet uses, from the preview harness.
//
//   npm run preview:surfaces          # in one terminal
//   node scripts/capture-marketing-shots.mjs
//
// Driving a headless browser directly keeps this reproducible and free of window
// chrome, device-emulation toolbars and DevTools panels, all of which leaked into
// hand-taken captures. Phone shots use a real mobile viewport so the pilot
// screens are the layout a pilot actually sees.
//
// Every capture is written to marketing/raw2/, which prepare-marketing-shots.mjs
// then trims for the booklet.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright';

import { tenant } from '../preview/tenants.js';

const root = path.resolve(import.meta.dirname, '..');

// Which operator to capture. The harness renders the product as any tenant it
// knows about, so the booklet can be produced for a prospect as easily as for
// the operator that runs it.
const TENANT = process.env.TENANT || 'skyway';

const outDir = path.join(root, 'marketing/raw2', TENANT);
mkdirSync(outDir, { recursive: true });

const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:4178';

// The leg the sample day puts in the air. Its tail and destination are what the
// pilot's trip screens are reached by, and they differ per operator.
const LEAD_LEG = (() => {
  const t = tenant(TENANT);
  const leg = t.schedule[1];
  return { ...leg, tail: leg.tail };
})();

/** Every surface is opened as the selected tenant. */
const urlFor = (query) => {
  const joiner = query.includes('?') ? '&' : '?';
  return `${BASE}/${query}${joiner}tenant=${TENANT}`;
};
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };

const settle = (page, ms = 1400) => page.waitForTimeout(ms);

/** Waits for text to appear, but never fails the whole run over it. */
async function waitForText(page, text, timeout = 20_000) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function tap(page, name, { exact = false } = {}) {
  // Prefer a real control; several labels also appear in body copy.
  const candidates = [
    page.getByRole('button', { name, exact }),
    page.locator('button', { hasText: name }),
    page.getByText(name, { exact }),
  ];
  for (const locator of candidates) {
    const visible = locator.locator('visible=true').first();
    if (await visible.count()) {
      await visible.click({ timeout: 10_000 });
      return;
    }
  }
  throw new Error(`no clickable target for "${name}"`);
}

/**
 * Screenshots a single dashboard card by its heading.
 *
 * Cards carry the type sizes the product was designed at, so a whole-screen
 * capture scaled onto a page loses them. Shooting the element keeps it at full
 * resolution and avoids guessing crop fractions against a screen whose content
 * can extend below the fold.
 */
async function cardShot(page, headingText, file) {
  // Screens differ in how a card is assembled: some wrap the heading and body in
  // one bordered container, others put the heading in a sibling above a bordered
  // table. Try the tightest container first.
  const candidates = [
    page.locator('div.rounded-xl').filter({ hasText: headingText }),
    page.locator('section').filter({ hasText: headingText }),
  ];
  for (const locator of candidates) {
    const card = locator.first();
    if (await card.count()) {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      await card.screenshot({ path: path.join(outDir, file) });
      return;
    }
  }
  throw new Error(`no card container found for "${headingText}"`);
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} ${detail}`);
}

const browser = await chromium.launch();

/* ── Desktop surfaces ─────────────────────────────────────────────────── */
const desktop = await browser.newContext({
  viewport: DESKTOP,
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

const DESKTOP_SHOTS = [
  {
    name: 'crew-grouped.png',
    url: '?surface=dashboard',
    ready: 'Crew currently on duty',
    // Scroll the crew card into the frame; it sits below the fleet map.
    after: async (page) => {
      await page.getByText('Crew currently on duty').first()
        .scrollIntoViewIfNeeded().catch(() => {});
      await settle(page, 900);
      await cardShot(page, 'Crew currently on duty', 'on-duty-crews.png');
      await cardShot(page, "Today's flight board", 'flight-board-card.png');
    },
  },
  {
    name: 'dispatch.png',
    url: '?surface=dispatch',
    ready: 'Ops console',
    // Printed at page width, a 1600px capture reduces the card text past reading
    // size. A narrower, shorter viewport shows fewer legs but keeps them legible.
    viewport: { width: 1000, height: 520 },
  },
  {
    name: 'duty-report.png',
    url: '?surface=dutyreport',
    ready: 'Pilot summary',
    // A long report: the pilot summary sits below a 1000px fold.
    viewport: { width: 1600, height: 1600 },
    after: async (page) => {
      await cardShot(page, 'Pilot summary', 'duty-report-table.png');
    },
  },
  {
    name: 'broker.png',
    url: '?surface=broker',
    ready: LEAD_LEG.tail,
    wait: 4200,
    // The broker page is a max-w-3xl column; a 1600px viewport surrounds it with
    // empty margin that then dominates the page it is printed on.
    viewport: { width: 820, height: 1180 },
  },
  { name: 'flight-board-tv.png', url: '?surface=board', ready: 'FLIGHT BOARD', wait: 3200 },
  {
    name: 'expenses.png',
    url: '?surface=expenses',
    ready: 'By crew member',
    viewport: { width: 1120, height: 1000 },
    after: async (page) => {
      // The per-crew and per-account breakdown is the part accounting reads, and
      // it survives page width where the whole screen does not.
      const grid = page.locator('div.grid').filter({ hasText: 'By crew member' }).first();
      await grid.screenshot({ path: path.join(outDir, 'expense-summary.png') });
    },
  },
  {
    name: 'email-open.png',
    url: '?surface=email',
    ready: 'Inbox',
    after: async (page) => {
      // An open message shows the reading pane, which is the point of the page.
      const first = page.locator('[role="button"], li, div').filter({ hasText: 'Aircraft Ready for Passengers' }).last();
      await first.click({ timeout: 10_000 }).catch(() => {});
      await settle(page, 1800);
    },
  },
  {
    name: 'teams-channel.png',
    url: '?surface=teams',
    ready: 'Teams',
    after: async (page) => {
      await tap(page, 'Dispatch').catch(() => {});
      await settle(page, 2000);
    },
  },
  {
    name: 'accounting-all.png',
    url: '?surface=accounting',
    ready: 'Invoices',
    wait: 2400,
    after: async (page) => {
      // The list opens filtered to open invoices; the whole ledger, including
      // paid and overdue, is what shows receivables working.
      await tap(page, 'All', { exact: true }).catch(() => {});
      await settle(page, 1600);
    },
  },
  {
    name: 'schedule.png',
    url: '?surface=app&role=admin',
    ready: 'Flights',
    after: async (page) => {
      await tap(page, 'Flights');
      await settle(page, 2200);
      // Without a trip selected the detail panel is an empty "select a trip"
      // placeholder, which is most of the screen.
      await tap(page, 'HYA').catch(() => {});
      await settle(page, 2000);
    },
  },
];

console.log(`Capturing as tenant: ${TENANT}\n\nDesktop captures:`);
for (const shot of DESKTOP_SHOTS) {
  const page = await desktop.newPage();
  try {
    if (shot.viewport) await page.setViewportSize(shot.viewport);
    await page.goto(urlFor(shot.url), { waitUntil: 'networkidle', timeout: 45_000 });
    const found = shot.ready ? await waitForText(page, shot.ready) : true;
    await settle(page, shot.wait || 1600);
    if (shot.after) await shot.after(page);
    await page.screenshot({ path: path.join(outDir, shot.name) });
    record(shot.name, true, found ? '' : `(did not find "${shot.ready}")`);
  } catch (err) {
    record(shot.name, false, err.message.split('\n')[0]);
  } finally {
    await page.close();
  }
}
await desktop.close();

/* ── Pilot phone ──────────────────────────────────────────────────────── */
const phone = await browser.newContext({
  ...devices['iPhone 13'],
  viewport: PHONE,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});

console.log('\nPhone captures:');

/* Standalone phone surfaces. */
for (const shot of [
  { name: 'phone-duty.png', url: '?surface=duty', ready: 'Duty' },
]) {
  const page = await phone.newPage();
  try {
    await page.goto(urlFor(shot.url), { waitUntil: 'networkidle', timeout: 45_000 });
    await waitForText(page, shot.ready);
    await settle(page);
    await page.screenshot({ path: path.join(outDir, shot.name) });
    record(shot.name, true);
  } catch (err) {
    record(shot.name, false, err.message.split('\n')[0]);
  } finally {
    await page.close();
  }
}

/* The pilot's own journey, captured in sequence on one page so the app's
   navigation state carries from screen to screen. */
{
  const page = await phone.newPage();
  const step = async (name, action) => {
    try {
      if (action) await action();
      await settle(page, 1500);
      await page.screenshot({ path: path.join(outDir, name) });
      record(name, true);
    } catch (err) {
      record(name, false, err.message.split('\n')[0]);
    }
  };

  try {
    await page.goto(urlFor('?surface=app&role=crew'), { waitUntil: 'networkidle', timeout: 45_000 });
    await waitForText(page, 'Good');
    await settle(page, 2600);

    await step('phone-pilot-home.png');
    await step('phone-flights.png', () => tap(page, 'Flights'));
    await step('phone-trip.png', () => tap(page, LEAD_LEG.to));
    await step('phone-trip-status.png', async () => {
      // The status list opens by default; bring the milestones into frame.
      const landed = page.getByText('WHEELS UP', { exact: false }).first();
      if (await landed.count()) await landed.scrollIntoViewIfNeeded().catch(() => {});
    });
    await step('phone-trip-pax.png', () => tap(page, 'Passengers'));

    // Expenses live behind the overflow tab in the crew navigation.
    await step('phone-expenses.png', async () => {
      await tap(page, 'More');
      await settle(page, 700);
      await tap(page, 'Expenses');
    });
  } catch (err) {
    record('pilot journey', false, err.message.split('\n')[0]);
  } finally {
    await page.close();
  }
}

await phone.close();
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} captures written to ${path.relative(root, outDir)}/`);
if (failed.length) {
  console.log('Failed:');
  for (const f of failed) console.log(`  ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
