// Drives the real UI in headless Edge: signs in, opens every screen and the entry forms (desktop + phone),
// records console/page errors and saves screenshots.   BASE=http://localhost:3000 node test/ui-smoke.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3111';
const OUT = process.env.SHOTS || 'data/shots'; fs.mkdirSync(OUT, { recursive: true });
const PAGES = ['dashboard', 'sales', 'expenses', 'inventory', 'profit', 'settings'];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'] });
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 }]]) {
  const page = await browser.newPage(); await page.setViewport(vp);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: label === 'phone' ? 'light' : 'dark' }]);
  page.on('pageerror', (e) => errors.push(`${label} PAGEERROR ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(`${label} CONSOLE ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon') && !r.url().endsWith('/api/auth/me')) errors.push(`${label} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  if (label === 'desktop') await page.screenshot({ path: `${OUT}/${label}-login.png` });
  if (await page.$('#u')) { await page.type('#u', 'admin'); await page.type('#p', 'Admin@123'); await page.click('#lb'); }
  await page.waitForSelector('.shell', { timeout: 10000 });
  for (const p of PAGES) {
    const before = errors.length;
    await page.goto(`${BASE}/#/${p}`); await wait(900);
    await page.screenshot({ path: `${OUT}/${label}-${p}.png`, fullPage: true });
    const bad = await page.$eval('#view', (v) => /Could not load|Something went wrong/.test(v.innerText)).catch(() => true);
    console.log(`${errors.length > before || bad ? 'FAIL' : 'ok  '} ${label} ${p}`, errors.slice(before).join(' | '));
  }
  // entry forms
  for (const [p, btn, name] of [['sales', '[data-new]', 'sale-form'], ['expenses', '[data-new]', 'expense-form'], ['inventory', '[data-restock]', 'stock-form'], ['inventory', '[data-new]', 'product-form']]) {
    await page.goto(`${BASE}/#/${p}`); await wait(700); await page.click(btn); await wait(700);
    await page.screenshot({ path: `${OUT}/${label}-${name}.png` });
    console.log(`${(await page.$('.modal')) ? 'ok  ' : 'FAIL'} ${label} ${name}`);
    await page.keyboard.press('Escape');
  }
  await page.close();
}
console.log('\nErrors:', errors.length ? '\n' + [...new Set(errors)].join('\n') : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
