// The everyday entry forms, shared by the dashboard and the individual tabs.
import { $, $$, esc, api, GET, modal, val, money, today, toast, moneyInput, moneyOptions } from '../core.js';

const changed = (msg) => { toast(msg); document.dispatchEvent(new CustomEvent('data-changed')); return true; };
const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;
const dateField = (v) => `<div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(v || today())}" max="${today()}"></div>`;
const payField = (label, accounts, sel, attrs = '') => `<div class="field full" ${attrs}><label>${label}</label><div class="seg">${moneyOptions(accounts, sel ?? accounts[0]?.id)}</div></div>`;
const namesList = (names) => `<datalist id="people-names">${names.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;

// "Paid in full / Part paid / Not paid yet" - the rest becomes money owed (Receivables & Payables).
// p = field-name prefix, so one form can hold both the selling and the buying side.
const F = (p) => ({ mode: `${p}mode`, paid: p ? `${p}_paid` : 'paid', acct: p ? `${p}_account_id` : 'money_account_id' });
function payBlock(kind, accounts, { mode = 'full', paid = '', account, p = '' } = {}) {
  const sale = kind === 'sale'; const f = F(p);
  const opt = (v, l) => `<label><input type="radio" name="${f.mode}" value="${v}" ${mode === v ? 'checked' : ''}>${l}</label>`;
  return `<div class="field full"><label>${sale ? 'Did they pay you?' : 'Did you pay for it?'}</label>
      <div class="seg">${opt('full', 'Paid in full')}${opt('part', 'Part paid')}${opt('none', sale ? 'Not paid yet' : 'Pay later')}</div>
      <span class="help" data-owedhelp="${p}"></span></div>
    <div class="field full" data-partamt="${p}"><label>${sale ? 'Amount received now' : 'Amount paid now'}</label>${moneyInput(f.paid, paid)}</div>
    <div class="field full" data-acct="${p}"><label>${sale ? 'Money received in' : 'Paid from'}</label><div class="seg">${moneyOptions(accounts, account ?? accounts[0]?.id).replaceAll('name="money_account_id"', `name="${f.acct}"`)}</div></div>`;
}
// shows/hides the right fields and says what will be owed; getTotal() returns the full amount
function wirePay(f, kind, getTotal, personField, personLabel, p = '') {
  const E = f.elements; const sale = kind === 'sale'; const k = F(p);
  const upd = () => {
    const mode = E[k.mode].value; const total = getTotal();
    $(`[data-partamt="${p}"]`, f).classList.toggle('hidden', mode !== 'part');
    $(`[data-acct="${p}"]`, f).classList.toggle('hidden', mode === 'none');
    const paid = mode === 'full' ? total : mode === 'none' ? 0 : n(E[k.paid].value) || 0;
    const owed = Number.isFinite(total) ? r2(total - paid) : NaN;
    const help = $(`[data-owedhelp="${p}"]`, f);
    help.textContent = mode !== 'full' && owed > 0 ? `${money(owed)} will be added to ${sale ? 'money you are owed' : 'money you owe'}.` : '';
    help.className = `help ${mode !== 'full' && owed > 0 ? (sale ? 'pos' : 'neg') : ''}`;
    $('label', personField).innerHTML = `${personLabel} ${mode === 'full' ? '<span class="opt">(optional)</span>' : '<span class="neg">(needed)</span>'}`;
  };
  $$(`[name=${k.mode}]`, f).forEach((r) => { r.onchange = upd; });
  E[k.paid].oninput = upd;
  return upd;
}
const paidValue = (f, total, p = '') => {
  const k = F(p); const mode = f.elements[k.mode].value;
  if (mode === 'full') return '';
  if (mode === 'none') return 0;
  const v = n(val(f, k.paid));
  if (!(v >= 0)) throw new Error('Enter how much was paid now');
  if (v > total + 0.005) throw new Error('The amount paid now is more than the total');
  return v;
};
const accountValue = (f, p = '') => { const k = F(p); return f.elements[k.mode].value === 'none' ? null : f.elements[k.acct].value; };
const modeOf = (total, paidAtTime) => (paidAtTime >= total - 0.005 ? 'full' : paidAtTime > 0.005 ? 'part' : 'none');

// ---------------------------------------------------------------- sale (buy the phone, sell it)
export async function saleForm(sale = null) {
  const [accounts, names, items] = await Promise.all([GET('/api/simple/money'), GET('/api/simple/names'), GET('/api/simple/item-names')]);
  const laterIn = sale ? r2(sale.received - sale.paid_at_sale) : 0; // payments made after the sale stay recorded on edit
  const laterOut = sale ? r2(sale.cost_paid - sale.cost_paid_at_purchase) : 0;
  const sellMode = sale ? modeOf(sale.total - laterIn, sale.paid_at_sale) : 'full';
  const buyMode = sale ? (sale.purchase_bill_id ? modeOf(sale.cost - laterOut, sale.cost_paid_at_purchase) : 'full') : 'full';
  const body = `<div class="fields">
    <div class="field full"><label>What did you sell?</label><input class="input" name="item_name" list="item-names" autocomplete="off" value="${esc(sale?.product || '')}" placeholder="e.g. iPhone 13 (128GB), black"></div>
    <div class="form-sec">Buying</div>
    <div class="field"><label>Bought for <span class="opt">(each)</span></label>${moneyInput('unit_cost', sale?.unit_cost ?? '')}</div>
    <div class="field"><label>Quantity</label><input class="input" name="qty" type="number" inputmode="decimal" min="0" step="any" value="${sale ? sale.qty : 1}"></div>
    ${payBlock('buy', accounts, { p: 'cost', mode: buyMode, paid: buyMode === 'part' ? sale.cost_paid_at_purchase : '', account: sale?.cost_account_id })}
    ${laterOut > 0 ? `<p class="help" style="grid-column:1/-1;margin:-6px 0 0">${money(laterOut)} was paid later — that stays recorded.</p>` : ''}
    <div class="field full" data-supplier><label>Bought from</label><input class="input" name="supplier_name" list="people-names" autocomplete="off" value="${esc(sale?.bought_from || '')}" placeholder="Who you bought it from"></div>
    <div class="form-sec">Selling</div>
    <div class="field"><label>Sold for <span class="opt">(each)</span></label>${moneyInput('unit_price', sale?.unit_price ?? '')}</div>
    <div class="field"><label>Profit <span class="opt">(total)</span></label>${moneyInput('profit', '', 'min=""')}<span class="help">Type the profit to fill in the sold price.</span></div>
    <div class="summary-box"><div><small>You paid</small><b data-s="cost">—</b></div><div><small>You got</small><b data-s="total">—</b></div><div><small>Profit</small><b data-s="profit">—</b></div></div>
    ${payBlock('sale', accounts, { mode: sellMode, paid: sellMode === 'part' ? sale.paid_at_sale : '', account: sale?.money_account_id })}
    ${laterIn > 0 ? `<p class="help" style="grid-column:1/-1;margin:-6px 0 0">${money(laterIn)} was received later — that stays recorded.</p>` : ''}
    <div class="field" data-person><label>Customer</label><input class="input" name="customer_name" list="people-names" autocomplete="off" value="${esc(sale?.customer || '')}" placeholder="Walk-in customer"></div>
    ${dateField(sale?.date)}
    <div class="field full"><label>Note <span class="opt">(optional)</span></label><input class="input" name="note" value="${esc(sale?.note || '')}" placeholder="e.g. IMEI, colour, warranty"></div>
    ${namesList(names)}<datalist id="item-names">${items.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
  </div>`;
  const q = (f) => n(f.elements.qty.value);
  const total = (f) => q(f) * n(f.elements.unit_price.value);
  const costTotal = (f) => q(f) * n(f.elements.unit_cost.value);
  modal({
    title: sale ? 'Edit sale' : 'Record a sale', sub: sale ? sale.number : 'What you paid for it, and what you sold it for.', body, submit: sale ? 'Save changes' : 'Save sale',
    onOpen(f) {
      const E = f.elements;
      const saleUpd = wirePay(f, 'sale', () => total(f) - laterIn, $('[data-person]', f), 'Customer');
      const buyUpd = wirePay(f, 'buy', () => costTotal(f) - laterOut, $('[data-supplier]', f), 'Bought from', 'cost');
      const summary = () => {
        const t = total(f), c = costTotal(f), pr = t - c;
        $('[data-s=cost]', f).textContent = Number.isFinite(c) ? money(c) : '—';
        $('[data-s=total]', f).textContent = Number.isFinite(t) ? money(t) : '—';
        const pe = $('[data-s=profit]', f); pe.textContent = Number.isFinite(pr) ? money(pr) : '—'; pe.className = pr < 0 ? 'neg' : pr > 0 ? 'pos' : '';
        saleUpd(); buyUpd();
      };
      const fromPrices = () => { const pr = total(f) - costTotal(f); E.profit.value = Number.isFinite(pr) ? r2(pr) : ''; summary(); };
      const fromProfit = () => { const pr = n(E.profit.value), c = n(E.unit_cost.value); if (q(f) > 0 && Number.isFinite(pr) && Number.isFinite(c)) E.unit_price.value = r2(c + pr / q(f)); summary(); };
      E.qty.oninput = fromPrices; E.unit_price.oninput = fromPrices; E.unit_cost.oninput = fromPrices; E.profit.oninput = fromProfit;
      fromPrices();
    },
    async onSubmit(f) {
      if (!val(f, 'item_name')) throw new Error('Enter what you sold');
      if (!(n(val(f, 'unit_cost')) >= 0)) throw new Error('Enter what you bought it for');
      if (!(n(val(f, 'unit_price')) > 0)) throw new Error('Enter what you sold it for');
      const paid = paidValue(f, total(f) - laterIn);
      const costPaid = paidValue(f, costTotal(f) - laterOut, 'cost');
      if (paid !== '' && !val(f, 'customer_name')) throw new Error('Enter the customer’s name so you know who owes you');
      if (costPaid !== '' && costTotal(f) > 0 && !val(f, 'supplier_name')) throw new Error('Enter who you bought it from, so you know who you owe');
      const body = {
        item_name: val(f, 'item_name'), qty: val(f, 'qty'), unit_price: val(f, 'unit_price'), unit_cost: val(f, 'unit_cost'),
        paid: paid === '' ? r2(total(f) - laterIn) : paid, money_account_id: accountValue(f),
        cost_paid: costPaid === '' ? r2(costTotal(f) - laterOut) : costPaid, cost_account_id: accountValue(f, 'cost'),
        supplier_name: val(f, 'supplier_name'), customer_name: val(f, 'customer_name'), date: val(f, 'date'), note: val(f, 'note'),
      };
      if (sale) await api('PUT', `/api/simple/sales/${sale.id}`, body); else await api('POST', '/api/simple/sales', body);
      return changed(sale ? 'Sale updated' : 'Sale saved');
    },
    onDelete: sale ? async () => { await api('DELETE', `/api/simple/sales/${sale.id}`); return changed('Sale deleted'); } : null,
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
