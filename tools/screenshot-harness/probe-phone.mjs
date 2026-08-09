/* Lists what a pilot can reach on a phone, to plan mobile captures.
 * Usage: node probe-phone.mjs "Flights>TEB" */

import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, TZ: 'America/New_York' },
  protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: 402, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5199/?as=crew', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5500));

const helper = `
  function visible() {
    return Array.from(document.querySelectorAll('button, [role="button"], a')).filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && r.top < window.innerHeight && r.bottom > 0
        && getComputedStyle(n).visibility !== 'hidden';
    });
  }
`;

for (const label of (process.argv[2] || '').split('>').filter(Boolean)) {
  const box = await page.evaluate((text, h) => {
    eval(h);
    // eslint-disable-next-line no-undef
    const nodes = visible();
    const name = (n) => n.innerText.replace(/\s+/g, ' ').trim().toUpperCase();
    const t = nodes.find((n) => name(n) === text.toUpperCase())
      || nodes.find((n) => name(n).includes(text.toUpperCase()));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 18) };
  }, label, helper);
  if (!box) { console.log(`click "${label}": NOT FOUND`); break; }
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 70));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 2600));
  console.log(`click "${label}": ok`);
}

const labels = await page.evaluate((h) => {
  eval(h);
  // eslint-disable-next-line no-undef
  return visible().map((n) => n.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60);
}, helper);
console.log('--- tappable ---');
console.log(labels.join(' | '));
console.log('--- text ---');
console.log((await page.evaluate(() => document.body.innerText)).slice(0, 1800));

await browser.close();
