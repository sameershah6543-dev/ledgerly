// Inventory: products (+opening stock), stock returns, stock adjustments and stock queries.
import { all, get, run, insert, update, tx } from '../db.js';
import { fail, r2, num, str, reqStr, oneOf, id as idv, isoDate, listQuery, claimNumber, today, fyStart } from '../util.js';
import { sys } from '../coa.js';
import { postEntry, voidEntry, clearMovements, addMovement, avgCost, assertStock, stockOf, audit, diffRows } from '../posting.js';
import { defineDoc, docs } from '../docs.js';
import { invoiceSettled, billSettled, party, moneyAcc } from '../finance.js';

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
async function postOpening(item, user) {
  const oldIds = await clearMovements('opening_stock', item.id);
  if (item.is_deleted || item.is_service || !(item.opening_stock > 0)) { await voidEntry('opening_stock', item.id); await assertStock(oldIds); return; }
  const value = r2(item.opening_stock * item.purchase_price);
  const date = item.opening_date || fyStart(today());
  await addMovement({ itemId: item.id, date, type: 'opening', qty: item.opening_stock, value, sourceType: 'opening_stock', sourceId: item.id, memo: 'Opening stock' });
  await postEntry({ sourceType: 'opening_stock', sourceId: item.id, date, memo: `Opening stock - ${item.name}`, lines: [{ account: sys('INVENTORY'), debit: value }, { account: sys('OBE'), credit: value }], user });
  await assertStock([item.id]);
}
export async function saveItem(b, idOrNull, user) {
  return await tx(async () => {
    const old = idOrNull ? await get('SELECT * FROM items WHERE id=? AND is_deleted=0', idOrNull) : null;
    if (idOrNull && !old) fail('Product not found', 404);
    const name = reqStr(b.name, 'Product name');
    const sku = str(b.sku);
    if (sku && await get('SELECT id FROM items WHERE sku=? AND id<>?', sku, idOrNull || 0)) fail(`SKU "${sku}" is already used`);
    const isService = b.is_service === true || b.is_service === 1 || b.is_service === '1' ? 1 : 0;
    const row = {
      name, sku, category_id: b.category_id ? idv(b.category_id, 'Category') : null, unit: str(b.unit) || 'pcs',
      purchase_price: num(b.purchase_price, 'Purchase price', { min: 0 }), selling_price: num(b.selling_price, 'Selling price', { min: 0 }),
      opening_stock: isService ? 0 : num(b.opening_stock, 'Opening stock', { min: 0 }), opening_date: isoDate(b.opening_date || old?.opening_date || fyStart(today()), 'Opening date'),
      min_stock: num(b.min_stock, 'Minimum stock level', { min: 0 }), supplier_id: b.supplier_id ? (await party(idv(b.supplier_id, 'Supplier'), 'supplier', 'Supplier')).id : null,
      location: str(b.location), notes: str(b.notes), is_service: isService, active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
    };
    if (old && old.is_service !== isService && await get('SELECT id FROM stock_movements WHERE item_id=? AND type<>?', old.id, 'opening')) fail('Cannot switch between product and service once it has stock movements');
    let id;
    if (old) { await update('items', old.id, row); id = old.id; } else id = await insert('items', row);
    const fresh = await get('SELECT * FROM items WHERE id=?', id);
    const openingChanged = !old || old.opening_stock !== fresh.opening_stock || old.opening_date !== fresh.opening_date || (old.purchase_price !== fresh.purchase_price && old.opening_stock > 0 && false);
    if (openingChanged) await postOpening(fresh, user);
    await audit({ entity: 'items', entityId: id, ref: fresh.name, action: old ? 'updated' : 'created', user, changes: old ? diffRows(old, fresh) : null });
    return await itemDetail(id);
  });
}
export async function deleteItem(id, user) {
  return await tx(async () => {
    const it = await get('SELECT * FROM items WHERE id=? AND is_deleted=0', id);
    if (!it) fail('Product not found', 404);
    const used = (await get(`SELECT (SELECT COUNT(*) FROM sales_invoice_lines l JOIN sales_invoices s ON s.id=l.invoice_id WHERE l.item_id=? AND s.is_deleted=0)
      + (SELECT COUNT(*) FROM purchase_invoice_lines l JOIN purchase_invoices s ON s.id=l.invoice_id WHERE l.item_id=? AND s.is_deleted=0)
      + (SELECT COUNT(*) FROM stock_returns WHERE item_id=? AND is_deleted=0) + (SELECT COUNT(*) FROM stock_adjustments WHERE item_id=? AND is_deleted=0) n`, id, id, id, id)).n;
    if (used) fail('This product is used in transactions and cannot be deleted. Mark it inactive instead.');
    await run('UPDATE items SET is_deleted=1 WHERE id=?', id);
    await postOpening({ ...it, is_deleted: 1 }, user);
    await audit({ entity: 'items', entityId: id, ref: it.name, action: 'deleted', user });
    return { ok: true };
  });
}
const ITEM_SELECT = `SELECT i.id, i.name, i.sku, i.category_id, c.name AS category, i.unit, i.purchase_price, i.selling_price, i.min_stock, i.supplier_id, s.name AS supplier,
  i.location, i.notes, i.is_service, i.active, i.opening_date,
  COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.item_id=i.id AND m.type='opening'),0) AS opening_stock,
  COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.item_id=i.id AND m.type IN ('purchase','purchase_return')),0) AS purchased,
  COALESCE((SELECT -SUM(qty) FROM stock_movements m WHERE m.item_id=i.id AND m.type='sale'),0) AS sold,
  COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.item_id=i.id AND m.type='sales_return'),0) AS returned,
  COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.item_id=i.id AND m.type='adjustment'),0) AS adjusted,
  COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.item_id=i.id),0) AS current_stock,
  COALESCE((SELECT SUM(value) FROM stock_movements m WHERE m.item_id=i.id),0) AS stock_value
  FROM items i LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN parties s ON s.id=i.supplier_id WHERE i.is_deleted=0`;
