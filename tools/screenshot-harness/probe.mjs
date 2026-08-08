/* Lists the clickable labels on the current screen so capture steps can target
 * real UI. Usage: node probe.mjs [clickPath] e.g. node probe.mjs "Crew>Duty" */

import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, TZ: 'America/New_York' },
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));

const clickPath = (process.argv[2] || '').split('>').filter(Boolean);
for (const label of clickPath) {
  const clicked = await page.evaluate((text) => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const match = nodes.find((n) => n.innerText.trim().toUpperCase() === text.toUpperCase())
      || nodes.find((n) => n.innerText.trim().toUpperCase().startsWith(text.toUpperCase()));
    if (!match) return false;
    match.click();
    return true;
  }, label);
  console.log(`click "${label}": ${clicked}`);
  await new Promise((r) => setTimeout(r, 2500));
}

const labels = await page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"]'))
  .map((n) => n.innerText.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
  .slice(0, 120));
console.log('--- buttons ---');
console.log(labels.join(' | '));
console.log('--- text ---');
console.log((await page.evaluate(() => document.body.innerText)).slice(0, 2500));

await browser.close();
