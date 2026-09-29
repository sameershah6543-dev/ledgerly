// Simple mode: the small set of actions a shop owner needs (buy & sell, spend, who owes what, profit).
// Everything goes through the full double-entry documents underneath, so the books stay balanced.
import { all, get, run, insert, tx } from './db.js';
import { fail, r2, num, str, reqStr, id as idv, isoDate, today, addMonths, monthEnd } from './util.js';
import { docs, saveDoc, deleteDoc } from './docs.js';
import { saveItem, itemList, movementList } from './modules/stock.js';
import { moneyAccountsList } from './modules/masters.js';
import { walkInCustomer, findOrCreateSupplier, moneyAcc } from './finance.js';
import { sys } from './coa.js';

const monthStart = (d) => `${d.slice(0, 7)}-01`;
// cash first - it is the everyday default for a shop
export const moneyList = async () => (await moneyAccountsList()).filter((m) => m.active).sort((a, b) => (a.kind === 'cash' ? 0 : 1) - (b.kind === 'cash' ? 0 : 1) || a.id - b.id)
  .map((m) => ({ id: m.id, name: m.name, kind: m.kind, balance: r2(m.balance) }));
const range = (q) => {
  const to = q.to || today(); const from = q.from || '0000-01-01';
  if (from > to) fail('The start date is after the end date');
  return { from, to };
};
const method = async (moneyId) => ((await get('SELECT kind FROM money_accounts WHERE id=?', moneyId))?.kind === 'cash' ? 'Cash' : 'Bank Transfer');

async function findOrCreateCustomer(name) {
  const n = String(name || '').trim();
  if (!n) return await walkInCustomer();
  const p = await get("SELECT * FROM parties WHERE kind='customer' AND lower(name)=lower(?) AND is_deleted=0", n);
  return p || await get('SELECT * FROM parties WHERE id=?', await insert('parties', { kind: 'customer', name: n }));
}

// ---------------------------------------------------------------------------
// Profit & loss figures straight from the ledger
// ---------------------------------------------------------------------------
async function totals(from, to) {
  const rows = await all(`SELECT a.type, a.subtype, a.name, SUM(l.debit - l.credit) AS dr
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
    WHERE e.status='posted' AND e.date BETWEEN ? AND ? AND a.type IN ('revenue','expense') GROUP BY a.id`, from, to);
  let sales = 0, other = 0, cogs = 0, expenses = 0; const byExpense = [];
  for (const r of rows) {
    if (r.type === 'revenue') { if (r.subtype === 'other_revenue') other += -r.dr; else sales += -r.dr; }
    else if (r.subtype === 'cogs') cogs += r.dr;
    else if (Math.abs(r.dr) > 0.005) { expenses += r.dr; byExpense.push({ name: r.name, amount: r2(r.dr) }); }
  }
  byExpense.sort((a, b) => b.amount - a.amount);
  const gross = sales - cogs;
  return { sales: r2(sales), other_income: r2(other), cost_of_sales: r2(cogs), gross_profit: r2(gross), expenses: r2(expenses), net_profit: r2(gross + other - expenses), expense_breakdown: byExpense };
}

export async function summary(q) {
  const { from, to } = range(q);
  const t = await totals(from, to);
  const count = (await get("SELECT COUNT(*) n FROM sales_invoices WHERE is_deleted=0 AND state='sent' AND date BETWEEN ? AND ?", from, to)).n;
  // six-month trend ending at the range end
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const s = addMonths(monthStart(to), -i);
    const m = await totals(s, monthEnd(s));
    trend.push({ month: s.slice(0, 7), sales: m.sales, profit: m.net_profit, expenses: r2(m.expenses + m.cost_of_sales) });
  }
  return {
    from, to, ...t, sales_count: count, trend,
    money: await moneyList(),
    owed: { receive: (await openList('receive')).total, pay: (await openList('pay')).total },
    recent: (await salesList({ from, to, limit: 5 })).rows,
  };
}

// ---------------------------------------------------------------------------
// Sales: buy a phone, sell it. Each sale is a purchase (what you paid - cost of sales)
// linked to a sale (what you sold it for). No stock is counted.
// ---------------------------------------------------------------------------
// receipts/payments created together with the sale/purchase are tagged so an edit replaces only them
const AT_SALE = 'at-sale', AT_PURCHASE = 'at-purchase';
const atSaleSql = `(r.notes='${AT_SALE}' OR (r.notes IS NULL AND r.description LIKE 'Sale %'))`;
const statusOf = (total, paid) => (paid >= total - 0.005 ? 'paid' : paid > 0.005 ? 'part' : 'unpaid');
export const GENERAL_SUPPLIER = 'General Supplier';

