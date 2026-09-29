// Reporting engine. Everything is derived from the general ledger (journal_lines) so every
// statement is guaranteed to agree with the Trial Balance.
import { all, get } from './db.js';
import { fail, r2, cents, today, addDays, addMonths, monthEnd, fyStart, fyEnd, daysBetween, iso, parseD, listQuery } from './util.js';
import { getAccount, sys, SUBTYPE_LABEL, CASH_SUBTYPES, isDebitNormal } from './coa.js';
import { expenseLedger, revenueLedger, capitalSummary } from './modules/ledgers.js';
import { docs } from './docs.js';
import { itemList, movementList } from './modules/stock.js';
import { accountLedger, SOURCE_LABEL } from './modules/masters.js';

const MIN = '0000-01-01', MAX = '9999-12-31';

// ---- core: per-account debit/credit sums for a date window ----
export async function glSums(from, to) {
  const m = new Map();
  for (const r of await all(`SELECT jl.account_id id, SUM(jl.debit) d, SUM(jl.credit) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.status='posted' AND je.date BETWEEN ? AND ? GROUP BY jl.account_id`, from || MIN, to || MAX)) m.set(r.id, { d: r.d, c: r.c });
  return m;
}
const net = (m, id) => { const x = m.get(id); return x ? r2(x.d - x.c) : 0; };
const natural = (a, m) => { const n = net(m, a.id); return r2(isDebitNormal(a) ? n : -n); };
const allAccounts = async () => await all('SELECT * FROM accounts ORDER BY code');
const sumBy = (accts, m, pred) => r2(accts.filter(pred).reduce((s, a) => s + natural(a, m), 0));

export function rangeOf(p = {}) {
  const to = p.to || today();
  const from = p.from || fyStart(to);
  if (from > to) fail('The start date is after the end date');
  return { from, to };
}

// ---- Profit & Loss ----
export async function plData(from, to) {
  const m = await glSums(from, to); const accts = await allAccounts();
  const rev = accts.filter((a) => a.type === 'revenue'); const cogs = accts.filter((a) => a.type === 'expense' && a.subtype === 'cogs');
  const opx = accts.filter((a) => a.type === 'expense' && a.subtype !== 'cogs');
  const revenue = r2(rev.reduce((s, a) => s + natural(a, m), 0)), cogsT = r2(cogs.reduce((s, a) => s + natural(a, m), 0)), opexT = r2(opx.reduce((s, a) => s + natural(a, m), 0));
  return { m, accts, rev, cogs, opx, revenue, cogs_total: cogsT, gross: r2(revenue - cogsT), opex: r2(opexT), expenses: r2(cogsT + opexT), net: r2(revenue - cogsT - opexT) };
}
export async function profitLoss({ from, to }) {
  const d = await plData(from, to);
  const rows = []; const add = (label, amount, o = {}) => rows.push({ label, amount, ...o });
  const acc = (list) => list.filter((a) => Math.abs(net(d.m, a.id)) > 0.004).forEach((a) => add(`${a.code}  ${a.name}`, natural(a, d.m), { _i: 1, account_id: a.id }));
  add('Revenue', null, { _t: 'head' }); acc(d.rev); add('Total Revenue', d.revenue, { _t: 'total' });
  add('Cost of Goods Sold', null, { _t: 'head' }); acc(d.cogs); add('Total Cost of Goods Sold', d.cogs_total, { _t: 'total' });
  add('GROSS PROFIT', d.gross, { _t: 'grand' });
  add('Operating Expenses', null, { _t: 'head' }); acc(d.opx); add('Total Operating Expenses', d.opex, { _t: 'total' });
  add(d.net >= 0 ? 'NET PROFIT' : 'NET LOSS', d.net, { _t: 'grand' });
  return { title: 'Profit & Loss Statement', subtitle: `${from} to ${to}`, columns: [['label', 'Description'], ['amount', 'Amount', 'money']], rows, kind: 'statement', data: { revenue: d.revenue, cogs: d.cogs_total, gross: d.gross, opex: d.opex, net: d.net } };
}

