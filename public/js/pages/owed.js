import { $, $$, esc, GET, icon, money, fdate, remember, emptyState } from '../core.js';
import { settleForm } from './forms.js';
import { stat } from './sales.js';

const TYPE = { invoice: 'Sale', bill: 'Stock bought', expense: 'Expense' };

export async function owed(root, params) {
  let kind = params.get('tab') || remember('owed-tab') || 'receive';
  const [rec, pay] = await Promise.all([GET('/api/simple/owed/receive'), GET('/api/simple/owed/pay')]);
  const draw = () => {
    const d = kind === 'receive' ? rec : pay; const R = kind === 'receive';
    root.innerHTML = `
      <div class="page-head"><div><h1>Receivables &amp; Payables</h1><p>Who owes you money, and who you need to pay. Record a payment when money comes in or goes out.</p></div></div>
      <div class="stats" style="--cols:3">
        ${stat('To receive', `<span class="pos">${money(rec.total)}</span>`, `${rec.people.length} ${rec.people.length === 1 ? 'person owes' : 'people owe'} you`, 'var(--green)')}
        ${stat('To pay', `<span class="neg">${money(pay.total)}</span>`, `You owe ${pay.people.length} ${pay.people.length === 1 ? 'person' : 'people'}`, 'var(--red)')}
        ${stat('Difference', money(rec.total - pay.total), rec.total >= pay.total ? 'More coming in than going out' : 'More to pay than to receive', 'var(--primary)')}
      </div>
      <div class="toolbar"><div class="chips" role="tablist">
        <button data-k="receive" class="${R ? 'on' : ''}">To receive · ${money(rec.total)}</button>
        <button data-k="pay" class="${R ? '' : 'on'}">To pay · ${money(pay.total)}</button></div></div>
      ${d.people.length ? `<div class="grid">${d.people.map((p, pi) => `
        <div class="card owe-card">
          <div class="owe-head">
            <div class="avatar ${R ? 'av-g' : 'av-r'}">${esc(p.person[0].toUpperCase())}</div>
            <div class="owe-who"><b>${esc(p.person)}</b><small>${p.items.length} ${p.items.length === 1 ? 'item' : 'items'} · since ${fdate(p.oldest)}</small></div>
            <div class="owe-amt"><small>${R ? 'Owes you' : 'You owe'}</small><b class="${R ? 'pos' : 'neg'}">${money(p.due)}</b></div>
            <div class="owe-act"><button class="btn primary sm" data-settle="${pi}">${icon('check')} ${R ? 'Money received' : 'Pay'}</button>
              <a class="btn sm" href="#/ledgers?name=${encodeURIComponent(p.person)}">${icon('book')} Ledger</a></div>
          </div>
          <div class="table-wrap"><table class="t cards owe-items"><thead><tr><th>Date</th><th>What for</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Remaining</th><th></th></tr></thead><tbody>
            ${p.items.map((i, ii) => `<tr><td class="hide-m">${fdate(i.date)}</td>
              <td class="lead"><span class="strong">${esc(i.what || i.number)}</span><span class="sub">${TYPE[i.type]} · ${esc(i.number)}<span class="m-only"> · ${fdate(i.date)}</span></span></td>
              <td class="r hide-m">${money(i.total)}</td><td class="r hide-m">${money(i.paid)}</td>
              <td class="r strong ${R ? 'pos' : 'neg'}" data-l="Left">${money(i.due)}</td>
              <td class="r"><button class="btn sm ghost" data-item="${pi}:${ii}">${R ? 'Received' : 'Paid'}…</button></td></tr>`).join('')}
          </tbody></table></div>
        </div>`).join('')}</div>`
        : `<div class="card">${emptyState('check', R ? 'Nobody owes you money' : 'You don’t owe anyone',
          R ? 'When you choose “Not paid yet” or “Part paid” on a sale, the customer shows up here.' : 'When you buy stock or record an expense with “Pay later” or “Part paid”, it shows up here.')}</div>`}`;
    $$('[data-k]', root).forEach((b) => { b.onclick = () => { kind = b.dataset.k; remember('owed-tab', kind); draw(); }; });
    $$('[data-settle]', root).forEach((b) => { b.onclick = () => { const p = d.people[b.dataset.settle]; settleForm({ kind, person: p.person, due: p.due }); }; });
    $$('[data-item]', root).forEach((b) => {
      b.onclick = () => { const [pi, ii] = b.dataset.item.split(':').map(Number); const p = d.people[pi]; const i = p.items[ii]; settleForm({ kind, person: p.person, due: i.due, item: i }); };
    });
  };
  draw();
}
