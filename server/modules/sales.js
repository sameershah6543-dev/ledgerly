// Sales: customer invoices, receipts, revenue entries.
import { all, get, run, update } from '../db.js';
import { getSetting } from '../db.js';
import { mapSeq, fail, r2, num, str, reqStr, oneOf, id as idv, isoDate, addDays, claimNumber, listQuery, statusSql, withToday, today } from '../util.js';
import { sys } from '../coa.js';
import { postEntry, voidEntry, clearMovements, addMovement, avgCost, assertStock, stockOf } from '../posting.js';
import { defineDoc, docs, saveDoc, calcLines, getDoc, patchDoc } from '../docs.js';
import { SQL, invoiceSettled, revenueReceived, party, moneyAcc, categoryAccount, accountOfType, walkInCustomer } from '../finance.js';

const taxDefault = () => (getSetting('tax_enabled', '1') === '1' ? Number(getSetting('tax_rate', '0')) : 0);

// ---------------------------------------------------------------------------
// Customer invoices
// ---------------------------------------------------------------------------
export const invoiceStatusSql = () => withToday(statusSql({
  total: 'si.total', paid: `(${SQL.invReceived('si')} + ${SQL.invCredited('si')})`, due: 'si.due_date', state: 'si.state',
}));

defineDoc({
  key: 'invoices', table: 'sales_invoices', label: 'Invoice', amountField: 'total', moneyCols: [],
  lines: { table: 'sales_invoice_lines', fk: 'invoice_id' },
  async normalize(b, { old, id }) {
    const customer = await party(idv(b.customer_id, 'Customer'), 'customer', 'Customer');
    const date = isoDate(b.date, 'Invoice date');
    const due = isoDate(b.due_date || addDays(date, Number(getSetting('default_due_days', '30'))), 'Due date');
    if (due < date) fail('Due date cannot be before the invoice date');
    const state = oneOf(b.state || old?.state || 'sent', ['draft', 'sent', 'cancelled'], 'Status');
    if (!Array.isArray(b.lines) || !b.lines.length) fail('Add at least one line item');
    const raw = await mapSeq(b.lines, async (l, i) => {
      const n = i + 1;
      const item = l.item_id ? await get('SELECT * FROM items WHERE id=? AND is_deleted=0', l.item_id) : null;
      if (l.item_id && !item) fail(`Line ${n}: product not found`);
      const description = str(l.description) || item?.name;
      if (!description) fail(`Line ${n}: choose a product or enter a description`);
      let acc;
      if (l.revenue_category_id) acc = (await categoryAccount(l.revenue_category_id, 'revenue', `Line ${n} revenue category`)).accountId;
      else acc = sys(item && !item.is_service ? 'SALES' : 'SERVICE');
      const dp = num(l.discount_pct, `Line ${n} discount`, { min: 0 });
      if (dp > 100) fail(`Line ${n}: discount cannot exceed 100%`);
      // optional per-sale cost (what this unit actually cost) - replaces the average stock cost for profit
      const hasCost = l.cost_override !== undefined && l.cost_override !== null && l.cost_override !== '';
      if (hasCost && (!item || item.is_service)) fail(`Line ${n}: a cost can only be set for stock products`);
      return {
        item_id: item?.id || null, description, cost_override: hasCost ? num(l.cost_override, `Line ${n} cost`, { min: 0 }) : null,
        qty: num(l.qty, `Line ${n} quantity`, { required: true }), unit_price: num(l.unit_price, `Line ${n} unit price`, { min: 0, required: true }),
        discount_pct: dp, tax_rate: num(l.tax_rate, `Line ${n} tax`, { min: 0, def: taxDefault() }), revenue_account_id: acc,
      };
    });
    for (const [i, l] of raw.entries()) if (l.qty <= 0) fail(`Line ${i + 1}: quantity must be greater than zero`);
    const t = calcLines(raw);
    if (t.total <= 0) fail('Invoice total must be greater than zero');
    if (old && old.customer_id !== customer.id && await invoiceSettled(old.id) > 0) fail('The customer cannot be changed after payments were recorded');
    return {
      row: {
        number: await claimNumber('invoice', b.number || old?.number, 'sales_invoices', 'number', id, date), date, due_date: due, customer_id: customer.id, state,
        subtotal: t.subtotal, discount_total: t.discount_total, tax_total: t.tax_total, total: t.total,
        notes: str(b.notes), terms: str(b.terms), attachment: str(b.attachment),
      },
      lines: t.lines.map(({ item_id, description, qty, unit_price, discount_pct, tax_rate, revenue_account_id, line_net, line_tax, cost_override }) =>
        ({ item_id, description, qty, unit_price, discount_pct, tax_rate, revenue_account_id, line_net, line_tax, cost_override })),
    };
  },
  async post(id) {
    const inv = await get('SELECT * FROM sales_invoices WHERE id=?', id);
    const oldItems = await clearMovements('sales_invoice', id);
    if (inv.is_deleted || inv.state !== 'sent') { await voidEntry('sales_invoice', id); await assertStock(oldItems); return; }
    const lines = await all('SELECT * FROM sales_invoice_lines WHERE invoice_id=? ORDER BY id', id);
    const rev = new Map(); let cogs = 0; let reval = 0; const touched = [...oldItems];
    for (const l of lines) {
      rev.set(l.revenue_account_id, r2((rev.get(l.revenue_account_id) || 0) + l.line_net));
      const item = l.item_id ? await get('SELECT * FROM items WHERE id=?', l.item_id) : null;
      if (item && !item.is_service) {
        const override = l.cost_override !== null && l.cost_override !== undefined;
        const value = r2(l.qty * (override ? l.cost_override : await avgCost(item.id)));
        await addMovement({ itemId: item.id, date: inv.date, type: 'sale', qty: -l.qty, value: -value, sourceType: 'sales_invoice', sourceId: id, memo: inv.number });
        await run('UPDATE sales_invoice_lines SET unit_cost=? WHERE id=?', l.qty ? value / l.qty : 0, l.id);
        cogs = r2(cogs + value); touched.push(item.id);
        if (override) {
          // A user-set cost can leave value behind on an emptied item (or push it negative):
          // revalue the remaining stock against opening equity so profit stays exactly as entered.
          const s = await stockOf(item.id);
          const target = s.qty > 0.0000001 ? (s.value >= 0 ? s.value : r2(s.qty * item.purchase_price)) : 0;
          const residue = r2(s.value - target);
          if (Math.abs(residue) > 0.005) {
            await addMovement({ itemId: item.id, date: inv.date, type: 'adjustment', qty: 0, value: -residue, sourceType: 'sales_invoice', sourceId: id, memo: `${inv.number} cost revaluation` });
            reval = r2(reval + residue);
          }
        }
      }
    }
    const jl = [{ account: sys('AR'), debit: inv.total, party: inv.customer_id }];
    for (const [acc, amt] of rev) jl.push({ account: acc, credit: amt });
    jl.push({ account: sys('TAX_PAYABLE'), credit: inv.tax_total });
    jl.push({ account: sys('COGS'), debit: cogs }, { account: sys('INVENTORY'), credit: cogs });
    if (reval > 0) jl.push({ account: sys('OBE'), debit: reval }, { account: sys('INVENTORY'), credit: reval });
    else if (reval < 0) jl.push({ account: sys('INVENTORY'), debit: -reval }, { account: sys('OBE'), credit: -reval });
    await postEntry({ sourceType: 'sales_invoice', sourceId: id, date: inv.date, memo: `Invoice ${inv.number}`, lines: jl });
    await assertStock(touched);
  },
  async unpost(id) { const items = await clearMovements('sales_invoice', id); await voidEntry('sales_invoice', id); await assertStock(items); },
  async afterSave(id) {
    const inv = await get('SELECT * FROM sales_invoices WHERE id=?', id);
    const settled = await invoiceSettled(id);
    if (inv.state !== 'sent' && settled > 0.005) fail('This invoice has payments or credits applied - delete/reverse them before cancelling or making it a draft');
    if (settled > inv.total + 0.005) fail(`Invoice total (${inv.total}) cannot be less than the amount already received/credited (${settled})`);
  },
  async canDelete(id) {
    if (await invoiceSettled(id) > 0.005) fail('This invoice has receipts or credit notes applied. Delete those first.');
  },
  async decorate(row) {
    row.customer_name = (await get('SELECT name FROM parties WHERE id=?', row.customer_id))?.name;
    row.received = r2((await get(`SELECT ${SQL.invReceived('si')} v FROM sales_invoices si WHERE id=?`, row.id)).v);
    row.credited = r2((await get(`SELECT ${SQL.invCredited('si')} v FROM sales_invoices si WHERE id=?`, row.id)).v);
    row.outstanding = row.state === 'sent' ? r2(row.total - row.received - row.credited) : 0;
    row.status = (await get(`SELECT ${invoiceStatusSql()} v FROM sales_invoices si WHERE id=?`, row.id)).v;
    if (row.lines) for (const l of row.lines) l.item_name = l.item_id ? (await get('SELECT name FROM items WHERE id=?', l.item_id))?.name : null;
    return row;
  },
  async afterCreate(rid, b, user) {
    const amt = num(b.received_now, 'Amount received now', { min: 0 });
    const inv = await get('SELECT * FROM sales_invoices WHERE id=?', rid);
    if (amt > 0) {
      if (inv.state !== 'sent') fail('Payments can only be received on invoices with status "Sent"');
      await saveDoc(docs.receipts, {
        date: b.received_date || inv.date, kind: 'customer', customer_id: inv.customer_id, ref_type: 'invoice', ref_id: rid, amount: amt,
        method: b.received_method || 'Bank Transfer', money_account_id: b.received_account_id, description: `Payment for invoice ${inv.number}`,
      }, null, user);
    }
  },
  async list(q) {
    const base = `SELECT si.id, si.number, si.date, si.due_date, si.customer_id, p.name AS customer, si.subtotal, si.tax_total, si.total,
      ${SQL.invReceived('si')} AS received,
      CASE WHEN si.state='sent' THEN si.total - ${SQL.invReceived('si')} - ${SQL.invCredited('si')} ELSE 0 END AS outstanding,
      CASE WHEN si.state='sent' THEN si.total ELSE 0 END AS billed, si.state, ${invoiceStatusSql()} AS status, si.attachment
      FROM sales_invoices si JOIN parties p ON p.id=si.customer_id WHERE si.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Invoice #'], ['customer', 'Customer'], ['due_date', 'Due Date', 'date'], ['total', 'Total', 'money'],
        ['received', 'Received', 'money'], ['outstanding', 'Outstanding', 'money'], ['status', 'Status', 'badge']],
      search: ['number', 'customer', 'total', 'date', 'status'], dateCol: 'date', filters: ['status', 'customer_id'],
      sortable: ['date', 'number', 'customer', 'due_date', 'total', 'received', 'outstanding', 'status'], defaultSort: 'date', sums: ['billed', 'received', 'outstanding'],
    });
  },
});

export async function setInvoiceState(invId, state, user) {
  oneOf(state, ['draft', 'sent', 'cancelled'], 'Status');
  return await patchDoc(docs.invoices, invId, { state }, user, 'status');
}

// ---------------------------------------------------------------------------
// Receipts (money received)
// ---------------------------------------------------------------------------
async function receiptRef(row) {
  if (row.ref_type === 'invoice') {
    const inv = await get('SELECT * FROM sales_invoices WHERE id=? AND is_deleted=0', row.ref_id);
    if (!inv) fail('Referenced invoice not found or deleted');
    if (inv.state !== 'sent') fail(`Invoice ${inv.number} is ${inv.state} - receipts can only be recorded against sent invoices`);
    if (inv.customer_id !== row.customer_id) fail('The invoice belongs to a different customer');
    const settled = await invoiceSettled(inv.id);
    if (settled > inv.total + 0.005) fail(`Amount exceeds the outstanding balance of invoice ${inv.number} (${r2(inv.total - settled + row.amount)})`);
  } else if (row.ref_type === 'revenue') {
    const re = await get('SELECT * FROM revenue_entries WHERE id=? AND is_deleted=0', row.ref_id);
    if (!re) fail('Referenced revenue entry not found or deleted');
    if (re.customer_id !== row.customer_id) fail('The revenue entry belongs to a different customer');
    if (await revenueReceived(re.id) > re.amount + 0.005) fail(`Amount exceeds the outstanding balance of ${re.number}`);
  }
}
defineDoc({
  key: 'receipts', table: 'receipts', label: 'Receipt', amountField: 'amount', moneyCols: ['money_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const kind = oneOf(b.kind || 'customer', ['customer', 'other'], 'Receipt type');
    const money = await moneyAcc(idv(b.money_account_id, 'Cash/Bank account'), 'Cash/Bank account');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    const row = {
      number: await claimNumber('receipt', b.number || old?.number, 'receipts', 'number', id, date), date, kind, amount, method: str(b.method),
      money_account_id: money.id, description: str(b.description), notes: str(b.notes), attachment: str(b.attachment),
      customer_id: null, ref_type: null, ref_id: null, credit_account_id: null, source_name: null,
    };
    if (kind === 'customer') {
      row.customer_id = (await party(idv(b.customer_id, 'Customer'), 'customer', 'Customer')).id;
      if (b.ref_type) { row.ref_type = oneOf(b.ref_type, ['invoice', 'revenue'], 'Reference'); row.ref_id = idv(b.ref_id, 'Reference'); }
    } else {
      row.credit_account_id = (await accountOfType(idv(b.credit_account_id, 'Income / credit account'), ['revenue', 'liability', 'equity'], 'Credit account')).id;
      row.source_name = reqStr(b.source_name, 'Received from');
    }
    return { row };
  },
  async post(id) {
    const r = await get('SELECT * FROM receipts WHERE id=?', id);
    if (r.is_deleted) return await voidEntry('receipt', id);
    if (r.kind === 'customer') await receiptRef(r);
    const m = await get('SELECT * FROM money_accounts WHERE id=?', r.money_account_id);
    const label = r.kind === 'customer' ? (await get('SELECT name FROM parties WHERE id=?', r.customer_id)).name : r.source_name;
    await postEntry({
      sourceType: 'receipt', sourceId: id, date: r.date, memo: `Receipt ${r.number} - ${label}`,
      lines: [{ account: m.account_id, debit: r.amount },
        r.kind === 'customer' ? { account: sys('AR'), credit: r.amount, party: r.customer_id } : { account: r.credit_account_id, credit: r.amount }],
    });
  },
  async unpost(id) { await voidEntry('receipt', id); },
  async decorate(row) {
    row.customer_name = row.customer_id ? (await get('SELECT name FROM parties WHERE id=?', row.customer_id))?.name : row.source_name;
    row.account_name = (await get('SELECT name FROM money_accounts WHERE id=?', row.money_account_id))?.name;
    if (row.ref_type === 'invoice') row.ref_number = (await get('SELECT number FROM sales_invoices WHERE id=?', row.ref_id))?.number;
    if (row.ref_type === 'revenue') row.ref_number = (await get('SELECT number FROM revenue_entries WHERE id=?', row.ref_id))?.number;
    return row;
  },
  async list(q) {
    const base = `SELECT r.id, r.number, r.date, COALESCE(p.name, r.source_name) AS customer, r.customer_id,
      CASE r.ref_type WHEN 'invoice' THEN (SELECT number FROM sales_invoices WHERE id=r.ref_id) WHEN 'revenue' THEN (SELECT number FROM revenue_entries WHERE id=r.ref_id) ELSE NULL END AS reference,
      r.amount, r.method, m.name AS account, r.money_account_id, r.description, r.attachment
      FROM receipts r LEFT JOIN parties p ON p.id=r.customer_id JOIN money_accounts m ON m.id=r.money_account_id WHERE r.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Receipt #'], ['customer', 'Customer / Source'], ['reference', 'Reference'], ['amount', 'Amount', 'money'],
        ['method', 'Method'], ['account', 'Account'], ['description', 'Description']],
      search: ['number', 'customer', 'reference', 'amount', 'date', 'description', 'account'], dateCol: 'date', filters: ['customer_id', 'money_account_id', 'method'],
      sortable: ['date', 'number', 'customer', 'reference', 'amount', 'method', 'account'], defaultSort: 'date', sums: ['amount'],
    });
  },
});