export const itemDetail = async (id) => await get(`SELECT * FROM (${ITEM_SELECT}) WHERE id=?`, id);
export async function itemList(q) {
  const base = `SELECT *, CASE WHEN is_service=1 THEN 'Service' WHEN current_stock<=0 THEN 'Out of Stock' WHEN current_stock<=min_stock THEN 'Low Stock' ELSE 'In Stock' END AS stock_status FROM (${ITEM_SELECT})`;
  const opts = {
    columns: [['name', 'Product'], ['sku', 'SKU'], ['category', 'Category'], ['unit', 'Unit'], ['purchase_price', 'Purchase Price', 'money'], ['selling_price', 'Selling Price', 'money'],
      ['opening_stock', 'Opening', 'num'], ['purchased', 'Purchased', 'num'], ['returned', 'Returned', 'num'], ['sold', 'Sold', 'num'], ['current_stock', 'Current Stock', 'num'],
      ['stock_value', 'Stock Value', 'money'], ['min_stock', 'Min Level', 'num'], ['stock_status', 'Status', 'badge']],
    search: ['name', 'sku', 'category', 'supplier', 'location'], filters: ['stock_status', 'category_id', 'supplier_id', 'is_service'],
    sortable: ['name', 'sku', 'category', 'purchase_price', 'selling_price', 'opening_stock', 'purchased', 'returned', 'sold', 'current_stock', 'stock_value', 'min_stock', 'stock_status'], defaultSort: 'name', defaultDir: 'ASC', sums: ['stock_value', 'current_stock'],
  };
  const r = await listQuery(base, [], q, opts);
  const s = await get(`SELECT COUNT(*) items, COALESCE(SUM(current_stock),0) qty, COALESCE(SUM(stock_value),0) value,
    COALESCE(SUM(CASE WHEN is_service=0 AND current_stock>0 AND current_stock<=min_stock THEN 1 ELSE 0 END),0) low,
    COALESCE(SUM(CASE WHEN is_service=0 AND current_stock<=0 THEN 1 ELSE 0 END),0) out FROM (${ITEM_SELECT}) WHERE is_service=0 AND active=1`);
  r.summary = { items: s.items, quantity: r2(s.qty), value: r2(s.value), low: s.low, out: s.out };
  return r;
}

