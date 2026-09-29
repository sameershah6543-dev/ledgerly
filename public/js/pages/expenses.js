import { $, $$, esc, icon, money, fdate, emptyState } from '../core.js';
import { expenseForm } from './forms.js';
import { listPage, stat, payBadge } from './sales.js';

export async function expenses(root) {
  await listPage(root, {
    title: 'Expenses', sub: 'Money spent running your business — rent, bills, salaries and more.', storeKey: 'exp-period',
    actions: `<button class="btn primary" data-new>${icon('plus')} Add an expense</button>`, url: '/api/simple/expenses', searchPh: 'Search category or details…',
    stats: ({ rows, summary: s }) => {
      const by = {}; rows.forEach((r) => { by[r.category] = (by[r.category] || 0) + r.amount; });
      const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
      return stat('Total expenses', money(s.total), `${s.count} payment${s.count === 1 ? '' : 's'}`, 'var(--red)')
        + stat('Biggest cost', top ? esc(top[0]) : '—', top ? money(top[1]) : '', 'var(--amber)')
        + stat('Average payment', money(s.count ? s.total / s.count : 0), '', 'var(--faint)');
    },
    table: ({ rows, summary: s }) => `<table class="t cards"><thead><tr><th>Date</th><th>Category</th><th>Details</th><th>Payment</th><th class="r">Amount</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-id="${r.id}"><td class="hide-m">${fdate(r.date)}</td><td class="lead strong">${esc(r.category)}<span class="sub"><span class="m-only">${fdate(r.date)}${r.paid_to || r.description ? ' · ' : ''}${esc([r.paid_to, r.description].filter(Boolean).join(' · '))}${r.status !== 'paid' ? ` ${payBadge(r, 'Unpaid')}` : ''}</span></span></td>
        <td class="hide-m">${esc([r.paid_to, r.description].filter(Boolean).join(' · '))}</td><td class="hide-m">${r.status === 'paid' ? esc(r.paid_from || 'Paid') : payBadge(r, 'Unpaid')}</td><td class="r strong">${money(r.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td class="hide-m"></td><td class="lead">Total</td><td class="hide-m"></td><td class="hide-m"></td><td class="r">${money(s.total)}</td></tr></tfoot></table>`,
    empty: (searching) => emptyState('expense', searching ? 'No matching expenses' : 'No expenses in this period', searching ? 'Try a different search.' : 'Add rent, bills, salaries and other costs to see your true profit.', searching ? '' : `<br><button class="btn primary" data-new2>${icon('plus')} Add an expense</button>`),
    bind(r, d) {
      $$('tr[data-id]', r).forEach((tr) => { tr.onclick = () => expenseForm(d.rows.find((x) => String(x.id) === tr.dataset.id)); });
      const b = $('[data-new2]', r); if (b) b.onclick = () => expenseForm();
    },
  });
  $('[data-new]', root).onclick = () => expenseForm();
}
