// The four everyday entry forms, shared by the dashboard and the individual tabs.
import { $, esc, api, GET, modal, val, money, qty, today, toast, moneyInput, moneyOptions } from '../core.js';

const changed = (msg) => { toast(msg); document.dispatchEvent(new CustomEvent('data-changed')); return true; };
const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;
const dateField = (v) => `<div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(v || today())}" max="${today()}"></div>`;
const payField = (label, accounts, sel) => `<div class="field full"><label>${label}</label><div class="seg">${moneyOptions(accounts, sel ?? accounts[0]?.id)}</div></div>`;

// ---------------------------------------------------------------- sale
export async function saleForm(sale = null) {
  const [inv, accounts] = await Promise.all([GET('/api/simple/inventory'), GET('/api/simple/money')]);
  const items = inv.rows;
  const byId = (id) => items.find((i) => String(i.id) === String(id));
  const avail = (i) => (i.is_service ? Infinity : i.stock + (sale && sale.item_id === i.id ? sale.qty : 0));
  const first = sale ? sale.item_id : (items.find((i) => avail(i) > 0)?.id ?? 'new');
  const opts = items.map((i) => {
    const a = avail(i); const out = a <= 0;
    return `<option value="${i.id}" ${String(i.id) === String(first) ? 'selected' : ''} ${out ? 'disabled' : ''}>${esc(i.name)}${i.is_service ? '' : ` — ${out ? 'out of stock' : `${qty(a)} in stock`}`}</option>`;
  }).join('');
  const body = `<div class="fields">
    <div class="field full"><label>Product</label><select class="input" name="item_id">${opts}<option value="new" ${first === 'new' ? 'selected' : ''}>+ Something not in my inventory</option></select></div>
    <div class="field full" data-new><label>Product name</label><input class="input" name="item_name" placeholder="e.g. Samsung Galaxy A55"><span class="help">It will be added to your inventory automatically.</span></div>
    <div class="field"><label>Quantity</label><input class="input" name="qty" type="number" inputmode="decimal" min="0" step="any" value="${sale ? sale.qty : 1}"></div>
    <div class="field"><label>Sold for <span class="opt">(each)</span></label>${moneyInput('unit_price', sale?.unit_price ?? '')}</div>
    <div class="field"><label>It cost me <span class="opt">(each)</span></label>${moneyInput('unit_cost', sale?.unit_cost ?? '')}<span class="help" data-costhelp></span></div>
    <div class="field"><label>Profit on this sale</label>${moneyInput('profit', '', 'min=""')}<span class="help">Change this or the cost — the other updates.</span></div>
    <div class="summary-box"><div><small>Total sale</small><b data-s="total">—</b></div><div><small>Profit</small><b data-s="profit">—</b></div><div><small>Margin</small><b data-s="margin">—</b></div></div>
    ${payField('Money received in', accounts, sale?.money_account_id)}
    ${dateField(sale?.date)}
    <div class="field"><label>Customer <span class="opt">(optional)</span></label><input class="input" name="customer_name" value="${esc(sale?.customer || '')}" placeholder="Walk-in customer"></div>
    <div class="field full"><label>Note <span class="opt">(optional)</span></label><input class="input" name="note" value="${esc(sale?.note || '')}" placeholder="e.g. IMEI, colour, warranty"></div>
  </div>`;
  modal({
    title: sale ? 'Edit sale' : 'Record a sale', sub: sale ? `${sale.number}` : 'Money in from something you sold.', body, submit: sale ? 'Save changes' : 'Save sale',
    onOpen(f) {
      const E = f.elements; const newBox = $('[data-new]', f); const help = $('[data-costhelp]', f);
      const summary = () => {
        const q = n(E.qty.value), p = n(E.unit_price.value), c = n(E.unit_cost.value);
        const total = q * p, profit = q * (p - c);
        $('[data-s=total]', f).textContent = Number.isFinite(total) ? money(total) : '—';
        const pe = $('[data-s=profit]', f); pe.textContent = Number.isFinite(profit) ? money(profit) : '—'; pe.className = profit < 0 ? 'neg' : profit > 0 ? 'pos' : '';
        $('[data-s=margin]', f).textContent = Number.isFinite(profit) && total > 0 ? `${Math.round((profit / total) * 100)}%` : '—';
      };
      const fromCost = () => { const q = n(E.qty.value), p = n(E.unit_price.value), c = n(E.unit_cost.value); E.profit.value = Number.isFinite(q * (p - c)) ? r2(q * (p - c)) : ''; summary(); };
      const fromProfit = () => { const q = n(E.qty.value), p = n(E.unit_price.value), pr = n(E.profit.value); if (q > 0 && Number.isFinite(p) && Number.isFinite(pr)) E.unit_cost.value = r2(p - pr / q); summary(); };
      const pick = (keep) => {
        const it = byId(E.item_id.value); const isNew = E.item_id.value === 'new';
        newBox.classList.toggle('hidden', !isNew);
        E.unit_cost.closest('.field').classList.toggle('hidden', !!it?.is_service);
        E.profit.closest('.field').classList.toggle('hidden', !!it?.is_service);
        help.textContent = isNew ? 'What you paid for it.' : it && !it.is_service ? `Your stock cost is ${money(it.cost)} each.` : '';
        if (!keep) { E.unit_price.value = it ? it.selling_price || '' : ''; E.unit_cost.value = it && !it.is_service ? it.cost : ''; }
        fromCost();
      };
      E.item_id.onchange = () => pick(false);
      E.qty.oninput = fromCost; E.unit_price.oninput = fromCost; E.unit_cost.oninput = fromCost; E.profit.oninput = fromProfit;
      pick(!!sale);
    },
    async onSubmit(f) {
      const isNew = f.elements.item_id.value === 'new'; const it = byId(f.elements.item_id.value);
      if (isNew && !val(f, 'item_name')) throw new Error('Enter the product name');
      if (!(n(val(f, 'unit_price')) > 0)) throw new Error('Enter how much you sold it for');
      if (isNew && !(n(val(f, 'unit_cost')) >= 0)) throw new Error('Enter what it cost you, so profit can be worked out');
      const body = {
        item_id: isNew ? null : f.elements.item_id.value, item_name: val(f, 'item_name'), qty: val(f, 'qty'), unit_price: val(f, 'unit_price'),
        unit_cost: it?.is_service ? null : val(f, 'unit_cost'), money_account_id: f.elements.money_account_id.value, date: val(f, 'date'),
        customer_name: val(f, 'customer_name'), note: val(f, 'note'),
      };
      if (sale) await api('PUT', `/api/simple/sales/${sale.id}`, body); else await api('POST', '/api/simple/sales', body);
      return changed(sale ? 'Sale updated' : 'Sale saved');
    },
    onDelete: sale ? async () => { await api('DELETE', `/api/simple/sales/${sale.id}`); return changed('Sale deleted — stock returned'); } : null,
  });
}