// ---- Balance Sheet ----
export async function bsData(asOf) {
  const m = await glSums(null, asOf); const accts = await allAccounts();
  const fy = fyStart(asOf);
  const prior = (await plData(null, addDays(fy, -1))).net, current = (await plData(fy, asOf)).net;
  const grp = (type, subs) => accts.filter((a) => a.type === type && subs.includes(a.subtype));
  const total = (list) => r2(list.reduce((s, a) => s + natural(a, m), 0));
  const assets = accts.filter((a) => a.type === 'asset'), liab = accts.filter((a) => a.type === 'liability'), eq = accts.filter((a) => a.type === 'equity');
  const equityAccts = total(eq);
  return {
    m, accts, fy, prior, current, assets: total(assets), liabilities: total(liab), equity: r2(equityAccts + prior + current),
    grp, total, eq,
  };
}
export async function balanceSheet({ to }) {
  const b = await bsData(to); const rows = []; const add = (label, amount, o = {}) => rows.push({ label, amount, ...o });
  const list = (accts) => accts.filter((a) => Math.abs(net(b.m, a.id)) > 0.004).forEach((a) => add(`${a.code}  ${a.name}`, natural(a, b.m), { _i: 1, account_id: a.id }));
  const section = async (title, accts) => { const l = accts.filter((a) => Math.abs(net(b.m, a.id)) > 0.004); if (!l.length) return 0; add(title, null, { _t: 'sub' }); list(accts); const t = b.total(accts); add(`Total ${title}`, t, { _t: 'total' }); return t; };
  add('ASSETS', null, { _t: 'head' });
  await section('Cash & Bank', b.grp('asset', CASH_SUBTYPES)); await section('Accounts Receivable', b.grp('asset', ['receivable'])); await section('Inventory', b.grp('asset', ['inventory']));
  await section('Other Current Assets', b.grp('asset', ['tax_receivable', 'other_current'])); await section('Fixed Assets (net of depreciation)', b.grp('asset', ['fixed_asset', 'accum_depr'])); await section('Other Assets', b.grp('asset', ['other_asset']));
  add('TOTAL ASSETS', b.assets, { _t: 'grand' });
  add('LIABILITIES', null, { _t: 'head' });
  await section('Current Liabilities', b.grp('liability', ['payable', 'tax_payable', 'credit_card', 'other_liability']));
  await section('Loans & Long-Term Liabilities', b.grp('liability', ['loan', 'long_term']));
  add('TOTAL LIABILITIES', b.liabilities, { _t: 'grand' });
  add("OWNER'S EQUITY", null, { _t: 'head' });
  await list(b.eq.filter((a) => a.subtype !== 'retained'));
  const ret = b.eq.filter((a) => a.subtype === 'retained').reduce((s, a) => s + natural(a, b.m), 0);
  add('Retained Earnings (prior periods)', r2(ret + b.prior), { _i: 1 });
  add('Current Period Profit / (Loss)', b.current, { _i: 1 });
  add("TOTAL OWNER'S EQUITY", b.equity, { _t: 'grand' });
  add('TOTAL LIABILITIES + EQUITY', r2(b.liabilities + b.equity), { _t: 'grand' });
  const diff = r2(b.assets - b.liabilities - b.equity);
  add(diff === 0 ? 'Check: Assets = Liabilities + Equity  ✓ balanced' : `Check: OUT OF BALANCE by ${diff}`, diff, { _t: 'check' });
  return { title: 'Balance Sheet', subtitle: `As at ${to}`, columns: [['label', 'Description'], ['amount', 'Amount', 'money']], rows, kind: 'statement', data: { assets: b.assets, liabilities: b.liabilities, equity: b.equity, balanced: diff === 0 } };
}

// ---- Trial Balance ----
export async function trialBalance({ from, to }) {
  const cum = await glSums(null, to), per = await glSums(from, to); const accts = await allAccounts();
  const rows = []; let td = 0, tc = 0;
  for (const a of accts) {
    const m = a.type === 'revenue' || a.type === 'expense' ? per : cum;
    const n = net(m, a.id);
    if (Math.abs(n) < 0.005) continue;
    const debit = n > 0 ? n : 0, credit = n < 0 ? -n : 0;
    td += cents(debit); tc += cents(credit);
    rows.push({ code: a.code, name: a.name, type: a.type[0].toUpperCase() + a.type.slice(1), debit, credit, balance: r2(isDebitNormal(a) ? n : -n), account_id: a.id });
  }
  const priorNet = (await plData(null, addDays(from, -1))).net; // prior-period profit sits in retained earnings
  if (Math.abs(priorNet) >= 0.005) {
    const debit = priorNet < 0 ? -priorNet : 0, credit = priorNet > 0 ? priorNet : 0;
    td += cents(debit); tc += cents(credit);
    rows.push({ code: '', name: 'Retained Earnings - prior periods result', type: 'Equity', debit, credit, balance: priorNet });
  }
  const totalRow = { code: '', name: 'TOTAL', type: '', debit: td / 100, credit: tc / 100, balance: null, _t: 'grand' };
  return {
    title: 'Trial Balance', subtitle: `${from} to ${to}`,
    columns: [['code', 'Account Code'], ['name', 'Account Name'], ['type', 'Account Type'], ['debit', 'Debit', 'money'], ['credit', 'Credit', 'money'], ['balance', 'Balance', 'money']],
    rows: [...rows, totalRow], kind: 'statement', data: { debit: td / 100, credit: tc / 100, balanced: td === tc },
  };
}

