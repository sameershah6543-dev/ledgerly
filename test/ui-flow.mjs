// Submits the real forms in headless Edge against a throwaway database and checks the numbers.
//   node test/ui-flow.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-ui-'));
const PORT = 3112, BASE = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dir, DB_PATH: path.join(dir, 't.db') }, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2500);
let failed = 0; const ok = (c, m) => { console.log(`${c ? '  ✔' : '  ✘ FAIL:'} ${m}`); if (!c) failed++; };
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 900 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.type('#u', 'admin'); await page.type('#p', 'Admin@123'); await page.click('#lb'); await page.waitForSelector('.shell');
  const api = (u) => page.evaluate((x) => fetch(x).then((r) => r.json()), u);
  const set = async (name, v) => { await page.$eval(`.modal [name=${name}]`, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); };
  const submit = async () => { await page.click('.modal [type=submit]'); await wait(900); const err = await page.$eval('.modal .form-error', (e) => (e.classList.contains('hidden') ? '' : e.textContent)).catch(() => ''); return err; };

  // 1. sell a phone, typing the profit instead of the cost
  await page.goto(`${BASE}/#/sales`); await wait(600); await page.click('[data-new]'); await wait(600);
  await set('unit_price', '180000'); await set('profit', '35000');
  ok(await page.$eval('.modal [name=unit_cost]', (e) => e.value) === '145000', 'Typing profit fills in the cost (145,000)');
  ok(!(await submit()), 'Sale saved');
  let s = await api('/api/simple/sales');
  ok(s.rows[0].profit === 35000 && s.rows[0].net === 180000, 'Sale shows 180,000 revenue and 35,000 profit');

  // 2. sell something not in inventory
  await page.click('[data-new]'); await wait(600);
  await set('item_id', 'new'); await set('item_name', 'AirPods Pro'); await set('qty', '2'); await set('unit_price', '60000'); await set('unit_cost', '45000');
  ok(!(await submit()), 'New-product sale saved');
  const inv = await api('/api/simple/inventory');
  ok(inv.rows.some((r) => r.name === 'AirPods Pro'), 'AirPods Pro added to inventory automatically');

  // 3. expense with a new category
  await page.goto(`${BASE}/#/expenses`); await wait(600); await page.click('[data-new]'); await wait(600);
  await set('amount', '5000'); await set('category_id', 'new'); await set('new_category', 'Shop repairs');
  ok(!(await submit()), 'Expense with new category saved');

  // 4. add a product and restock it
  await page.goto(`${BASE}/#/inventory`); await wait(600); await page.click('[data-new]'); await wait(600);
  await set('name', 'Charger 20W'); await set('purchase_price', '1500'); await set('selling_price', '2500'); await set('opening_stock', '10');
  ok(!(await submit()), 'Product added');
  await page.click('[data-restock]'); await wait(600);
  const cid = (await api('/api/simple/inventory')).rows.find((r) => r.name === 'Charger 20W').id;
  await set('item_id', String(cid)); await set('qty', '5'); await set('unit_cost', '1400');
  ok(!(await submit()), 'Stock added');
  ok((await api('/api/simple/inventory')).rows.find((r) => r.id === cid).stock === 15, 'Charger stock now 15');

  // 5. totals agree
  const d = await api('/api/simple/summary');
  ok(d.sales === 172000 + 180000 + 120000, `Revenue adds up (${d.sales})`);
  ok(d.net_profit === 22000 + 35000 + 30000 - 15000 - 5000, `Net profit adds up (${d.net_profit})`);
  const integ = await api('/api/integrity'); ok(integ.ok, 'Books balanced');
  ok(!errs.length, `No page errors ${errs.join(' | ')}`);
} finally { await browser.close(); srv.kill(); }
console.log(failed ? `\n✘ ${failed} failed` : '\n✔ all passed');
process.exit(failed ? 1 : 0);
