import { $, $$, esc, GET, icon, money, qty, fdate, modal, emptyState } from '../core.js';
import { productForm, restockForm } from './forms.js';
import { listPage, stat } from './sales.js';

const badge = (r) => (r.is_service ? '<span class="badge">Service</span>'
  : `<span class="badge ${r.status}">${r.status === 'out' ? 'Out of stock' : r.status === 'low' ? `Low · ${qty(r.stock)}` : qty(r.stock)}</span>`);

async function history(p) {
  const h = await GET(`/api/simple/products/${p.id}/history`);
  const each = p.selling_price - p.cost;
  const rows = h.rows.filter((m) => m.qty_in || m.qty_out);
  modal({
    title: p.name, sub: 'Stock history — every unit in and out.', wide: true, submit: false,
    body: `<div class="summary-box" style="margin:0 0 18px"><div><small>In stock</small><b>${qty(p.stock)}</b></div><div><small>Stock value</small><b>${money(p.value)}</b></div><div><small>Profit each (at selling price)</small><b class="${each < 0 ? 'neg' : 'pos'}">${money(each)}</b></div></div>
      ${rows.length ? `<div class="history card"><table class="t"><thead><tr><th>Date</th><th>What happened</th><th class="r">In</th><th class="r">Out</th><th class="r">Cost each</th><th class="r">Balance</th></tr></thead><tbody>
      ${rows.map((m) => `<tr><td>${fdate(m.date)}</td><td>${esc({ 'Opening Stock': 'Starting stock', Purchase: 'Bought', Sale: 'Sold' }[m.type_label] || m.type_label)}</td><td class="r pos">${m.qty_in ? `+${qty(m.qty_in)}` : ''}</td><td class="r neg">${m.qty_out ? `−${qty(m.qty_out)}` : ''}</td><td class="r">${money(m.unit_cost)}</td><td class="r strong">${qty(m.balance)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No stock movements yet.</p>'}
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap"><button type="button" class="btn primary" data-rs>${icon('plus')} Add stock</button><button type="button" class="btn" data-ed>${icon('edit')} Edit product</button></div>`,
    onOpen(f) {
      const close = () => f.closest('.overlay').remove();
      $('[data-rs]', f).onclick = () => { close(); restockForm(p.id); };
      $('[data-ed]', f).onclick = () => { close(); productForm(p); };
    },
  });
}

export async function inventory(root) {
  await listPage(root, {
    title: 'Inventory', sub: 'Your products, how many you have, and what they’re worth. Sales reduce stock automatically.', noPeriod: true, statCols: 4,
    actions: `<button class="btn" data-restock>${icon('plus')} Add stock</button><button class="btn primary" data-new>${icon('box')} Add a product</button>`,
    url: '/api/simple/inventory', searchPh: 'Search products…',
    stats: ({ rows, summary: s }) => stat('Products', rows.length, '', 'var(--primary)')
      + stat('Units in stock', qty(s.quantity), '', 'var(--faint)')
      + stat('Stock value', money(s.value), 'At what you paid', 'var(--green)')
      + stat('Need restocking', s.low + s.out, s.out ? `${s.out} out of stock` : s.low ? 'Running low' : 'All good', 'var(--amber)'),
    table: ({ rows }) => `<table class="t cards"><thead><tr><th>Product</th><th>In stock</th><th class="r">Cost</th><th class="r">Selling price</th><th class="r">Profit each</th><th class="r">Stock value</th><th></th></tr></thead><tbody>
      ${rows.map((r) => { const each = r.selling_price - r.cost; const pct = r.selling_price > 0 ? Math.round((each / r.selling_price) * 100) : 0;
        return `<tr class="click" data-id="${r.id}"><td class="lead strong">${esc(r.name)}<span class="sub">${r.sold ? `${qty(r.sold)} sold` : 'Not sold yet'}<span class="m-only"> · cost ${money(r.cost)} · sells ${money(r.selling_price)}</span></span></td>
          <td class="r" style="text-align:left">${badge(r)}</td><td class="r hide-m">${money(r.cost)}</td><td class="r hide-m">${money(r.selling_price)}</td>
          <td class="r hide-m ${each < 0 ? 'neg' : 'pos'}">${money(each)} <span class="muted" style="font-weight:400">(${pct}%)</span></td><td class="r strong hide-m">${money(r.value)}</td>
          <td class="hide-m"><div class="row-actions">${r.is_service ? '' : `<button class="btn sm" data-add="${r.id}">${icon('plus')} Stock</button>`}<button class="icon-btn" data-edit="${r.id}" aria-label="Edit ${esc(r.name)}">${icon('edit')}</button></div></td></tr>`; }).join('')}</tbody></table>`,
    empty: (searching) => emptyState('box', searching ? 'No matching products' : 'No products yet', searching ? 'Try a different search.' : 'Add the products you sell to track stock and profit.', searching ? '' : `<br><button class="btn primary" data-new2>${icon('box')} Add a product</button>`),
    bind(r, d) {
      const find = (id) => d.rows.find((x) => String(x.id) === String(id));
      $$('tr[data-id]', r).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('button')) history(find(tr.dataset.id)); }; });
      $$('[data-add]', r).forEach((b) => { b.onclick = () => restockForm(b.dataset.add); });
      $$('[data-edit]', r).forEach((b) => { b.onclick = () => productForm(find(b.dataset.edit)); });
      const b = $('[data-new2]', r); if (b) b.onclick = () => productForm();
    },
  });
  $('[data-new]', root).onclick = () => productForm();
  $('[data-restock]', root).onclick = () => restockForm();
}