// ---------------------------------------------------------------------------
// Revenue entries (direct income not raised through an invoice)
// ---------------------------------------------------------------------------
defineDoc({
  key: 'revenue', table: 'revenue_entries', label: 'Revenue entry', amountField: 'amount',
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const customer = b.customer_id ? await party(idv(b.customer_id, 'Customer'), 'customer', 'Customer') : await walkInCustomer();
    const { accountId } = await categoryAccount(idv(b.category_id, 'Revenue category'), 'revenue', 'Revenue category');
    const amount = num(b.amount, 'Amount', { required: true });
    if (amount <= 0) fail('Amount must be greater than zero');
    const due = isoDate(b.due_date || date, 'Due date');
    if (old && amount < await revenueReceived(old.id) - 0.005) fail('Amount cannot be less than the amount already received');
    return {
      row: {
        number: await claimNumber('revenue', b.number || old?.number, 'revenue_entries', 'number', id, date), date, customer_id: customer.id, category_id: b.category_id,
        account_id: accountId, description: str(b.description), reference: str(b.reference), amount, due_date: due, notes: str(b.notes), attachment: str(b.attachment),
      },
    };
  },
  async post(id) {
    const r = await get('SELECT * FROM revenue_entries WHERE id=?', id);
    if (r.is_deleted) return await voidEntry('revenue', id);
    await postEntry({ sourceType: 'revenue', sourceId: id, date: r.date, memo: `Revenue ${r.number}`, lines: [{ account: sys('AR'), debit: r.amount, party: r.customer_id }, { account: r.account_id, credit: r.amount }] });
  },
  async unpost(id) { await voidEntry('revenue', id); },
  async afterSave(id) { const r = await get('SELECT amount FROM revenue_entries WHERE id=?', id); if (await revenueReceived(id) > r.amount + 0.005) fail('Amount cannot be less than the amount already received'); },
  async canDelete(id) { if (await revenueReceived(id) > 0.005) fail('This entry has receipts recorded against it. Delete those first.'); },
  async afterCreate(rid, b, user) {
    const amt = num(b.received_now, 'Amount received now', { min: 0 });
    if (amt > 0) {
      const r = await get('SELECT * FROM revenue_entries WHERE id=?', rid);
      await saveDoc(docs.receipts, {
        date: b.received_date || r.date, kind: 'customer', customer_id: r.customer_id, ref_type: 'revenue', ref_id: rid, amount: amt,
        method: b.received_method || 'Cash', money_account_id: b.received_account_id, description: `Received for ${r.number}`,
      }, null, user);
    }
  },
  async decorate(row) {
    row.customer_name = (await get('SELECT name FROM parties WHERE id=?', row.customer_id))?.name;
    row.received = await revenueReceived(row.id); row.outstanding = r2(row.amount - row.received);
    return row;
  },
  async list() { return { rows: [], total: 0, columns: [] }; }, // the ledger view is served by the combined revenue ledger (reports.js)
});
