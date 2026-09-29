// Liabilities, capital, assets (+depreciation/disposal), transfers, and the combined expense/revenue ledger views.
import { all, get, run } from '../db.js';
import { fail, r2, num, str, reqStr, oneOf, id as idv, isoDate, monthEnd, addMonths, listQuery, statusSql, withToday, today, claimNumber } from '../util.js';
import { sys, getAccount } from '../coa.js';
import { postEntry, voidEntry } from '../posting.js';
import { defineDoc, docs, saveDoc, deleteDoc, patchDoc } from '../docs.js';
import { SQL, SQL as S, liabilityPaidOf, moneyAcc, categoryAccount, accountOfType, expensePaidOf } from '../finance.js';
import { invoiceStatusSql } from './sales.js';

// ---------------------------------------------------------------------------
// Liabilities ledger
// ---------------------------------------------------------------------------
const liaStatus = () => withToday(`CASE WHEN l.original_amount - ${SQL.liaPaid('l')} <= 0.005 THEN 'Paid' WHEN l.due_date IS NOT NULL AND l.due_date < :TODAY: THEN 'Overdue' ELSE 'Active' END`);
defineDoc({
  key: 'liabilities', table: 'liabilities', label: 'Liability', amountField: 'original_amount', numberField: 'number', moneyCols: ['money_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const { accountId } = await categoryAccount(idv(b.category_id, 'Category'), 'liability', 'Category');
    if ((await getAccount(accountId)).sys_key === 'AP') fail('Accounts Payable is maintained through Purchase Invoices and Expenses');
    const amount = num(b.original_amount, 'Original amount', { required: true });
    if (amount <= 0) fail('Original amount must be greater than zero');
    const offset = oneOf(b.offset_type || 'opening', ['cash', 'expense', 'opening'], 'Recorded against');
    const row = {
      number: await claimNumber('liability', b.number || old?.number, 'liabilities', 'number', id, date), name: reqStr(b.name, 'Liability name'), category_id: b.category_id,
      account_id: accountId, creditor: str(b.creditor), date, original_amount: amount, due_date: isoDate(b.due_date, 'Due date', false), payment_schedule: str(b.payment_schedule),
      installment_amount: b.installment_amount === '' || b.installment_amount == null ? null : num(b.installment_amount, 'Installment', { min: 0 }),
      offset_type: offset, money_account_id: null, expense_account_id: null, notes: str(b.notes), attachment: str(b.attachment),
    };
    if (offset === 'cash') row.money_account_id = (await moneyAcc(idv(b.money_account_id, 'Received into account'), 'Received into account')).id;
    if (offset === 'expense') row.expense_account_id = (await categoryAccount(idv(b.expense_category_id, 'Expense category'), 'expense', 'Expense category')).accountId;
    if (row.due_date && row.due_date < date) fail('Due date cannot be before the liability date');
    return { row };
  },
  async post(id) {
    const l = await get('SELECT * FROM liabilities WHERE id=?', id);
    if (l.is_deleted) return await voidEntry('liability', id);
    const debit = l.offset_type === 'cash' ? (await get('SELECT account_id FROM money_accounts WHERE id=?', l.money_account_id)).account_id
      : l.offset_type === 'expense' ? l.expense_account_id : sys('OBE');
    await postEntry({ sourceType: 'liability', sourceId: id, date: l.date, memo: `Liability ${l.name}`, lines: [{ account: debit, debit: l.original_amount }, { account: l.account_id, credit: l.original_amount }] });
  },
  async unpost(id) { await voidEntry('liability', id); },
  async afterSave(id) { const l = await get('SELECT * FROM liabilities WHERE id=?', id); if (await liabilityPaidOf(id) > l.original_amount + 0.005) fail('Original amount cannot be less than the payments already made'); },
  async canDelete(id) { if (await liabilityPaidOf(id) > 0.005) fail('This liability has payments recorded against it. Delete those payments first.'); },
  async decorate(row) {
    row.amount_paid = await liabilityPaidOf(row.id); row.remaining = r2(row.original_amount - row.amount_paid);
    row.category_name = (await get('SELECT name FROM categories WHERE id=?', row.category_id))?.name;
    row.expense_category_id = row.expense_account_id ? (await get("SELECT id FROM categories WHERE kind='expense' AND account_id=?", row.expense_account_id))?.id : null;
    return row;
  },
  async list(q) {
    const base = `SELECT l.id, l.number, l.name, c.name AS category, l.category_id, l.creditor, l.date, l.original_amount, ${SQL.liaPaid('l')} AS amount_paid,
      l.original_amount - ${SQL.liaPaid('l')} AS remaining, l.due_date, l.payment_schedule, ${liaStatus()} AS status, l.attachment
      FROM liabilities l JOIN categories c ON c.id=l.category_id WHERE l.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['name', 'Liability'], ['category', 'Category'], ['creditor', 'Creditor'], ['date', 'Date', 'date'], ['original_amount', 'Original Amount', 'money'], ['amount_paid', 'Amount Paid', 'money'],
        ['remaining', 'Remaining', 'money'], ['due_date', 'Due Date', 'date'], ['payment_schedule', 'Schedule'], ['status', 'Status', 'badge']],
      search: ['number', 'name', 'category', 'creditor', 'original_amount', 'date', 'status'], dateCol: 'date', filters: ['status', 'category_id'],
      sortable: ['name', 'category', 'creditor', 'date', 'original_amount', 'amount_paid', 'remaining', 'due_date', 'status'], defaultSort: 'date', sums: ['original_amount', 'amount_paid', 'remaining'],
    });
  },
});

// ---------------------------------------------------------------------------
// Capital ledger
// ---------------------------------------------------------------------------
export const CAPITAL_TYPES = {
  initial_capital: ['Initial Capital', 'in'], additional_investment: ['Additional Investment', 'in'], owner_contribution: ['Owner Contribution', 'in'],
  other_in: ['Other Capital (In)', 'in'], withdrawal: ['Withdrawal', 'out'], drawing: ['Drawing', 'out'], other_out: ['Other Capital (Out)', 'out'],
};
defineDoc({
  key: 'capital', table: 'capital_transactions', label: 'Capital transaction', amountField: 'amount', moneyCols: ['money_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const type = oneOf(b.type, Object.keys(CAPITAL_TYPES), 'Investment type');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    return {
      row: {
        number: await claimNumber('capital', b.number || old?.number, 'capital_transactions', 'number', id, date), date, investor: reqStr(b.investor, 'Investor / Owner'), type, amount,
        money_account_id: (await moneyAcc(idv(b.money_account_id, 'Account / Bank'), 'Account / Bank')).id, description: str(b.description), reference: str(b.reference), notes: str(b.notes), attachment: str(b.attachment),
      },
    };
  },
  async post(id) {
    const c = await get('SELECT * FROM capital_transactions WHERE id=?', id);
    if (c.is_deleted) return await voidEntry('capital', id);
    const cash = (await get('SELECT account_id FROM money_accounts WHERE id=?', c.money_account_id)).account_id;
    const [label, dir] = CAPITAL_TYPES[c.type];
    const lines = dir === 'in'
      ? [{ account: cash, debit: c.amount }, { account: sys('OWNER_CAPITAL'), credit: c.amount }]
      : [{ account: c.type === 'other_out' ? sys('OWNER_CAPITAL') : sys('DRAWINGS'), debit: c.amount }, { account: cash, credit: c.amount }];
    await postEntry({ sourceType: 'capital', sourceId: id, date: c.date, memo: `${label} - ${c.investor}`, lines });
  },
  async unpost(id) { await voidEntry('capital', id); },
  async decorate(row) { row.account_name = (await get('SELECT name FROM money_accounts WHERE id=?', row.money_account_id))?.name; row.type_label = CAPITAL_TYPES[row.type][0]; return row; },
  async list(q) {
    const t = Object.entries(CAPITAL_TYPES).map(([k, [l]]) => `WHEN '${k}' THEN '${l}'`).join(' ');
    const base = `SELECT c.id, c.number, c.date, c.investor, c.type, CASE c.type ${t} END AS type_label,
      CASE WHEN c.type IN ('initial_capital','additional_investment','owner_contribution','other_in') THEN c.amount ELSE 0 END AS money_in,
      CASE WHEN c.type IN ('initial_capital','additional_investment','owner_contribution','other_in') THEN 0 ELSE c.amount END AS money_out,
      c.amount, m.name AS account, c.money_account_id, c.description, c.reference, c.attachment
      FROM capital_transactions c JOIN money_accounts m ON m.id=c.money_account_id WHERE c.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Ref #'], ['investor', 'Investor / Owner'], ['type_label', 'Type'], ['money_in', 'Investment', 'money'], ['money_out', 'Withdrawal', 'money'],
        ['account', 'Account'], ['reference', 'Reference'], ['description', 'Description']],
      search: ['number', 'investor', 'type_label', 'amount', 'date', 'reference', 'description', 'account'], dateCol: 'date', filters: ['type', 'money_account_id', 'investor'],
      sortable: ['date', 'number', 'investor', 'type_label', 'money_in', 'money_out', 'account'], defaultSort: 'date', sums: ['money_in', 'money_out'],
    });
  },
});
export async function capitalSummary(q = {}) {
  const w = []; const p = [];
  if (q.from) { w.push('date>=?'); p.push(q.from); } if (q.to) { w.push('date<=?'); p.push(q.to); }
  const W = 'is_deleted=0' + (w.length ? ' AND ' + w.join(' AND ') : '');
  const sum = async (types) => r2((await get(`SELECT COALESCE(SUM(amount),0) v FROM capital_transactions WHERE ${W} AND type IN (${types.map((t) => `'${t}'`).join(',')})`, ...p)).v);
  const initial = await sum(['initial_capital']), additional = await sum(['additional_investment', 'owner_contribution', 'other_in']);
  const withdrawals = await sum(['withdrawal', 'drawing', 'other_out']);
  return { initial, additional, invested: r2(initial + additional), withdrawals, balance: r2(initial + additional - withdrawals) };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
defineDoc({
  key: 'transfers', table: 'transfers', label: 'Transfer', amountField: 'amount', moneyCols: ['from_account_id', 'to_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const from = await moneyAcc(idv(b.from_account_id, 'From account'), 'From account'); const to = await moneyAcc(idv(b.to_account_id, 'To account'), 'To account');
    if (from.id === to.id) fail('The source and destination accounts must be different');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    return {
      row: {
        number: await claimNumber('transfer', b.number || old?.number, 'transfers', 'number', id, date), date, from_account_id: from.id, to_account_id: to.id, amount,
        description: str(b.description), reference: str(b.reference), notes: str(b.notes),
      },
    };
  },
  async post(id) {
    const t = await get('SELECT * FROM transfers WHERE id=?', id);
    if (t.is_deleted) return await voidEntry('transfer', id);
    const f = await get('SELECT * FROM money_accounts WHERE id=?', t.from_account_id); const to = await get('SELECT * FROM money_accounts WHERE id=?', t.to_account_id);
    await postEntry({ sourceType: 'transfer', sourceId: id, date: t.date, memo: `Transfer ${f.name} -> ${to.name}`, lines: [{ account: to.account_id, debit: t.amount }, { account: f.account_id, credit: t.amount }] });
  },
  async unpost(id) { await voidEntry('transfer', id); },
  async decorate(row) { row.from_name = (await get('SELECT name FROM money_accounts WHERE id=?', row.from_account_id))?.name; row.to_name = (await get('SELECT name FROM money_accounts WHERE id=?', row.to_account_id))?.name; return row; },
  async list(q) {
    const base = `SELECT t.id, t.number, t.date, f.name AS from_account, t.from_account_id, o.name AS to_account, t.to_account_id, t.amount, t.description, t.reference
      FROM transfers t JOIN money_accounts f ON f.id=t.from_account_id JOIN money_accounts o ON o.id=t.to_account_id WHERE t.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Transfer #'], ['from_account', 'From'], ['to_account', 'To'], ['amount', 'Amount', 'money'], ['reference', 'Reference'], ['description', 'Description']],
      search: ['number', 'from_account', 'to_account', 'amount', 'date', 'reference', 'description'], dateCol: 'date', filters: ['from_account_id', 'to_account_id'],
      sortable: ['date', 'number', 'from_account', 'to_account', 'amount'], defaultSort: 'date', sums: ['amount'],
    });
  },
});

// ---------------------------------------------------------------------------
// Fixed / other assets
// ---------------------------------------------------------------------------
const accumOf = async (assetId) => r2((await get('SELECT COALESCE(SUM(amount),0) v FROM asset_depreciations WHERE asset_id=? AND is_deleted=0', assetId)).v);
defineDoc({
  key: 'assets', table: 'assets', label: 'Asset', amountField: 'purchase_value', moneyCols: ['money_account_id', 'disposal_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.purchase_date, 'Purchase date');
    const { accountId } = await categoryAccount(idv(b.category_id, 'Asset category'), 'asset', 'Asset category');
    const acc = await getAccount(accountId);
    if (acc.type !== 'asset' || ['cash', 'bank', 'wallet', 'receivable', 'inventory'].includes(acc.subtype)) fail('This category cannot be used for the asset register');
    const value = num(b.purchase_value, 'Purchase value', { required: true });
    if (value <= 0) fail('Purchase value must be greater than zero');
    const source = oneOf(b.source || 'paid', ['paid', 'opening'], 'Source of funds');
    const depreciable = b.depreciable === true || b.depreciable === 1 || b.depreciable === '1' || b.depreciable === 'true' ? 1 : 0;
    const salvage = num(b.salvage_value, 'Salvage value', { min: 0 });
    const row = {
      number: await claimNumber('asset', b.number || old?.number, 'assets', 'number', id, date), name: reqStr(b.name, 'Asset name'), category_id: b.category_id, account_id: accountId,
      description: str(b.description), purchase_date: date, purchase_value: value, salvage_value: salvage, payment_method: str(b.payment_method), supplier: str(b.supplier),
      reference: str(b.reference), notes: str(b.notes), attachment: str(b.attachment), source, money_account_id: null, depreciable,
      dep_method: oneOf(b.dep_method || 'straight_line', ['straight_line', 'declining_balance'], 'Depreciation method'), useful_life_years: null,
    };
    if (source === 'paid') row.money_account_id = (await moneyAcc(idv(b.money_account_id, 'Paid from account'), 'Paid from account')).id;
    if (depreciable) {
      row.useful_life_years = num(b.useful_life_years, 'Useful life (years)', { required: true });
      if (row.useful_life_years <= 0) fail('Useful life must be greater than zero');
      if (salvage >= value) fail('Salvage value must be less than the purchase value');
    }
    if (old && old.status === 'disposed') fail('A disposed asset cannot be edited. Reinstate it first.');
    return { row };
  },
  async post(id) {
    const a = await get('SELECT * FROM assets WHERE id=?', id);
    if (a.is_deleted) { await voidEntry('asset', id); await voidEntry('asset_disposal', id); return; }
    const credit = a.source === 'paid' ? (await get('SELECT account_id FROM money_accounts WHERE id=?', a.money_account_id)).account_id : sys('OBE');
    await postEntry({ sourceType: 'asset', sourceId: id, date: a.purchase_date, memo: `Asset ${a.name}`, lines: [{ account: a.account_id, debit: a.purchase_value }, { account: credit, credit: a.purchase_value }] });
    if (a.status === 'disposed') {
      const acc = await accumOf(id); const proceeds = a.disposal_proceeds || 0; const gain = r2(proceeds + acc - a.purchase_value);
      const cash = proceeds > 0 ? (await get('SELECT account_id FROM money_accounts WHERE id=?', a.disposal_account_id)).account_id : null;
      await postEntry({
        sourceType: 'asset_disposal', sourceId: id, date: a.disposal_date, memo: `Disposal of ${a.name}`,
        lines: [{ account: cash, debit: proceeds }, { account: sys('ACC_DEPR'), debit: acc }, { account: a.account_id, credit: a.purchase_value },
          { account: sys('DISPOSAL_GAIN'), debit: gain < 0 ? -gain : 0, credit: gain > 0 ? gain : 0 }].filter((l) => l.account),
      });
    } else await voidEntry('asset_disposal', id);
  },
  async unpost(id) { await voidEntry('asset', id); await voidEntry('asset_disposal', id); },
  async canDelete(id, row) {
    if (row.status === 'disposed') fail('This asset was disposed. Reinstate it before deleting.');
    if (await get('SELECT id FROM asset_depreciations WHERE asset_id=? AND is_deleted=0', id)) fail('Delete this asset\'s depreciation entries first.');
  },
  async afterSave(id) {
    const a = await get('SELECT * FROM assets WHERE id=?', id);
    if (!a.depreciable && await accumOf(id) > 0) fail('This asset has depreciation entries - delete them before turning depreciation off');
    if (a.depreciable && await accumOf(id) > a.purchase_value - a.salvage_value + 0.005) fail('Purchase value / salvage value is lower than the depreciation already charged');
  },
  async decorate(row) {
    row.accumulated = await accumOf(row.id); row.current_value = row.status === 'disposed' ? 0 : r2(row.purchase_value - row.accumulated);
    row.category_name = (await get('SELECT name FROM categories WHERE id=?', row.category_id))?.name;
    return row;
  },
  async list(q) {
    const acc = '(SELECT COALESCE(SUM(amount),0) FROM asset_depreciations d WHERE d.asset_id=a.id AND d.is_deleted=0)';
    const base = `SELECT a.id, a.number, a.name, c.name AS category, a.category_id, a.purchase_date, a.purchase_value, ${acc} AS accumulated,
      CASE WHEN a.status='disposed' THEN 0 ELSE a.purchase_value - ${acc} END AS current_value, a.supplier, a.reference, a.payment_method,
      CASE WHEN a.status='disposed' THEN 'Disposed' ELSE 'Active' END AS status, a.depreciable, a.attachment
      FROM assets a JOIN categories c ON c.id=a.category_id WHERE a.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['number', 'Ref #'], ['name', 'Asset'], ['category', 'Category'], ['purchase_date', 'Purchased', 'date'], ['purchase_value', 'Purchase Value', 'money'],
        ['accumulated', 'Depreciation', 'money'], ['current_value', 'Current Value', 'money'], ['supplier', 'Supplier'], ['status', 'Status', 'badge']],
      search: ['number', 'name', 'category', 'supplier', 'reference', 'purchase_value', 'purchase_date'], dateCol: 'purchase_date', filters: ['status', 'category_id'],
      sortable: ['number', 'name', 'category', 'purchase_date', 'purchase_value', 'accumulated', 'current_value', 'supplier', 'status'], defaultSort: 'purchase_date', sums: ['purchase_value', 'accumulated', 'current_value'],
    });
  },
});

