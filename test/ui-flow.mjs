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
  const pick = async (name, v) => { await page.$eval(`.modal input[name=${name}][value=${v}]`, (i) => i.closest("label").click()); await wait(150); };
  const submit = async () => { await page.click('.modal [type=submit]'); await wait(900); return page.$eval('.modal .form-error', (e) => (e.classList.contains('hidden') ? '' : e.textContent)).catch(() => ''); };
  const newSale = async () => { await page.goto(`${BASE}/#/sales`); await wait(700); await page.click('[data-new]'); await wait(700); };

  // 1. buy & sell a phone, typing the profit instead of the sold price
  await newSale();
  ok(await page.$eval('.modal [name=source]', (e) => e.value) === 'direct', 'With an empty inventory the form is buy & sell now');
  await set('item_name', 'iPhone 13 Pro'); await set('unit_cost', '145000'); await set('supplier_name', 'Ali Mobiles'); await set('profit', '35000');
  ok(await page.$eval('.modal [name=unit_price]', (e) => e.value) === '180000', 'Typing the profit fills in the sold price (180,000)');
  ok(!(await submit()), 'Sale saved');
  const s = await api('/api/simple/sales');
  const r1 = s.rows.find((r) => r.product === 'iPhone 13 Pro');
  ok(r1 && r1.profit === 35000 && r1.cost === 145000 && r1.bought_from === 'Ali Mobiles', 'Sale shows bought 145,000 from Ali Mobiles, profit 35,000');

  // 2. bought on credit, sold on credit
  await newSale();
  await set('item_name', 'Samsung S23'); await set('unit_cost', '120000'); await set('unit_price', '140000');
  await pick('costmode', 'none'); await pick('mode', 'none');
  ok(/will be added/.test(await page.$eval('.modal [data-owedhelp="cost"]', (e) => e.textContent)), 'Form says the phone cost will be owed');
  ok(/customer/i.test(await submit()), 'Unpaid sale without a customer is refused');
  await set('customer_name', 'Bilal');
  ok(/bought it from/i.test(await submit()), 'Unpaid purchase without a supplier is refused');
  await set('supplier_name', 'Hafeez Traders');
  ok(!(await submit()), 'Credit sale saved');
  const rec = await api('/api/simple/owed/receive'), pay = await api('/api/simple/owed/pay');
  ok(rec.people.find((p) => p.person === 'Bilal')?.due === 140000, 'Bilal owes 140,000');
  ok(pay.people.find((p) => p.person === 'Hafeez Traders')?.due === 120000, 'You owe Hafeez Traders 120,000');

  // 3. collect part of it from the Receivables screen
  await page.goto(`${BASE}/#/owed?tab=receive`); await wait(900);
  await page.click('[data-settle="0"]'); await wait(700);
  await set('amount', '100000'); await set('note', 'first instalment');
  ok(!(await submit()), 'Payment recorded from Receivables');
  ok((await api('/api/simple/owed/receive')).people.find((p) => p.person === 'Bilal')?.due === 40000, 'Bilal now owes 40,000');
  await page.goto(`${BASE}/#/ledgers?name=Bilal`); await wait(900);
  const lg = await page.$eval('#view', (v) => v.innerText);
  ok(/first instalment/.test(lg) && /Owes you/.test(lg), 'Bilal ledger shows the payment note and balance');

  // 4. inventory: add two phones, delete one, sell the other
  await page.goto(`${BASE}/#/inventory`); await wait(800); await page.click('[data-new]'); await wait(700);
  await set('item_name', 'Pixel 8'); await set('unit_cost', '90000'); await set('supplier_name', 'Ali Mobiles'); await set('note', 'IMEI 1111');
  ok(!(await submit()), 'Phone added to inventory');
  await page.click('[data-new]'); await wait(700);
  await set('item_name', 'Oppo Reno'); await set('unit_cost', '50000');
  ok(!(await submit()), 'Second phone added');
  let stock = await api('/api/simple/stock');
  ok(stock.rows.length === 2 && stock.summary.value === 140000, 'Inventory holds 2 phones worth 140,000');
  const oppo = stock.rows.find((x) => x.name === 'Oppo Reno');
  await page.click(`[data-del="${oppo.id}"]`); await wait(600); await page.click('.modal [type=submit]'); await wait(900);
  ok(!(await api('/api/simple/stock')).rows.some((x) => x.name === 'Oppo Reno'), 'Deleted phone is gone');
  const pixel = stock.rows.find((x) => x.name === 'Pixel 8');
  await page.click(`[data-sell="${pixel.id}"]`); await wait(800);
  ok(await page.$eval('.modal [name=source]:checked', (e) => e.value) === 'stock', 'Sell opens the sale form on "From my inventory"');
  await set('unit_price', '105000');
  ok(/15,000/.test(await page.$eval('.modal [data-s=profit]', (e) => e.textContent)), 'Profit shows 15,000 using the bought price');
  ok(!(await submit()), 'Sold from inventory');
  ok(!(await api('/api/simple/stock')).rows.length, 'Inventory is empty after selling');

  // 5. expense with a new category
  await page.goto(`${BASE}/#/expenses`); await wait(600); await page.click('[data-new]'); await wait(700);
  await set('amount', '5000'); await set('category_id', 'new'); await set('new_category', 'Shop repairs');
  ok(!(await submit()), 'Expense with new category saved');

  // 6. edit a sale from the list
  await page.goto(`${BASE}/#/sales`); await wait(800);
  await page.$$eval('tr[data-id]', (trs) => trs.find((t) => /iPhone 13 Pro/.test(t.innerText)).click()); await wait(700);
  ok(await page.$eval('.modal [name=unit_cost]', (e) => e.value) === '145000', 'Edit form shows the bought price');
  await set('unit_price', '182000');
  ok(!(await submit()), 'Sale edited');

  // 7. totals agree
  const d = await api('/api/simple/summary');
  ok(d.sales === 172000 + 182000 + 140000 + 105000, `Sales add up (${d.sales})`);
  ok(d.cost_of_sales === 150000 + 145000 + 120000 + 90000, `What you paid adds up (${d.cost_of_sales})`);
  ok(d.net_profit === (172000 - 150000) + (182000 - 145000) + (140000 - 120000) + 15000 - 15000 - 5000, `Net profit adds up (${d.net_profit})`);
  const integ = await api('/api/integrity'); ok(integ.ok, 'Books balanced');
  ok(!errs.length, `No page errors ${errs.join(' | ')}`);
} finally { await browser.close(); srv.kill(); }
console.log(failed ? `\n✘ ${failed} failed` : '\n✔ all passed');
process.exit(failed ? 1 : 0);
