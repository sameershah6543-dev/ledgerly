// Simple-mode flows: buy a phone & sell it, money owed both ways, ledgers, expenses, start fresh.
// The books must stay balanced after every step.   node test/simple.test.js
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-simple-'));
process.env.DATA_DIR = dir; process.env.DB_PATH = path.join(dir, 'test.db');

const { bootstrap } = await import('../server/bootstrap.js');
const Simple = await import('../server/simple.js');
const S = await import('../server/system.js');

await bootstrap({ sample: true });
const U = 'tester';
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✔ ${m}`); } else { failed++; console.log(`  ✘ FAIL: ${m}`); } };
const eq = (a, b, m) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${m} (expected ${b}, got ${a})`);
const throws = async (fn, re, m) => { try { await fn(); ok(false, `${m} — expected an error`); } catch (e) { ok(re.test(e.message), `${m} → "${e.message}"`); } };
const books = async (label) => { const i = await S.integrity(); ok(i.ok, `[${label}] books balanced & consistent${i.ok ? '' : ': ' + i.checks.filter((c) => !c.ok).map((c) => c.name + ' ' + c.detail).join('; ')}`); };
const money = await Simple.moneyList();
const cash = money.find((m) => m.kind === 'cash').id, bank = money.find((m) => m.kind === 'bank').id;
const bal = async (id) => (await Simple.moneyList()).find((m) => m.id === id).balance;
const sale = async (id) => (await Simple.salesList()).rows.find((r) => r.id === id);
const owes = async (kind, person) => (await Simple.openList(kind)).people.find((p) => p.person === person)?.due || 0;

console.log('\n■ Demo data');
let s = await Simple.summary({});
eq(s.sales, 172000, 'Demo sale counted as revenue'); eq(s.cost_of_sales, 150000, 'What the phone cost is the cost of sales'); eq(s.expenses, 15000, 'Demo rent expense');
eq(s.net_profit, 172000 - 150000 - 15000, 'Net profit = sold − bought − expenses');
eq(await bal(cash), 172000 - 150000 - 15000, 'Cash = money in − phone paid − rent');
eq((await Simple.salesList()).rows.length, 1, 'Exactly one demo sale'); eq((await Simple.expenseList()).rows.length, 1, 'Exactly one demo expense');
eq((await Simple.ledger('Hall Road Traders')).balance, 0, 'Demo supplier was paid in full');
await books('demo');

console.log('\n■ Buy & sell, all paid');
let t0 = await bal(cash);
const a = await Simple.createSale({ item_name: 'Samsung A55', qty: 2, unit_cost: 80000, unit_price: 95000, supplier_name: 'Ali Mobiles', customer_name: 'Usman', money_account_id: cash, note: 'IMEI 3569' }, U);
let r = await sale(a.id);
eq(r.profit, 30000, 'Profit = 2 × (95,000 − 80,000)'); eq(r.cost, 160000, 'Cost = what you paid'); ok(r.bought_from === 'Ali Mobiles' && r.customer === 'Usman', 'Supplier and customer stored');
eq(await bal(cash), t0 + 190000 - 160000, 'Cash moves by what you received minus what you paid');
await throws(() => Simple.createSale({ item_name: 'Pixel 8', unit_price: 100 }, U), /Bought for/, 'The bought price is required');
await throws(() => Simple.createSale({ unit_cost: 1, unit_price: 100, money_account_id: cash }, U), /What you sold/, 'The item name is required');
await books('paid sale');

console.log('\n■ Bank payment, and different accounts for each side');
t0 = await bal(bank); const c0 = await bal(cash);
await Simple.createSale({ item_name: 'iPhone 12', unit_cost: 100000, unit_price: 118000, money_account_id: bank, cost_account_id: cash }, U);
eq(await bal(bank), t0 + 118000, 'Sale money went to the bank'); eq(await bal(cash), c0 - 100000, 'Phone was paid from cash');
await books('two accounts');

console.log('\n■ Receivables: sold on credit');
const cs = await Simple.createSale({ item_name: 'iPhone 14', unit_cost: 150000, unit_price: 180000, paid: 50000, customer_name: 'Bilal', money_account_id: cash }, U);
eq(await owes('receive', 'Bilal'), 130000, 'Bilal owes 130,000 after paying 50,000');
await throws(() => Simple.createSale({ item_name: 'X', unit_cost: 1, unit_price: 1000, paid: 0 }, U), /customer/, 'Unpaid sale needs a customer name');
await Simple.settle({ kind: 'receive', person: 'bilal', amount: 100000, money_account_id: cash, note: 'Cash at shop' }, U);
eq(await owes('receive', 'Bilal'), 30000, 'Person-level payment reduces what Bilal owes');
await throws(() => Simple.settle({ kind: 'receive', person: 'Bilal', amount: 40000, money_account_id: cash }, U), /more than what is owed/, 'Cannot receive more than owed');
await Simple.updateSale(cs.id, { item_name: 'iPhone 14', unit_cost: 150000, unit_price: 185000, paid: 50000, customer_name: 'Bilal', money_account_id: cash }, U);
eq(await owes('receive', 'Bilal'), 35000, 'Price edit keeps the later payment (185,000 − 150,000 received)');
eq((await sale(cs.id)).profit, 35000, 'Edited price updates profit');
const bItem = (await Simple.openList('receive')).people.find((p) => p.person === 'Bilal').items[0];
await Simple.settle({ kind: 'receive', type: bItem.type, id: bItem.id, amount: 35000, money_account_id: cash }, U);
ok(!(await owes('receive', 'Bilal')), 'Bilal fully paid - gone from receivables');
let lg = await Simple.ledger('Bilal');
eq(lg.balance, 0, 'Bilal ledger is settled'); eq(lg.summary.received, 185000, 'Ledger shows 185,000 received');
ok(lg.rows.some((x) => x.note === 'Cash at shop'), 'Payment note appears in the ledger');
await books('receivables');