// ---- Cash flow ----
const cashIds = async () => (await all(`SELECT id FROM accounts WHERE type='asset' AND subtype IN ('cash','bank','wallet')`)).map((r) => r.id);
export async function cashEntries(from, to) {
  const ids = await cashIds(); if (!ids.length) return [];
  const lines = await all(`SELECT je.id eid, je.date, je.source_type st, jl.account_id, jl.debit, jl.credit, a.type, a.subtype, a.name FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id JOIN accounts a ON a.id=jl.account_id
    WHERE je.status='posted' AND je.date BETWEEN ? AND ? AND je.id IN (SELECT entry_id FROM journal_lines WHERE account_id IN (${ids.join(',')}))`, from, to);
  const by = new Map();
  for (const l of lines) {
    let e = by.get(l.eid); if (!e) { e = { date: l.date, st: l.st, cash: 0, counters: [] }; by.set(l.eid, e); }
    if (ids.includes(l.account_id)) e.cash += l.debit - l.credit; else e.counters.push({ name: l.name, type: l.type, subtype: l.subtype, amt: l.credit - l.debit });
  }
  return [...by.values()].filter((e) => e.counters.length); // entries between two cash accounts (transfers) are internal
}
function cfClass(c, st) {
  if (st === 'asset_disposal') return ['investing', c.name];
  if (c.type === 'asset' && ['fixed_asset', 'accum_depr', 'other_asset'].includes(c.subtype)) return ['investing', `Fixed / other assets: ${c.name}`];
  if (c.type === 'equity') return ['financing', c.subtype === 'capital' ? 'Owner capital invested / (withdrawn)' : c.subtype === 'drawings' ? 'Owner drawings' : c.subtype === 'obe' ? 'Opening balances' : c.name];
  if (c.type === 'liability' && ['loan', 'long_term', 'credit_card'].includes(c.subtype)) return ['financing', `Loans & credit: ${c.name}`];
  if (c.subtype === 'inventory' || c.subtype === 'cogs') return ['operating', 'Inventory & cost of sales (net of returns)'];
  if (/returns/i.test(c.name)) return ['operating', 'Sales returns refunded'];
  const label = c.subtype === 'receivable' ? 'Cash received from customers' : c.subtype === 'payable' ? 'Cash paid to suppliers & vendors'
    : c.subtype === 'inventory' ? 'Inventory purchased for cash' : c.subtype === 'tax_payable' || c.subtype === 'tax_receivable' ? 'Sales tax (net)'
    : c.type === 'revenue' ? `Received: ${c.name}` : c.type === 'expense' ? `Paid: ${c.name}` : c.name;
  return ['operating', label];
}
export async function cashFlow({ from, to }) {
  const ids = await cashIds();
  const bal = async (d) => r2((await all(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.status='posted' AND je.date<=? AND jl.account_id IN (${ids.join(',') || 0})`, d))[0].v);
  const sec = { operating: new Map(), investing: new Map(), financing: new Map() };
  for (const e of await cashEntries(from, to)) {
    // each counter-line carries its own share of the cash movement
    for (const c of e.counters) { const [s, label] = cfClass(c, e.st); sec[s].set(label, r2((sec[s].get(label) || 0) + c.amt)); }
  }
  const rows = []; const add = (label, amount, o = {}) => rows.push({ label, amount, ...o });
  let netChange = 0; const totals = {};
  for (const [k, title] of [['operating', 'Cash Flow from Operating Activities'], ['investing', 'Cash Flow from Investing Activities'], ['financing', 'Cash Flow from Financing Activities']]) {
    add(title, null, { _t: 'head' });
    let t = 0;
    for (const [label, amt] of [...sec[k]].sort((a, b) => b[1] - a[1])) if (Math.abs(amt) >= 0.005) { add(label, amt, { _i: 1 }); t += amt; }
    t = r2(t); totals[k] = t; netChange += t; add(`Net Cash from ${k[0].toUpperCase() + k.slice(1)} Activities`, t, { _t: 'total' });
  }
  netChange = r2(netChange);
  const opening = await bal(addDays(from, -1)), closing = await bal(to);
  add('NET INCREASE / (DECREASE) IN CASH', netChange, { _t: 'grand' });
  add('Opening Cash & Bank Balance', opening, { _t: 'total' });
  add('Closing Cash & Bank Balance', r2(opening + netChange), { _t: 'grand' });
  const ok = Math.abs(opening + netChange - closing) < 0.005;
  add(ok ? 'Check: agrees to cash & bank balances in the ledger  ✓' : `Check: OUT OF BALANCE with ledger (${closing})`, r2(closing - opening - netChange), { _t: 'check' });
  return { title: 'Cash Flow Statement', subtitle: `${from} to ${to}`, columns: [['label', 'Description'], ['amount', 'Amount', 'money']], rows, kind: 'statement', data: { ...totals, net: netChange, opening, closing, ok } };
}

// ---- Receivables / payables ----
const BUCKETS = ['current', 'd30', 'd60', 'd90', 'd90p'];
export const BUCKET_LABEL = { current: 'Current', d30: '1-30 Days', d60: '31-60 Days', d90: '61-90 Days', d90p: '90+ Days' };
const bucketOf = (days) => (days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'd90p');

export async function openItems(kind, asOf = today()) {
  const items = [];
  const status = (o, due) => (o <= 0.005 ? 'Paid' : due && due < asOf ? 'Overdue' : 'Unpaid');
  if (kind === 'customer') {
    for (const r of await all(`SELECT si.id, si.number, si.date, si.due_date, si.customer_id party_id, p.name party, si.total,
      (SELECT COALESCE(SUM(amount),0) FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0 AND r.date<=?) rec,
      (SELECT COALESCE(SUM(total),0) FROM stock_returns sr WHERE sr.kind='sales' AND sr.settlement='credit' AND sr.ref_id=si.id AND sr.is_deleted=0 AND sr.date<=?) cred
      FROM sales_invoices si JOIN parties p ON p.id=si.customer_id WHERE si.is_deleted=0 AND si.state='sent' AND si.date<=?`, asOf, asOf, asOf))
      items.push({ ...r, type: 'Invoice', amount: r.total, settled: r2(r.rec + r.cred), outstanding: r2(r.total - r.rec - r.cred) });
    for (const r of await all(`SELECT re.id, re.number, re.date, re.due_date, re.customer_id party_id, p.name party, re.amount total,
      (SELECT COALESCE(SUM(amount),0) FROM receipts r WHERE r.ref_type='revenue' AND r.ref_id=re.id AND r.is_deleted=0 AND r.date<=?) rec
      FROM revenue_entries re JOIN parties p ON p.id=re.customer_id WHERE re.is_deleted=0 AND re.date<=?`, asOf, asOf))
      items.push({ ...r, type: 'Revenue', amount: r.total, settled: r.rec, outstanding: r2(r.total - r.rec) });
  } else {
    for (const r of await all(`SELECT pi.id, pi.number, pi.date, pi.due_date, pi.supplier_id party_id, p.name party, pi.total,
      (SELECT COALESCE(SUM(amount),0) FROM payments x WHERE x.ref_type='purchase_invoice' AND x.ref_id=pi.id AND x.is_deleted=0 AND x.date<=?) paid,
      (SELECT COALESCE(SUM(total),0) FROM stock_returns sr WHERE sr.kind='purchase' AND sr.settlement='credit' AND sr.ref_id=pi.id AND sr.is_deleted=0 AND sr.date<=?) cred
      FROM purchase_invoices pi JOIN parties p ON p.id=pi.supplier_id WHERE pi.is_deleted=0 AND pi.state='posted' AND pi.date<=?`, asOf, asOf, asOf))
      items.push({ ...r, type: 'Purchase Invoice', amount: r.total, settled: r2(r.paid + r.cred), outstanding: r2(r.total - r.paid - r.cred) });
    for (const r of await all(`SELECT e.id, e.number, e.date, e.due_date, e.vendor_id party_id, p.name party, e.amount total,
      (SELECT COALESCE(SUM(amount),0) FROM payments x WHERE x.ref_type='expense' AND x.ref_id=e.id AND x.is_deleted=0 AND x.date<=?) paid
      FROM expenses e JOIN parties p ON p.id=e.vendor_id WHERE e.is_deleted=0 AND e.mode='credit' AND e.date<=?`, asOf, asOf))
      items.push({ ...r, type: 'Expense Bill', amount: r.total, settled: r.paid, outstanding: r2(r.total - r.paid) });
  }
  const out = items.filter((i) => Math.abs(i.outstanding) > 0.005).map((i) => {
    const due = i.due_date || i.date; const days = Math.max(0, daysBetween(due, asOf));
    return { ...i, invoice_date: i.date, due_date: due, days_overdue: days, bucket: bucketOf(days), status: status(i.outstanding, due) };
  });
  // unapplied receipts / payments / credits reduce the party balance but belong to no document
  const unapplied = kind === 'customer'
    ? (await all(`SELECT r.customer_id party_id, p.name party, SUM(r.amount) v FROM receipts r JOIN parties p ON p.id=r.customer_id WHERE r.is_deleted=0 AND r.kind='customer' AND r.ref_type IS NULL AND r.date<=? GROUP BY r.customer_id`, asOf))
      .concat(await all(`SELECT r.party_id, p.name party, SUM(r.total) v FROM stock_returns r JOIN parties p ON p.id=r.party_id WHERE r.is_deleted=0 AND r.kind='sales' AND r.settlement='credit' AND r.ref_id IS NULL AND r.date<=? GROUP BY r.party_id`, asOf))
    : (await all(`SELECT r.party_id, p.name party, SUM(r.amount) v FROM payments r JOIN parties p ON p.id=r.party_id WHERE r.is_deleted=0 AND r.category='supplier_invoice' AND r.ref_type IS NULL AND r.date<=? GROUP BY r.party_id`, asOf))
      .concat(await all(`SELECT r.party_id, p.name party, SUM(r.total) v FROM stock_returns r JOIN parties p ON p.id=r.party_id WHERE r.is_deleted=0 AND r.kind='purchase' AND r.settlement='credit' AND r.ref_id IS NULL AND r.date<=? GROUP BY r.party_id`, asOf));
  for (const u of unapplied) out.push({ id: 0, number: 'Unapplied', type: 'Unapplied payment / credit', date: asOf, invoice_date: asOf, due_date: asOf, party_id: u.party_id, party: u.party, amount: -u.v, settled: 0, outstanding: -r2(u.v), days_overdue: 0, bucket: 'current', status: 'Credit' });
  return out;
}
export async function agingSummary(kind, asOf = today()) {
  const items = await openItems(kind, asOf); const tot = Object.fromEntries(BUCKETS.map((b) => [b, 0])); tot.total = 0; tot.overdue = 0;
  for (const i of items) { tot[i.bucket] = r2(tot[i.bucket] + i.outstanding); tot.total = r2(tot.total + i.outstanding); if (i.bucket !== 'current') tot.overdue = r2(tot.overdue + i.outstanding); }
  return { items, totals: tot };
}
async function agingReport(kind, { to }) {
  const { items, totals } = await agingSummary(kind, to); const by = new Map();
  for (const i of items) { let r = by.get(i.party_id); if (!r) { r = { party: i.party, party_id: i.party_id, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])), total: 0 }; by.set(i.party_id, r); } r[i.bucket] = r2(r[i.bucket] + i.outstanding); r.total = r2(r.total + i.outstanding); }
  const isC = kind === 'customer';
  return {
    title: isC ? 'Accounts Receivable Aging' : 'Accounts Payable Aging', subtitle: `As at ${to}`,
    columns: [['party', isC ? 'Customer' : 'Supplier'], ...BUCKETS.map((b) => [b, BUCKET_LABEL[b], 'money', true]), ['total', 'Total Outstanding', 'money', true]],
    rows: [...by.values()].sort((a, b) => b.total - a.total), totals: { ...totals }, data: totals,
  };
}
async function openItemsReport(kind, { to, party_id, status }) {
  const isC = kind === 'customer';
  let items = (await openItems(kind, to)).filter((i) => i.number !== 'Unapplied' || true);
  if (party_id) items = items.filter((i) => i.party_id === Number(party_id));
  if (status) items = items.filter((i) => i.status === status);
  return {
    title: isC ? 'Accounts Receivable' : 'Accounts Payable', subtitle: `Outstanding as at ${to}`,
    columns: [['party', isC ? 'Customer' : 'Supplier'], ['number', 'Invoice'], ['invoice_date', 'Invoice Date', 'date'], ['due_date', 'Due Date', 'date'], ['amount', 'Invoice Amount', 'money', true],
      ['settled', isC ? 'Amount Received' : 'Amount Paid', 'money', true], ['outstanding', 'Outstanding', 'money', true], ['days_overdue', 'Days Overdue', 'num'], ['status', 'Status', 'badge']],
    rows: items.sort((a, b) => b.days_overdue - a.days_overdue), kind: 'table',
  };
}

// ---- Party statements from the ledger ----
export async function statement(kind, { from, to, party_id }) {
  if (!party_id) fail(`Select a ${kind}`);
  const p = await get('SELECT * FROM parties WHERE id=? AND kind=?', party_id, kind); if (!p) fail('Party not found', 404);
  const acc = sys(kind === 'customer' ? 'AR' : 'AP'); const sign = kind === 'customer' ? 1 : -1;
  const opening = r2(sign * (await get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.status='posted' AND jl.party_id=? AND jl.account_id=? AND je.date<?`, party_id, acc, from)).v);
  const lines = await all(`SELECT je.date, je.entry_no, je.memo, je.source_type, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.status='posted' AND jl.party_id=? AND jl.account_id=? AND je.date BETWEEN ? AND ? ORDER BY je.date, jl.id`, party_id, acc, from, to);
  let bal = opening; const rows = [{ date: from, ref: '', description: 'Opening balance', charges: null, payments: null, balance: opening, _t: 'total' }];
  let ch = 0, py = 0;
  for (const l of lines) {
    const charge = kind === 'customer' ? l.debit : l.credit, pay = kind === 'customer' ? l.credit : l.debit;
    bal = r2(bal + charge - pay); ch += charge; py += pay;
    rows.push({ date: l.date, ref: l.entry_no, description: l.memo, charges: charge || null, payments: pay || null, balance: bal });
  }
  rows.push({ date: to, ref: '', description: 'Closing balance', charges: r2(ch), payments: r2(py), balance: bal, _t: 'grand' });
  const isC = kind === 'customer';
  return {
    title: `${isC ? 'Customer' : 'Supplier'} Statement - ${p.name}`, subtitle: `${from} to ${to}`,
    columns: [['date', 'Date', 'date'], ['ref', 'Entry #'], ['description', 'Description'], ['charges', isC ? 'Invoiced / Charges' : 'Bills / Charges', 'money'], ['payments', isC ? 'Received / Credits' : 'Paid / Credits', 'money'], ['balance', 'Balance', 'money']],
    rows, kind: 'statement', data: { party: p, opening, closing: bal },
  };
}

