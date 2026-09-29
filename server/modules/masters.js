// Master data: cash/bank accounts, parties (customers/suppliers), categories, chart of accounts, GL lines.
import { all, get, run, insert, update, tx } from '../db.js';
import { mapSeq, fail, r2, num, str, reqStr, oneOf, id as idv, isoDate, listQuery, today, fyStart } from '../util.js';
import { sys, createAccount, getAccount, resetAccountCache, SUBTYPES, TYPES, SUBTYPE_LABEL, accountBalance, isDebitNormal } from '../coa.js';
import { postEntry, voidEntry, audit, diffRows } from '../posting.js';
import { assertMoneyOk } from '../finance.js';

// ---------------------------------------------------------------------------
// Cash & bank accounts
// ---------------------------------------------------------------------------
const GL_SUBTYPE = { cash: 'cash', bank: 'bank', wallet: 'wallet', other: 'bank', credit_card: 'credit_card' };
async function postOpeningBalance(m, user) {
  const amt = r2(m.opening_balance);
  const gl = m.account_id;
  const lines = m.kind === 'credit_card'
    ? [{ account: sys('OBE'), debit: amt }, { account: gl, credit: amt }]
    : [{ account: gl, debit: amt }, { account: sys('OBE'), credit: amt }];
  await postEntry({ sourceType: 'opening_money', sourceId: m.id, date: m.opening_date, memo: `Opening balance - ${m.name}`, lines, user });
}
export async function saveMoneyAccount(b, idOrNull, user) {
  return await tx(async () => {
    const old = idOrNull ? await get('SELECT * FROM money_accounts WHERE id=?', idOrNull) : null;
    if (idOrNull && !old) fail('Account not found', 404);
    const name = reqStr(b.name, 'Account name');
    if (await get('SELECT id FROM money_accounts WHERE lower(name)=lower(?) AND id<>?', name, idOrNull || 0)) fail(`An account named "${name}" already exists`);
    const kind = oneOf(b.kind || old?.kind, ['cash', 'bank', 'credit_card', 'wallet', 'other'], 'Account type');
    const opening = num(b.opening_balance, 'Opening balance', { min: 0 });
    const row = { name, kind, opening_balance: opening, opening_date: isoDate(b.opening_date || old?.opening_date || fyStart(today()), 'Opening date'), account_no: str(b.account_no), notes: str(b.notes), active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1 };
    let id;
    if (!old) {
      const glType = kind === 'credit_card' ? 'liability' : 'asset';
      row.account_id = await createAccount({ name, type: glType, subtype: GL_SUBTYPE[kind], description: `Ledger for ${name}` });
      id = await insert('money_accounts', row);
    } else {
      if (kind !== old.kind && await get('SELECT id FROM journal_lines WHERE account_id=? LIMIT 1', old.account_id) && (kind === 'credit_card' || old.kind === 'credit_card')) fail('The account type cannot be changed to/from Credit Card after it has transactions');
      await update('money_accounts', old.id, row); id = old.id;
      await run('UPDATE accounts SET name=? WHERE id=?', name, old.account_id);
      if (['cash', 'bank', 'wallet', 'other'].includes(kind) && old.kind !== 'credit_card') await run('UPDATE accounts SET subtype=? WHERE id=?', GL_SUBTYPE[kind], old.account_id);
    }
    const fresh = await get('SELECT * FROM money_accounts WHERE id=?', id);
    await postOpeningBalance(fresh, user);
    await assertMoneyOk(id);
    await audit({ entity: 'money_accounts', entityId: id, ref: name, action: old ? 'updated' : 'created', user, oldAmount: old?.opening_balance ?? null, newAmount: opening, changes: old ? diffRows(old, fresh) : null });
    return await moneyAccountRow(id);
  });
}
export async function deleteMoneyAccount(id, user) {
  return await tx(async () => {
    const m = await get('SELECT * FROM money_accounts WHERE id=?', id);
    if (!m) fail('Account not found', 404);
    const other = (await get(`SELECT COUNT(*) n FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=? AND je.source_type<>'opening_money'`, m.account_id)).n;
    const docs = (await get(`SELECT (SELECT COUNT(*) FROM receipts WHERE money_account_id=@i) + (SELECT COUNT(*) FROM payments WHERE money_account_id=@i) + (SELECT COUNT(*) FROM expenses WHERE money_account_id=@i)
      + (SELECT COUNT(*) FROM transfers WHERE from_account_id=@i OR to_account_id=@i) + (SELECT COUNT(*) FROM capital_transactions WHERE money_account_id=@i) n`.replaceAll('@i', Number(id)))).n;
    if (other || docs) fail('This account has transactions. Mark it inactive instead of deleting it.');
    await run("DELETE FROM journal_entries WHERE source_type='opening_money' AND source_id=?", id);
    await run('DELETE FROM money_accounts WHERE id=?', id);
    await run('DELETE FROM accounts WHERE id=?', m.account_id); await resetAccountCache();
    await audit({ entity: 'money_accounts', entityId: id, ref: m.name, action: 'deleted', user });
    return { ok: true };
  });
}
export async function moneyAccountRow(id, { from = null, to = null } = {}) {
  return (await moneyAccountsList({ from, to })).find((r) => r.id === Number(id));
}
// Period figures come straight from the general ledger so they always agree with the Trial Balance.
export async function moneyAccountsList({ from = null, to = null } = {}) {
  const f = from || '0000-01-01', t = to || '9999-12-31';
  return mapSeq(await all('SELECT * FROM money_accounts ORDER BY active DESC, kind, name'), async (m) => {
    const g = async (extra, ...p) => await get(`SELECT COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE jl.account_id=? AND je.status='posted' ${extra}`, m.account_id, ...p);
    const before = from ? await g('AND je.date<?', from) : { d: 0, c: 0 };
    const inn = await g("AND je.date BETWEEN ? AND ? AND je.source_type NOT IN ('opening_money','transfer')", f, t);
    const tr = await g("AND je.date BETWEEN ? AND ? AND je.source_type='transfer'", f, t);
    const open = await g("AND je.date BETWEEN ? AND ? AND je.source_type='opening_money'", f, t);
    const bal = await g('AND je.date<=?', t);
    // opening = balance at the start of the period (plus the account's own opening entry if it falls inside the period)
    const opening = from ? r2(before.d - before.c + open.d - open.c) : r2(open.d - open.c);
    return {
      ...m, opening, money_in: r2(inn.d), money_out: r2(inn.c),
      transfers_in: r2(tr.d), transfers_out: r2(tr.c), balance: r2(bal.d - bal.c),
    };
  });
}