// the purchase side of a sale is booked straight to Cost of Goods Sold through this (hidden) category
async function costCategory() {
  const acc = sys('COGS');
  const c = await get("SELECT id FROM categories WHERE kind='expense' AND account_id=?", acc);
  return c ? c.id : insert('categories', { kind: 'expense', name: 'Cost of items sold', account_id: acc, active: 0 });
}
const salesCategory = async () => (await get("SELECT id FROM categories WHERE kind='revenue' AND account_id=?", sys('SALES')))?.id;

export async function salesList(q = {}) {
  const { from, to } = range(q);
  const s = q.search ? `%${String(q.search).toLowerCase()}%` : null;
  const rows = await all(`SELECT * FROM (SELECT si.id, si.number, si.date, p.name AS customer, si.notes AS note, si.total,
      si.subtotal - si.discount_total AS net, si.purchase_bill_id,
      (SELECT GROUP_CONCAT(COALESCE(i.name, l.description), ', ') FROM sales_invoice_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.invoice_id=si.id) AS product,
      (SELECT COALESCE(SUM(qty),0) FROM sales_invoice_lines WHERE invoice_id=si.id) AS qty,
      COALESCE((SELECT pi.subtotal FROM purchase_invoices pi WHERE pi.id=si.purchase_bill_id AND pi.is_deleted=0),
        (SELECT COALESCE(SUM(qty*unit_cost),0) FROM sales_invoice_lines WHERE invoice_id=si.id)) AS cost,
      (SELECT sp.name FROM purchase_invoices pi JOIN parties sp ON sp.id=pi.supplier_id WHERE pi.id=si.purchase_bill_id) AS bought_from,
      (SELECT COALESCE(SUM(x.amount),0) FROM payments x WHERE x.ref_type='purchase_invoice' AND x.ref_id=si.purchase_bill_id AND x.is_deleted=0) AS cost_paid,
      (SELECT COALESCE(SUM(x.amount),0) FROM payments x WHERE x.ref_type='purchase_invoice' AND x.ref_id=si.purchase_bill_id AND x.is_deleted=0 AND x.notes='${AT_PURCHASE}') AS cost_paid_at_purchase,
      (SELECT x.money_account_id FROM payments x WHERE x.ref_type='purchase_invoice' AND x.ref_id=si.purchase_bill_id AND x.is_deleted=0 ORDER BY x.id LIMIT 1) AS cost_account_id,
      (SELECT COALESCE(SUM(r.amount),0) FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0) AS received,
      (SELECT COALESCE(SUM(r.amount),0) FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0 AND ${atSaleSql}) AS paid_at_sale,
      (SELECT r.money_account_id FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0 ORDER BY r.id LIMIT 1) AS money_account_id
    FROM sales_invoices si JOIN parties p ON p.id=si.customer_id
    WHERE si.is_deleted=0 AND si.state='sent' AND si.date BETWEEN ? AND ?)
    WHERE ? IS NULL OR lower(product || ' ' || customer || ' ' || COALESCE(bought_from,'') || ' ' || COALESCE(note,'') || ' ' || number) LIKE ?
    ORDER BY date DESC, id DESC ${q.limit ? 'LIMIT ' + Number(q.limit) : ''}`, from, to, s, s);
  for (const r of rows) {
    r.cost = r2(r.cost); r.profit = r2(r.net - r.cost); r.unit_price = r.qty ? r2(r.net / r.qty) : 0; r.unit_cost = r.qty ? r2(r.cost / r.qty) : 0;
    r.received = r2(r.received); r.paid_at_sale = r2(r.paid_at_sale); r.due = r2(r.total - r.received); r.status = statusOf(r.total, r.received);
    r.cost_paid = r2(r.cost_paid); r.cost_paid_at_purchase = r2(r.cost_paid_at_purchase); r.cost_due = r.purchase_bill_id ? r2(r.cost - r.cost_paid) : 0;
    if (r.customer === 'Walk-in Customer') r.customer = '';
    if (r.bought_from === GENERAL_SUPPLIER) r.bought_from = '';
  }
  const sum = (k) => r2(rows.reduce((a, r) => a + r[k], 0));
  return { rows, summary: { count: rows.length, sales: sum('net'), cost: sum('cost'), profit: sum('profit'), due: sum('due') } };
}