// ---- Dashboard ----
function buckets(from, to) {
  const days = daysBetween(from, to) + 1; const out = [];
  if (days <= 31) { for (let i = 0; i < days; i++) { const d = addDays(from, i); out.push({ start: d, end: d, label: d.slice(5) }); } return out; }
  let s = from;
  while (s <= to) { const e = monthEnd(s) < to ? monthEnd(s) : to; out.push({ start: s, end: e, label: s.slice(0, 7) }); s = addDays(monthEnd(s), 1); }
  return out;
}
export async function dashboard({ from, to: rangeTo }) {
  // position figures (balances, receivables, stock) are "as at" the end of the range, but never in the future
  const to = rangeTo > today() ? today() : rangeTo;
  const pl = await plData(from, rangeTo); const bs = await bsData(to); const m = bs.m; const accts = bs.accts;
  const bySub = (sub) => r2(accts.filter((a) => a.subtype === sub).reduce((s, a) => s + natural(a, m), 0));
  const cashB = bySub('cash'), bankB = bySub('bank'), walletB = bySub('wallet');
  const capital = r2(bySub('capital') + bySub('drawings'));
  const stock = await get(`SELECT COALESCE(SUM(m.value),0) v, COALESCE(SUM(m.qty),0) q FROM stock_movements m WHERE m.date<=?`, to);
  const st = await get(`SELECT COUNT(*) items, COALESCE(SUM(CASE WHEN current_stock>0 AND current_stock<=min_stock THEN 1 ELSE 0 END),0) low, COALESCE(SUM(CASE WHEN current_stock<=0 THEN 1 ELSE 0 END),0) out
    FROM (SELECT i.id, i.min_stock, COALESCE((SELECT SUM(qty) FROM stock_movements WHERE item_id=i.id),0) current_stock FROM items i WHERE i.is_deleted=0 AND i.is_service=0 AND i.active=1)`);
  const ar = await agingSummary('customer', to), ap = await agingSummary('supplier', to);
  // time series
  const bk = buckets(from, rangeTo); const series = bk.map((b) => ({ label: b.label, revenue: 0, expenses: 0, inflow: 0, outflow: 0 }));
  const idx = (date) => bk.findIndex((b) => date >= b.start && date <= b.end);
  for (const r of await all(`SELECT je.date, a.type, SUM(jl.debit) d, SUM(jl.credit) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id JOIN accounts a ON a.id=jl.account_id
    WHERE je.status='posted' AND je.date BETWEEN ? AND ? AND a.type IN ('revenue','expense') GROUP BY je.date, a.type`, from, rangeTo)) {
    const i = idx(r.date); if (i < 0) continue;
    if (r.type === 'revenue') series[i].revenue = r2(series[i].revenue + r.c - r.d); else series[i].expenses = r2(series[i].expenses + r.d - r.c);
  }
  for (const e of await cashEntries(from, rangeTo)) { const i = idx(e.date); if (i < 0) continue; if (e.cash > 0) series[i].inflow = r2(series[i].inflow + e.cash); else series[i].outflow = r2(series[i].outflow - e.cash); }
  const topStock = await all(`SELECT i.name, SUM(m.value) value FROM stock_movements m JOIN items i ON i.id=m.item_id WHERE m.date<=? GROUP BY i.id HAVING SUM(m.value)>0.005 ORDER BY value DESC LIMIT 8`, to);
  const recent = (await all(`SELECT je.date, je.entry_no, je.memo, je.source_type, (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id=je.id) amount FROM journal_entries je WHERE je.status='posted' ORDER BY je.date DESC, je.id DESC LIMIT 8`))
    .map((r) => ({ ...r, source_label: SOURCE_LABEL[r.source_type] || r.source_type }));
  const overdueInv = (await get(`SELECT COUNT(*) n FROM sales_invoices WHERE is_deleted=0 AND state='sent' AND due_date < ? AND total - (SELECT COALESCE(SUM(amount),0) FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=sales_invoices.id AND r.is_deleted=0) > 0.005`, today())).n;
  return {
    range: { from, to: rangeTo, asOf: to },
    position: { assets: bs.assets, liabilities: bs.liabilities, equity: bs.equity, capital: r2(capital) },
    performance: { revenue: pl.revenue, cogs: pl.cogs_total, expenses: pl.expenses, gross: pl.gross, net: pl.net },
    cash: { cash: cashB, bank: bankB, wallet: walletB, total: r2(cashB + bankB + walletB) },
    receivables: { total: ar.totals.total, overdue: ar.totals.overdue, aging: ar.totals }, payables: { total: ap.totals.total, overdue: ap.totals.overdue, aging: ap.totals },
    inventory: { items: st.items, quantity: r2(stock.q), value: r2(stock.v), low: st.low, out: st.out },
    charts: { series, topStock, receivablesVsPayables: [{ label: 'Total', receivable: ar.totals.total, payable: ap.totals.total }, { label: 'Overdue', receivable: ar.totals.overdue, payable: ap.totals.overdue }] },
    recent, alerts: { overdueInvoices: overdueInv, lowStock: st.low, outOfStock: st.out },
  };
}

