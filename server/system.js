// Authentication, users, settings, uploads, global search, audit trail, trash, integrity checks.
import crypto from 'node:crypto';
import { all, get, run, insert, update, setSetting, getSettings, tx } from './db.js';
import { fail, r2, str, reqStr, listQuery, oneOf, NUMBER_KEYS, defaultFmt, peekNumber, today, cents } from './util.js';
import { docs } from './docs.js';
import { audit } from './posting.js';
import { sys } from './coa.js';
import { trialBalance, bsData, cashFlow, openItems, rangeOf, glSums } from './reports.js';
import { fyStart } from './util.js';

// ---------------- passwords & sessions ----------------
export function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verify(pw, user) {
  const h = crypto.scryptSync(pw, user.salt, 64);
  const b = Buffer.from(user.password_hash, 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}
export function checkPasswordStrength(pw) {
  if (!pw || pw.length < 8) fail('Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail('Password must contain letters and numbers');
}
export async function createUser({ username, name, role = 'admin', password }) {
  username = reqStr(username, 'Username').toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) fail('Username must be 3-30 characters (letters, numbers, . _ -)');
  oneOf(role, ['admin', 'accountant', 'viewer'], 'Role');
  checkPasswordStrength(password);
  if (await get('SELECT id FROM users WHERE username=?', username)) fail('That username is already taken');
  const { salt, hash } = hashPassword(password);
  return await insert('users', { username, name: str(name) || username, role, password_hash: hash, salt });
}
const attempts = new Map();
export async function login(username, password) {
  const key = String(username || '').toLowerCase();
  const a = attempts.get(key);
  if (a && a.until > Date.now()) fail(`Too many failed attempts. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} minute(s).`, 429);
  const u = await get('SELECT * FROM users WHERE username=? AND active=1', key);
  if (!u || !verify(String(password || ''), u)) {
    const n = (a?.count || 0) + 1; attempts.set(key, { count: n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
    fail('Invalid username or password', 401);
  }
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  await run('DELETE FROM sessions WHERE expires_at<?', Date.now());
  await run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', token, u.id, Date.now() + 7 * 86400000);
  return { token, user: publicUser(u) };
}
export const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });
export async function userFromToken(token) {
  if (!token) return null;
  const s = await get('SELECT * FROM sessions WHERE token=? AND expires_at>?', token, Date.now());
  if (!s) return null;
  const u = await get('SELECT * FROM users WHERE id=? AND active=1', s.user_id);
  return u ? publicUser(u) : null;
}
export const logout = async (token) => await run('DELETE FROM sessions WHERE token=?', token);
export async function changePassword(userId, current, next) {
  const u = await get('SELECT * FROM users WHERE id=?', userId);
  if (!verify(String(current || ''), u)) fail('Current password is incorrect');
  checkPasswordStrength(next);
  const { salt, hash } = hashPassword(next);
  await update('users', userId, { salt, password_hash: hash });
}
export async function listUsers() { return await all('SELECT id,username,name,role,active,created_at FROM users ORDER BY id'); }
export async function saveUser(b, idOrNull, me) {
  if (!idOrNull) { const id = await createUser(b); return (await listUsers()).find((u) => u.id === id); }
  const u = await get('SELECT * FROM users WHERE id=?', idOrNull); if (!u) fail('User not found', 404);
  const row = { name: str(b.name) || u.username, role: oneOf(b.role || u.role, ['admin', 'accountant', 'viewer'], 'Role'), active: b.active === false || b.active === 0 ? 0 : 1 };
  if (u.id === me.id && (row.role !== 'admin' || !row.active)) fail('You cannot remove your own admin access');
  if (b.password) { checkPasswordStrength(b.password); const { salt, hash } = hashPassword(b.password); row.salt = salt; row.password_hash = hash; }
  await update('users', u.id, row);
  if (!row.active) await run('DELETE FROM sessions WHERE user_id=?', u.id);
  return (await listUsers()).find((x) => x.id === u.id);
}

// ---------------- settings ----------------
const SETTING_KEYS = ['business_name', 'business_address', 'business_phone', 'business_email', 'business_website', 'business_tax_no', 'business_logo', 'currency_code', 'currency_symbol',
  'date_format', 'fy_start_month', 'tax_enabled', 'tax_name', 'tax_rate', 'default_due_days', 'block_negative_cash', ...NUMBER_KEYS.map((k) => `fmt_${k}`)];
export async function publicSettings() {
  const s = getSettings(); const out = {};
  for (const k of SETTING_KEYS) out[k] = s[k] ?? '';
  for (const k of NUMBER_KEYS) { if (!out[`fmt_${k}`]) out[`fmt_${k}`] = defaultFmt(k); out[`next_${k}`] = await peekNumber(k); }
  return out;
}
export async function saveSettings(b) {
  const v = { ...b };
  if ('fy_start_month' in v) { const m = Number(v.fy_start_month); if (!(m >= 1 && m <= 12)) fail('Financial year start month is invalid'); }
  if ('tax_rate' in v) { const t = Number(v.tax_rate); if (!(t >= 0 && t <= 100)) fail('Tax rate must be between 0 and 100'); }
  if ('default_due_days' in v && !(Number(v.default_due_days) >= 0)) fail('Default due days is invalid');
  if ('currency_code' in v && !/^[A-Za-z]{3}$/.test(v.currency_code)) fail('Currency code must be 3 letters');
  if ('date_format' in v) oneOf(v.date_format, ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY'], 'Date format');
  for (const k of NUMBER_KEYS) if (`fmt_${k}` in v && !/\{0{2,}\}/.test(v[`fmt_${k}`])) fail(`Number format for ${k} must contain a counter such as {0000}`);
  if ('business_name' in v && !String(v.business_name).trim()) fail('Business name is required');
  await tx(async () => { for (const k of SETTING_KEYS) if (k in v) await setSetting(k, typeof v[k] === 'boolean' ? (v[k] ? '1' : '0') : v[k]); });
  return await publicSettings();
}

// ---------------- global search ----------------
export async function globalSearch(q) {
  q = String(q || '').trim(); if (q.length < 1) return [];
  const like = `%${q}%`; const numeric = /^-?[\d,]+(\.\d+)?$/.test(q) ? Number(q.replace(/,/g, '')) : null;
  let dateIso = null;
  const m1 = q.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); if (m1) dateIso = `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) dateIso = q;
  const out = [];
  const add = async (group, sql, mk, params) => { try { for (const r of await all(sql, ...params)) out.push({ group, ...mk(r) }); } catch (e) { /* ignore a failing group */ } };
  const amt = (col) => (numeric !== null ? ` OR ${col}=${Number(numeric)}` : '');
  const dt = (col) => (dateIso ? ` OR ${col}='${dateIso}'` : '');
  const del = (a) => `${a}.is_deleted=0`;
  await add('Sales Invoices', `SELECT si.id, si.number, p.name party, si.total, si.date FROM sales_invoices si JOIN parties p ON p.id=si.customer_id WHERE ${del('si')} AND (si.number LIKE ? OR p.name LIKE ?${amt('si.total')}${dt('si.date')}) ORDER BY si.date DESC LIMIT 6`,
    (r) => ({ title: r.number, subtitle: r.party, amount: r.total, date: r.date, route: `#/sales/invoices?open=${r.id}` }), [like, like]);
  await add('Purchase Invoices', `SELECT pi.id, pi.number, p.name party, pi.total, pi.date FROM purchase_invoices pi JOIN parties p ON p.id=pi.supplier_id WHERE ${del('pi')} AND (pi.number LIKE ? OR p.name LIKE ? OR pi.reference LIKE ?${amt('pi.total')}${dt('pi.date')}) ORDER BY pi.date DESC LIMIT 6`,
    (r) => ({ title: r.number, subtitle: r.party, amount: r.total, date: r.date, route: `#/purchases/bills?open=${r.id}` }), [like, like, like]);
  await add('Receipts', `SELECT r.id, r.number, COALESCE(p.name, r.source_name) party, r.amount, r.date FROM receipts r LEFT JOIN parties p ON p.id=r.customer_id WHERE ${del('r')} AND (r.number LIKE ? OR p.name LIKE ? OR r.description LIKE ?${amt('r.amount')}${dt('r.date')}) ORDER BY r.date DESC LIMIT 5`,
    (r) => ({ title: r.number, subtitle: r.party, amount: r.amount, date: r.date, route: `#/sales/receipts?open=${r.id}` }), [like, like, like]);
  await add('Payments', `SELECT r.id, r.number, r.payee_name party, r.amount, r.date FROM payments r WHERE ${del('r')} AND (r.number LIKE ? OR r.payee_name LIKE ? OR r.description LIKE ?${amt('r.amount')}${dt('r.date')}) ORDER BY r.date DESC LIMIT 5`,
    (r) => ({ title: r.number, subtitle: r.party, amount: r.amount, date: r.date, route: `#/purchases/payments?open=${r.id}` }), [like, like, like]);
  await add('Expenses', `SELECT e.id, e.number, e.vendor_name, c.name cat, e.amount, e.date FROM expenses e JOIN categories c ON c.id=e.category_id WHERE ${del('e')} AND (e.number LIKE ? OR e.vendor_name LIKE ? OR e.description LIKE ? OR e.invoice_ref LIKE ? OR c.name LIKE ?${amt('e.amount')}${dt('e.date')}) ORDER BY e.date DESC LIMIT 5`,
    (r) => ({ title: r.number, subtitle: `${r.cat}${r.vendor_name ? ' - ' + r.vendor_name : ''}`, amount: r.amount, date: r.date, route: `#/accounting/expenses?open=${r.id}` }), [like, like, like, like, like]);
  await add('Revenue', `SELECT e.id, e.number, p.name party, e.amount, e.date FROM revenue_entries e JOIN parties p ON p.id=e.customer_id WHERE ${del('e')} AND (e.number LIKE ? OR p.name LIKE ? OR e.description LIKE ? OR e.reference LIKE ?${amt('e.amount')}${dt('e.date')}) ORDER BY e.date DESC LIMIT 4`,
    (r) => ({ title: r.number, subtitle: r.party, amount: r.amount, date: r.date, route: `#/accounting/revenue?open=${r.id}&src=revenue` }), [like, like, like, like]);
  await add('Transfers', `SELECT t.id, t.number, f.name a, o.name b, t.amount, t.date FROM transfers t JOIN money_accounts f ON f.id=t.from_account_id JOIN money_accounts o ON o.id=t.to_account_id WHERE ${del('t')} AND (t.number LIKE ? OR t.reference LIKE ? OR f.name LIKE ? OR o.name LIKE ?${amt('t.amount')}${dt('t.date')}) ORDER BY t.date DESC LIMIT 4`,
    (r) => ({ title: r.number, subtitle: `${r.a} → ${r.b}`, amount: r.amount, date: r.date, route: `#/banking/transfers?open=${r.id}` }), [like, like, like, like]);
  await add('Capital', `SELECT c.id, c.number, c.investor, c.amount, c.date FROM capital_transactions c WHERE ${del('c')} AND (c.number LIKE ? OR c.investor LIKE ? OR c.reference LIKE ?${amt('c.amount')}${dt('c.date')}) LIMIT 4`,
    (r) => ({ title: r.number, subtitle: r.investor, amount: r.amount, date: r.date, route: `#/accounting/capital?open=${r.id}` }), [like, like, like]);
  await add('Liabilities', `SELECT l.id, l.number, l.name, l.creditor, l.original_amount amt, l.date FROM liabilities l WHERE ${del('l')} AND (l.name LIKE ? OR l.creditor LIKE ? OR l.number LIKE ?${amt('l.original_amount')}) LIMIT 4`,
    (r) => ({ title: r.name, subtitle: r.creditor, amount: r.amt, date: r.date, route: `#/accounting/liabilities?open=${r.id}` }), [like, like, like]);
  await add('Assets', `SELECT a.id, a.number, a.name, a.supplier, a.purchase_value amt, a.purchase_date date FROM assets a WHERE ${del('a')} AND (a.name LIKE ? OR a.number LIKE ? OR a.reference LIKE ? OR a.supplier LIKE ?${amt('a.purchase_value')}) LIMIT 4`,
    (r) => ({ title: r.name, subtitle: r.number, amount: r.amt, date: r.date, route: `#/accounting/assets?open=${r.id}` }), [like, like, like, like]);
  await add('Customers', `SELECT id, name, phone, email FROM parties WHERE kind='customer' AND is_deleted=0 AND (name LIKE ? OR phone LIKE ? OR email LIKE ?) LIMIT 5`,
    (r) => ({ title: r.name, subtitle: [r.phone, r.email].filter(Boolean).join(' · '), route: `#/sales/customers?open=${r.id}` }), [like, like, like]);
  await add('Suppliers', `SELECT id, name, phone, email FROM parties WHERE kind='supplier' AND is_deleted=0 AND (name LIKE ? OR phone LIKE ? OR email LIKE ?) LIMIT 5`,
    (r) => ({ title: r.name, subtitle: [r.phone, r.email].filter(Boolean).join(' · '), route: `#/purchases/suppliers?open=${r.id}` }), [like, like, like]);
  await add('Products', `SELECT id, name, sku FROM items WHERE is_deleted=0 AND (name LIKE ? OR sku LIKE ?) LIMIT 5`, (r) => ({ title: r.name, subtitle: r.sku, route: `#/accounting/stock?open=${r.id}` }), [like, like]);
  await add('Accounts', `SELECT id, code, name FROM accounts WHERE code LIKE ? OR name LIKE ? LIMIT 5`, (r) => ({ title: `${r.code} ${r.name}`, subtitle: 'Chart of accounts', route: `#/accounting/coa?ledger=${r.id}` }), [like, like]);
  await add('Cash & Bank', `SELECT id, name, kind FROM money_accounts WHERE name LIKE ? OR account_no LIKE ? LIMIT 4`, (r) => ({ title: r.name, subtitle: r.kind, route: `#/banking/accounts?open=${r.id}` }), [like, like]);
  await add('Categories', `SELECT id, name, kind FROM categories WHERE name LIKE ? LIMIT 5`, (r) => ({ title: r.name, subtitle: `${r.kind} category`, route: `#/settings?tab=categories` }), [like]);
  await add('Journal', `SELECT id, entry_no, memo, date FROM journal_entries WHERE status='posted' AND (entry_no LIKE ? OR memo LIKE ?${dt('date')}) ORDER BY date DESC LIMIT 4`, (r) => ({ title: r.entry_no, subtitle: r.memo, date: r.date, route: `#/accounting/journal?q=${encodeURIComponent(r.entry_no)}` }), [like, like]);
  return out;
}

// ---------------- audit & trash ----------------
const ENTITY_LABEL = {
  sales_invoices: 'Invoice', purchase_invoices: 'Purchase invoice', receipts: 'Receipt', payments: 'Payment', expenses: 'Expense', revenue_entries: 'Revenue', liabilities: 'Liability',
  capital_transactions: 'Capital', assets: 'Asset', asset_depreciations: 'Depreciation', transfers: 'Transfer', stock_returns: 'Stock return', stock_adjustments: 'Stock adjustment',
  items: 'Product', parties: 'Customer / Supplier', money_accounts: 'Cash / Bank account', categories: 'Category', accounts: 'Account',
};
export async function auditList(q) {
  const base = `SELECT id, at, user, entity, entity_id, ref, action, old_amount, new_amount, changes FROM audit_log`;
  const r = await listQuery(base, [], { ...q, filters: undefined }, {
    columns: [['at', 'When'], ['user', 'User'], ['entity_label', 'Record'], ['ref', 'Reference'], ['action', 'Action', 'badge'], ['old_amount', 'Original Amount', 'money'], ['new_amount', 'Updated Amount', 'money']],
    search: ['ref', 'user', 'entity', 'action', 'changes'], filters: ['entity', 'entity_id', 'action', 'user'], sortable: ['at', 'user', 'entity', 'ref', 'action'], defaultSort: 'at',
  });
  r.rows.forEach((x) => { x.entity_label = ENTITY_LABEL[x.entity] || x.entity; x.changes = x.changes ? JSON.parse(x.changes) : null; });
  return r;
}
export async function auditFor(entity, id) {
  const rows = (await all('SELECT * FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC', entity, id)).map((x) => ({ ...x, changes: x.changes ? JSON.parse(x.changes) : null }));
  const t = Object.values(docs).find((d) => d.table === entity);
  const rec = t ? await get(`SELECT created_at, created_by, updated_at, updated_by FROM ${entity} WHERE id=?`, id) : null;
  return { rows, record: rec };
}
export async function trashList(q) {
  const parts = Object.values(docs).filter((d) => d.table !== 'asset_depreciations').map((d) =>
    `SELECT '${d.key}' AS key, '${d.label}' AS type, id, ${d.numberField || 'number'} AS ref, ${d.amountField} AS amount, deleted_at, deleted_by FROM ${d.table} WHERE is_deleted=1`);
  return await listQuery(parts.join(' UNION ALL '), [], q, {
    columns: [['type', 'Type'], ['ref', 'Reference'], ['amount', 'Amount', 'money'], ['deleted_at', 'Deleted On'], ['deleted_by', 'Deleted By']],
    search: ['ref', 'type', 'deleted_by'], sortable: ['type', 'ref', 'amount', 'deleted_at'], defaultSort: 'deleted_at',
  });
}

// ---------------- integrity ----------------
export async function integrity() {
  const checks = []; const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const bad = await all(`SELECT je.entry_no, ROUND(SUM(jl.debit)-SUM(jl.credit),2) diff FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id WHERE je.status='posted' GROUP BY je.id HAVING ABS(SUM(jl.debit)-SUM(jl.credit))>0.005`);
  await add('Every journal entry balances (debits = credits)', bad.length === 0, bad.length ? `${bad.length} unbalanced: ${bad.slice(0, 3).map((b) => b.entry_no).join(', ')}` : 'All entries balanced');
  const t = await get(`SELECT COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.status='posted'`);
  await add('General ledger: total debits = total credits', cents(t.d) === cents(t.c), `Debits ${r2(t.d)} / Credits ${r2(t.c)}`);
  const to = today(); const tb = await trialBalance({ from: fyStart(to), to });
  await add('Trial balance is balanced', tb.data.balanced, `Debit ${tb.data.debit} / Credit ${tb.data.credit}`);
  const bs = await bsData(to);
  await add('Balance sheet: Assets = Liabilities + Equity', Math.abs(bs.assets - bs.liabilities - bs.equity) < 0.005, `${bs.assets} = ${bs.liabilities} + ${bs.equity}`);
  const inv = r2((await get('SELECT COALESCE(SUM(value),0) v FROM stock_movements')).v);
  const invGl = r2((await get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.status='posted' AND jl.account_id=?`, sys('INVENTORY'))).v);
  await add('Inventory ledger = stock valuation', Math.abs(inv - invGl) < 0.005, `Stock ${inv} / GL ${invGl}`);
  for (const [k, ctrl, label] of [['customer', 'AR', 'Accounts Receivable'], ['supplier', 'AP', 'Accounts Payable']]) {
    const sub = r2((await openItems(k)).reduce((s, i) => s + i.outstanding, 0));
    const gl = r2((await get(`SELECT COALESCE(SUM(jl.${k === 'customer' ? 'debit-jl.credit' : 'credit-jl.debit'}),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.status='posted' AND jl.account_id=?`, sys(ctrl))).v);
    await add(`${label} sub-ledger = control account`, Math.abs(sub - gl) < 0.005, `Open items ${sub} / GL ${gl}`);
  }
  const negStock = await all('SELECT i.name FROM items i WHERE (SELECT COALESCE(SUM(qty),0) FROM stock_movements WHERE item_id=i.id) < -0.0000001');
  await add('No negative stock', negStock.length === 0, negStock.length ? negStock.map((x) => x.name).join(', ') : 'OK');
  const cf = await cashFlow({ from: fyStart(to), to });
  await add('Cash flow statement agrees with cash & bank ledgers', cf.data.ok, `Closing ${cf.data.closing}`);
  return { ok: checks.every((c) => c.ok), checks };
}

// Full data export (every table except logins/sessions) as JSON - works for local and Turso databases.
export async function exportAll() {
  const tables = (await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('users','sessions') ORDER BY name")).map((t) => t.name);
  const out = { app: 'ledgerly', exported_at: new Date().toISOString(), tables: {} };
  for (const t of tables) out.tables[t] = await all(`SELECT * FROM ${t}`);
  return out;
}
