import { $, $$, esc, GET, api, icon, money, fdate, toast, confirmBox, emptyState } from '../core.js';
import { settleForm } from './forms.js';
import { stat } from './sales.js';

// "Owes you Rs 5,000" / "You owe Rs 5,000" / "Settled"
export const balanceText = (b, cls = true) => (Math.abs(b) < 0.005 ? '<span class="muted">Settled</span>'
  : b > 0 ? `<span class="${cls ? 'pos' : ''}">Owes you ${money(b)}</span>` : `<span class="${cls ? 'neg' : ''}">You owe ${money(-b)}</span>`);
const role = (p) => [p.customer && 'Customer', p.supplier && 'Supplier'].filter(Boolean).join(' & ');

export async function ledgers(root, params) {
  const name = params.get('name');
  return name ? personLedger(root, name) : peopleList(root);
}

async function peopleList(root) {
  let search = '';
  root.innerHTML = `<div class="page-head"><div><h1>Ledgers</h1><p>Everyone you buy from or sell to — open a person to see every sale, purchase and payment with them.</p></div></div>
    <div class="stats" data-stats style="--cols:3"></div>
    <div class="toolbar"><div class="search">${icon('search')}<input type="search" placeholder="Search a name…" aria-label="Search people"></div></div>
    <div class="card" data-list></div>`;
  const load = async () => {
    const d = await GET('/api/simple/people', { search });
    $('[data-stats]', root).innerHTML = stat('People', d.summary.people, '', 'var(--primary)')
      + stat('They owe you', `<span class="pos">${money(d.summary.to_receive)}</span>`, '', 'var(--green)')
      + stat('You owe', `<span class="neg">${money(d.summary.to_pay)}</span>`, '', 'var(--red)');
    $('[data-list]', root).innerHTML = d.rows.length ? `<div class="table-wrap"><table class="t cards"><thead><tr><th>Name</th><th class="r">Sold to them</th><th class="r">Bought from them</th><th class="r">Balance</th><th>Last activity</th></tr></thead><tbody>
      ${d.rows.map((p) => `<tr class="click" data-name="${esc(p.name)}"><td class="lead strong">${esc(p.name)}<span class="sub">${role(p)}${p.phone ? ` · ${esc(p.phone)}` : ''}</span></td>
        <td class="r hide-m">${p.sold ? money(p.sold) : '—'}</td><td class="r hide-m">${p.bought ? money(p.bought) : '—'}</td>
        <td class="r strong">${balanceText(p.balance)}</td><td class="hide-m muted">${p.last ? fdate(p.last) : '—'}</td></tr>`).join('')}</tbody></table></div>`
      : emptyState('book', search ? 'No one by that name' : 'No people yet', search ? 'Try a different spelling.' : 'When you add a customer name to a sale, or a supplier / “paid to” name to a purchase or expense, they appear here.');
    $$('tr[data-name]', root).forEach((tr) => { tr.onclick = () => { location.hash = `#/ledgers?name=${encodeURIComponent(tr.dataset.name)}`; }; });
  };
  let t; $('.search input', root).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { search = e.target.value.trim(); load(); }, 220); };
  await load();
}

async function personLedger(root, name) {
  const d = await GET('/api/simple/ledger', { name });
  const s = d.summary;
  const moneyCol = (r) => (r.kind === 'received' ? `<span class="pos">Received ${money(r.amount)}</span>`
    : r.kind === 'paid' || r.kind === 'paid_expense' ? `<span class="neg">Paid ${money(r.amount)}</span>` : '');
  const dealCol = (r) => (r.kind === 'sale' ? `Sold ${money(r.amount)}` : r.kind === 'bought' || r.kind === 'paid_expense' ? `Bought ${money(r.amount)}` : '');
  root.innerHTML = `
    <a class="back no-print" href="#/ledgers">← All ledgers</a>
    <div class="page-head"><div><h1>${esc(d.name)}</h1><p>${role(d)}${d.phone ? ` · ${esc(d.phone)}` : ''} — every sale, purchase and payment, newest first.</p></div>
      <div class="actions no-print">
        ${d.balance > 0.005 ? `<button class="btn primary" data-settle="receive">${icon('check')} Money received</button>` : ''}
        ${d.balance < -0.005 ? `<button class="btn primary" data-settle="pay">${icon('check')} Make a payment</button>` : ''}
        <button class="btn" data-print>${icon('printer')} Print</button></div></div>
    <div class="stats">
      <div class="card stat ${d.balance > 0.005 ? 'hero' : d.balance < -0.005 ? 'hero loss' : ''}"><div class="label">Balance</div><div class="value">${Math.abs(d.balance) < 0.005 ? 'Settled' : money(Math.abs(d.balance))}</div>
        <div class="sub">${d.balance > 0.005 ? 'They owe you' : d.balance < -0.005 ? 'You owe them' : 'Nothing owed either way'}</div></div>
      ${d.customer ? stat('Sold to them', money(s.sold), `Received ${money(s.received)}`, 'var(--primary)') : ''}
      ${d.supplier ? stat('Bought from them', money(s.bought), `Paid ${money(s.paid)}`, 'var(--amber)') : ''}
      ${stat('Entries', d.rows.length, '', 'var(--faint)')}
    </div>
    <div class="card">${d.rows.length ? `<div class="table-wrap"><table class="t cards"><thead><tr><th>Date</th><th>What happened</th><th class="r">Sale / purchase</th><th class="r">Money</th><th class="r">Balance after</th></tr></thead><tbody>
      ${d.rows.map((r, i) => `<tr class="${r.ref.type === 'receipt' || r.ref.type === 'payment' ? 'click' : ''}" data-i="${i}"><td class="hide-m">${fdate(r.date)}</td>
        <td class="lead"><span class="strong">${esc(r.details)}</span><span class="sub"><span class="m-only">${fdate(r.date)} · </span>${[r.note, r.number].filter(Boolean).map(esc).join(' · ')}</span></td>
        <td class="r hide-m">${dealCol(r)}</td><td class="r strong">${moneyCol(r) || `<span class="m-only">${dealCol(r)}</span>`}</td>
        <td class="r hide-m">${balanceText(r.balance, false)}</td></tr>`).join('')}</tbody></table></div>`
      : emptyState('book', 'No entries yet', 'Sales, purchases and payments with this person will appear here.')}</div>
    <p class="help no-print" style="margin-top:12px">Tip: tap a “Received” or “Paid” line to delete it if it was entered by mistake.</p>`;
  $$('[data-settle]', root).forEach((b) => { b.onclick = () => settleForm({ kind: b.dataset.settle, person: d.name, due: Math.abs(d.balance) }); });
  $('[data-print]', root).onclick = () => window.print();
  $$('tr.click[data-i]', root).forEach((tr) => {
    tr.onclick = async () => {
      const r = d.rows[tr.dataset.i];
      if (!await confirmBox('Delete this payment?', `${r.details} of ${money(r.amount)} on ${fdate(r.date)} will be removed, and the amount will show as owed again.`)) return;
      try { await api('DELETE', `/api/simple/money/${r.ref.type}/${r.ref.id}`); toast('Payment deleted'); document.dispatchEvent(new CustomEvent('data-changed')); } catch (e) { toast(e.message, true); }
    };
  });
}
