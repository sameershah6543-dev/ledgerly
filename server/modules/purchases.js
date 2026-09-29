// Purchases: supplier bills (purchase invoices), payments, expenses.
import { all, get, run, insert } from '../db.js';
import { getSetting } from '../db.js';
import { mapSeq, fail, r2, num, str, reqStr, oneOf, id as idv, isoDate, addDays, claimNumber, listQuery, statusSql, withToday } from '../util.js';
import { sys, getAccount } from '../coa.js';
import { postEntry, voidEntry, clearMovements, addMovement, assertStock } from '../posting.js';
import { defineDoc, docs, saveDoc, calcLines } from '../docs.js';
import { SQL, billSettled, expensePaidOf, liabilityPaidOf, party, moneyAcc, categoryAccount, accountOfType, findOrCreateSupplier } from '../finance.js';

const taxDefault = () => (getSetting('tax_enabled', '1') === '1' ? Number(getSetting('tax_rate', '0')) : 0);

// ---------------------------------------------------------------------------
// Purchase invoices (bills)
// ---------------------------------------------------------------------------
export const billStatusSql = () => withToday(statusSql({
  total: 'pi.total', paid: `(${SQL.billPaid('pi')} + ${SQL.billCredited('pi')})`, due: 'pi.due_date', state: 'pi.state', draft: false,
}));