// ---------------------------------------------------------------- expense
export async function expenseForm(exp = null) {
  const [cats, accounts] = await Promise.all([GET('/api/simple/expense-categories'), GET('/api/simple/money')]);
  const rent = cats.find((c) => c.name === 'Rent')?.id;
  const body = `<div class="fields">
    <div class="field full"><label>Amount</label>${moneyInput('amount', exp?.amount ?? '')}</div>
    <div class="field full"><label>What was it for?</label><select class="input" name="category_id">${cats.map((c) => `<option value="${c.id}" ${c.id === (exp?.category_id ?? rent) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="new">+ New category…</option></select></div>
    <div class="field full hidden" data-newcat><label>New category name</label><input class="input" name="new_category" placeholder="e.g. Shop repairs"></div>
    <div class="field full"><label>Details <span class="opt">(optional)</span></label><input class="input" name="description" value="${esc(exp?.description || '')}" placeholder="e.g. October electricity bill"></div>
    ${payField('Paid from', accounts, exp?.money_account_id)}
    ${dateField(exp?.date)}
  </div>`;
  modal({
    title: exp ? 'Edit expense' : 'Add an expense', sub: exp ? exp.number : 'Money out for running your business.', body, submit: exp ? 'Save changes' : 'Save expense',
    onOpen(f) { f.elements.category_id.onchange = () => $('[data-newcat]', f).classList.toggle('hidden', f.elements.category_id.value !== 'new'); },
    async onSubmit(f) {
      if (!(n(val(f, 'amount')) > 0)) throw new Error('Enter the amount');
      let cat = f.elements.category_id.value;
      if (cat === 'new') { if (!val(f, 'new_category')) throw new Error('Enter a name for the new category'); cat = (await api('POST', '/api/categories', { kind: 'expense', name: val(f, 'new_category') })).id; }
      const body = { amount: val(f, 'amount'), category_id: cat, description: val(f, 'description'), money_account_id: f.elements.money_account_id.value, date: val(f, 'date') };
      if (exp) await api('PUT', `/api/simple/expenses/${exp.id}`, body); else await api('POST', '/api/simple/expenses', body);
      return changed(exp ? 'Expense updated' : 'Expense saved');
    },
    onDelete: exp ? async () => { await api('DELETE', `/api/simple/expenses/${exp.id}`); return changed('Expense deleted'); } : null,
  });
}

// ---------------------------------------------------------------- product
export function productForm(p = null) {
  const body = `<div class="fields">
    <div class="field full"><label>Product name</label><input class="input" name="name" value="${esc(p?.name || '')}" placeholder="e.g. iPhone 15 (128GB)"></div>
    <div class="field"><label>Cost price <span class="opt">(what you pay)</span></label>${moneyInput('purchase_price', p?.purchase_price ?? '')}</div>
    <div class="field"><label>Selling price</label>${moneyInput('selling_price', p?.selling_price ?? '')}</div>
    ${p ? '' : '<div class="field"><label>How many do you have now?</label><input class="input" name="opening_stock" type="number" inputmode="decimal" min="0" step="any" value="0"></div>'}
    <div class="field ${p ? 'full' : ''}"><label>Warn me when stock is at <span class="opt">(optional)</span></label><input class="input" name="min_stock" type="number" inputmode="decimal" min="0" step="any" value="${p?.min_stock ?? 1}"><span class="help">Shows a “Low stock” alert on your dashboard.</span></div>
    ${p ? '<p class="help full" style="grid-column:1/-1;margin:0">To add more units, use <b>Add stock</b> — it records what you paid.</p>' : ''}
  </div>`;
  modal({
    title: p ? 'Edit product' : 'Add a product', sub: p ? '' : 'Something you buy and sell.', body, submit: p ? 'Save changes' : 'Add product',
    async onSubmit(f) {
      if (!val(f, 'name')) throw new Error('Enter the product name');
      const b = { name: val(f, 'name'), purchase_price: val(f, 'purchase_price') || 0, selling_price: val(f, 'selling_price') || 0, min_stock: val(f, 'min_stock') || 0 };
      if (!p) b.opening_stock = val(f, 'opening_stock') || 0;
      if (p) await api('PUT', `/api/simple/products/${p.id}`, b); else await api('POST', '/api/simple/products', b);
      return changed(p ? 'Product updated' : 'Product added');
    },
    onDelete: p ? async () => { await api('DELETE', `/api/simple/products/${p.id}`); return changed('Product deleted'); } : null,
  });
}

// ---------------------------------------------------------------- restock
export async function restockForm(itemId = null) {
  const [inv, accounts] = await Promise.all([GET('/api/simple/inventory'), GET('/api/simple/money')]);
  const items = inv.rows.filter((i) => !i.is_service);
  if (!items.length) { productForm(); return; }
  const cur = items.find((i) => String(i.id) === String(itemId)) || items[0];
  const body = `<div class="fields">
    <div class="field full"><label>Product</label><select class="input" name="item_id">${items.map((i) => `<option value="${i.id}" ${i.id === cur.id ? 'selected' : ''}>${esc(i.name)} — ${qty(i.stock)} in stock</option>`).join('')}</select></div>
    <div class="field"><label>Quantity bought</label><input class="input" name="qty" type="number" inputmode="decimal" min="0" step="any" value="1"></div>
    <div class="field"><label>Cost <span class="opt">(each)</span></label>${moneyInput('unit_cost', cur.purchase_price || '')}</div>
    <div class="summary-box" style="grid-template-columns:1fr 1fr"><div><small>Total paid</small><b data-s="total">—</b></div><div><small>Stock after</small><b data-s="after">—</b></div></div>
    ${payField('Paid from', accounts)}
    ${dateField()}
    <div class="field"><label>Supplier <span class="opt">(optional)</span></label><input class="input" name="supplier_name" placeholder="Who you bought from"></div>
  </div>`;
  modal({
    title: 'Add stock', sub: 'Record units you bought. The cost is paid from your cash or bank.', body, submit: 'Add stock',
    onOpen(f) {
      const E = f.elements;
      const upd = () => { const it = items.find((i) => String(i.id) === E.item_id.value); const q = n(E.qty.value), c = n(E.unit_cost.value);
        $('[data-s=total]', f).textContent = Number.isFinite(q * c) ? money(q * c) : '—'; $('[data-s=after]', f).textContent = Number.isFinite(q) ? qty(it.stock + q) : '—'; };
      E.item_id.onchange = () => { E.unit_cost.value = items.find((i) => String(i.id) === E.item_id.value).purchase_price || ''; upd(); };
      E.qty.oninput = upd; E.unit_cost.oninput = upd; upd();
    },
    async onSubmit(f) {
      await api('POST', '/api/simple/restock', { item_id: f.elements.item_id.value, qty: val(f, 'qty'), unit_cost: val(f, 'unit_cost'), money_account_id: f.elements.money_account_id.value, date: val(f, 'date'), supplier_name: val(f, 'supplier_name') });
      return changed('Stock added');
    },
  });
}