defineDoc({
  key: 'depreciation', table: 'asset_depreciations', label: 'Depreciation entry', amountField: 'amount', numberField: 'number',
  async normalize(b) {
    const a = await get('SELECT * FROM assets WHERE id=? AND is_deleted=0', idv(b.asset_id, 'Asset'));
    if (!a) fail('Asset not found');
    if (!a.depreciable) fail('Depreciation is not enabled for this asset');
    if (a.status === 'disposed') fail('The asset is disposed');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    if (await accumOf(a.id) + amount > a.purchase_value - a.salvage_value + 0.005) fail('Depreciation would exceed the depreciable amount (cost less salvage value)');
    const date = isoDate(b.date, 'Date');
    return { row: { asset_id: a.id, date, amount, number: await claimNumber('depreciation', b.number, 'asset_depreciations', 'number', 0, date) } };
  },
  async post(id) {
    const d = await get('SELECT d.*, a.name, a.is_deleted AS adel FROM asset_depreciations d JOIN assets a ON a.id=d.asset_id WHERE d.id=?', id);
    if (d.is_deleted || d.adel) return await voidEntry('depreciation', id);
    await postEntry({ sourceType: 'depreciation', sourceId: id, date: d.date, memo: `Depreciation - ${d.name}`, lines: [{ account: sys('DEPR_EXP'), debit: d.amount }, { account: sys('ACC_DEPR'), credit: d.amount }] });
  },
  async unpost(id) { await voidEntry('depreciation', id); },
  async canDelete(id, row) { if (await get("SELECT id FROM assets WHERE id=? AND status='disposed'", row.asset_id)) fail('The asset is disposed - reinstate it first'); },
  async list(q) {
    const base = `SELECT d.id, d.number, d.date, a.name AS asset, d.asset_id, d.amount FROM asset_depreciations d JOIN assets a ON a.id=d.asset_id WHERE d.is_deleted=0`;
    return await listQuery(base, [], q, { columns: [['date', 'Date', 'date'], ['number', 'Ref #'], ['asset', 'Asset'], ['amount', 'Depreciation', 'money']], search: ['number', 'asset'], dateCol: 'date', filters: ['asset_id'], sortable: ['date', 'asset', 'amount'], defaultSort: 'date', sums: ['amount'] });
  },
});

