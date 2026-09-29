import { S, $, $$, esc, GET, icon, money, compact, qty, fdate, monthName, period, PERIODS, periodLabel, remember, emptyState } from '../core.js';
import { saleForm, expenseForm } from './forms.js';

// Grouped bars: sales vs net profit per month (profit bars go red below zero).
export function barChart(trend) {
  const W = 640, H = 240, L = 46, B = 26, T = 10; const iw = W - L - 8, ih = H - B - T;
  const vals = trend.flatMap((m) => [m.sales, m.profit]);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals); const span = max - min;
  const y = (v) => T + ih - ((v - min) / span) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + span * t);
  const gw = iw / trend.length, bw = Math.min(26, gw / 3.2);
  let g = ticks.map((t) => `<line class="gl" x1="${L}" x2="${W - 8}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('');
  g += `<line class="zero" x1="${L}" x2="${W - 8}" y1="${y(0)}" y2="${y(0)}"/>`;
  trend.forEach((m, i) => {
    const cx = L + gw * i + gw / 2;
    const bar = (v, x, cls) => { const top = Math.min(y(v), y(0)); const h = Math.max(v === 0 ? 0 : 2, Math.abs(y(v) - y(0))); return `<rect class="${cls}" x="${x}" y="${top}" width="${bw}" height="${h}" rx="4"/>`; };
    g += `<g data-i="${i}">${bar(m.sales, cx - bw - 2, 'bar-sales')}${bar(m.profit, cx + 2, m.profit < 0 ? 'bar-loss' : 'bar-profit')}
      <rect x="${L + gw * i}" y="${T}" width="${gw}" height="${ih}" fill="transparent"/><text x="${cx}" y="${H - 6}" text-anchor="middle">${monthName(m.month)}</text></g>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Sales and profit for the last six months">${g}</svg>`;
}
export function chartTips(root, trend) {
  let tip = null;
  $$('g[data-i]', root).forEach((gEl) => {
    gEl.addEventListener('mousemove', (e) => {
      const m = trend[gEl.dataset.i];
      if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.append(tip); }
      tip.innerHTML = `<b>${monthName(m.month)} ${m.month.slice(0, 4)}</b><br>Sales ${money(m.sales)}<br>${m.profit < 0 ? 'Loss' : 'Profit'} ${money(m.profit)}`;
      tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 200)}px`; tip.style.top = `${e.clientY + 14}px`;
    });
    gEl.addEventListener('mouseleave', () => { tip?.remove(); tip = null; });
  });
}

export async function dashboard(root) {
  const key = remember('dash-period') || 'month';
  const d = await GET('/api/simple/summary', period(key));
  const hr = new Date().getHours(); const hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const margin = d.sales > 0 ? Math.round((d.gross_profit / d.sales) * 100) : 0;
  const loss = d.net_profit < 0;
  root.innerHTML = `
    <div class="page-head"><div><h1>${hello}</h1><p>Here’s how ${esc(S.settings.business_name || 'your business')} is doing — ${periodLabel(key).toLowerCase()}.</p></div>
      <div class="chips" role="tablist">${PERIODS.map(([k, l]) => `<button data-p="${k}" class="${k === key ? 'on' : ''}">${l}</button>`).join('')}</div></div>

    <div class="quick">
      <button data-a="sale"><span class="qi c1">${icon('sales')}</span><span><b>Record a sale</b><small>You sold something</small></span></button>
      <button data-a="expense"><span class="qi c2">${icon('expense')}</span><span><b>Add an expense</b><small>You paid a bill or cost</small></span></button>
      <button data-a="owed"><span class="qi c3">${icon('swap')}</span><span><b>Record a payment</b><small>Money someone paid you, or you paid</small></span></button>
    </div>

    <div class="stats">
      <div class="card stat"><div class="label"><span class="dot" style="background:var(--primary)"></span>Sales</div><div class="value">${money(d.sales)}</div><div class="sub">${d.sales_count} sale${d.sales_count === 1 ? '' : 's'}</div></div>
      <div class="card stat"><div class="label"><span class="dot" style="background:var(--green)"></span>Profit on sales</div><div class="value">${money(d.gross_profit)}</div><div class="sub">${margin}% margin after what you paid</div></div>
      <div class="card stat"><div class="label"><span class="dot" style="background:var(--red)"></span>Expenses</div><div class="value">${money(d.expenses)}</div><div class="sub">Rent, bills, salaries…</div></div>
      <div class="card stat hero ${loss ? 'loss' : ''}"><div class="label">${loss ? 'Net loss' : 'Net profit'}</div><div class="value">${money(d.net_profit)}</div><div class="sub">What you ${loss ? 'lost' : 'kept'} after everything</div></div>
    </div>

    <div class="dash-grid">
      <div class="grid">
        <div class="card"><div class="card-head"><h2>Last 6 months</h2><div class="legend"><span><i style="background:var(--primary)"></i>Sales</span><span><i style="background:var(--green)"></i>Net profit</span></div></div>
          <div class="card-body" id="chart">${barChart(d.trend)}</div></div>
        <div class="card"><div class="card-head"><h2>Recent sales</h2><a href="#/sales">See all</a></div><div class="card-body">
          ${d.recent.length ? `<ul class="list">${d.recent.map((s) => `<li><div class="l"><b>${esc(s.product)}</b><small>${fdate(s.date)} · ${qty(s.qty)} × ${money(s.unit_price)}${s.customer ? ` · ${esc(s.customer)}` : ''}</small></div>
            <div class="rt"><b>${money(s.net)}</b><small class="${s.profit < 0 ? 'neg' : 'pos'}">${money(s.profit, { sign: true })} profit</small></div></li>`).join('')}</ul>`
            : emptyState('sales', 'No sales in this period', 'Record your first sale to see it here.')}
        </div></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><div class="card-head"><h2>Money you have</h2></div><div class="card-body"><ul class="list">
          ${d.money.map((m) => `<li><div class="l" style="display:flex;gap:10px;align-items:center"><span class="qi ${m.kind === 'cash' ? 'c3' : 'c1'}" style="width:34px;height:34px;border-radius:9px;display:grid;place-items:center">${icon(m.kind === 'cash' ? 'wallet' : 'bank')}</span><b>${esc(m.name)}</b></div><div class="rt"><b class="${m.balance < 0 ? 'neg' : ''}">${money(m.balance)}</b></div></li>`).join('')}
        </ul></div></div>
        <div class="card"><div class="card-head"><h2>Inventory</h2><a href="#/inventory">Open</a></div><div class="card-body"><ul class="list">
          <li><div class="l"><b>${d.stock.phones} ${d.stock.phones === 1 ? 'phone' : 'phones'} not sold yet</b><small>What you paid for them</small></div><div class="rt"><b>${money(d.stock.value)}</b></div></li>
        </ul></div></div>
        <div class="card"><div class="card-head"><h2>Money owed</h2><a href="#/owed">Open</a></div><div class="card-body"><ul class="list">
          <li><div class="l"><b>To receive</b><small>Customers who haven’t paid yet</small></div><div class="rt"><b class="${d.owed.receive > 0 ? 'pos' : ''}">${money(d.owed.receive)}</b></div></li>
          <li><div class="l"><b>To pay</b><small>Suppliers & bills not paid yet</small></div><div class="rt"><b class="${d.owed.pay > 0 ? 'neg' : ''}">${money(d.owed.pay)}</b></div></li>
        </ul></div></div>
      </div>
    </div>`;
  $$('[data-p]', root).forEach((b) => { b.onclick = () => { remember('dash-period', b.dataset.p); dashboard(root); }; });
  $('[data-a=sale]', root).onclick = () => saleForm();
  $('[data-a=expense]', root).onclick = () => expenseForm();
  $('[data-a=owed]', root).onclick = () => { location.hash = '#/owed'; };
  chartTips($('#chart', root), d.trend);
}