// ---------------------------------------------------------------------------
// Tabular report catalogue
// ---------------------------------------------------------------------------
const all_ = (fn, p, extra = {}) => fn({ ...p, ...extra, size: 'all', page: 1 });
const sumCols = (columns, rows) => {
  const t = {};
  for (const c of columns) if (c[3] || (c[2] === 'money' && c[3] !== false && rows.length && rows.every((r) => r._t == null))) t[c[0]] = r2(rows.reduce((s, r) => s + (Number(r[c[0]]) || 0), 0));
  return t;
};
function fromList(title, list, p, opts = {}) {
  const r = all_(list, p, opts.extra);
  const columns = r.columns.map((c) => [c[0], c[1], c[2] || 'text', ['money', 'num'].includes(c[2]) && opts.sum !== false && !opts.noSum?.includes(c[0])]);
  return { title, subtitle: `${p.from || 'Beginning'} to ${p.to || 'Today'}`, columns, rows: r.rows, totals: r.summary, kind: 'table' };
}
function groupReport(title, rows, p, { keyFns, amountKey = 'amount', label }) {
  const g = p.group || 'detail'; if (g === 'detail') return null;
  const fn = keyFns[g]; if (!fn) return null;
  const by = new Map();
  for (const r of rows) { const k = fn(r) || '(none)'; const x = by.get(k) || { name: k, count: 0, total: 0 }; x.count++; x.total = r2(x.total + Number(r[amountKey] || 0)); by.set(k, x); }
  const all_ = [...by.values()]; const sum = all_.reduce((s, x) => s + x.total, 0);
  all_.forEach((x) => { x.share = sum ? r2((x.total / sum) * 100) : 0; });
  all_.sort((a, b) => (g === 'month' || g === 'year' ? a.name.localeCompare(b.name) : b.total - a.total));
  return { title: `${title} by ${label[g]}`, subtitle: `${p.from} to ${p.to}`, columns: [['name', label[g]], ['count', 'Transactions', 'num', true], ['total', 'Total', 'money', true], ['share', '% of Total', 'num']], rows: all_, kind: 'table' };
}
const GROUP_LABELS = { category: 'Category', month: 'Month', year: 'Year', vendor: 'Vendor', method: 'Payment Method', customer: 'Customer' };