// Stock movement / purchase history / sales history
export async function movementList(q, kind) {
  const types = kind === 'purchases' ? "('purchase','purchase_return')" : kind === 'sales' ? "('sale','sales_return')" : null;
  const base = `SELECT m.id, m.date, i.name AS product, m.item_id, i.sku, m.type,
      CASE m.type WHEN 'opening' THEN 'Opening Stock' WHEN 'purchase' THEN 'Purchase' WHEN 'sale' THEN 'Sale' WHEN 'sales_return' THEN 'Sales Return' WHEN 'purchase_return' THEN 'Purchase Return' ELSE 'Adjustment' END AS type_label,
      m.memo AS reference, CASE WHEN m.qty>0 THEN m.qty ELSE 0 END AS qty_in, CASE WHEN m.qty<0 THEN -m.qty ELSE 0 END AS qty_out, m.qty, m.value,
      CASE WHEN m.qty<>0 THEN ABS(m.value/m.qty) ELSE 0 END AS unit_cost,
      m.source_type, m.source_id, (SELECT COALESCE(SUM(m2.qty),0) FROM stock_movements m2 WHERE m2.item_id=m.item_id AND (m2.date<m.date OR (m2.date=m.date AND m2.id<=m.id))) AS balance
    FROM stock_movements m JOIN items i ON i.id=m.item_id ${types ? `WHERE m.type IN ${types}` : ''}`;
  return await listQuery(base, [], q, {
    columns: [['date', 'Date', 'date'], ['product', 'Product'], ['sku', 'SKU'], ['type_label', 'Type'], ['reference', 'Reference'], ['qty_in', 'In', 'num'], ['qty_out', 'Out', 'num'],
      ['unit_cost', 'Unit Cost', 'money'], ['value', 'Value', 'money'], ['balance', 'Balance Qty', 'num']],
    search: ['product', 'sku', 'reference', 'type_label'], dateCol: 'date', filters: ['item_id', 'type'], sortable: ['date', 'product', 'type_label', 'qty_in', 'qty_out', 'value', 'reference'], defaultSort: 'date', sums: ['qty_in', 'qty_out', 'value'],
  });
}