// Post monthly depreciation up to `through` for one asset (or all depreciable assets)
export async function runDepreciation({ assetId = null, through }, user) {
  through = isoDate(through || today(), 'Depreciate through');
  const list = await all(`SELECT * FROM assets WHERE is_deleted=0 AND depreciable=1 AND status='active' ${assetId ? 'AND id=' + Number(assetId) : ''}`);
  const created = [];
  for (const a of list) {
    const last = (await get('SELECT MAX(date) d FROM asset_depreciations WHERE asset_id=? AND is_deleted=0', a.id)).d;
    let next = last ? monthEnd(addMonths(last, 1)) : monthEnd(a.purchase_date);
    while (next <= through) {
      const accum = await accumOf(a.id); const room = r2(a.purchase_value - a.salvage_value - accum);
      if (room <= 0.005) break;
      const monthly = a.dep_method === 'declining_balance' ? r2((a.purchase_value - accum) * (2 / a.useful_life_years) / 12) : r2((a.purchase_value - a.salvage_value) / (a.useful_life_years * 12));
      const amount = Math.min(room, Math.max(monthly, 0.01));
      created.push(await saveDoc(docs.depreciation, { asset_id: a.id, date: next, amount }, null, user));
      next = monthEnd(addMonths(next, 1));
    }
  }
  return created;
}
export async function disposeAsset(assetId, b, user) {
  const a = await get('SELECT * FROM assets WHERE id=?', assetId);
  if (!a || a.is_deleted) fail('Asset not found', 404);
  if (a.status === 'disposed') fail('Asset is already disposed');
  const date = isoDate(b.date, 'Disposal date'); if (date < a.purchase_date) fail('Disposal date cannot be before the purchase date');
  const proceeds = num(b.proceeds, 'Sale proceeds', { min: 0 });
  const patch = { status: 'disposed', disposal_date: date, disposal_proceeds: proceeds, disposal_account_id: null };
  if (proceeds > 0) patch.disposal_account_id = (await moneyAcc(idv(b.money_account_id, 'Proceeds received into'), 'Account')).id;
  return await patchDoc(docs.assets, assetId, patch, user, 'disposed');
}
export async function reinstateAsset(assetId, user) {
  return await patchDoc(docs.assets, assetId, { status: 'active', disposal_date: null, disposal_proceeds: null, disposal_account_id: null }, user, 'reinstated');
}

