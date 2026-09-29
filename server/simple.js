// Simple mode: the small set of actions a shop owner needs (sell, spend, stock, profit).
// Everything goes through the full double-entry documents underneath, so the books stay balanced.
import { all, get, run, insert, tx } from './db.js';
import { fail, r2, num, str, reqStr, id as idv, isoDate, today, addMonths, monthEnd } from './util.js';
import { docs, saveDoc, deleteDoc } from './docs.js';
import { saveItem, itemList, movementList } from './modules/stock.js';
import { moneyAccountsList } from './modules/masters.js';
import { walkInCustomer, findOrCreateSupplier, moneyAcc } from './finance.js';

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
  const stock = await itemList({ size: 'all' });
  return {
    from, to, ...t, sales_count: count, trend,
    stock: { products: stock.summary.items, value: stock.summary.value, low: stock.summary.low, out: stock.summary.out },
    money: await moneyList(),
    recent: (await salesList({ from, to, limit: 5 })).rows,
    low_stock: stock.rows.filter((i) => !i.is_service && i.active && i.current_stock <= i.min_stock).slice(0, 5)
      .map((i) => ({ id: i.id, name: i.name, stock: i.current_stock, min: i.min_stock })),
  };
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------
export async function salesList(q = {}) {
  const { from, to } = range(q);
  const s = q.search ? `%${String(q.search).toLowerCase()}%` : null;
  const rows = await all(`SELECT * FROM (SELECT si.id, si.number, si.date, p.name AS customer, si.notes AS note, si.total,
      si.subtotal - si.discount_total AS net,
      (SELECT GROUP_CONCAT(COALESCE(i.name, l.description), ', ') FROM sales_invoice_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.invoice_id=si.id) AS product,
      (SELECT l.item_id FROM sales_invoice_lines l WHERE l.invoice_id=si.id ORDER BY l.id LIMIT 1) AS item_id,
      (SELECT COALESCE(SUM(qty),0) FROM sales_invoice_lines WHERE invoice_id=si.id) AS qty,
      (SELECT COALESCE(SUM(qty*unit_cost),0) FROM sales_invoice_lines WHERE invoice_id=si.id) AS cost,
      (SELECT r.money_account_id FROM receipts r WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0 ORDER BY r.id LIMIT 1) AS money_account_id,
      (SELECT m.name FROM receipts r JOIN money_accounts m ON m.id=r.money_account_id WHERE r.ref_type='invoice' AND r.ref_id=si.id AND r.is_deleted=0 ORDER BY r.id LIMIT 1) AS paid_into
    FROM sales_invoices si JOIN parties p ON p.id=si.customer_id
    WHERE si.is_deleted=0 AND si.state='sent' AND si.date BETWEEN ? AND ?)
    WHERE ? IS NULL OR lower(product || ' ' || customer || ' ' || COALESCE(note,'') || ' ' || number) LIKE ?
    ORDER BY date DESC, id DESC ${q.limit ? 'LIMIT ' + Number(q.limit) : ''}`, from, to, s, s);
  for (const r of rows) { r.cost = r2(r.cost); r.profit = r2(r.net - r.cost); r.unit_price = r.qty ? r2(r.net / r.qty) : 0; r.unit_cost = r.qty ? r2(r.cost / r.qty) : 0; if (r.customer === 'Walk-in Customer') r.customer = ''; }
  const sum = (k) => r2(rows.reduce((a, r) => a + r[k], 0));
  return { rows, summary: { count: rows.length, sales: await sum('net'), cost: await sum('cost'), profit: await sum('profit') } };
}

