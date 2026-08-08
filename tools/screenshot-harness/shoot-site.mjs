/* Captures full-page and section renders of the marketing site itself, so the
 * built page can be reviewed as images. Usage: node shoot-site.mjs */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../marketing/.preview');
await fs.mkdir(outDir, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});

async function shoot(name, { width, height, full, sections }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto('http://localhost:8088/', { waitUntil: 'networkidle2', timeout: 60000 });
  // Force reveal animations so nothing is invisible in a static capture.
  await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('is-visible')));
  await wait(900);

  if (full) {
    await autoScroll(page);
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  }
  for (const [label, selector] of Object.entries(sections || {})) {
    const el = await page.$(selector);
    if (!el) { console.warn(`  ! missing ${selector}`); continue; }
    await el.scrollIntoView();
    await wait(500);
    await el.screenshot({ path: path.join(outDir, `${label}.png`) });
  }
  await page.close();
  console.log(`shot ${name}`);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = () => {
        window.scrollBy(0, 900);
        y += 900;
        if (y >= document.body.scrollHeight) { window.scrollTo(0, 0); resolve(); }
        else setTimeout(step, 60);
      };
      step();
    });
  });
  await wait(600);
}

await shoot('desktop', {
  width: 1440,
  height: 900,
  full: true,
  sections: {
    'sec-hero': '.hero',
    'sec-tour': '#tour',
    'sec-compliance': '#compliance',
    'sec-features': '#features',
    'sec-gallery': '#gallery',
    'sec-cta': '#demo',
  },
});

await shoot('mobile', { width: 402, height: 860, full: true });

await browser.close();
