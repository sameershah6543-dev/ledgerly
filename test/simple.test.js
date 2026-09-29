// Simple-mode flows: sell, set profit, restock, expenses, start fresh - books must stay balanced.
//   node test/simple.test.js
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-simple-'));
process.env.DATA_DIR = dir; process.env.DB_PATH = path.join(dir, 'test.db');

const { get } = await import('../server/db.js');
const { bootstrap } = await import('../server/bootstrap.js');
const Simple = await import('../server/simple.js');
const S = await import('../server/system.js');
const { today } = await import('../server/util.js');

await bootstrap({ sample: true });
const U = 'tester';
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✔ ${m}`); } else { failed++; console.log(`  ✘ FAIL: ${m}`); } };
const eq = (a, b, m) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${m} (expected ${b}, got ${a})`);
const throws = async (fn, re, m) => { try { await fn(); ok(false, `${m} — expected an error`); } catch (e) { ok(re.test(e.message), `${m} → "${e.message}"`); } };
const books = async (label) => { const i = await S.integrity(); ok(i.ok, `[${label}] books balanced & consistent${i.ok ? '' : ': ' + i.checks.filter((c) => !c.ok).map((c) => c.name + ' ' + c.detail).join('; ')}`); };
const cash = (await get("SELECT id FROM money_accounts WHERE kind='cash'")).id;
const phone = (await get("SELECT id FROM items WHERE name LIKE 'iPhone%'")).id;

console.log('\n■ Demo data');
let s = await Simple.summary({});
eq(s.sales, 172000, 'Demo sale counted as revenue'); eq(s.cost_of_sales, 150000, 'Demo cost of sale'); eq(s.expenses, 15000, 'Demo rent expense');
eq(s.net_profit, 172000 - 150000 - 15000, 'Net profit = sales − cost − expenses');
eq((await Simple.inventory()).rows.find((r) => r.id === phone).stock, 2, 'Phone stock 3 − 1 sold = 2');
eq((await Simple.salesList()).rows.length, 1, 'Exactly one demo sale'); eq((await Simple.expenseList()).rows.length, 1, 'Exactly one demo expense');
await books('demo');

console.log('\n■ Sell with your own cost (profit you choose)');
const sale = await Simple.createSale({ item_id: phone, qty: 1, unit_price: 180000, unit_cost: 140000, money_account_id: cash, customer_name: 'Ali' }, U);
let row = (await Simple.salesList()).rows.find((r) => r.id === sale.id);
eq(row.profit, 40000, 'Profit on this sale = 180,000 − 140,000'); ok(row.customer === 'Ali', 'Customer name stored');
await books('custom cost, stock left');
const last = await Simple.createSale({ item_id: phone, qty: 1, unit_price: 170000, unit_cost: 165000, money_account_id: cash }, U);
eq((await Simple.salesList()).rows.find((r) => r.id === last.id).profit, 5000, 'Selling the last unit keeps the chosen profit');
eq((await Simple.inventory()).rows.find((r) => r.id === phone).stock, 0, 'Phone now out of stock');
eq((await Simple.inventory()).rows.find((r) => r.id === phone).value, 0, 'Empty stock has no leftover value');
await books('sold out with custom cost');
await throws(async () => await Simple.createSale({ item_id: phone, qty: 1, unit_price: 1000, money_account_id: cash }, U), /Insufficient stock/, 'Cannot sell stock you do not have');

console.log('\n■ Sell something not yet in inventory');
const q = await Simple.createSale({ item_name: 'Samsung A55', qty: 2, unit_price: 95000, unit_cost: 80000, money_account_id: cash }, U);
eq((await Simple.salesList()).rows.find((r) => r.id === q.id).profit, 30000, 'Profit = 2 × (95,000 − 80,000)');
ok((await Simple.inventory()).rows.some((r) => r.name === 'Samsung A55' && r.stock === 0), 'Product added to inventory, stock 0 after sale');
await throws(async () => await Simple.createSale({ item_name: 'Pixel 8', qty: 1, unit_price: 100, money_account_id: cash }, U), /cost you/, 'New product needs a cost');
await books('quick product');

console.log('\n■ Edit and delete a sale');
await Simple.updateSale(q.id, { item_id: (await Simple.salesList()).rows.find((r) => r.id === q.id).item_id, qty: 2, unit_price: 99000, unit_cost: 80000, money_account_id: cash }, U);
eq((await Simple.salesList()).rows.find((r) => r.id === q.id).profit, 38000, 'Edited price updates profit');
await Simple.deleteSale(q.id, U);
ok(!(await Simple.salesList()).rows.some((r) => r.id === q.id), 'Deleted sale disappears'); await books('edit/delete');

console.log('\n■ Restock and average cost');
await Simple.restock({ item_id: phone, qty: 4, unit_cost: 152000, money_account_id: cash, supplier_name: 'Hall Road Wholesale' }, U);
const inv = (await Simple.inventory()).rows.find((r) => r.id === phone);
eq(inv.stock, 4, 'Stock increased by 4'); eq(inv.value, 608000, 'Stock value = 4 × 152,000');
const avg = await Simple.createSale({ item_id: phone, qty: 1, unit_price: 175000, money_account_id: cash }, U);
eq((await Simple.salesList()).rows.find((r) => r.id === avg.id).profit, 23000, 'No cost entered → uses stock cost');
await books('restock');

console.log('\n■ Expenses');
const catId = (await Simple.expenseCategories()).find((c) => c.name === 'Electricity').id;
const e = await Simple.saveExpense({ category_id: catId, amount: 8000, description: 'Bill', money_account_id: cash }, null, U);
await Simple.saveExpense({ category_id: catId, amount: 9000, description: 'Bill', money_account_id: cash, date: today() }, e.id, U);
eq((await Simple.expenseList()).rows.find((r) => r.id === e.id).amount, 9000, 'Expense edited');
s = await Simple.summary({});
ok(s.expense_breakdown.some((x) => x.name === 'Electricity' && x.amount === 9000), 'Expense appears in the breakdown');
await Simple.deleteExpense(e.id, U); await books('expenses');

console.log('\n■ Start fresh');
await Simple.clearAllData();
s = await Simple.summary({});
eq(s.sales + s.expenses + s.stock.value, 0, 'Everything cleared'); ok(s.money.length === 2, 'Cash and bank accounts kept');
ok((await Simple.expenseCategories()).length > 0, 'Expense categories kept');
await Simple.createSale({ item_name: 'Charger', qty: 1, unit_price: 2000, unit_cost: 1200, money_account_id: cash }, U);
eq((await Simple.summary({})).net_profit, 800, 'Works normally after clearing'); await books('after clearing');

console.log(`\n${failed ? '✘' : '✔'} ${pass} passed, ${failed} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* db still open on Windows */ }
process.exit(failed ? 1 : 0);