console.log('\n■ Payables: bought the phone without paying yet');
const ps = await Simple.createSale({ item_name: 'Vivo V30', unit_cost: 70000, cost_paid: 0, supplier_name: 'Hafeez Traders', unit_price: 82000, money_account_id: cash }, U);
eq(await owes('pay', 'Hafeez Traders'), 70000, 'You owe the supplier 70,000');
eq((await sale(ps.id)).profit, 12000, 'Profit counts even before you pay the supplier');
await throws(() => Simple.createSale({ item_name: 'X', unit_cost: 1000, cost_paid: 0, unit_price: 2000, money_account_id: cash }, U), /bought it from/, 'Unpaid purchase needs the supplier name');
await Simple.settle({ kind: 'pay', person: 'Hafeez Traders', amount: 50000, money_account_id: cash }, U);
await Simple.updateSale(ps.id, { item_name: 'Vivo V30', unit_cost: 72000, cost_paid: 0, supplier_name: 'Hafeez Traders', unit_price: 82000, money_account_id: cash }, U);
eq(await owes('pay', 'Hafeez Traders'), 22000, 'Cost edit keeps the later supplier payment (72,000 − 50,000)');
lg = await Simple.ledger('Hafeez Traders');
eq(lg.balance, -22000, 'Supplier ledger: you owe them 22,000');
ok((await Simple.people({})).rows.some((p) => p.name === 'Hafeez Traders' && p.balance === -22000), 'Ledgers list shows what you owe');
ok(!(await Simple.people({})).rows.some((p) => p.name === 'General Supplier'), 'The unnamed supplier stays hidden');
const pay1 = lg.rows.find((x) => x.kind === 'paid');
await Simple.deleteMoney('payment', pay1.ref.id, U);
eq(await owes('pay', 'Hafeez Traders'), 72000, 'Deleting a payment puts it back as owed');
await books('payables');

console.log('\n■ Delete a sale');
t0 = await bal(cash);
const del = await Simple.createSale({ item_name: 'Nokia', unit_cost: 5000, unit_price: 7000, money_account_id: cash }, U);
await Simple.deleteSale(del.id, U);
ok(!(await sale(del.id)), 'Deleted sale disappears'); eq(await bal(cash), t0, 'Cash is back to where it was');
await books('delete');

console.log('\n■ Expenses');
const cats = await Simple.expenseCategories();
ok(!cats.some((c) => c.name === 'Cost of items sold'), 'Internal cost category is not offered as an expense');
const catId = cats.find((c) => c.name === 'Electricity').id;
const e = await Simple.saveExpense({ category_id: catId, amount: 8000, description: 'Bill', money_account_id: cash }, null, U);
await Simple.saveExpense({ category_id: catId, amount: 9000, description: 'Bill', money_account_id: cash }, e.id, U);
eq((await Simple.expenseList()).rows.find((x) => x.id === e.id).amount, 9000, 'Expense edited');
await Simple.saveExpense({ category_id: cats.find((c) => c.name === 'Rent').id, amount: 20000, pay_later: true, paid_to: 'Landlord', description: 'October rent' }, null, U);
await throws(() => Simple.saveExpense({ category_id: catId, amount: 10, pay_later: true }, null, U), /who you need to pay/, 'Pay-later expense needs a name');
eq(await owes('pay', 'Landlord'), 20000, 'Unpaid rent shows as owed');
await Simple.settle({ kind: 'pay', person: 'Landlord', amount: 20000, money_account_id: cash }, U);
ok((await Simple.ledger('Landlord')).rows.some((x) => x.kind === 'paid'), 'Landlord ledger shows the payment');
await Simple.deleteExpense(e.id, U);
await books('expenses');

console.log('\n■ Start fresh');
await Simple.clearAllData();
s = await Simple.summary({});
eq(s.sales + s.expenses, 0, 'Everything cleared'); ok(s.money.length === 2, 'Cash and bank accounts kept');
await Simple.createSale({ item_name: 'Charger', unit_cost: 1200, unit_price: 2000, money_account_id: cash }, U);
eq((await Simple.summary({})).net_profit, 800, 'Works normally after clearing'); await books('after clearing');

console.log(`\n${failed ? '✘' : '✔'} ${pass} passed, ${failed} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* db still open on Windows */ }
process.exit(failed ? 1 : 0);
