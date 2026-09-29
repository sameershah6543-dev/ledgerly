import { $, $$, esc, api, icon, money, qty, fdate, toast, confirmBox, emptyState } from '../core.js';
import { saleForm, stockForm } from './forms.js';
import { listPage, stat } from './sales.js';

// Phones you bought and haven't sold yet
export async function inventory(root) {
  await listPage(root, {
    title: 'Inventory', sub: 'Phones you’ve bought but not sold yet. When you sell one, pick it from here and the profit is worked out for you.', noPeriod: true,
    actions: `<button class="btn primary" data-new>${icon('plus')} Add a phone</button>`, url: '/api/simple/stock', searchPh: 'Search phone, IMEI…',
    stats: ({ summary: s }) => stat('Phones in inventory', qty(s.phones), '', 'var(--primary)')
      + stat('Money tied up', money(s.value), 'What you paid for them', 'var(--amber)')
      + stat('Still to pay suppliers', `<span class="${s.owed > 0 ? 'neg' : ''}">${money(s.owed)}</span>`, s.owed > 0 ? '<a href="#/owed?tab=pay">See who you owe →</a>' : 'All paid for', 'var(--red)'),
    table: ({ rows }) => `<table class="t cards"><thead><tr><th>Phone</th><th class="r">Qty</th><th class="r">Bought for</th><th>Bought from</th><th>Bought on</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-id="${r.id}"><td class="lead strong">${esc(r.name)}<span class="sub">${[r.notes && esc(r.notes), r.owed > 0 ? `<span class="badge low">You owe ${money(r.owed)}</span>` : ''].filter(Boolean).join(' ')}<span class="m-only">${r.notes || r.owed > 0 ? ' · ' : ''}${money(r.cost)}${r.bought_from ? ` from ${esc(r.bought_from)}` : ''}</span></span></td>
        <td class="r hide-m">${qty(r.qty)}</td><td class="r strong hide-m">${money(r.cost)}</td><td class="hide-m">${esc(r.bought_from || '—')}</td><td class="hide-m muted">${fdate(r.bought_on)}</td>
        <td class="r"><div class="row-actions"><button class="btn primary sm" data-sell="${r.id}">Sell</button>
          ${r.editable ? `<button class="icon-btn" data-edit="${r.id}" title="Edit" aria-label="Edit ${esc(r.name)}">${icon('edit')}</button><button class="icon-btn" data-del="${r.id}" title="Delete" aria-label="Delete ${esc(r.name)}">${icon('trash')}</button>` : ''}</div></td></tr>`).join('')}</tbody></table>`,
    empty: (searching) => emptyState('box', searching ? 'No matching phones' : 'No phones in inventory', searching ? 'Try a different search.' : 'Add phones you’ve bought but not sold yet. Sold phones leave the inventory automatically.', searching ? '' : `<br><button class="btn primary" data-new2>${icon('plus')} Add a phone</button>`),
    bind(r, d) {
      const find = (id) => d.rows.find((x) => String(x.id) === String(id));
      $$('[data-sell]', r).forEach((b) => { b.onclick = () => saleForm(null, { itemId: Number(b.dataset.sell) }); });
      $$('[data-edit]', r).forEach((b) => { b.onclick = () => stockForm(find(b.dataset.edit)); });
      $$('[data-del]', r).forEach((b) => {
        b.onclick = async () => {
          const p = find(b.dataset.del);
          if (!await confirmBox(`Delete ${p.name}?`, `It will be removed from your inventory, along with its purchase of ${money(p.value)}${p.owed < p.value ? ' and the money you paid for it' : ''}.`)) return;
          try { await api('DELETE', `/api/simple/stock/${p.id}`); toast('Phone deleted from inventory'); document.dispatchEvent(new CustomEvent('data-changed')); } catch (e) { toast(e.message, true); }
        };
      });
      const b = $('[data-new2]', r); if (b) b.onclick = () => stockForm();
    },
  });
  $('[data-new]', root).onclick = () => stockForm();
}