defineDoc({
  key: 'bills', table: 'purchase_invoices', label: 'Purchase invoice', amountField: 'total', moneyCols: [],
  lines: { table: 'purchase_invoice_lines', fk: 'invoice_id' },
  async normalize(b, { old, id }) {
    const supplier = await party(idv(b.supplier_id, 'Supplier'), 'supplier', 'Supplier');
    const date = isoDate(b.date, 'Invoice date');
    const due = isoDate(b.due_date || addDays(date, Number(getSetting('default_due_days', '30'))), 'Due date');
    if (due < date) fail('Due date cannot be before the invoice date');
    const state = oneOf(b.state || old?.state || 'posted', ['posted', 'cancelled'], 'Status');
    if (!Array.isArray(b.lines) || !b.lines.length) fail('Add at least one line item');
    const raw = await mapSeq(b.lines, async (l, i) => {
      const n = i + 1;
      const item = l.item_id ? await get('SELECT * FROM items WHERE id=? AND is_deleted=0', l.item_id) : null;
      if (l.item_id && !item) fail(`Line ${n}: product not found`);
      const description = str(l.description) || item?.name;
      if (!description) fail(`Line ${n}: choose a product or enter a description`);
      let acc = null;
      if (!item || item.is_service) {
        acc = l.expense_category_id ? (await categoryAccount(l.expense_category_id, 'expense', `Line ${n} expense category`)).accountId
          : (await get("SELECT id FROM accounts WHERE code='6990'") || {}).id;
        if (!acc) fail(`Line ${n}: choose an expense category`);
      }
      const dp = num(l.discount_pct, `Line ${n} discount`, { min: 0 });
      if (dp > 100) fail(`Line ${n}: discount cannot exceed 100%`);
      const qty = num(l.qty, `Line ${n} quantity`, { required: true });
      if (qty <= 0) fail(`Line ${n}: quantity must be greater than zero`);
      return {
        item_id: item?.id || null, description, qty, unit_price: num(l.unit_price, `Line ${n} unit price`, { min: 0, required: true }),
        discount_pct: dp, tax_rate: num(l.tax_rate, `Line ${n} tax`, { min: 0, def: taxDefault() }), expense_account_id: acc,
      };
    });
    const t = calcLines(raw);
    if (t.total <= 0) fail('Invoice total must be greater than zero');
    const number = str(b.number) || old?.number || await claimNumber('bill', null, 'purchase_invoices', 'number', id, date);
    const dup = await get('SELECT id FROM purchase_invoices WHERE supplier_id=? AND number=? AND id<>? AND is_deleted=0', supplier.id, number, id || 0);
    if (dup) fail(`Supplier invoice ${number} already exists for ${supplier.name}`);
    if (old && old.supplier_id !== supplier.id && await billSettled(old.id) > 0) fail('The supplier cannot be changed after payments were recorded');
    return {
      row: {
        number, reference: str(b.reference), date, due_date: due, supplier_id: supplier.id, state, subtotal: t.subtotal, discount_total: t.discount_total,
        tax_total: t.tax_total, total: t.total, notes: str(b.notes), attachment: str(b.attachment),
      },
      lines: t.lines.map(({ item_id, description, qty, unit_price, discount_pct, tax_rate, expense_account_id, line_net, line_tax }) =>
        ({ item_id, description, qty, unit_price, discount_pct, tax_rate, expense_account_id, line_net, line_tax })),
    };
  },
  async post(id) {
    const inv = await get('SELECT * FROM purchase_invoices WHERE id=?', id);
    const oldItems = await clearMovements('purchase_invoice', id);
    if (inv.is_deleted || inv.state !== 'posted') { await voidEntry('purchase_invoice', id); await assertStock(oldItems); return; }
    const lines = await all('SELECT * FROM purchase_invoice_lines WHERE invoice_id=? ORDER BY id', id);
    const exp = new Map(); let inventory = 0; const touched = [...oldItems];
    for (const l of lines) {
      if (l.item_id && !l.expense_account_id) {
        await addMovement({ itemId: l.item_id, date: inv.date, type: 'purchase', qty: l.qty, value: l.line_net, sourceType: 'purchase_invoice', sourceId: id, memo: inv.number });
        inventory = r2(inventory + l.line_net); touched.push(l.item_id);
      } else exp.set(l.expense_account_id, r2((exp.get(l.expense_account_id) || 0) + l.line_net));
    }
    const jl = [{ account: sys('INVENTORY'), debit: inventory }];
    for (const [acc, amt] of exp) jl.push({ account: acc, debit: amt });
    jl.push({ account: sys('TAX_RECEIVABLE'), debit: inv.tax_total }, { account: sys('AP'), credit: inv.total, party: inv.supplier_id });
    await postEntry({ sourceType: 'purchase_invoice', sourceId: id, date: inv.date, memo: `Purchase invoice ${inv.number}`, lines: jl });
    await assertStock(touched);
  },
  async unpost(id) { const items = await clearMovements('purchase_invoice', id); await voidEntry('purchase_invoice', id); await assertStock(items); },
  async afterSave(id) {
    const inv = await get('SELECT * FROM purchase_invoices WHERE id=?', id);
    const settled = await billSettled(id);
    if (inv.state !== 'posted' && settled > 0.005) fail('This invoice has payments or returns applied - delete them before cancelling');
    if (settled > inv.total + 0.005) fail(`Invoice total (${inv.total}) cannot be less than the amount already paid/credited (${settled})`);
  },
  async canDelete(id) { if (await billSettled(id) > 0.005) fail('This invoice has payments or returns applied. Delete those first.'); },
  async decorate(row) {
    row.supplier_name = (await get('SELECT name FROM parties WHERE id=?', row.supplier_id))?.name;
    row.paid = r2((await get(`SELECT ${SQL.billPaid('pi')} v FROM purchase_invoices pi WHERE id=?`, row.id)).v);
    row.credited = r2((await get(`SELECT ${SQL.billCredited('pi')} v FROM purchase_invoices pi WHERE id=?`, row.id)).v);
    row.outstanding = row.state === 'posted' ? r2(row.total - row.paid - row.credited) : 0;
    row.status = (await get(`SELECT ${billStatusSql()} v FROM purchase_invoices pi WHERE id=?`, row.id)).v;
    if (row.lines) for (const l of row.lines) l.item_name = l.item_id ? (await get('SELECT name FROM items WHERE id=?', l.item_id))?.name : null;
    return row;
  },
  async afterCreate(rid, b, user) {
    const amt = num(b.paid_now, 'Amount paid now', { min: 0 });
    const inv = await get('SELECT * FROM purchase_invoices WHERE id=?', rid);
    if (amt > 0) {
      await saveDoc(docs.payments, {
        date: b.paid_date || inv.date, category: 'supplier_invoice', party_id: inv.supplier_id, ref_type: 'purchase_invoice', ref_id: rid, amount: amt,
        method: b.paid_method || 'Bank Transfer', money_account_id: b.paid_account_id, description: `Payment for invoice ${inv.number}`,
      }, null, user);
    }
  },
  async list(q) {
    const base = `SELECT pi.id, pi.number, pi.date, pi.due_date, pi.supplier_id, p.name AS supplier, pi.subtotal, pi.tax_total, pi.total,
      ${SQL.billPaid('pi')} AS paid,
      CASE WHEN pi.state='posted' THEN pi.total - ${SQL.billPaid('pi')} - ${SQL.billCredited('pi')} ELSE 0 END AS outstanding,
      CASE WHEN pi.state='posted' THEN pi.total ELSE 0 END AS billed, pi.state, ${billStatusSql()} AS status, pi.attachment
      FROM purchase_invoices pi JOIN parties p ON p.id=pi.supplier_id WHERE pi.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Invoice #'], ['supplier', 'Supplier'], ['due_date', 'Due Date', 'date'], ['total', 'Total', 'money'],
        ['paid', 'Paid', 'money'], ['outstanding', 'Outstanding', 'money'], ['status', 'Status', 'badge']],
      search: ['number', 'supplier', 'total', 'date', 'status'], dateCol: 'date', filters: ['status', 'supplier_id'],
      sortable: ['date', 'number', 'supplier', 'due_date', 'total', 'paid', 'outstanding', 'status'], defaultSort: 'date', sums: ['billed', 'paid', 'outstanding'],
    });
  },
});

// ---------------------------------------------------------------------------
// Payments (money paid out)
// ---------------------------------------------------------------------------
async function paymentRef(row) {
  if (row.ref_type === 'purchase_invoice') {
    const bill = await get('SELECT * FROM purchase_invoices WHERE id=? AND is_deleted=0', row.ref_id);
    if (!bill) fail('Referenced purchase invoice not found or deleted');
    if (bill.state !== 'posted') fail(`Invoice ${bill.number} is cancelled`);
    if (bill.supplier_id !== row.party_id) fail('The invoice belongs to a different supplier');
    if (await billSettled(bill.id) > bill.total + 0.005) fail(`Amount exceeds the outstanding balance of invoice ${bill.number} (${r2(bill.total - await billSettled(bill.id) + row.amount)})`);
  } else if (row.ref_type === 'expense') {
    const e = await get('SELECT * FROM expenses WHERE id=? AND is_deleted=0', row.ref_id);
    if (!e || e.mode !== 'credit') fail('Referenced expense not found (or it was already paid in full when recorded)');
    if (await expensePaidOf(e.id) > e.amount + 0.005) fail(`Amount exceeds the outstanding balance of ${e.number} (${r2(e.amount - await expensePaidOf(e.id) + row.amount)})`);
  } else if (row.ref_type === 'liability') {
    const l = await get('SELECT * FROM liabilities WHERE id=? AND is_deleted=0', row.ref_id);
    if (!l) fail('Referenced liability not found');
    if (await liabilityPaidOf(l.id) > l.original_amount + 0.005) fail(`Amount exceeds the outstanding balance of ${l.name} (${r2(l.original_amount - await liabilityPaidOf(l.id) + row.amount)})`);
  }
}
defineDoc({
  key: 'payments', table: 'payments', label: 'Payment', amountField: 'amount', moneyCols: ['money_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const category = oneOf(b.category, ['supplier_invoice', 'expense_bill', 'liability', 'other'], 'Payment category');
    const money = await moneyAcc(idv(b.money_account_id, 'Paid from account'), 'Paid from account');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    const row = {
      number: await claimNumber('payment', b.number || old?.number, 'payments', 'number', id, date), date, category, amount, method: str(b.method),
      money_account_id: money.id, description: str(b.description), notes: str(b.notes), attachment: str(b.attachment),
      party_id: null, payee_name: str(b.payee_name), ref_type: null, ref_id: null, debit_account_id: null,
    };
    if (category === 'supplier_invoice') {
      row.party_id = (await party(idv(b.party_id, 'Supplier'), 'supplier', 'Supplier')).id;
      if (b.ref_id) { row.ref_type = 'purchase_invoice'; row.ref_id = idv(b.ref_id, 'Invoice'); }
    } else if (category === 'expense_bill') {
      row.ref_type = 'expense'; row.ref_id = idv(b.ref_id, 'Expense');
      const e = await get('SELECT * FROM expenses WHERE id=? AND is_deleted=0', row.ref_id);
      if (!e) fail('Expense not found');
      row.party_id = e.vendor_id;
    } else if (category === 'liability') {
      row.ref_type = 'liability'; row.ref_id = idv(b.ref_id, 'Liability');
      const l = await get('SELECT * FROM liabilities WHERE id=? AND is_deleted=0', row.ref_id);
      if (!l) fail('Liability not found');
      row.payee_name = row.payee_name || l.creditor;
    } else {
      row.debit_account_id = (await accountOfType(idv(b.debit_account_id, 'Expense / debit account'), ['expense', 'liability', 'asset', 'equity'], 'Debit account')).id;
      const a = await getAccount(row.debit_account_id);
      if (['AR', 'AP'].includes(a.sys_key) || ['cash', 'bank', 'wallet', 'inventory'].includes(a.subtype)) fail(`Use the dedicated screens for "${a.name}" - it cannot be used for a general payment`);
      row.payee_name = reqStr(b.payee_name, 'Paid to');
    }
    if (row.party_id && !row.payee_name) row.payee_name = (await get('SELECT name FROM parties WHERE id=?', row.party_id)).name;
    return { row };
  },
  async post(id) {
    const p = await get('SELECT * FROM payments WHERE id=?', id);
    if (p.is_deleted) return await voidEntry('payment', id);
    await paymentRef(p);
    const m = await get('SELECT * FROM money_accounts WHERE id=?', p.money_account_id);
    let debit;
    if (p.category === 'supplier_invoice' || p.category === 'expense_bill') {
      if (!p.party_id) fail('This expense has no vendor - it was paid when recorded');
      debit = { account: sys('AP'), debit: p.amount, party: p.party_id };
    } else if (p.category === 'liability') debit = { account: (await get('SELECT account_id FROM liabilities WHERE id=?', p.ref_id)).account_id, debit: p.amount };
    else debit = { account: p.debit_account_id, debit: p.amount };
    await postEntry({ sourceType: 'payment', sourceId: id, date: p.date, memo: `Payment ${p.number} - ${p.payee_name}`, lines: [debit, { account: m.account_id, credit: p.amount }] });
  },
  async unpost(id) { await voidEntry('payment', id); },
  async decorate(row) {
    row.account_name = (await get('SELECT name FROM money_accounts WHERE id=?', row.money_account_id))?.name;
    if (row.ref_type === 'purchase_invoice') row.ref_number = (await get('SELECT number FROM purchase_invoices WHERE id=?', row.ref_id))?.number;
    if (row.ref_type === 'expense') row.ref_number = (await get('SELECT number FROM expenses WHERE id=?', row.ref_id))?.number;
    if (row.ref_type === 'liability') row.ref_number = (await get('SELECT name FROM liabilities WHERE id=?', row.ref_id))?.name;
    return row;
  },
  async list(q) {
    const base = `SELECT p.id, p.number, p.date, COALESCE(p.payee_name, s.name) AS paid_to, p.party_id,
      CASE p.category WHEN 'supplier_invoice' THEN 'Supplier Invoice' WHEN 'expense_bill' THEN 'Expense Bill' WHEN 'liability' THEN 'Liability / Loan' ELSE 'Other Payment' END AS category,
      p.category AS category_key,
      CASE p.ref_type WHEN 'purchase_invoice' THEN (SELECT number FROM purchase_invoices WHERE id=p.ref_id) WHEN 'expense' THEN (SELECT number FROM expenses WHERE id=p.ref_id)
        WHEN 'liability' THEN (SELECT name FROM liabilities WHERE id=p.ref_id) ELSE NULL END AS reference,
      p.amount, p.method, m.name AS account, p.money_account_id, p.description, p.attachment
      FROM payments p LEFT JOIN parties s ON s.id=p.party_id JOIN money_accounts m ON m.id=p.money_account_id WHERE p.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Payment #'], ['paid_to', 'Paid To'], ['category', 'Category'], ['reference', 'Reference'], ['amount', 'Amount', 'money'],
        ['method', 'Method'], ['account', 'Paid From']],
      search: ['number', 'paid_to', 'category', 'reference', 'amount', 'date', 'description', 'account'], dateCol: 'date', filters: ['party_id', 'money_account_id', 'category_key', 'method'],
      sortable: ['date', 'number', 'paid_to', 'category', 'reference', 'amount', 'method', 'account'], defaultSort: 'date', sums: ['amount'],
    });
  },
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
defineDoc({
  key: 'expenses', table: 'expenses', label: 'Expense', amountField: 'amount', moneyCols: ['money_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const { accountId } = await categoryAccount(idv(b.category_id, 'Expense category'), 'expense', 'Expense category');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    const mode = oneOf(b.mode || 'paid', ['paid', 'credit'], 'Payment mode');
    const row = {
      number: await claimNumber('expense', b.number || old?.number, 'expenses', 'number', id, date), date, category_id: b.category_id, account_id: accountId,
      description: str(b.description), amount, mode, method: str(b.method), money_account_id: null, vendor_id: null,
      vendor_name: str(b.vendor_name), invoice_ref: str(b.invoice_ref), due_date: null, notes: str(b.notes), attachment: str(b.attachment),
    };
    if (mode === 'paid') row.money_account_id = (await moneyAcc(idv(b.money_account_id, 'Paid from account'), 'Paid from account')).id;
    else {
      if (!row.vendor_name) fail('Vendor is required for an unpaid (pay later) expense');
      row.due_date = isoDate(b.due_date || addDays(date, Number(getSetting('default_due_days', '30'))), 'Due date');
    }
    if (row.vendor_name) { const v = await findOrCreateSupplier(row.vendor_name, mode === 'credit'); row.vendor_id = v?.id || null; if (v) row.vendor_name = v.name; }
    if (old) {
      const paid = (await get("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE ref_type='expense' AND ref_id=? AND is_deleted=0", old.id)).v;
      if (paid > 0 && mode === 'paid') fail('This expense already has payments recorded - it cannot be changed to "paid now"');
      if (paid > amount + 0.005) fail('Amount cannot be less than the payments already recorded');
    }
    return { row };
  },
  async post(id) {
    const e = await get('SELECT * FROM expenses WHERE id=?', id);
    if (e.is_deleted) return await voidEntry('expense', id);
    const credit = e.mode === 'paid' ? { account: (await get('SELECT account_id FROM money_accounts WHERE id=?', e.money_account_id)).account_id, credit: e.amount }
      : { account: sys('AP'), credit: e.amount, party: e.vendor_id };
    await postEntry({ sourceType: 'expense', sourceId: id, date: e.date, memo: `Expense ${e.number}${e.vendor_name ? ' - ' + e.vendor_name : ''}`, lines: [{ account: e.account_id, debit: e.amount }, credit] });
  },
  async unpost(id) { await voidEntry('expense', id); },
  async afterSave(id) {
    const e = await get('SELECT * FROM expenses WHERE id=?', id);
    if (e.mode === 'credit' && await expensePaidOf(id) > e.amount + 0.005) fail('Amount cannot be less than the payments already recorded');
  },
  async canDelete(id, row) { if (row.mode === 'credit' && await expensePaidOf(id) > 0.005) fail('This expense has payments recorded against it. Delete those first.'); },
  async decorate(row) {
    row.paid = await expensePaidOf(row.id); row.outstanding = r2(row.amount - row.paid);
    row.account_name = row.money_account_id ? (await get('SELECT name FROM money_accounts WHERE id=?', row.money_account_id))?.name : null;
    row.category_name = (await get('SELECT name FROM categories WHERE id=?', row.category_id))?.name;
    return row;
  },
  async list() { return { rows: [], total: 0, columns: [] }; }, // combined expense ledger lives in ledgers.js
});
