// The everyday entry forms, shared by the dashboard and the individual tabs.
import { $, $$, esc, api, GET, modal, val, money, qty, today, toast, moneyInput, moneyOptions } from '../core.js';

const changed = (msg) => { toast(msg); document.dispatchEvent(new CustomEvent('data-changed')); return true; };
const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;
const dateField = (v) => `<div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(v || today())}" max="${today()}"></div>`;
const payField = (label, accounts, sel, attrs = '') => `<div class="field full" ${attrs}><label>${label}</label><div class="seg">${moneyOptions(accounts, sel ?? accounts[0]?.id)}</div></div>`;
const namesList = (names) => `<datalist id="people-names">${names.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;

// "Paid in full / Part paid / Not paid yet" - the rest becomes money owed (Receivables & Payables)
function payBlock(kind, accounts, { mode = 'full', paid = '', account } = {}) {
  const sale = kind === 'sale';
  const opt = (v, l) => `<label><input type="radio" name="paymode" value="${v}" ${mode === v ? 'checked' : ''}>${l}</label>`;
  return `<div class="field full"><label>${sale ? 'Did they pay?' : 'Did you pay?'}</label>
      <div class="seg">${opt('full', 'Paid in full')}${opt('part', 'Part paid')}${opt('none', sale ? 'Not paid yet' : 'Pay later')}</div>
      <span class="help" data-owedhelp></span></div>
    <div class="field full" data-partamt><label>${sale ? 'Amount received now' : 'Amount paid now'}</label>${moneyInput('paid', paid)}</div>
    ${payField(sale ? 'Money received in' : 'Paid from', accounts, account, 'data-acct')}`;
}
// shows/hides the right fields and tells the user what will be owed; getTotal() returns the full amount
function wirePay(f, kind, getTotal, personField, personLabel) {
  const E = f.elements; const sale = kind === 'sale';
  const upd = () => {
    const mode = E.paymode.value; const total = getTotal();
    $('[data-partamt]', f).classList.toggle('hidden', mode !== 'part');
    $('[data-acct]', f).classList.toggle('hidden', mode === 'none');
    const paid = mode === 'full' ? total : mode === 'none' ? 0 : n(E.paid.value) || 0;
    const owed = Number.isFinite(total) ? r2(total - paid) : NaN;
    const help = $('[data-owedhelp]', f);
    help.textContent = mode !== 'full' && owed > 0 ? `${money(owed)} will be added to ${sale ? 'money you are owed' : 'money you owe'}.` : '';
    help.className = `help ${mode !== 'full' && owed > 0 ? (sale ? 'pos' : 'neg') : ''}`;
    const lbl = $('label', personField);
    lbl.innerHTML = `${personLabel} ${mode === 'full' ? '<span class="opt">(optional)</span>' : '<span class="neg">(needed)</span>'}`;
  };
  $$('[name=paymode]', f).forEach((r) => { r.onchange = upd; });
  E.paid.oninput = upd;
  return upd;
}
const paidValue = (f, total) => {
  const mode = f.elements.paymode.value;
  if (mode === 'full') return '';
  if (mode === 'none') return 0;
  const p = n(val(f, 'paid'));
  if (!(p >= 0)) throw new Error('Enter how much was paid now');
  if (p > total + 0.005) throw new Error('The amount paid now is more than the total');
  return p;
};
const accountValue = (f) => (f.elements.paymode.value === 'none' ? null : f.elements.money_account_id.value);

// ---------------------------------------------------------------- sale
export async function saleForm(sale = null) {
  const [inv, accounts, names] = await Promise.all([GET('/api/simple/inventory'), GET('/api/simple/money'), GET('/api/simple/names')]);
  const items = inv.rows;
  const byId = (id) => items.find((i) => String(i.id) === String(id));
  const avail = (i) => (i.is_service ? Infinity : i.stock + (sale && sale.item_id === i.id ? sale.qty : 0));
  const first = sale ? sale.item_id : (items.find((i) => avail(i) > 0)?.id ?? 'new');
  const opts = items.map((i) => {
    const a = avail(i); const out = a <= 0;
    return `<option value="${i.id}" ${String(i.id) === String(first) ? 'selected' : ''} ${out ? 'disabled' : ''}>${esc(i.name)}${i.is_service ? '' : ` — ${out ? 'out of stock' : `${qty(a)} in stock`}`}</option>`;
  }).join('');
  const later = sale ? r2(sale.received - sale.paid_at_sale) : 0; // payments received after the sale are kept on edit
  const mode = !sale ? 'full' : sale.paid_at_sale >= sale.total - 0.005 ? 'full' : sale.paid_at_sale > 0 ? 'part' : 'none';
  const body = `<div class="fields">
    <div class="field full"><label>Product</label><select class="input" name="item_id">${opts}<option value="new" ${first === 'new' ? 'selected' : ''}>+ Something not in my inventory</option></select></div>
    <div class="field full" data-new><label>Product name</label><input class="input" name="item_name" placeholder="e.g. Samsung Galaxy A55"><span class="help">It will be added to your inventory automatically.</span></div>
    <div class="field"><label>Quantity</label><input class="input" name="qty" type="number" inputmode="decimal" min="0" step="any" value="${sale ? sale.qty : 1}"></div>
    <div class="field"><label>Sold for <span class="opt">(each)</span></label>${moneyInput('unit_price', sale?.unit_price ?? '')}</div>
    <div class="field"><label>It cost me <span class="opt">(each)</span></label>${moneyInput('unit_cost', sale?.unit_cost ?? '')}<span class="help" data-costhelp></span></div>
    <div class="field"><label>Profit on this sale</label>${moneyInput('profit', '', 'min=""')}<span class="help">Change this or the cost — the other updates.</span></div>
    <div class="summary-box"><div><small>Total sale</small><b data-s="total">—</b></div><div><small>Profit</small><b data-s="profit">—</b></div><div><small>Margin</small><b data-s="margin">—</b></div></div>
    ${payBlock('sale', accounts, { mode, paid: mode === 'part' ? sale.paid_at_sale : '', account: sale?.money_account_id })}
    ${later > 0 ? `<p class="help full" style="grid-column:1/-1;margin:-6px 0 0">${money(later)} was received later — that stays recorded.</p>` : ''}
    <div class="field" data-person><label>Customer</label><input class="input" name="customer_name" list="people-names" autocomplete="off" value="${esc(sale?.customer || '')}" placeholder="Walk-in customer"></div>
    ${dateField(sale?.date)}
    <div class="field full"><label>Note <span class="opt">(optional)</span></label><input class="input" name="note" value="${esc(sale?.note || '')}" placeholder="e.g. IMEI, colour, warranty"></div>
    ${namesList(names)}
  </div>`;
  const total = (f) => n(f.elements.qty.value) * n(f.elements.unit_price.value);
  modal({
    title: sale ? 'Edit sale' : 'Record a sale', sub: sale ? `${sale.number}` : 'Money in from something you sold.', body, submit: sale ? 'Save changes' : 'Save sale',
    onOpen(f) {
      const E = f.elements; const newBox = $('[data-new]', f); const help = $('[data-costhelp]', f);
      const payUpd = wirePay(f, 'sale', () => total(f) - later, $('[data-person]', f), 'Customer');
      const summary = () => {
        const q = n(E.qty.value), p = n(E.unit_price.value), c = n(E.unit_cost.value);
        const t = q * p, profit = q * (p - c);
        $('[data-s=total]', f).textContent = Number.isFinite(t) ? money(t) : '—';
        const pe = $('[data-s=profit]', f); pe.textContent = Number.isFinite(profit) ? money(profit) : '—'; pe.className = profit < 0 ? 'neg' : profit > 0 ? 'pos' : '';
        $('[data-s=margin]', f).textContent = Number.isFinite(profit) && t > 0 ? `${Math.round((profit / t) * 100)}%` : '—';
        payUpd();
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
      const paid = paidValue(f, total(f) - later);
      if (paid !== '' && !val(f, 'customer_name')) throw new Error('Enter the customer’s name so you know who owes you');
      const body = {
        item_id: isNew ? null : f.elements.item_id.value, item_name: val(f, 'item_name'), qty: val(f, 'qty'), unit_price: val(f, 'unit_price'),
        unit_cost: it?.is_service ? null : val(f, 'unit_cost'), paid: paid === '' ? r2(total(f) - later) : paid, money_account_id: accountValue(f), date: val(f, 'date'),
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
  const [cats, accounts, names] = await Promise.all([GET('/api/simple/expense-categories'), GET('/api/simple/money'), GET('/api/simple/names')]);
  const rent = cats.find((c) => c.name === 'Rent')?.id;
  const later = exp?.mode === 'credit';
  const body = `<div class="fields">
    <div class="field full"><label>Amount</label>${moneyInput('amount', exp?.amount ?? '')}</div>
    <div class="field full"><label>What was it for?</label><select class="input" name="category_id">${cats.map((c) => `<option value="${c.id}" ${c.id === (exp?.category_id ?? rent) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="new">+ New category…</option></select></div>
    <div class="field full hidden" data-newcat><label>New category name</label><input class="input" name="new_category" placeholder="e.g. Shop repairs"></div>
    <div class="field full"><label>Did you pay?</label><div class="seg">
      <label><input type="radio" name="when" value="now" ${later ? '' : 'checked'}>Paid now</label><label><input type="radio" name="when" value="later" ${later ? 'checked' : ''}>Pay later</label></div>
      <span class="help neg" data-laterhelp></span></div>
    ${payField('Paid from', accounts, exp?.money_account_id, 'data-acct')}
    <div class="field" data-person><label>Paid to</label><input class="input" name="paid_to" list="people-names" autocomplete="off" value="${esc(exp?.paid_to || '')}" placeholder="e.g. Landlord, K-Electric"></div>
    ${dateField(exp?.date)}
    <div class="field full"><label>Details <span class="opt">(optional)</span></label><input class="input" name="description" value="${esc(exp?.description || '')}" placeholder="e.g. October electricity bill"></div>
    ${namesList(names)}
  </div>`;
  modal({
    title: exp ? 'Edit expense' : 'Add an expense', sub: exp ? exp.number : 'Money out for running your business.', body, submit: exp ? 'Save changes' : 'Save expense',
    onOpen(f) {
      f.elements.category_id.onchange = () => $('[data-newcat]', f).classList.toggle('hidden', f.elements.category_id.value !== 'new');
      const upd = () => {
        const l = f.elements.when.value === 'later';
        $('[data-acct]', f).classList.toggle('hidden', l);
        $('[data-laterhelp]', f).textContent = l ? 'It will be added to money you owe until you pay it.' : '';
        $('[data-person] label', f).innerHTML = `Paid to ${l ? '<span class="neg">(needed)</span>' : '<span class="opt">(optional)</span>'}`;
      };
      $$('[name=when]', f).forEach((r) => { r.onchange = upd; }); upd();
    },
    async onSubmit(f) {
      if (!(n(val(f, 'amount')) > 0)) throw new Error('Enter the amount');
      const payLater = f.elements.when.value === 'later';
      if (payLater && !val(f, 'paid_to')) throw new Error('Enter who you need to pay');
      let cat = f.elements.category_id.value;
      if (cat === 'new') { if (!val(f, 'new_category')) throw new Error('Enter a name for the new category'); cat = (await api('POST', '/api/categories', { kind: 'expense', name: val(f, 'new_category') })).id; }
      const body = { amount: val(f, 'amount'), category_id: cat, description: val(f, 'description'), paid_to: val(f, 'paid_to'), pay_later: payLater,
        money_account_id: payLater ? null : f.elements.money_account_id.value, date: val(f, 'date') };
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
  const [inv, accounts, names] = await Promise.all([GET('/api/simple/inventory'), GET('/api/simple/money'), GET('/api/simple/names')]);
  const items = inv.rows.filter((i) => !i.is_service);
  if (!items.length) { productForm(); return; }
  const cur = items.find((i) => String(i.id) === String(itemId)) || items[0];
  const body = `<div class="fields">
    <div class="field full"><label>Product</label><select class="input" name="item_id">${items.map((i) => `<option value="${i.id}" ${i.id === cur.id ? 'selected' : ''}>${esc(i.name)} — ${qty(i.stock)} in stock</option>`).join('')}</select></div>
    <div class="field"><label>Quantity bought</label><input class="input" name="qty" type="number" inputmode="decimal" min="0" step="any" value="1"></div>
    <div class="field"><label>Cost <span class="opt">(each)</span></label>${moneyInput('unit_cost', cur.purchase_price || '')}</div>
    <div class="summary-box" style="grid-template-columns:1fr 1fr"><div><small>Total cost</small><b data-s="total">—</b></div><div><small>Stock after</small><b data-s="after">—</b></div></div>
    ${payBlock('buy', accounts)}
    <div class="field" data-person><label>Supplier</label><input class="input" name="supplier_name" list="people-names" autocomplete="off" placeholder="Who you bought from"></div>
    ${dateField()}
    ${namesList(names)}
  </div>`;
  const total = (f) => n(f.elements.qty.value) * n(f.elements.unit_cost.value);
  modal({
    title: 'Add stock', sub: 'Record units you bought.', body, submit: 'Add stock',
    onOpen(f) {
      const E = f.elements;
      const payUpd = wirePay(f, 'buy', () => total(f), $('[data-person]', f), 'Supplier');
      const upd = () => { const it = items.find((i) => String(i.id) === E.item_id.value); const q = n(E.qty.value);
        $('[data-s=total]', f).textContent = Number.isFinite(total(f)) ? money(total(f)) : '—'; $('[data-s=after]', f).textContent = Number.isFinite(q) ? qty(it.stock + q) : '—'; payUpd(); };
      E.item_id.onchange = () => { E.unit_cost.value = items.find((i) => String(i.id) === E.item_id.value).purchase_price || ''; upd(); };
      E.qty.oninput = upd; E.unit_cost.oninput = upd; upd();
    },
    async onSubmit(f) {
      const paid = paidValue(f, total(f));
      if (paid !== '' && !val(f, 'supplier_name')) throw new Error('Enter the supplier’s name so you know who you owe');
      await api('POST', '/api/simple/restock', { item_id: f.elements.item_id.value, qty: val(f, 'qty'), unit_cost: val(f, 'unit_cost'), paid,
        money_account_id: accountValue(f), date: val(f, 'date'), supplier_name: val(f, 'supplier_name') });
      return changed('Stock added');
    },
  });
}

// ---------------------------------------------------------------- record a payment (received or made)
// o = { kind: 'receive'|'pay', person, due, item?: { type, id, number, what } }
export async function settleForm(o) {
  const accounts = await GET('/api/simple/money');
  const rec = o.kind === 'receive';
  const body = `<div class="fields">
    <div class="summary-box" style="grid-template-columns:1fr 1fr;margin:0 0 4px"><div><small>${rec ? 'They owe you' : 'You owe'}</small><b class="${rec ? 'pos' : 'neg'}">${money(o.due)}</b></div>
      <div><small>${o.item ? 'For' : 'Person'}</small><b style="font-size:15px">${esc(o.item ? o.item.what || o.item.number : o.person)}</b></div></div>
    <div class="field full"><label>Amount ${rec ? 'received' : 'paid'}</label>${moneyInput('amount', o.due)}
      <span class="help">${o.item ? '' : 'It is applied to the oldest amounts first.'}</span></div>
    ${payField(rec ? 'Received in' : 'Paid from', accounts)}
    ${dateField()}
    <div class="field"><label>Note <span class="opt">(optional)</span></label><input class="input" name="note" placeholder="${rec ? 'e.g. cash at shop' : 'e.g. cheque #1234'}"></div>
  </div>`;
  modal({
    title: rec ? `Money received from ${o.person}` : `Payment to ${o.person}`, sub: rec ? 'Record money they paid you.' : 'Record money you paid them.', body, submit: rec ? 'Save — money received' : 'Save — money paid',
    async onSubmit(f) {
      const amt = n(val(f, 'amount'));
      if (!(amt > 0)) throw new Error('Enter the amount');
      if (amt > o.due + 0.005) throw new Error(`That is more than what is owed (${money(o.due)})`);
      await api('POST', '/api/simple/settle', { kind: o.kind, person: o.person, type: o.item?.type, id: o.item?.id, amount: amt, money_account_id: f.elements.money_account_id.value, date: val(f, 'date'), note: val(f, 'note') });
      return changed(rec ? 'Money received — saved' : 'Payment saved');
    },
  });
}
