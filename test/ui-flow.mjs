// Submits the real forms in headless Edge against a throwaway database and checks the numbers.
//   node test/ui-flow.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-ui-'));
const PORT = 3112, BASE = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dir, DB_PATH: path.join(dir, 't.db') }, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) { try { await fetch(BASE); break; } catch { await wait(500); } } // wait for the server
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

  // 5. sell on credit, then collect it from the Receivables screen
  await page.goto(`${BASE}/#/sales`); await wait(600); await page.click('[data-new]'); await wait(700);
  await set('item_id', String(cid)); await set('qty', '1'); await set('unit_price', '3000');
  await page.click('.modal input[name=paymode][value=none]'); await wait(200);
  ok(/will be added/.test(await page.$eval('.modal [data-owedhelp]', (e) => e.textContent)), 'Form says the amount will be owed');
  ok(/customer/i.test(await submit()), 'Unpaid sale without a name is refused');
  await set('customer_name', 'Bilal');
  ok(!(await submit()), 'Credit sale saved');
  await page.goto(`${BASE}/#/owed`); await wait(900);
  const owedTxt = await page.$eval('#view', (v) => v.innerText);
  ok(/Bilal/.test(owedTxt) && /3,000/.test(owedTxt), 'Bilal appears on Receivables owing 3,000');
  await page.click('[data-settle="0"]'); await wait(700);
  await set('amount', '2000'); await set('note', 'first instalment');
  ok(!(await submit()), 'Payment recorded from Receivables');
  let rec = await api('/api/simple/owed/receive');
  ok(rec.people.find((p) => p.person === 'Bilal')?.due === 1000, 'Bilal now owes 1,000');
  await page.goto(`${BASE}/#/ledgers?name=Bilal`); await wait(900);
  const lg = await page.$eval('#view', (v) => v.innerText);
  ok(/first instalment/.test(lg) && /Owes you/.test(lg), 'Bilal ledger shows the payment note and balance');

  // 5. totals agree
  const d = await api('/api/simple/summary');
  ok(d.sales === 172000 + 180000 + 120000 + 3000, `Revenue adds up (${d.sales})`);
  ok(d.owed.receive === 1000, `Dashboard shows 1,000 to receive (${d.owed.receive})`);
  const integ = await api('/api/integrity'); ok(integ.ok, 'Books balanced');
  ok(!errs.length, `No page errors ${errs.join(' | ')}`);
} finally { await browser.close(); srv.kill(); }
console.log(failed ? `\n✘ ${failed} failed` : '\n✔ all passed');
process.exit(failed ? 1 : 0);