// ---------------------------------------------------------------------------
// Stock returns (sales returns / purchase returns)
// ---------------------------------------------------------------------------
defineDoc({
  key: 'returns', table: 'stock_returns', label: 'Stock return', amountField: 'total', moneyCols: ['money_account_id'],
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const kind = oneOf(b.kind, ['sales', 'purchase'], 'Return type');
    const item = await get('SELECT * FROM items WHERE id=? AND is_deleted=0', idv(b.item_id, 'Product'));
    if (!item) fail('Product not found'); if (item.is_service) fail('Services cannot be returned to stock');
    const p = await party(idv(b.party_id, kind === 'sales' ? 'Customer' : 'Supplier'), kind === 'sales' ? 'customer' : 'supplier', kind === 'sales' ? 'Customer' : 'Supplier');
    const qty = num(b.qty, 'Quantity', { required: true }); if (qty <= 0) fail('Quantity must be greater than zero');
    const settlement = oneOf(b.settlement || 'credit', ['credit', 'refund'], 'Settlement');
    const unitCost = num(b.unit_cost, 'Unit cost', { min: 0, def: await avgCost(item.id) });
    const unitPrice = kind === 'sales' ? num(b.unit_price, 'Unit price', { min: 0, def: item.selling_price }) : unitCost;
    const taxRate = num(b.tax_rate, 'Tax rate', { min: 0 });
    const net = r2(qty * unitPrice), tax = r2(net * taxRate / 100);
    const row = {
      number: await claimNumber('return', b.number || old?.number, 'stock_returns', 'number', id, date), date, kind, item_id: item.id, party_id: p.id, ref_id: b.ref_id ? idv(b.ref_id, 'Invoice') : null,
      qty, unit_price: unitPrice, unit_cost: unitCost, tax_rate: taxRate, net, tax_amount: tax, total: r2(net + tax), settlement, money_account_id: null,
      reason: str(b.reason), notes: str(b.notes),
    };
    if (settlement === 'refund') row.money_account_id = (await moneyAcc(idv(b.money_account_id, 'Refund account'), 'Refund account')).id;
    return { row };
  },
  async post(id) {
    const r = await get('SELECT * FROM stock_returns WHERE id=?', id);
    const oldIds = await clearMovements('stock_return', id);
    if (r.is_deleted) { await voidEntry('stock_return', id); await assertStock(oldIds); return; }
    // link validation
    if (r.ref_id) {
      const tbl = r.kind === 'sales' ? 'sales_invoices' : 'purchase_invoices'; const lineTbl = r.kind === 'sales' ? 'sales_invoice_lines' : 'purchase_invoice_lines';
      const inv = await get(`SELECT * FROM ${tbl} WHERE id=? AND is_deleted=0`, r.ref_id);
      if (!inv) fail('Referenced invoice not found');
      if ((r.kind === 'sales' ? inv.customer_id : inv.supplier_id) !== r.party_id) fail('The invoice belongs to a different customer/supplier');
      const sold = (await get(`SELECT COALESCE(SUM(qty),0) q FROM ${lineTbl} WHERE invoice_id=? AND item_id=?`, r.ref_id, r.item_id)).q;
      const already = (await get('SELECT COALESCE(SUM(qty),0) q FROM stock_returns WHERE kind=? AND ref_id=? AND item_id=? AND is_deleted=0', r.kind, r.ref_id, r.item_id)).q;
      if (already > sold + 0.0000001) fail(`Returned quantity (${already}) exceeds the quantity on the invoice (${sold})`);
      if (r.settlement === 'credit') {
        const settled = r.kind === 'sales' ? await invoiceSettled(r.ref_id) : await billSettled(r.ref_id);
        if (settled > inv.total + 0.005) fail('The credit exceeds the invoice\'s outstanding balance - choose "Refund" instead');
      }
    }
    const value = r2(r.qty * r.unit_cost); const sign = r.kind === 'sales' ? 1 : -1;
    await addMovement({ itemId: r.item_id, date: r.date, type: r.kind === 'sales' ? 'sales_return' : 'purchase_return', qty: sign * r.qty, value: sign * value, sourceType: 'stock_return', sourceId: id, memo: r.number });
    const settle = r.settlement === 'refund' ? { account: (await get('SELECT account_id FROM money_accounts WHERE id=?', r.money_account_id)).account_id } : { account: r.kind === 'sales' ? sys('AR') : sys('AP'), party: r.party_id };
    let lines;
    if (r.kind === 'sales') {
      lines = [{ account: sys('SALES_RETURNS'), debit: r.net }, { account: sys('TAX_PAYABLE'), debit: r.tax_amount }, { ...settle, credit: r.total },
        { account: sys('INVENTORY'), debit: value }, { account: sys('COGS'), credit: value }];
    } else {
      // purchase return: value returned at cost; any price/cost difference is not modelled (unit_price = unit_cost)
      lines = [{ ...settle, debit: r.total }, { account: sys('INVENTORY'), credit: r.net }, { account: sys('TAX_RECEIVABLE'), credit: r.tax_amount }];
      if (Math.abs(r.net - value) > 0.005) fail('Internal: purchase return value mismatch', 500);
    }
    await postEntry({ sourceType: 'stock_return', sourceId: id, date: r.date, memo: `${r.kind === 'sales' ? 'Sales' : 'Purchase'} return ${r.number}`, lines });
    await assertStock([...oldIds, r.item_id]);
  },
  async unpost(id) { const ids = await clearMovements('stock_return', id); await voidEntry('stock_return', id); await assertStock(ids); },
  async afterSave(id) {
    const r = await get('SELECT * FROM stock_returns WHERE id=?', id);
    if (r.ref_id && r.settlement === 'credit') {
      const settled = r.kind === 'sales' ? await invoiceSettled(r.ref_id) : await billSettled(r.ref_id);
      const total = (await get(`SELECT total FROM ${r.kind === 'sales' ? 'sales_invoices' : 'purchase_invoices'} WHERE id=?`, r.ref_id)).total;
      if (settled > total + 0.005) fail('The credit exceeds the invoice\'s outstanding balance - choose "Refund" instead');
    }
  },
  async decorate(row) {
    row.item_name = (await get('SELECT name FROM items WHERE id=?', row.item_id))?.name; row.party_name = (await get('SELECT name FROM parties WHERE id=?', row.party_id))?.name;
    const tbl = row.kind === 'sales' ? 'sales_invoices' : 'purchase_invoices';
    row.ref_number = row.ref_id ? (await get(`SELECT number FROM ${tbl} WHERE id=?`, row.ref_id))?.number : null;
    return row;
  },
  async list(q) {
    const base = `SELECT r.id, r.number, r.date, CASE r.kind WHEN 'sales' THEN 'Sales Return' ELSE 'Purchase Return' END AS type, r.kind, i.name AS product, r.item_id, p.name AS party,
      r.qty, r.unit_cost, r.total, r.settlement, r.reason FROM stock_returns r JOIN items i ON i.id=r.item_id JOIN parties p ON p.id=r.party_id WHERE r.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, {
      columns: [['date', 'Date', 'date'], ['number', 'Return #'], ['type', 'Type'], ['product', 'Product'], ['party', 'Customer / Supplier'], ['qty', 'Qty', 'num'], ['total', 'Amount', 'money'], ['settlement', 'Settlement'], ['reason', 'Reason']],
      search: ['number', 'product', 'party', 'reason'], dateCol: 'date', filters: ['kind', 'item_id'], sortable: ['date', 'number', 'type', 'product', 'party', 'qty', 'total'], defaultSort: 'date', sums: ['total'],
    });
  },
});

// ---------------------------------------------------------------------------
// Stock adjustments (count corrections, damage, found stock)
// ---------------------------------------------------------------------------
defineDoc({
  key: 'adjustments', table: 'stock_adjustments', label: 'Stock adjustment', amountField: 'qty',
  async normalize(b, { old, id }) {
    const date = isoDate(b.date, 'Date');
    const item = await get('SELECT * FROM items WHERE id=? AND is_deleted=0', idv(b.item_id, 'Product'));
    if (!item) fail('Product not found'); if (item.is_service) fail('Services have no stock');
    const qty = num(b.qty, 'Quantity', { required: true }); if (qty === 0) fail('Quantity cannot be zero');
    return {
      row: {
        number: await claimNumber('adjustment', b.number || old?.number, 'stock_adjustments', 'number', id, date), date, item_id: item.id, qty,
        unit_cost: qty > 0 ? num(b.unit_cost, 'Unit cost', { min: 0, def: item.purchase_price }) : 0, reason: reqStr(b.reason, 'Reason'), notes: str(b.notes),
      },
    };
  },
  async post(id) {
    const a = await get('SELECT * FROM stock_adjustments WHERE id=?', id);
    const oldIds = await clearMovements('stock_adjustment', id);
    if (a.is_deleted) { await voidEntry('stock_adjustment', id); await assertStock(oldIds); return; }
    const unit = a.qty > 0 ? a.unit_cost : await avgCost(a.item_id);
    const value = r2(Math.abs(a.qty) * unit); const sign = a.qty > 0 ? 1 : -1;
    await addMovement({ itemId: a.item_id, date: a.date, type: 'adjustment', qty: a.qty, value: sign * value, sourceType: 'stock_adjustment', sourceId: id, memo: a.reason });
    await postEntry({
      sourceType: 'stock_adjustment', sourceId: id, date: a.date, memo: `Stock adjustment ${a.number}`,
      lines: a.qty > 0 ? [{ account: sys('INVENTORY'), debit: value }, { account: sys('INV_ADJ'), credit: value }] : [{ account: sys('INV_ADJ'), debit: value }, { account: sys('INVENTORY'), credit: value }],
    });
    await assertStock([...oldIds, a.item_id]);
  },
  async unpost(id) { const ids = await clearMovements('stock_adjustment', id); await voidEntry('stock_adjustment', id); await assertStock(ids); },
  async decorate(row) { row.item_name = (await get('SELECT name FROM items WHERE id=?', row.item_id))?.name; return row; },
  async list(q) {
    const base = `SELECT a.id, a.number, a.date, i.name AS product, a.item_id, a.qty, a.reason FROM stock_adjustments a JOIN items i ON i.id=a.item_id WHERE a.is_deleted=${q.deleted ? 1 : 0}`;
    return await listQuery(base, [], q, { columns: [['date', 'Date', 'date'], ['number', 'Ref #'], ['product', 'Product'], ['qty', 'Qty (+/-)', 'num'], ['reason', 'Reason']], search: ['number', 'product', 'reason'], dateCol: 'date', filters: ['item_id'], sortable: ['date', 'number', 'product', 'qty'], defaultSort: 'date' });
  },
});