// ---------------------------------------------------------------------------
// Combined expense ledger (expenses + general payments that hit an expense account)
// ---------------------------------------------------------------------------
export async function expenseLedger(q) {
  const paid = SQL.expPaid('e');
  const status = withToday(`CASE WHEN e.mode='paid' THEN 'Paid' WHEN e.amount - ${paid} <= 0.005 THEN 'Paid' WHEN e.due_date < :TODAY: THEN 'Overdue' WHEN ${paid} > 0.005 THEN 'Partially Paid' ELSE 'Unpaid' END`);
  const base = `SELECT 'expense' AS src, e.id, e.number, e.date, c.name AS category, e.category_id, e.description, e.vendor_name AS vendor, e.amount, e.method,
      COALESCE(m.name, 'On credit') AS paid_from, e.invoice_ref, ${status} AS status, e.attachment
    FROM expenses e JOIN categories c ON c.id=e.category_id LEFT JOIN money_accounts m ON m.id=e.money_account_id WHERE e.is_deleted=${q.deleted ? 1 : 0}
    UNION ALL
    SELECT 'payment', p.id, p.number, p.date, a.name, NULL, p.description, p.payee_name, p.amount, p.method, m.name, NULL, 'Paid', p.attachment
    FROM payments p JOIN accounts a ON a.id=p.debit_account_id JOIN money_accounts m ON m.id=p.money_account_id
    WHERE p.category='other' AND a.type='expense' AND p.is_deleted=${q.deleted ? 1 : 0}`;
  return await listQuery(base, [], q, {
    columns: [['date', 'Date', 'date'], ['number', 'Ref #'], ['category', 'Category'], ['description', 'Description'], ['vendor', 'Vendor / Payee'], ['amount', 'Amount', 'money'],
      ['method', 'Method'], ['paid_from', 'Paid From'], ['invoice_ref', 'Invoice / Receipt #'], ['status', 'Status', 'badge']],
    search: ['number', 'category', 'description', 'vendor', 'amount', 'date', 'invoice_ref', 'paid_from'], dateCol: 'date', filters: ['category', 'vendor', 'method', 'paid_from', 'status'],
    sortable: ['date', 'number', 'category', 'description', 'vendor', 'amount', 'method', 'paid_from', 'status'], defaultSort: 'date', sums: ['amount'],
  });
}