export const REPORTS = {
  trial_balance: { title: 'Trial Balance', group: 'Financial Statements', params: ['range'], run: async (p) => await trialBalance(p) },
  profit_loss: { title: 'Profit & Loss', group: 'Financial Statements', params: ['range'], run: async (p) => await profitLoss(p) },
  balance_sheet: { title: 'Balance Sheet', group: 'Financial Statements', params: ['asof'], run: async (p) => await balanceSheet(p) },
  cash_flow: { title: 'Cash Flow Statement', group: 'Financial Statements', params: ['range'], run: async (p) => await cashFlow(p) },
  general_ledger: {
    title: 'General Ledger (Account)', group: 'Financial Statements', params: ['range', 'account'],
    run: async (p) => {
      if (!p.account_id) fail('Select an account');
      const a = await getAccount(p.account_id); if (!a) fail('Account not found', 404);
      const r = all_(async (q) => await accountLedger(p.account_id, q), p);
      return { title: `General Ledger - ${a.code} ${a.name}`, subtitle: `${p.from} to ${p.to}`, columns: r.columns.map((c) => [c[0], c[1], c[2] || 'text', ['debit', 'credit'].includes(c[0])]), rows: r.rows, kind: 'table' };
    },
  },
  asset_report: {
    title: 'Asset Report', group: 'Ledger Reports', params: ['range'],
    run: async (p) => { const r = fromList('Asset Report', async (q) => await docs.assets.list(q), p, { noSum: [] }); r.subtitle = 'Asset register - purchases in ' + r.subtitle; return r; },
  },
  expense_report: {
    title: 'Expense Report', group: 'Ledger Reports', params: ['range', 'group:category,month,year,vendor,method', 'category'],
    run: async (p) => {
      const rep = fromList('Expense Report', expenseLedger, p);
      return groupReport('Expense Report', rep.rows, p, { keyFns: { category: (r) => r.category, month: (r) => r.date.slice(0, 7), year: (r) => r.date.slice(0, 4), vendor: (r) => r.vendor, method: (r) => r.method }, label: GROUP_LABELS }) || rep;
    },
  },
  revenue_report: {
    title: 'Revenue Report', group: 'Ledger Reports', params: ['range', 'group:customer,category,month,year'],
    run: async (p) => {
      const rep = fromList('Revenue Report', revenueLedger, p);
      const g = groupReport('Revenue Report', rep.rows, { ...p }, { amountKey: 'net_revenue', keyFns: { customer: (r) => r.customer, category: (r) => r.category, month: (r) => r.date.slice(0, 7), year: (r) => r.date.slice(0, 4) }, label: GROUP_LABELS });
      return g || rep;
    },
  },
  capital_report: { title: 'Capital Report', group: 'Ledger Reports', params: ['range'], run: async (p) => { const r = fromList('Capital Report', async (q) => await docs.capital.list(q), p); const s = await capitalSummary(p); r.summary = s; return r; } },
  liability_report: { title: 'Liability Report', group: 'Ledger Reports', params: ['range'], run: async (p) => fromList('Liability Report', async (q) => await docs.liabilities.list(q), p) },
  receivable_report: { title: 'Accounts Receivable Report', group: 'Sales', params: ['asof', 'view:detail,aging', 'customer'], run: async (p) => (p.view === 'aging' ? await agingReport('customer', p) : await openItemsReport('customer', p)) },
  payable_report: { title: 'Accounts Payable Report', group: 'Purchases', params: ['asof', 'view:detail,aging', 'supplier'], run: async (p) => (p.view === 'aging' ? await agingReport('supplier', p) : await openItemsReport('supplier', p)) },
  stock_report: {
    title: 'Stock Report', group: 'Inventory', params: ['view:valuation,low,movement'],
    run: async (p) => {
      if (p.view === 'movement') return fromList('Stock Movement Report', async (q) => await movementList(q), p);
      const r = fromList(p.view === 'low' ? 'Low / Out of Stock Items' : 'Stock Valuation Report', itemList, { ...p, from: null, to: null }, { noSum: ['opening_stock', 'purchased', 'returned', 'sold', 'min_stock'] });
      if (p.view === 'low') r.rows = r.rows.filter((x) => x.stock_status === 'Low Stock' || x.stock_status === 'Out of Stock');
      r.subtitle = `As at ${p.to || today()}`; return r;
    },
  },
  purchase_report: { title: 'Purchase Report', group: 'Purchases', params: ['range', 'supplier'], run: async (p) => fromList('Purchase Report', async (q) => await docs.bills.list(q), p) },
  sales_report: { title: 'Sales Report', group: 'Sales', params: ['range', 'customer'], run: async (p) => fromList('Sales Report', async (q) => await docs.invoices.list(q), p) },
  payment_report: { title: 'Payment Report', group: 'Purchases', params: ['range'], run: async (p) => fromList('Payment Report', async (q) => await docs.payments.list(q), p) },
  receipt_report: { title: 'Receipt Report', group: 'Sales', params: ['range'], run: async (p) => fromList('Receipt Report', async (q) => await docs.receipts.list(q), p) },
  transfer_report: { title: 'Transfer Report', group: 'Banking', params: ['range'], run: async (p) => fromList('Transfer Report', async (q) => await docs.transfers.list(q), p) },
  customer_statement: { title: 'Customer Statement', group: 'Sales', params: ['range', 'customer*'], run: async (p) => await statement('customer', p) },
  supplier_statement: { title: 'Supplier Statement', group: 'Purchases', params: ['range', 'supplier*'], run: async (p) => await statement('supplier', p) },
};