async function saleBody(b, user) {
  const date = isoDate(b.date || today(), 'Date');
  const qty = num(b.qty, 'Quantity', { required: true }); if (qty <= 0) fail('Quantity must be more than zero');
  const price = num(b.unit_price, 'Selling price', { required: true, min: 0 }); if (price <= 0) fail('Selling price must be more than zero');
  const cost = b.unit_cost === '' || b.unit_cost === null || b.unit_cost === undefined ? null : num(b.unit_cost, 'Cost price', { min: 0 });
  const money = await moneyAcc(idv(b.money_account_id, 'Received into'), 'Received into');
  let itemId = b.item_id ? idv(b.item_id, 'Product') : null;
  if (!itemId) {
    // a product that is not in the inventory yet: add it with exactly the quantity being sold
    const name = reqStr(b.item_name, 'Product');
    if (cost === null) fail('Enter what this product cost you, so the profit can be worked out');
    if (await get('SELECT id FROM items WHERE lower(name)=lower(?) AND is_deleted=0', name)) fail(`"${name}" is already in your inventory - pick it from the list`);
    itemId = (await saveItem({ name, purchase_price: cost, selling_price: price, opening_stock: qty, opening_date: date }, null, user)).id;
  }
  const item = await get('SELECT * FROM items WHERE id=? AND is_deleted=0', itemId); if (!item) fail('Product not found');
  return {
    date, money, total: r2(qty * price),
    doc: {
      customer_id: (await findOrCreateCustomer(b.customer_name)).id, date, due_date: date, state: 'sent', notes: str(b.note),
      lines: [{ item_id: item.id, qty, unit_price: price, tax_rate: 0, cost_override: item.is_service ? null : cost }],
    },
  };
}
async function receive(invId, date, money, amount, user) {
  const inv = await get('SELECT * FROM sales_invoices WHERE id=?', invId);
  await saveDoc(docs.receipts, { date, kind: 'customer', customer_id: inv.customer_id, ref_type: 'invoice', ref_id: invId, amount, method: await method(money.id), money_account_id: money.id, description: `Sale ${inv.number}` }, null, user);
}
async function dropReceipts(invId, user) {
  for (const r of await all("SELECT id FROM receipts WHERE ref_type='invoice' AND ref_id=? AND is_deleted=0", invId)) await deleteDoc(docs.receipts, r.id, user);
}
export async function createSale(b, user) {
  return await tx(async () => {
    const s = await saleBody(b, user);
    const inv = await saveDoc(docs.invoices, s.doc, null, user);
    await receive(inv.id, s.date, s.money, s.total, user);
    return { id: inv.id };
  });
}
export async function updateSale(id, b, user) {
  return await tx(async () => {
    if (!await get("SELECT id FROM sales_invoices WHERE id=? AND is_deleted=0", id)) fail('Sale not found', 404);
    await dropReceipts(id, user);
    const s = await saleBody(b, user);
    await saveDoc(docs.invoices, s.doc, id, user);
    await receive(id, s.date, s.money, s.total, user);
    return { id };
  });
}
export async function deleteSale(id, user) {
  return await tx(async () => { await dropReceipts(id, user); await deleteDoc(docs.invoices, id, user); return { ok: true }; });
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export async function expenseList(q = {}) {
  const { from, to } = range(q);
  const s = q.search ? `%${String(q.search).toLowerCase()}%` : null;
  const rows = await all(`SELECT e.id, e.number, e.date, e.category_id, c.name AS category, e.description, e.amount, e.money_account_id, m.name AS paid_from
    FROM expenses e JOIN categories c ON c.id=e.category_id LEFT JOIN money_accounts m ON m.id=e.money_account_id
    WHERE e.is_deleted=0 AND e.date BETWEEN ? AND ? AND (? IS NULL OR lower(c.name || ' ' || COALESCE(e.description,'')) LIKE ?)
    ORDER BY e.date DESC, e.id DESC`, from, to, s, s);
  return { rows, summary: { count: rows.length, total: r2(rows.reduce((a, r) => a + r.amount, 0)) } };
}
const expenseDoc = async (b) => ({ date: b.date || today(), category_id: b.category_id, amount: b.amount, description: b.description, money_account_id: b.money_account_id, method: await method(b.money_account_id), mode: 'paid' });
export const saveExpense = async (b, id, user) => { const e = await saveDoc(docs.expenses, await expenseDoc(b), id, user); return { id: e.id }; };
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
    const money = await moneyAcc(idv(b.money_account_id, 'Paid from'), 'Paid from');
    const supplier = await findOrCreateSupplier(str(b.supplier_name) || 'General Supplier');
    await saveDoc(docs.bills, {
      supplier_id: supplier.id, date, due_date: date, lines: [{ item_id: item.id, qty, unit_price: cost, tax_rate: 0 }],
      paid_now: r2(qty * cost), paid_account_id: money.id, paid_method: await method(money.id), paid_date: date,
    }, null, user);
    return { ok: true };
  });
}
export const stockHistory = async (itemId) => await movementList({ item_id: itemId, size: 'all', sort: 'date', dir: 'DESC' });

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