// ---------------------------------------------------------------------------
// Parties (customers & suppliers)
// ---------------------------------------------------------------------------
export async function saveParty(kind, b, idOrNull, user) {
  return await tx(async () => {
    const old = idOrNull ? await get('SELECT * FROM parties WHERE id=? AND kind=? AND is_deleted=0', idOrNull, kind) : null;
    if (idOrNull && !old) fail('Not found', 404);
    const name = reqStr(b.name, 'Name');
    if (await get('SELECT id FROM parties WHERE kind=? AND lower(name)=lower(?) AND id<>? AND is_deleted=0', kind, name, idOrNull || 0)) fail(`A ${kind} named "${name}" already exists`);
    const email = str(b.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Email address is not valid');
    const row = { kind, name, email, phone: str(b.phone), address: str(b.address), tax_no: str(b.tax_no), notes: str(b.notes), active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1 };
    let id; if (old) { await update('parties', old.id, row); id = old.id; } else id = await insert('parties', row);
    await audit({ entity: 'parties', entityId: id, ref: name, action: old ? 'updated' : 'created', user, changes: old ? diffRows(old, await get('SELECT * FROM parties WHERE id=?', id)) : null });
    return (await partyList({ kind, size: 'all' })).rows.find((r) => r.id === id);
  });
}
export async function deleteParty(id, user) {
  const p = await get('SELECT * FROM parties WHERE id=? AND is_deleted=0', id);
  if (!p) fail('Not found', 404);
  if (await get('SELECT id FROM journal_lines WHERE party_id=? LIMIT 1', id) || await get('SELECT id FROM sales_invoices WHERE customer_id=? AND is_deleted=0 UNION SELECT id FROM purchase_invoices WHERE supplier_id=? AND is_deleted=0 LIMIT 1', id, id))
    fail(`This ${p.kind} has transactions and cannot be deleted. Mark them inactive instead.`);
  await run('UPDATE parties SET is_deleted=1 WHERE id=?', id);
  await audit({ entity: 'parties', entityId: id, ref: p.name, action: 'deleted', user });
  return { ok: true };
}
export async function partyList(q) {
  const kind = q.kind === 'supplier' ? 'supplier' : 'customer';
  const ctrl = kind === 'customer' ? 'AR' : 'AP';
  const bal = kind === 'customer' ? 'COALESCE(SUM(jl.debit-jl.credit),0)' : 'COALESCE(SUM(jl.credit-jl.debit),0)';
  const base = `SELECT p.id, p.name, p.email, p.phone, p.address, p.tax_no, p.notes, p.active,
    (SELECT ${bal} FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.party_id=p.id AND jl.account_id=${sys(ctrl)} AND je.status='posted') AS balance,
    ${kind === 'customer'
      ? "(SELECT COALESCE(SUM(total),0) FROM sales_invoices WHERE customer_id=p.id AND state='sent' AND is_deleted=0)"
      : "(SELECT COALESCE(SUM(total),0) FROM purchase_invoices WHERE supplier_id=p.id AND state='posted' AND is_deleted=0)"} AS total_billed
    FROM parties p WHERE p.kind='${kind}' AND p.is_deleted=0`;
  return await listQuery(base, [], q, {
    columns: [['name', kind === 'customer' ? 'Customer' : 'Supplier'], ['phone', 'Phone'], ['email', 'Email'], ['tax_no', 'Tax No.'], ['total_billed', kind === 'customer' ? 'Total Invoiced' : 'Total Purchased', 'money'], ['balance', kind === 'customer' ? 'Receivable' : 'Payable', 'money']],
    search: ['name', 'phone', 'email', 'tax_no', 'address'], filters: ['active'], sortable: ['name', 'phone', 'email', 'total_billed', 'balance'], defaultSort: 'name', defaultDir: 'ASC', sums: ['balance', 'total_billed'],
  });
}

// ---------------------------------------------------------------------------
// Categories (each expense/revenue/asset/liability category is backed by a ledger account)
// ---------------------------------------------------------------------------
const CAT_ACCOUNT = { expense: ['expense', 'opex'], revenue: ['revenue', 'other_revenue'], asset: ['asset', 'fixed_asset'], liability: ['liability', 'other_liability'] };
export async function listCategories(kind) {
  return await all(`SELECT c.*, a.code AS account_code, a.name AS account_name,
    (CASE c.kind WHEN 'expense' THEN (SELECT COUNT(*) FROM expenses WHERE category_id=c.id AND is_deleted=0)
      WHEN 'revenue' THEN (SELECT COUNT(*) FROM revenue_entries WHERE category_id=c.id AND is_deleted=0)
      WHEN 'asset' THEN (SELECT COUNT(*) FROM assets WHERE category_id=c.id AND is_deleted=0)
      WHEN 'liability' THEN (SELECT COUNT(*) FROM liabilities WHERE category_id=c.id AND is_deleted=0)
      ELSE (SELECT COUNT(*) FROM items WHERE category_id=c.id AND is_deleted=0) END) AS used
    FROM categories c LEFT JOIN accounts a ON a.id=c.account_id ${kind ? 'WHERE c.kind=?' : ''} ORDER BY c.kind, c.name`, ...(kind ? [kind] : []));
}
export async function saveCategory(b, idOrNull, user) {
  return await tx(async () => {
    const old = idOrNull ? await get('SELECT * FROM categories WHERE id=?', idOrNull) : null;
    if (idOrNull && !old) fail('Category not found', 404);
    const kind = old?.kind || oneOf(b.kind, ['expense', 'revenue', 'product', 'asset', 'liability'], 'Category type');
    const name = reqStr(b.name, 'Category name');
    if (await get('SELECT id FROM categories WHERE kind=? AND lower(name)=lower(?) AND id<>?', kind, name, idOrNull || 0)) fail(`Category "${name}" already exists`);
    const active = b.active === false || b.active === 0 || b.active === '0' ? 0 : 1;
    let id;
    if (!old) {
      let accountId = null;
      if (kind !== 'product') {
        if (b.account_id) accountId = (await getAccount(idv(b.account_id, 'Account')))?.id;
        else { const [type, subtype] = CAT_ACCOUNT[kind]; accountId = await createAccount({ name, type, subtype, description: `${kind} category` }); }
      }
      id = await insert('categories', { kind, name, account_id: accountId, active });
    } else {
      await update('categories', old.id, { name, active }); id = old.id;
      const acc = old.account_id ? await getAccount(old.account_id) : null;
      if (acc && !acc.is_system && acc.name === old.name) await run('UPDATE accounts SET name=? WHERE id=?', name, acc.id);
    }
    await audit({ entity: 'categories', entityId: id, ref: name, action: old ? 'updated' : 'created', user });
    return (await listCategories()).find((c) => c.id === id);
  });
}
export async function deleteCategory(id, user) {
  const c = (await listCategories()).find((x) => x.id === Number(id));
  if (!c) fail('Category not found', 404);
  if (c.used) fail('This category is used by transactions. Mark it inactive instead.');
  if (c.kind === 'product' && await get('SELECT id FROM items WHERE category_id=?', id)) fail('This category is used by products');
  await run('DELETE FROM categories WHERE id=?', id);
  await audit({ entity: 'categories', entityId: id, ref: c.name, action: 'deleted', user });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------
export async function listAccounts({ q, type, active } = {}) {
  const rows = await all(`SELECT a.*, COALESCE(g.d,0) AS debit, COALESCE(g.c,0) AS credit,
    (SELECT COUNT(*) FROM journal_lines WHERE account_id=a.id) AS postings,
    (SELECT id FROM money_accounts WHERE account_id=a.id) AS money_account_id
    FROM accounts a LEFT JOIN (SELECT jl.account_id, SUM(jl.debit) d, SUM(jl.credit) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.status='posted' GROUP BY jl.account_id) g ON g.account_id=a.id
    ORDER BY a.code`);
  return rows.filter((a) => (!type || a.type === type) && (active === undefined || active === '' || String(a.active) === String(active)) &&
    (!q || `${a.code} ${a.name} ${a.subtype}`.toLowerCase().includes(String(q).toLowerCase()))).map((a) => ({
    ...a, subtype_label: SUBTYPE_LABEL[a.subtype], balance: r2(isDebitNormal(a) ? a.debit - a.credit : a.credit - a.debit),
  }));
}
export async function saveAccount(b, idOrNull, user) {
  return await tx(async () => {
    const old = idOrNull ? await getAccount(idOrNull) : null;
    if (idOrNull && !old) fail('Account not found', 404);
    let id;
    if (!old) {
      id = await createAccount({ code: b.code, name: b.name, type: b.type, subtype: b.subtype, description: str(b.description) });
    } else {
      const name = reqStr(b.name, 'Account name');
      const code = reqStr(b.code, 'Account code');
      if (await get('SELECT id FROM accounts WHERE code=? AND id<>?', code, old.id)) fail(`Account code ${code} already exists`);
      const posted = await get('SELECT id FROM journal_lines WHERE account_id=? LIMIT 1', old.id);
      let { type, subtype } = old;
      if (!old.is_system && !await get('SELECT id FROM money_accounts WHERE account_id=?', old.id)) {
        const nt = b.type || old.type, ns = b.subtype || old.subtype;
        if (!TYPES.includes(nt) || !SUBTYPES[nt].includes(ns)) fail('Invalid account type / group');
        if (posted && nt !== old.type) fail('The type of an account with postings cannot be changed');
        type = nt; subtype = ns;
      }
      const active = b.active === false || b.active === 0 || b.active === '0' ? 0 : 1;
      if (!active && old.is_system) fail('System accounts cannot be deactivated');
      if (!active && Math.abs(await accountBalance(old.id)) > 0.005) fail('An account with a balance cannot be deactivated');
      await update('accounts', old.id, { name, code, type, subtype, description: str(b.description), active });
      await resetAccountCache(); id = old.id;
      await audit({ entity: 'accounts', entityId: id, ref: `${code} ${name}`, action: 'updated', user, changes: diffRows(old, await getAccount(id)) });
    }
    if (!old) await audit({ entity: 'accounts', entityId: id, ref: b.name, action: 'created', user });
    return (await listAccounts()).find((a) => a.id === id);
  });
}
export async function deleteAccount(id, user) {
  const a = await getAccount(id);
  if (!a) fail('Account not found', 404);
  if (a.is_system) fail('System accounts cannot be deleted');
  if (await get('SELECT id FROM journal_lines WHERE account_id=? LIMIT 1', id)) fail('This account has postings. Deactivate it instead.');
  if (await get('SELECT id FROM categories WHERE account_id=?', id) || await get('SELECT id FROM money_accounts WHERE account_id=?', id)) fail('This account is linked to a category / cash account. Remove that first.');
  await run('DELETE FROM accounts WHERE id=?', id); await resetAccountCache();
  await audit({ entity: 'accounts', entityId: id, ref: a.name, action: 'deleted', user });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// General ledger lines (running balance) and journal
// ---------------------------------------------------------------------------
export const SOURCE_LABEL = {
  sales_invoice: 'Sales Invoice', purchase_invoice: 'Purchase Invoice', receipt: 'Receipt', payment: 'Payment', expense: 'Expense', revenue: 'Revenue Entry',
  liability: 'Liability', capital: 'Capital', asset: 'Asset Purchase', depreciation: 'Depreciation', asset_disposal: 'Asset Disposal', transfer: 'Transfer',
  stock_return: 'Stock Return', stock_adjustment: 'Stock Adjustment', opening_stock: 'Opening Stock', opening_money: 'Opening Balance',
};
export async function accountLedger(accountId, q) {
  const a = await getAccount(accountId);
  if (!a) fail('Account not found', 404);
  const sign = isDebitNormal(a) ? '(jl.debit - jl.credit)' : '(jl.credit - jl.debit)';
  const base = `SELECT jl.id, je.date, je.entry_no, je.memo, je.source_type, je.source_id, jl.debit, jl.credit, p.name AS party,
    SUM(${sign}) OVER (ORDER BY je.date, jl.id) AS balance
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id LEFT JOIN parties p ON p.id=jl.party_id WHERE jl.account_id=${Number(accountId)} AND je.status='posted'`;
  const r = await listQuery(base, [], { defaultDir: 'asc', ...q }, {
    columns: [['date', 'Date', 'date'], ['entry_no', 'Entry #'], ['memo', 'Description'], ['party', 'Party'], ['debit', 'Debit', 'money'], ['credit', 'Credit', 'money'], ['balance', 'Balance', 'money']],
    search: ['entry_no', 'memo', 'party', 'debit', 'credit'], dateCol: 'date', sortable: ['date', 'entry_no', 'debit', 'credit', 'balance'], defaultSort: 'date', defaultDir: 'ASC', sums: ['debit', 'credit'],
  });
  r.account = { ...a, subtype_label: SUBTYPE_LABEL[a.subtype] };
  r.rows.forEach((x) => { x.source_label = SOURCE_LABEL[x.source_type] || x.source_type; });
  return r;
}
export async function journalList(q) {
  const base = `SELECT je.id, je.entry_no, je.date, je.memo, je.source_type, je.source_id, je.status,
    (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id=je.id) AS amount,
    (SELECT GROUP_CONCAT(a.code || ' ' || a.name || CASE WHEN jl.debit>0 THEN ' Dr ' || jl.debit ELSE ' Cr ' || jl.credit END, ' | ') FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=je.id) AS lines
    FROM journal_entries je ${q.status === 'void' ? "WHERE je.status='void'" : "WHERE je.status='posted'"}`;
  const r = await listQuery(base, [], q, {
    columns: [['date', 'Date', 'date'], ['entry_no', 'Entry #'], ['source_label', 'Source'], ['memo', 'Description'], ['amount', 'Amount', 'money']],
    search: ['entry_no', 'memo', 'lines', 'amount'], dateCol: 'date', filters: ['source_type'], sortable: ['date', 'entry_no', 'memo', 'amount'], defaultSort: 'date', sums: ['amount'],
  });
  for (const x of r.rows) { x.source_label = SOURCE_LABEL[x.source_type] || x.source_type; x.lines = await all('SELECT a.code, a.name, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=? ORDER BY jl.id', x.id); }
  return r;
}