// how much was paid at the time: '' / missing = all of it
const paidAmount = (v, total, label) => {
  if (v === undefined || v === null || v === '') return total;
  const p = num(v, label, { min: 0 });
  if (p > total + 0.005) fail(`${label} cannot be more than the total (${total})`);
  return r2(p);
};

async function saleBody(b) {
  const date = isoDate(b.date || today(), 'Date');
  const name = reqStr(b.item_name, 'What you sold');
  const qty = num(b.qty ?? 1, 'Quantity', { required: true }); if (qty <= 0) fail('Quantity must be more than zero');
  const price = num(b.unit_price, 'Sold for', { required: true, min: 0 }); if (price <= 0) fail('Enter how much you sold it for');
  const cost = num(b.unit_cost, 'Bought for', { required: true, min: 0 });
  const total = r2(qty * price), costTotal = r2(qty * cost);
  const paid = paidAmount(b.paid, total, 'Amount received');
  if (paid < total - 0.005 && !str(b.customer_name)) fail('Enter the customer’s name so you know who owes you the rest');
  const costPaid = costTotal > 0 ? paidAmount(b.cost_paid, costTotal, 'Amount paid for it') : 0;
  if (costPaid < costTotal - 0.005 && !str(b.supplier_name)) fail('Enter who you bought it from, so you know who you owe');
  return {
    date, name, qty, price, cost, total, costTotal, paid, costPaid, note: str(b.note),
    money: paid > 0 ? await moneyAcc(idv(b.money_account_id, 'Received into'), 'Received into') : null,
    costMoney: costPaid > 0 ? await moneyAcc(idv(b.cost_account_id || b.money_account_id, 'Paid from'), 'Paid from') : null,
    customerId: (await findOrCreateCustomer(b.customer_name)).id,
    supplierId: (await findOrCreateSupplier(str(b.supplier_name) || GENERAL_SUPPLIER)).id,
  };
}
async function receive(invId, date, money, amount, user, notes = AT_SALE, description = null) {
  const inv = await get('SELECT * FROM sales_invoices WHERE id=?', invId);
  await saveDoc(docs.receipts, { date, kind: 'customer', customer_id: inv.customer_id, ref_type: 'invoice', ref_id: invId, amount, method: await method(money.id), money_account_id: money.id, description: description || `Sale ${inv.number}`, notes }, null, user);
}
async function payBill(billId, date, money, amount, user, notes = AT_PURCHASE, description = null) {
  const bill = await get('SELECT * FROM purchase_invoices WHERE id=?', billId);
  await saveDoc(docs.payments, { date, category: 'supplier_invoice', party_id: bill.supplier_id, ref_id: billId, amount, method: await method(money.id), money_account_id: money.id, description: description || `Purchase ${bill.number}`, notes }, null, user);
}
async function dropReceipts(invId, user, { atSaleOnly = false } = {}) {
  for (const r of await all(`SELECT id FROM receipts r WHERE ref_type='invoice' AND ref_id=? AND is_deleted=0 ${atSaleOnly ? `AND ${atSaleSql}` : ''}`, invId)) await deleteDoc(docs.receipts, r.id, user);
}
async function dropBillPayments(billId, user, { atPurchaseOnly = false } = {}) {
  for (const r of await all(`SELECT id FROM payments WHERE ref_type='purchase_invoice' AND ref_id=? AND is_deleted=0 ${atPurchaseOnly ? `AND notes='${AT_PURCHASE}'` : ''}`, billId)) await deleteDoc(docs.payments, r.id, user);
}
// write both halves; ids given = update in place (later payments are kept)
async function writeSale(s, user, invId = null, billId = null) {
  const billDoc = { supplier_id: s.supplierId, date: s.date, due_date: s.date, notes: s.note,
    lines: [{ description: s.name, qty: s.qty, unit_price: s.cost, tax_rate: 0, expense_category_id: await costCategory() }] };
  let bill = null;
  if (s.costTotal > 0) bill = await saveDoc(docs.bills, billDoc, billId, user);
  else if (billId) { await dropBillPayments(billId, user); await deleteDoc(docs.bills, billId, user); }
  const inv = await saveDoc(docs.invoices, {
    customer_id: s.customerId, date: s.date, due_date: s.date, state: 'sent', notes: s.note,
    lines: [{ description: s.name, qty: s.qty, unit_price: s.price, tax_rate: 0, revenue_category_id: await salesCategory() }],
  }, invId, user);
  await run('UPDATE sales_invoices SET purchase_bill_id=? WHERE id=?', bill?.id ?? null, inv.id);
  if (s.paid > 0) await receive(inv.id, s.date, s.money, s.paid, user);
  if (bill && s.costPaid > 0) await payBill(bill.id, s.date, s.costMoney, s.costPaid, user);
  return { id: inv.id };
}
export async function createSale(b, user) {
  return await tx(async () => writeSale(await saleBody(b), user));
}
export async function updateSale(id, b, user) {
  return await tx(async () => {
    const inv = await get('SELECT * FROM sales_invoices WHERE id=? AND is_deleted=0', id); if (!inv) fail('Sale not found', 404);
    await dropReceipts(id, user, { atSaleOnly: true }); // payments made later stay
    if (inv.purchase_bill_id) await dropBillPayments(inv.purchase_bill_id, user, { atPurchaseOnly: true });
    return writeSale(await saleBody(b), user, id, inv.purchase_bill_id || null);
  });
}
export async function deleteSale(id, user) {
  return await tx(async () => {
    const inv = await get('SELECT * FROM sales_invoices WHERE id=? AND is_deleted=0', id); if (!inv) fail('Sale not found', 404);
    await dropReceipts(id, user); await deleteDoc(docs.invoices, id, user);
    if (inv.purchase_bill_id) { await dropBillPayments(inv.purchase_bill_id, user); await deleteDoc(docs.bills, inv.purchase_bill_id, user); }
    return { ok: true };
  });
}
// names of things sold before, for autocomplete
export async function itemNames() {
  return (await all(`SELECT name FROM (SELECT COALESCE(i.name, l.description) AS name, MAX(l.id) AS last FROM sales_invoice_lines l
    LEFT JOIN items i ON i.id=l.item_id JOIN sales_invoices si ON si.id=l.invoice_id WHERE si.is_deleted=0 GROUP BY lower(COALESCE(i.name, l.description))) ORDER BY last DESC LIMIT 200`)).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Expenses (paid now, or pay later)
// ---------------------------------------------------------------------------
export async function expenseList(q = {}) {
  const { from, to } = range(q);
  const s = q.search ? `%${String(q.search).toLowerCase()}%` : null;
  const rows = await all(`SELECT e.id, e.number, e.date, e.category_id, c.name AS category, e.description, e.amount, e.mode, e.vendor_name AS paid_to,
      e.money_account_id, m.name AS paid_from,
      CASE WHEN e.mode='paid' THEN e.amount ELSE (SELECT COALESCE(SUM(x.amount),0) FROM payments x WHERE x.ref_type='expense' AND x.ref_id=e.id AND x.is_deleted=0) END AS paid
    FROM expenses e JOIN categories c ON c.id=e.category_id LEFT JOIN money_accounts m ON m.id=e.money_account_id
    WHERE e.is_deleted=0 AND e.date BETWEEN ? AND ? AND (? IS NULL OR lower(c.name || ' ' || COALESCE(e.description,'') || ' ' || COALESCE(e.vendor_name,'')) LIKE ?)
    ORDER BY e.date DESC, e.id DESC`, from, to, s, s);
  for (const r of rows) { r.paid = r2(r.paid); r.due = r2(r.amount - r.paid); r.status = statusOf(r.amount, r.paid); }
  return { rows, summary: { count: rows.length, total: r2(rows.reduce((a, r) => a + r.amount, 0)), due: r2(rows.reduce((a, r) => a + r.due, 0)) } };
}
export async function saveExpense(b, id, user) {
  return await tx(async () => {
    const later = b.pay_later === true || b.pay_later === 'true' || b.pay_later === 1;
    const who = str(b.paid_to);
    if (later && !who) fail('Enter who you need to pay');
    if (who) await findOrCreateSupplier(who); // so the expense shows up in that person's ledger
    const e = await saveDoc(docs.expenses, {
      date: b.date || today(), category_id: b.category_id, amount: b.amount, description: b.description, vendor_name: who,
      mode: later ? 'credit' : 'paid', money_account_id: later ? null : b.money_account_id, method: later ? null : await method(b.money_account_id), due_date: later ? b.date || today() : null,
    }, id, user);
    return { id: e.id };
  });
}
export const deleteExpense = async (id, user) => await deleteDoc(docs.expenses, id, user);
export const expenseCategories = async () => await all("SELECT id, name FROM categories WHERE kind='expense' AND active=1 ORDER BY name");

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
export async function inventory(q = {}) {
  const r = await itemList({ size: 'all', q: q.search || undefined });
  const rows = r.rows.filter((i) => i.active).map((i) => ({
    id: i.id, name: i.name, sku: i.sku, is_service: i.is_service, cost: r2(i.current_stock > 0 && i.stock_value > 0 ? i.stock_value / i.current_stock : i.purchase_price),
    purchase_price: i.purchase_price, selling_price: i.selling_price, stock: i.current_stock, sold: i.sold, value: r2(i.stock_value), min_stock: i.min_stock,
    status: i.is_service ? 'service' : i.current_stock <= 0 ? 'out' : i.current_stock <= i.min_stock ? 'low' : 'ok',
  }));
  return { rows, summary: r.summary };
}
export async function saveProduct(b, id, user) {
  const old = id ? await get('SELECT * FROM items WHERE id=? AND is_deleted=0', id) : null;
  if (id && !old) fail('Product not found', 404);
  const body = { ...(old || {}), name: b.name, sku: b.sku === undefined ? old?.sku : b.sku, purchase_price: b.purchase_price, selling_price: b.selling_price, min_stock: b.min_stock ?? old?.min_stock ?? 0 };
  // starting quantity is only set when the product is created; after that use "Add stock"
  body.opening_stock = old ? old.opening_stock : b.opening_stock;
  return await saveItem(body, id, user);
}
export async function restock(b, user) {
  return await tx(async () => {
    const item = await get('SELECT * FROM items WHERE id=? AND is_deleted=0', idv(b.item_id, 'Product')); if (!item) fail('Product not found');
    if (item.is_service) fail('Services have no stock');
    const qty = num(b.qty, 'Quantity', { required: true }); if (qty <= 0) fail('Quantity must be more than zero');
    const cost = num(b.unit_cost, 'Cost per unit', { required: true, min: 0 }); if (cost <= 0) fail('Cost per unit must be more than zero');
    const date = isoDate(b.date || today(), 'Date');
    const total = r2(qty * cost);
    const paid = paidAmount(b.paid, total, 'Amount paid');
    if (paid < total - 0.005 && !str(b.supplier_name)) fail('Enter the supplier’s name so you know who you owe');
    const money = paid > 0 ? await moneyAcc(idv(b.money_account_id, 'Paid from'), 'Paid from') : null;
    const supplier = await findOrCreateSupplier(str(b.supplier_name) || 'General Supplier');
    const bill = await saveDoc(docs.bills, { supplier_id: supplier.id, date, due_date: date, lines: [{ item_id: item.id, qty, unit_price: cost, tax_rate: 0 }] }, null, user);
    if (paid > 0) await saveDoc(docs.payments, { date, category: 'supplier_invoice', party_id: supplier.id, ref_id: bill.id, amount: paid, method: await method(money.id), money_account_id: money.id, description: `Stock ${bill.number}`, notes: AT_PURCHASE }, null, user);
    return { ok: true };
  });
}
export const stockHistory = async (itemId) => await movementList({ item_id: itemId, size: 'all', sort: 'date', dir: 'DESC' });

// ---------------------------------------------------------------------------
// Receivables & payables: what is still owed, by person
// ---------------------------------------------------------------------------
export async function openList(kind) {
  const items = kind === 'receive'
    ? await all(`SELECT 'invoice' AS type, si.id, si.number, si.date, p.id AS party_id, p.name AS person, si.total,
        (SELECT GROUP_CONCAT(COALESCE(i.name, l.description) || ' × ' || (CASE WHEN l.qty = CAST(l.qty AS INTEGER) THEN CAST(l.qty AS INTEGER) ELSE l.qty END), ', ') FROM sales_invoice_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.invoice_id=si.id) AS what,
        (SELECT COALESCE(SUM(amount),0) FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0)
        + (SELECT COALESCE(SUM(total),0) FROM stock_returns sr WHERE sr.kind='sales' AND sr.settlement='credit' AND sr.ref_id=si.id AND sr.is_deleted=0) AS paid
      FROM sales_invoices si JOIN parties p ON p.id=si.customer_id WHERE si.is_deleted=0 AND si.state='sent'`)
    : [...await all(`SELECT 'bill' AS type, pi.id, pi.number, pi.date, p.id AS party_id, p.name AS person, pi.total,
        (SELECT 'Bought ' || GROUP_CONCAT(COALESCE(i.name, l.description) || ' × ' || (CASE WHEN l.qty = CAST(l.qty AS INTEGER) THEN CAST(l.qty AS INTEGER) ELSE l.qty END), ', ') FROM purchase_invoice_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.invoice_id=pi.id) AS what,
        (SELECT COALESCE(SUM(amount),0) FROM payments x WHERE x.ref_type='purchase_invoice' AND x.ref_id=pi.id AND x.is_deleted=0)
        + (SELECT COALESCE(SUM(total),0) FROM stock_returns sr WHERE sr.kind='purchase' AND sr.settlement='credit' AND sr.ref_id=pi.id AND sr.is_deleted=0) AS paid
      FROM purchase_invoices pi JOIN parties p ON p.id=pi.supplier_id WHERE pi.is_deleted=0 AND pi.state='posted'`),
    ...await all(`SELECT 'expense' AS type, e.id, e.number, e.date, p.id AS party_id, p.name AS person, e.amount AS total,
        c.name || COALESCE(' - ' || e.description, '') AS what,
        (SELECT COALESCE(SUM(amount),0) FROM payments x WHERE x.ref_type='expense' AND x.ref_id=e.id AND x.is_deleted=0) AS paid
      FROM expenses e JOIN parties p ON p.id=e.vendor_id JOIN categories c ON c.id=e.category_id WHERE e.is_deleted=0 AND e.mode='credit'`)];
  const open = items.map((i) => ({ ...i, paid: r2(i.paid), due: r2(i.total - i.paid) })).filter((i) => i.due > 0.005)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const people = new Map();
  for (const i of open) {
    const k = i.person.toLowerCase();
    if (!people.has(k)) people.set(k, { person: i.person, due: 0, oldest: i.date, items: [] });
    const p = people.get(k); p.due = r2(p.due + i.due); p.items.push(i);
  }
  const list = [...people.values()].sort((a, b) => b.due - a.due);
  return { people: list, total: r2(list.reduce((a, p) => a + p.due, 0)), count: open.length };
}

// Record money received / paid - against one item, or against a person's oldest items first.
export async function settle(b, user) {
  return await tx(async () => {
    const kind = b.kind === 'pay' ? 'pay' : 'receive';
    let amount = r2(num(b.amount, 'Amount', { required: true })); if (amount <= 0) fail('Amount must be more than zero');
    const money = await moneyAcc(idv(b.money_account_id, kind === 'pay' ? 'Paid from' : 'Received into'), 'Account');
    const date = isoDate(b.date || today(), 'Date');
    const open = (await openList(kind)).people.flatMap((p) => p.items);
    const targets = b.type && b.id
      ? open.filter((i) => i.type === b.type && i.id === Number(b.id))
      : open.filter((i) => i.person.toLowerCase() === String(b.person || '').trim().toLowerCase());
    if (!targets.length) fail('Nothing is owed here any more');
    const owed = r2(targets.reduce((a, i) => a + i.due, 0));
    if (amount > owed + 0.005) fail(`That is more than what is owed (${owed})`);
    const note = str(b.note);
    for (const i of targets) {
      if (amount <= 0.005) break;
      const part = r2(Math.min(amount, i.due)); amount = r2(amount - part);
      const m = await method(money.id);
      if (i.type === 'invoice') await receive(i.id, date, money, part, user, note, `Payment for ${i.number}`);
      else if (i.type === 'bill') await saveDoc(docs.payments, { date, category: 'supplier_invoice', party_id: i.party_id, ref_id: i.id, amount: part, method: m, money_account_id: money.id, description: `Payment for ${i.number}`, notes: note }, null, user);
      else await saveDoc(docs.payments, { date, category: 'expense_bill', ref_id: i.id, amount: part, method: m, money_account_id: money.id, description: `Payment for ${i.number}`, notes: note }, null, user);
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Ledgers: everyone you deal with, and the full history with each of them
// ---------------------------------------------------------------------------
const HIDDEN = ['walk-in customer', GENERAL_SUPPLIER.toLowerCase()];
export async function people(q = {}) {
  const rows = await all(`SELECT p.id, p.kind, p.name, p.phone,
      COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
        WHERE je.status='posted' AND jl.party_id=p.id AND jl.account_id IN (?, ?)), 0) AS net,
      (SELECT COALESCE(SUM(total),0) FROM sales_invoices WHERE customer_id=p.id AND is_deleted=0 AND state='sent') AS sold,
      (SELECT COALESCE(SUM(total),0) FROM purchase_invoices WHERE supplier_id=p.id AND is_deleted=0 AND state='posted')
        + (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE vendor_id=p.id AND is_deleted=0) AS bought,
      MAX(COALESCE((SELECT MAX(date) FROM sales_invoices WHERE customer_id=p.id AND is_deleted=0), ''),
          COALESCE((SELECT MAX(date) FROM purchase_invoices WHERE supplier_id=p.id AND is_deleted=0), ''),
          COALESCE((SELECT MAX(date) FROM expenses WHERE vendor_id=p.id AND is_deleted=0), ''),
          COALESCE((SELECT MAX(date) FROM receipts WHERE customer_id=p.id AND is_deleted=0), ''),
          COALESCE((SELECT MAX(date) FROM payments WHERE party_id=p.id AND is_deleted=0), '')) AS last
    FROM parties p WHERE p.is_deleted=0`, sys('AR'), sys('AP'));
  const map = new Map();
  for (const r of rows) {
    const k = r.name.toLowerCase(); if (HIDDEN.includes(k)) continue;
    if (!map.has(k)) map.set(k, { name: r.name, phone: r.phone, balance: 0, sold: 0, bought: 0, last: '', customer: false, supplier: false });
    const p = map.get(k);
    p.balance = r2(p.balance + r.net); p.sold = r2(p.sold + r.sold); p.bought = r2(p.bought + r.bought);
    if (r.last > p.last) p.last = r.last; p[r.kind] = true; if (!p.phone) p.phone = r.phone;
  }
  const s = String(q.search || '').trim().toLowerCase();
  const list = [...map.values()].filter((p) => !s || p.name.toLowerCase().includes(s)).sort((a, b) => (b.last || '').localeCompare(a.last || '') || a.name.localeCompare(b.name));
  return {
    rows: list,
    summary: { people: list.length, to_receive: r2(list.reduce((a, p) => a + Math.max(0, p.balance), 0)), to_pay: r2(list.reduce((a, p) => a + Math.max(0, -p.balance), 0)) },
  };
}

// balance > 0: they owe you; < 0: you owe them
export async function ledger(name) {
  const n = String(name || '').trim(); if (!n) fail('Choose a person');
  const ids = await all('SELECT id, kind, name, phone FROM parties WHERE lower(name)=lower(?) AND is_deleted=0', n);
  if (!ids.length) fail('Person not found', 404);
  const C = ids.filter((p) => p.kind === 'customer').map((p) => p.id), P = ids.filter((p) => p.kind === 'supplier').map((p) => p.id);
  const inC = C.length ? C.join(',') : '0', inP = P.length ? P.join(',') : '0';
  const ev = [];
  for (const r of await all(`SELECT si.id, si.number, si.date, si.total, si.notes,
      (SELECT GROUP_CONCAT(COALESCE(i.name, l.description) || ' × ' || (CASE WHEN l.qty = CAST(l.qty AS INTEGER) THEN CAST(l.qty AS INTEGER) ELSE l.qty END), ', ') FROM sales_invoice_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.invoice_id=si.id) AS what
      FROM sales_invoices si WHERE si.customer_id IN (${inC}) AND si.is_deleted=0 AND si.state='sent'`))
    ev.push({ date: r.date, seq: 1, kind: 'sale', ref: { type: 'invoice', id: r.id }, number: r.number, details: `Sold ${r.what}`, note: r.notes, amount: r.total, effect: r.total });
  for (const r of await all(`SELECT r.id, r.number, r.date, r.amount, r.notes, m.name AS account FROM receipts r JOIN money_accounts m ON m.id=r.money_account_id
      WHERE r.customer_id IN (${inC}) AND r.is_deleted=0`))
    ev.push({ date: r.date, seq: 2, kind: 'received', ref: { type: 'receipt', id: r.id }, number: r.number, details: `Received (${r.account})`, note: r.notes === AT_SALE ? 'At the time of sale' : r.notes, amount: r.amount, effect: -r.amount });
  for (const r of await all(`SELECT pi.id, pi.number, pi.date, pi.total,
      (SELECT GROUP_CONCAT(COALESCE(i.name, l.description) || ' × ' || (CASE WHEN l.qty = CAST(l.qty AS INTEGER) THEN CAST(l.qty AS INTEGER) ELSE l.qty END), ', ') FROM purchase_invoice_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.invoice_id=pi.id) AS what
      FROM purchase_invoices pi WHERE pi.supplier_id IN (${inP}) AND pi.is_deleted=0 AND pi.state='posted'`))
    ev.push({ date: r.date, seq: 1, kind: 'bought', ref: { type: 'bill', id: r.id }, number: r.number, details: `Bought ${r.what}`, amount: r.total, effect: -r.total });
  for (const r of await all(`SELECT e.id, e.number, e.date, e.amount, e.mode, e.description, c.name AS category, m.name AS account
      FROM expenses e JOIN categories c ON c.id=e.category_id LEFT JOIN money_accounts m ON m.id=e.money_account_id WHERE e.vendor_id IN (${inP}) AND e.is_deleted=0`)) {
    if (r.mode === 'credit') ev.push({ date: r.date, seq: 1, kind: 'bought', ref: { type: 'expense', id: r.id }, number: r.number, details: `Expense: ${r.category}`, note: r.description, amount: r.amount, effect: -r.amount });
    else ev.push({ date: r.date, seq: 1, kind: 'paid_expense', ref: { type: 'expense', id: r.id }, number: r.number, details: `Expense: ${r.category} — paid (${r.account})`, note: r.description, amount: r.amount, effect: 0 });
  }
  for (const r of await all(`SELECT x.id, x.number, x.date, x.amount, x.notes, m.name AS account FROM payments x JOIN money_accounts m ON m.id=x.money_account_id
      WHERE x.party_id IN (${inP}) AND x.is_deleted=0 AND x.category IN ('supplier_invoice','expense_bill')`))
    ev.push({ date: r.date, seq: 2, kind: 'paid', ref: { type: 'payment', id: r.id }, number: r.number, details: `Paid (${r.account})`, note: r.notes === AT_PURCHASE ? 'At the time of purchase' : r.notes, amount: r.amount, effect: r.amount });
  ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq || a.ref.id - b.ref.id));
  let bal = 0;
  for (const e of ev) { bal = r2(bal + e.effect); e.balance = bal; }
  const sum = (k) => r2(ev.filter((e) => e.kind === k).reduce((a, e) => a + e.amount, 0));
  return {
    name: ids[0].name, phone: ids.find((p) => p.phone)?.phone || null, customer: C.length > 0, supplier: P.length > 0,
    rows: ev.reverse(), balance: bal,
    summary: { sold: sum('sale'), received: sum('received'), bought: r2(sum('bought') + sum('paid_expense')), paid: r2(sum('paid') + sum('paid_expense')) },
  };
}
// undo a payment recorded by mistake
export async function deleteMoney(type, id, user) {
  if (type === 'receipt') return await deleteDoc(docs.receipts, id, user);
  if (type === 'payment') return await deleteDoc(docs.payments, id, user);
  fail('Unknown entry');
}
// names already used, for autocomplete
export async function names() {
  return (await all("SELECT DISTINCT name FROM parties WHERE is_deleted=0 AND lower(name)<>'walk-in customer' ORDER BY lower(name)")).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Start fresh: remove every transaction and product, keep settings, users and accounts
// ---------------------------------------------------------------------------
export async function clearAllData() {
  return await tx(async () => {
    for (const t of ['stock_movements', 'journal_lines', 'journal_entries', 'sales_invoice_lines', 'purchase_invoice_lines', 'receipts', 'payments',
      'stock_returns', 'stock_adjustments', 'transfers', 'asset_depreciations', 'assets', 'capital_transactions', 'liabilities', 'revenue_entries',
      'expenses', 'sales_invoices', 'purchase_invoices', 'items', 'parties', 'audit_log', 'sequences']) await run(`DELETE FROM ${t}`);
    await run('UPDATE money_accounts SET opening_balance=0');
    return { ok: true };
  });
}
