/* Loads the harness once and reports console output — used while wiring the
 * mock data layer. Usage: node debug.mjs [query-string] */

import puppeteer from 'puppeteer-core';

const query = process.argv[2] || '';
const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  env: { ...process.env, TZ: 'America/New_York' },
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const messages = [];
page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => messages.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => messages.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));

await page.goto(`http://localhost:5199/${query ? `?${query}` : ''}`, {
  waitUntil: 'networkidle2',
  timeout: 60000,
});
await new Promise((resolve) => setTimeout(resolve, 6000));

const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
console.log('--- console ---');
console.log(messages.slice(0, 60).join('\n'));
console.log('--- body text ---');
console.log(text);

await browser.close();
