// End-to-end accounting flow tests (fresh temp database, no sample data).
//   npm test
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-test-'));
process.env.DATA_DIR = dir; process.env.NO_SAMPLE = '1'; process.env.DB_PATH = path.join(dir, 'test.db');

const { get, all } = await import('../server/db.js');
const { bootstrap } = await import('../server/bootstrap.js');
const { docs, saveDoc, deleteDoc, restoreDoc } = await import('../server/docs.js');
const { saveItem } = await import('../server/modules/stock.js');
const { saveMoneyAccount, saveParty, moneyAccountsList } = await import('../server/modules/masters.js');
const { setInvoiceState } = await import('../server/modules/sales.js');
const R = await import('../server/reports.js');
const S = await import('../server/system.js');
const { postEntry } = await import('../server/posting.js');
const { sys, accountBalance } = await import('../server/coa.js');
const { today, addDays, addMonths } = await import('../server/util.js');

await bootstrap({ sample: false });
await (await import('../server/db.js')).setSetting('block_negative_cash', '1'); // these tests exercise the overdraft guard
const U = 'tester';
let pass = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✔ ${msg}`); } else { failed++; console.log(`  ✘ FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${msg} (expected ${b}, got ${a})`);
const throws = async (fn, re, msg) => { try { await fn(); ok(false, `${msg} — expected an error`); } catch (e) { ok(re.test(e.message), `${msg} → "${e.message}"`); } };
const doc = async (k, b, id = null) => await saveDoc(docs[k], b, id, U);
const gl = async (key) => await accountBalance(sys(key));   // debit - credit
const T = today(); const FY = `${T.slice(0, 4)}-01-01`;
const cat = async (kind, name) => (await get('SELECT id FROM categories WHERE kind=? AND name=?', kind, name)).id;
const acct = async (id) => (await moneyAccountsList()).find((m) => m.id === id).balance;

async function verifyBooks(label) {
  const tb = await R.trialBalance({ from: FY, to: T }); const bs = await R.bsData(T); const cf = await R.cashFlow({ from: FY, to: T });
  const integ = await S.integrity();
  ok(tb.data.balanced, `[${label}] Trial Balance balanced (Dr ${tb.data.debit} = Cr ${tb.data.credit})`);
  eq(bs.assets, bs.liabilities + bs.equity, `[${label}] Assets = Liabilities + Equity`);
  ok(cf.data.ok, `[${label}] Cash flow closing agrees with cash & bank ledgers`);
  ok(integ.ok, `[${label}] Integrity checks pass${integ.ok ? '' : ': ' + integ.checks.filter((c) => !c.ok).map((c) => c.name + ' ' + c.detail).join('; ')}`);
}

// ------------------------------------------------------------------ setup
console.log('\n■ Setup');
const cash = (await saveMoneyAccount({ name: 'Cash', kind: 'cash', opening_balance: 100000, opening_date: FY }, null, U)).id;
const bankA = (await saveMoneyAccount({ name: 'Bank A', kind: 'bank', opening_balance: 0, opening_date: FY }, null, U)).id;
const bankB = (await saveMoneyAccount({ name: 'Bank B', kind: 'bank', opening_balance: 0, opening_date: FY }, null, U)).id;
const cust = (await saveParty('customer', { name: 'Acme Customer' }, null, U)).id;
const supp = (await saveParty('supplier', { name: 'Widget Supplier' }, null, U)).id;
const item = (await saveItem({ name: 'Widget', sku: 'W-1', unit: 'pcs', purchase_price: 100, selling_price: 150, opening_stock: 0, min_stock: 5 }, null, U)).id;
eq(await acct(cash), 100000, 'Cash opening balance posted');
await verifyBooks('setup');

// ------------------------------------------------------------------ 4. Capital
console.log('\n■ Flow 4 — Capital investment → Cash/Bank → Capital');
const cap = await doc('capital', { date: T, investor: 'Owner', type: 'initial_capital', amount: 1000000, money_account_id: bankA });
eq(await acct(bankA), 1000000, 'Bank A increased by the investment');
eq(-await gl('OWNER_CAPITAL'), 1000000, 'Owner Capital credited');
const cs = (await R.trialBalance({ from: FY, to: T })).rows.find((r) => r.name === 'Owner Capital');
eq(cs.credit, 1000000, 'Trial balance shows Owner Capital credit 1,000,000');
await verifyBooks('capital');
await throws(async () => await doc('capital', { date: T, investor: 'Owner', type: 'drawing', amount: 5000000, money_account_id: bankA }), /Insufficient balance/, 'Drawing larger than the bank balance is blocked');

// ------------------------------------------------------------------ 1. Purchase invoice → stock → payable → payment
console.log('\n■ Flow 1 — Purchase invoice → Stock → Payable → Payment');
const bill = await doc('bills', { number: 'SUP-100', supplier_id: supp, date: T, lines: [{ item_id: item, qty: 50, unit_price: 100, tax_rate: 17 }] });
eq(bill.total, 5850, 'Bill total = 5,000 + 17% tax');
eq((await get('SELECT COALESCE(SUM(qty),0) q FROM stock_movements WHERE item_id=?', item)).q, 50, 'Stock increased to 50');
eq(await gl('INVENTORY'), 5000, 'Inventory ledger debited 5,000');
eq(-await gl('AP'), 5850, 'Accounts Payable credited 5,850');
eq(await gl('TAX_RECEIVABLE'), 850, 'Input tax recorded 850');
eq(bill.outstanding, 5850, 'Bill outstanding 5,850'); ok(bill.status === 'Unpaid', `Bill status is Unpaid (${bill.status})`);
await verifyBooks('purchase invoice');
const pay1 = await doc('payments', { date: T, category: 'supplier_invoice', party_id: supp, ref_type: 'purchase_invoice', ref_id: bill.id, amount: 2000, method: 'Bank Transfer', money_account_id: bankA });
eq(-await gl('AP'), 3850, 'AP reduced by part payment'); eq(await acct(bankA), 998000, 'Bank A reduced by payment');
ok((await require_getBill(bill.id)).status === 'Partially Paid', 'Bill status is Partially Paid');
await throws(async () => await doc('payments', { date: T, category: 'supplier_invoice', party_id: supp, ref_type: 'purchase_invoice', ref_id: bill.id, amount: 9999, money_account_id: bankA }), /exceeds the outstanding/, 'Paying more than outstanding is rejected');
await doc('payments', { date: T, category: 'supplier_invoice', party_id: supp, ref_type: 'purchase_invoice', ref_id: bill.id, amount: 3850, money_account_id: bankA });
eq(-await gl('AP'), 0, 'AP fully settled'); ok((await require_getBill(bill.id)).status === 'Paid', 'Bill status is Paid');
eq(await acct(bankA), 994150, 'Bank A = 1,000,000 − 5,850');
await verifyBooks('supplier payment');
async function require_getBill(id) { return await docs.bills.decorate(await get('SELECT * FROM purchase_invoices WHERE id=?', id)); }

// ------------------------------------------------------------------ 2. Customer invoice → revenue → receivable → receipt
console.log('\n■ Flow 2 — Customer invoice → Revenue → Receivable → Receipt');
const inv = await doc('invoices', { date: T, customer_id: cust, state: 'sent', lines: [{ item_id: item, qty: 10, unit_price: 150, tax_rate: 17 }] });
eq(inv.total, 1755, 'Invoice total = 1,500 + 17% tax');
eq(await gl('AR'), 1755, 'Accounts Receivable debited 1,755');
eq(-await gl('SALES'), 1500, 'Sales revenue credited 1,500'); eq(-await gl('TAX_PAYABLE'), 255, 'Output tax payable 255');
eq(await gl('COGS'), 1000, 'Cost of goods sold = 10 × avg cost 100'); eq(await gl('INVENTORY'), 4000, 'Inventory reduced to 4,000');
eq((await get('SELECT SUM(qty) q FROM stock_movements WHERE item_id=?', item)).q, 40, 'Stock decreased to 40');
await verifyBooks('sales invoice');
await throws(async () => await doc('invoices', { date: T, customer_id: cust, lines: [{ item_id: item, qty: 500, unit_price: 150 }] }), /Insufficient stock/, 'Selling more than the stock on hand is blocked');
const rc1 = await doc('receipts', { date: T, kind: 'customer', customer_id: cust, ref_type: 'invoice', ref_id: inv.id, amount: 1000, method: 'Bank Transfer', money_account_id: bankB });
eq(await acct(bankB), 1000, 'Bank B increased by receipt'); eq(await gl('AR'), 755, 'Receivable reduced to 755');
const inv2 = await docs.invoices.decorate(await get('SELECT * FROM sales_invoices WHERE id=?', inv.id));
eq(inv2.outstanding, 755, 'Invoice outstanding 755'); ok(inv2.status === 'Partially Paid', `Invoice status Partially Paid (${inv2.status})`);
await throws(async () => await doc('receipts', { date: T, kind: 'customer', customer_id: cust, ref_type: 'invoice', ref_id: inv.id, amount: 800, money_account_id: bankB }), /exceeds the outstanding/, 'Receipt above the outstanding balance is rejected');
await doc('receipts', { date: T, kind: 'customer', customer_id: cust, ref_type: 'invoice', ref_id: inv.id, amount: 755, money_account_id: bankB });
eq(await gl('AR'), 0, 'Receivable fully settled'); ok((await docs.invoices.decorate(await get('SELECT * FROM sales_invoices WHERE id=?', inv.id))).status === 'Paid', 'Invoice status Paid');
eq(await acct(bankB), 1755, 'Bank B = 1,755');
await verifyBooks('customer receipt');

// ------------------------------------------------------------------ 3. Expense → payment → cash/bank
console.log('\n■ Flow 3 — Expense → Payment → Cash/Bank');
const cashBefore = await acct(cash);
const exp1 = await doc('expenses', { date: T, category_id: await cat('expense', 'Rent'), amount: 2000, mode: 'paid', money_account_id: cash, vendor_name: 'Landlord', description: 'Rent' });
eq(await acct(cash), cashBefore - 2000, 'Cash decreased by paid expense'); eq(await gl('COGS') === 1000 ? (await R.plData(FY, T)).opex : 0, 2000, 'Operating expenses on the P&L = 2,000');
const exp2 = await doc('expenses', { date: T, category_id: await cat('expense', 'Electricity'), amount: 3000, mode: 'credit', vendor_name: 'Power Co', description: 'Bill' });
eq(-await gl('AP'), 3000, 'Unpaid expense creates a payable');
ok((await all("SELECT id FROM parties WHERE kind='supplier' AND name='Power Co'")).length === 1, 'Vendor auto-created as a supplier');
await doc('payments', { date: T, category: 'expense_bill', ref_type: 'expense', ref_id: exp2.id, amount: 3000, money_account_id: bankA, method: 'Bank Transfer' });
eq(-await gl('AP'), 0, 'Payment settled the expense payable'); eq(await acct(bankA), 994150 - 3000, 'Bank A reduced by expense payment');
const pl = await R.plData(FY, T);
eq(pl.revenue, 1500, 'P&L revenue 1,500'); eq(pl.cogs_total, 1000, 'P&L COGS 1,000'); eq(pl.gross, 500, 'P&L gross profit 500'); eq(pl.opex, 5000, 'P&L operating expenses 5,000'); eq(pl.net, -4500, 'P&L net loss 4,500');
await verifyBooks('expenses');

// ------------------------------------------------------------------ 5. Transfer
console.log('\n■ Flow 5 — Transfer Account A → Account B');
const pl0 = await R.plData(FY, T); const a0 = await acct(bankA), b0 = await acct(bankB);
const tr = await doc('transfers', { date: T, from_account_id: bankA, to_account_id: bankB, amount: 50000, description: 'Move funds' });
eq(await acct(bankA), a0 - 50000, 'Source account decreased'); eq(await acct(bankB), b0 + 50000, 'Destination account increased');
const pl1 = await R.plData(FY, T); eq(pl1.revenue, pl0.revenue, 'Transfer does not change revenue'); eq(pl1.expenses, pl0.expenses, 'Transfer does not change expenses');
const cf = await R.cashFlow({ from: FY, to: T }); const totalCash = await acct(cash) + await acct(bankA) + await acct(bankB);
eq(cf.data.closing, totalCash, 'Cash-flow closing balance equals total cash & bank');
await throws(async () => await doc('transfers', { date: T, from_account_id: bankA, to_account_id: bankA, amount: 10 }), /different/, 'Transfer to the same account is rejected');
await throws(async () => await doc('transfers', { date: T, from_account_id: bankB, to_account_id: bankA, amount: 99999999 }), /Insufficient balance/, 'Transfer exceeding balance is blocked');
await verifyBooks('transfer');

// ------------------------------------------------------------------ integrity rules
console.log('\n■ Integrity rules');
await throws(async () => await postEntry({ sourceType: 'test', sourceId: 1, date: T, lines: [{ account: sys('AR'), debit: 100 }, { account: sys('SALES'), credit: 99 }] }), /Unbalanced/, 'Unbalanced journal entry cannot be posted');
const before = (await get('SELECT COUNT(*) n FROM journal_entries')).n;
await throws(async () => await doc('expenses', { date: T, category_id: await cat('expense', 'Rent'), amount: 99999999, mode: 'paid', money_account_id: cash }), /Insufficient balance/, 'Overdrawing cash is blocked');
eq((await get('SELECT COUNT(*) n FROM journal_entries')).n, before, 'Rejected transaction left no partial postings (rolled back)');
await throws(async () => await doc('invoices', { date: T, customer_id: cust, lines: [] }), /at least one line/, 'Invoice without lines rejected');
await throws(async () => await doc('receipts', { date: T, kind: 'customer', customer_id: cust, amount: -5, money_account_id: bankA }), /greater than zero/, 'Negative receipt rejected');

// ------------------------------------------------------------------ edit & audit
console.log('\n■ Editing, audit trail, soft delete');
const edited = await doc('expenses', { ...await docs.expenses.decorate(await get('SELECT * FROM expenses WHERE id=?', exp1.id)), amount: 2500 }, exp1.id);
eq(await acct(cash), cashBefore - 2500, 'Editing an expense re-posts the ledger (cash −2,500)');
const au = await get("SELECT * FROM audit_log WHERE entity='expenses' AND entity_id=? AND action='updated'", exp1.id);
ok(au && au.old_amount === 2000 && au.new_amount === 2500, 'Audit trail records original (2,000) and updated (2,500) amount');
ok(au && JSON.parse(au.changes).amount, 'Audit trail records the changed fields');
await verifyBooks('edit');
await throws(async () => await deleteDoc(docs.invoices, inv.id, U), /receipts or credit notes/, 'Invoice with receipts cannot be deleted until receipts are removed');
for (const r of await all('SELECT id FROM receipts WHERE ref_id=? AND is_deleted=0', inv.id)) await deleteDoc(docs.receipts, r.id, U);
eq(await gl('AR'), 1755, 'Deleting receipts restores the receivable');
await deleteDoc(docs.invoices, inv.id, U);
eq(await gl('AR'), 0, 'Deleting the invoice reverses receivable'); eq(-await gl('SALES'), 0, 'Deleting the invoice reverses revenue');
eq((await get('SELECT SUM(qty) q FROM stock_movements WHERE item_id=?', item)).q, 50, 'Deleting the invoice returns stock');
ok((await get('SELECT is_deleted FROM sales_invoices WHERE id=?', inv.id)).is_deleted === 1, 'Invoice is soft-deleted (row kept)');
await verifyBooks('soft delete');
await restoreDoc(docs.invoices, inv.id, U);
eq(await gl('AR'), 1755, 'Restoring the invoice re-posts receivable'); eq((await get('SELECT SUM(qty) q FROM stock_movements WHERE item_id=?', item)).q, 40, 'Restore re-applies stock');
await verifyBooks('restore');
await throws(async () => await deleteDoc(docs.bills, bill.id, U), /payments or returns/, 'Purchase invoice with payments cannot be deleted');
// editing a purchase so stock would go negative
await throws(async () => await doc('bills', { ...await require_getBill(bill.id), lines: [{ item_id: item, qty: 5, unit_price: 100, tax_rate: 17 }] }, bill.id), /Insufficient stock|less than the amount already paid/, 'Editing a purchase cannot leave inconsistent stock/payables');

// ------------------------------------------------------------------ returns & disposal & prior-year
console.log('\n■ Returns, depreciation, prior-year profit → retained earnings');
const ret = await doc('returns', { date: T, kind: 'sales', item_id: item, party_id: cust, ref_id: inv.id, qty: 2, unit_price: 150, unit_cost: 100, tax_rate: 17, settlement: 'refund', money_account_id: bankB });
eq((await get('SELECT SUM(qty) q FROM stock_movements WHERE item_id=?', item)).q, 42, 'Sales return adds stock back');
await verifyBooks('sales return');
const asset = await doc('assets', { name: 'Laptop', category_id: await cat('asset', 'Computers'), purchase_date: addMonths(T, -3), purchase_value: 60000, source: 'paid', money_account_id: bankA, depreciable: true, useful_life_years: 5, salvage_value: 0 });
const created = await (await import('../server/modules/ledgers.js')).runDepreciation({ through: T }, U);
ok(created.length >= 3, `Monthly depreciation posted (${created.length} entries)`);
await verifyBooks('depreciation');
// back-dated prior-year sale: profit must roll into retained earnings and keep the sheet balanced
const lastYear = `${Number(T.slice(0, 4)) - 1}-06-15`;
const oldBank = (await saveMoneyAccount({ name: 'Old Bank', kind: 'bank', opening_balance: 0, opening_date: `${Number(T.slice(0, 4)) - 1}-01-01` }, null, U)).id;
await doc('revenue', { date: lastYear, customer_id: cust, category_id: await cat('revenue', 'Other Revenue'), amount: 7000, received_now: 7000, received_account_id: oldBank });
const bsNow = await R.bsData(T);
ok(bsNow.prior >= 7000 - 0.01, `Prior-year profit (${bsNow.prior}) is carried into retained earnings`);
await verifyBooks('prior year');
const tbLast = await R.trialBalance({ from: `${Number(T.slice(0, 4)) - 1}-01-01`, to: `${Number(T.slice(0, 4)) - 1}-12-31` });
ok(tbLast.data.balanced, 'Trial balance for the previous year is balanced');
const dash = await R.dashboard({ from: FY, to: T }); eq(dash.position.assets, dash.position.liabilities + dash.position.equity, 'Dashboard: Assets = Liabilities + Equity');
const aging = await R.agingSummary('customer'); eq(aging.totals.total, await gl('AR'), 'AR aging total equals the receivable control account');

console.log(`\n${failed ? '✘' : '✔'} ${pass} passed, ${failed} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the SQLite file open */ }
process.exit(failed ? 1 : 0);
