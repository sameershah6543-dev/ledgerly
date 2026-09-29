// Shared "how much is outstanding" helpers, in both SQL-fragment and JS form.
import { get } from './db.js';
import { r2 } from './util.js';

// SQL fragments (alias must be provided by the caller's FROM clause)
export const SQL = {
  invReceived: (a = 'si') => `(SELECT COALESCE(SUM(amount),0) FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=${a}.id AND r.is_deleted=0)`,
  invCredited: (a = 'si') => `(SELECT COALESCE(SUM(total),0) FROM stock_returns sr WHERE sr.kind='sales' AND sr.settlement='credit' AND sr.ref_id=${a}.id AND sr.is_deleted=0)`,
  revReceived: (a = 're') => `(SELECT COALESCE(SUM(amount),0) FROM receipts r WHERE r.ref_type='revenue' AND r.ref_id=${a}.id AND r.is_deleted=0)`,
  billPaid: (a = 'pi') => `(SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.ref_type='purchase_invoice' AND p.ref_id=${a}.id AND p.is_deleted=0)`,
  billCredited: (a = 'pi') => `(SELECT COALESCE(SUM(total),0) FROM stock_returns sr WHERE sr.kind='purchase' AND sr.settlement='credit' AND sr.ref_id=${a}.id AND sr.is_deleted=0)`,
  expPaid: (a = 'e') => `(CASE WHEN ${a}.mode='paid' THEN ${a}.amount ELSE (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.ref_type='expense' AND p.ref_id=${a}.id AND p.is_deleted=0) END)`,
  liaPaid: (a = 'l') => `(SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.ref_type='liability' AND p.ref_id=${a}.id AND p.is_deleted=0)`,
};

const val = async (sql, id) => r2((await get(sql, id))?.v || 0);
export const invoiceSettled = async (id) => await val(`SELECT ${SQL.invReceived('si')} + ${SQL.invCredited('si')} v FROM sales_invoices si WHERE id=?`, id);
export const invoiceReceived = async (id) => await val(`SELECT ${SQL.invReceived('si')} v FROM sales_invoices si WHERE id=?`, id);
export const revenueReceived = async (id) => await val(`SELECT ${SQL.revReceived('re')} v FROM revenue_entries re WHERE id=?`, id);
export const billSettled = async (id) => await val(`SELECT ${SQL.billPaid('pi')} + ${SQL.billCredited('pi')} v FROM purchase_invoices pi WHERE id=?`, id);
export const expensePaidOf = async (id) => await val(`SELECT ${SQL.expPaid('e')} v FROM expenses e WHERE id=?`, id);
export const liabilityPaidOf = async (id) => await val(`SELECT ${SQL.liaPaid('l')} v FROM liabilities l WHERE id=?`, id);

// ---------------------------------------------------------------------------
// Guards / lookups used by every document module
// ---------------------------------------------------------------------------
import { insert } from './db.js';
import { fail } from './util.js';
import { accountBalance, getAccount } from './coa.js';
import { getSetting } from './db.js';

export async function party(idv, kind, label = 'Party') {
  const p = await get('SELECT * FROM parties WHERE id=? AND is_deleted=0', idv);
  if (!p) fail(`${label} not found`);
  if (kind && p.kind !== kind) fail(`${label} must be a ${kind}`);
  return p;
}
export async function moneyAcc(idv, label = 'Account') {
  const m = await get('SELECT * FROM money_accounts WHERE id=?', idv);
  if (!m) fail(`${label} not found`);
  if (!m.active) fail(`${label} "${m.name}" is inactive`);
  return m;
}
export async function categoryAccount(catId, kind, label = 'Category') {
  const c = await get('SELECT * FROM categories WHERE id=? AND kind=?', catId, kind);
  if (!c) fail(`${label} not found`);
  if (!c.account_id) fail(`${label} "${c.name}" is not linked to a ledger account`);
  return { category: c, accountId: c.account_id };
}
export async function accountOfType(idv, types, label = 'Account') {
  const a = await getAccount(idv);
  if (!a) fail(`${label} not found`);
  if (!a.active) fail(`${label} "${a.name}" is inactive`);
  if (types && !types.includes(a.type)) fail(`${label} must be a ${types.join(' / ')} account`);
  return a;
}
// Cash / bank / wallet accounts may not be overdrawn (setting: block_negative_cash).
export async function assertMoneyOk(idv) {
  if (!idv || getSetting('block_negative_cash', '1') !== '1') return;
  const m = await get('SELECT * FROM money_accounts WHERE id=?', idv);
  if (!m || m.kind === 'credit_card') return;
  const bal = await accountBalance(m.account_id);
  if (bal < -0.005) fail(`Insufficient balance in "${m.name}" - this would leave it at ${bal.toFixed(2)}`);
}
export async function findOrCreateSupplier(name, create = true) {
  const n = String(name || '').trim();
  if (!n) return null;
  const p = await get("SELECT * FROM parties WHERE kind='supplier' AND lower(name)=lower(?) AND is_deleted=0", n);
  if (p) return p;
  if (!create) return null;
  return await get('SELECT * FROM parties WHERE id=?', await insert('parties', { kind: 'supplier', name: n }));
}
export async function walkInCustomer() {
  let p = await get("SELECT * FROM parties WHERE kind='customer' AND name='Walk-in Customer'");
  if (!p) p = await get('SELECT * FROM parties WHERE id=?', await insert('parties', { kind: 'customer', name: 'Walk-in Customer' }));
  return p;
}
