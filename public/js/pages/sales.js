import { $, $$, esc, GET, icon, money, qty, fdate, period, PERIODS, remember, emptyState } from '../core.js';
import { saleForm } from './forms.js';

// Shared list-page scaffold: heading, summary cards, search + period filter, and a table that reloads in place.
export async function listPage(root, o) {
  let key = remember(o.storeKey) || 'month'; let search = '';
  root.innerHTML = `<div class="page-head"><div><h1>${o.title}</h1><p>${o.sub}</p></div><div class="actions">${o.actions}</div></div>
    <div class="stats" data-stats style="--cols:${o.statCols || 3}"></div>
    <div class="toolbar"><div class="search">${icon('search')}<input type="search" placeholder="${o.searchPh}" aria-label="Search"></div>
      ${o.noPeriod ? '' : `<div class="chips">${PERIODS.map(([k, l]) => `<button data-p="${k}" class="${k === key ? 'on' : ''}">${l}</button>`).join('')}</div>`}</div>
    <div class="card" data-list></div>`;
  const load = async () => {
    const d = await GET(o.url, { ...(o.noPeriod ? {} : period(key)), search });
    $('[data-stats]', root).innerHTML = o.stats(d);
    $('[data-list]', root).innerHTML = d.rows.length ? `<div class="table-wrap">${o.table(d)}</div>` : o.empty(!!search);
    o.bind?.(root, d);
  };
  let t; $('.search input', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { search = e.target.value.trim(); load(); }, 220); };
  $$('[data-p]', root).forEach((b) => { b.onclick = () => { key = b.dataset.p; remember(o.storeKey, key); $$('[data-p]', root).forEach((x) => x.classList.toggle('on', x === b)); load(); }; });
  await load();
}
export const stat = (label, value, sub, color) => `<div class="card stat"><div class="label"><span class="dot" style="background:${color}"></span>${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

export async function sales(root) {
  await listPage(root, {
    title: 'Sales', sub: 'Everything you’ve sold. Your revenue and profit update automatically.', storeKey: 'sales-period',
    actions: `<button class="btn primary" data-new>${icon('plus')} Record a sale</button>`, url: '/api/simple/sales', searchPh: 'Search product, customer, note…',
    stats: ({ summary: s }) => stat('Total sales', money(s.sales), `${s.count} sale${s.count === 1 ? '' : 's'}`, 'var(--primary)')
      + stat('Cost of products sold', money(s.cost), 'What those items cost you', 'var(--faint)')
      + stat('Profit on sales', `<span class="${s.profit < 0 ? 'neg' : ''}">${money(s.profit)}</span>`, s.sales ? `${Math.round((s.profit / s.sales) * 100)}% margin` : '', 'var(--green)'),
    table: ({ rows, summary: s }) => `<table class="t cards"><thead><tr><th>Date</th><th>Product</th><th class="r">Qty</th><th class="r">Sold for</th><th class="r">Cost</th><th class="r">Profit</th><th>Received in</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-id="${r.id}"><td class="hide-m">${fdate(r.date)}</td>
        <td class="lead strong">${esc(r.product)}<span class="sub"><span class="m-only">${fdate(r.date)} · ${qty(r.qty)} sold${r.customer || r.note ? ' · ' : ''}</span>${[r.customer, r.note].filter(Boolean).map(esc).join(' · ')}</span></td>
        <td class="r hide-m">${qty(r.qty)}</td><td class="r strong">${money(r.net)}</td><td class="r hide-m">${money(r.cost)}</td>
        <td class="r ${r.profit < 0 ? 'neg' : 'pos'} strong" data-l="Profit">${money(r.profit, { sign: true })}</td><td class="hide-m">${esc(r.paid_into || '')}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td class="hide-m"></td><td class="lead">Total</td><td class="r hide-m">${qty(rows.reduce((a, r) => a + r.qty, 0))}</td><td class="r">${money(s.sales)}</td><td class="r hide-m">${money(s.cost)}</td><td class="r ${s.profit < 0 ? 'neg' : 'pos'}">${money(s.profit, { sign: true })}</td><td class="hide-m"></td></tr></tfoot></table>`,
    empty: (searching) => emptyState('sales', searching ? 'No matching sales' : 'No sales in this period', searching ? 'Try a different search.' : 'When you sell something, record it here — revenue, profit and stock update on their own.', searching ? '' : `<br><button class="btn primary" data-new2>${icon('plus')} Record a sale</button>`),
    bind(r, d) {
      $$('tr[data-id]', r).forEach((tr) => { tr.onclick = () => saleForm(d.rows.find((x) => String(x.id) === tr.dataset.id)); });
      const b = $('[data-new2]', r); if (b) b.onclick = () => saleForm();
    },
  });
  $('[data-new]', root).onclick = () => saleForm();
}
