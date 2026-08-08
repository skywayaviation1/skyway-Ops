/* Captures one selector from the marketing site at full resolution.
 * Usage: node shoot-one.mjs "#tour .tour__item" out-name */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const selector = process.argv[2];
const name = process.argv[3] || 'one';
const nth = Number(process.argv[4] || 0);

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto('http://localhost:8088/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('is-visible')));
await new Promise((r) => setTimeout(r, 900));
const els = await page.$$(selector);
const el = els[nth];
if (el) {
  await el.scrollIntoView();
  await new Promise((r) => setTimeout(r, 400));
  await el.screenshot({ path: path.resolve(here, '../../marketing/.preview', `${name}.png`) });
  console.log('shot', name);
} else {
  console.warn('no match for', selector);
}
await browser.close();