// ---------------------------------------------------------------------------
// Combined revenue ledger (sent invoices + direct revenue entries)
// ---------------------------------------------------------------------------
export async function revenueLedger(q) {
  const invStatus = invoiceStatusSql();
  const revRec = SQL.revReceived('re');
  const revStatus = withToday(statusSql({ total: 're.amount', paid: revRec, due: 're.due_date', state: "'sent'" }));
  const rcpt = (t, a) => `(SELECT GROUP_CONCAT(DISTINCT r.method) FROM receipts r WHERE r.ref_type='${t}' AND r.ref_id=${a}.id AND r.is_deleted=0) AS method,
    (SELECT GROUP_CONCAT(DISTINCT m.name) FROM receipts r JOIN money_accounts m ON m.id=r.money_account_id WHERE r.ref_type='${t}' AND r.ref_id=${a}.id AND r.is_deleted=0) AS account`;
  const base = `SELECT 'invoice' AS src, si.id, si.date, si.number, p.name AS customer, si.customer_id,
      (SELECT GROUP_CONCAT(DISTINCT a.name) FROM sales_invoice_lines l JOIN accounts a ON a.id=l.revenue_account_id WHERE l.invoice_id=si.id) AS category,
      (SELECT description FROM sales_invoice_lines WHERE invoice_id=si.id ORDER BY id LIMIT 1) AS description,
      si.subtotal - si.discount_total AS net_revenue, si.total AS amount, ${SQL.invReceived('si')} AS received,
      si.total - ${SQL.invReceived('si')} - ${SQL.invCredited('si')} AS outstanding, ${rcpt('invoice', 'si')}, si.due_date, ${invStatus} AS status, si.attachment
    FROM sales_invoices si JOIN parties p ON p.id=si.customer_id WHERE si.is_deleted=${q.deleted ? 1 : 0} AND si.state='sent'
    UNION ALL
    SELECT 'revenue', re.id, re.date, re.number, p.name, re.customer_id, a.name, re.description, re.amount, re.amount, ${revRec}, re.amount - ${revRec},
      ${rcpt('revenue', 're')}, re.due_date, ${revStatus}, re.attachment
    FROM revenue_entries re JOIN parties p ON p.id=re.customer_id JOIN accounts a ON a.id=re.account_id WHERE re.is_deleted=${q.deleted ? 1 : 0}`;
  return await listQuery(base, [], q, {
    columns: [['date', 'Date', 'date'], ['number', 'Invoice / Ref #'], ['customer', 'Customer'], ['category', 'Category'], ['description', 'Description'], ['net_revenue', 'Revenue', 'money'],
      ['amount', 'Amount (incl. tax)', 'money'], ['received', 'Received', 'money'], ['outstanding', 'Outstanding', 'money'], ['method', 'Method'], ['account', 'Received Into'],
      ['due_date', 'Due Date', 'date'], ['status', 'Status', 'badge']],
    search: ['number', 'customer', 'category', 'description', 'amount', 'date', 'account', 'status'], dateCol: 'date', filters: ['customer_id', 'category', 'status', 'src'],
    sortable: ['date', 'number', 'customer', 'category', 'net_revenue', 'amount', 'received', 'outstanding', 'due_date', 'status'], defaultSort: 'date', sums: ['net_revenue', 'amount', 'received', 'outstanding'],
  });
}