// generic search / sort for tabular reports (statements are left untouched)
export function applyTableQuery(rep, q) {
  if (rep.kind === 'statement') return rep;
  let rows = rep.rows;
  const term = String(q.q || '').trim().toLowerCase();
  if (term) rows = rows.filter((r) => rep.columns.some((c) => String(r[c[0]] ?? '').toLowerCase().includes(term)));
  if (q.sort && rep.columns.some((c) => c[0] === q.sort)) {
    const dir = String(q.dir).toLowerCase() === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = a[q.sort], y = b[q.sort];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  return { ...rep, rows, totals: rep.totals && !term ? rep.totals : sumCols(rep.columns, rows) };
}
export async function runReport(key, params) {
  const def = REPORTS[key]; if (!def) fail('Unknown report', 404);
  const { from, to } = rangeOf(params);
  const p = { ...params, from: def.params.includes('range') || def.params.includes('asof') || params.from ? from : params.from, to };
  if (!def.params.includes('range') && !params.from) p.from = null;
  const rep = await def.run(p);
  if (!rep.totals && rep.kind === 'table') rep.totals = sumCols(rep.columns, rep.rows);
  return { key, ...rep };
}

export async function assetSummary(asOf = today()) {
  const b = await bsData(asOf); const sub = (list) => r2(b.accts.filter((a) => a.type === 'asset' && list.includes(a.subtype)).reduce((s, a) => s + natural(a, b.m), 0));
  return { total: b.assets, cash: sub(CASH_SUBTYPES), receivable: sub(['receivable']), inventory: sub(['inventory']), fixed: sub(['fixed_asset', 'accum_depr']), other: sub(['tax_receivable', 'other_current', 'other_asset']) };
}
