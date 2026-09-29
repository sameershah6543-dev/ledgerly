import { S, $, $$, esc, GET, icon, money, fdate, period, remember } from '../core.js';
import { barChart, chartTips } from './dashboard.js';

const OPTIONS = [['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['lastyear', 'Last year'], ['all', 'All time']];

export async function profitLoss(root) {
  const key = remember('pl-period') || 'month';
  const d = await GET('/api/simple/summary', period(key));
  const loss = d.net_profit < 0; const maxExp = Math.max(1, ...d.expense_breakdown.map((e) => e.amount));
  const range = d.from === '0000-01-01' ? `Up to ${fdate(d.to)}` : `${fdate(d.from)} – ${fdate(d.to)}`;
  root.innerHTML = `
    <div class="page-head"><div><h1>Profit &amp; Loss</h1><p>Did you make money? What you sold for, minus what you paid, minus your expenses.</p></div>
      <div class="actions no-print"><button class="btn" data-print>${icon('printer')} Print</button></div></div>
    <div class="toolbar no-print"><div class="chips">${OPTIONS.map(([k, l]) => `<button data-p="${k}" class="${k === key ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="dash-grid">
      <div class="card"><div class="card-head"><div><h2>${esc(S.settings.business_name || 'Profit & Loss')}</h2><span class="muted" style="font-size:13.5px">${range}</span></div></div>
        <div class="card-body pl">
          <div class="pl-row"><span>Sales<span class="hint">${d.sales_count} sale${d.sales_count === 1 ? '' : 's'}</span></span><span class="n">${money(d.sales)}</span></div>
          <div class="pl-row"><span>What you paid for them<span class="hint">The buying price of everything you sold</span></span><span class="n">${money(-d.cost_of_sales)}</span></div>
          <div class="pl-row total"><span>Profit on sales</span><span class="${d.gross_profit < 0 ? 'neg' : ''}">${money(d.gross_profit)}</span></div>
          ${d.other_income ? `<div class="pl-row"><span>Other income</span><span class="n">${money(d.other_income)}</span></div>` : ''}
          <div class="pl-row"><span>Expenses<span class="hint">Rent, bills, salaries and other running costs</span></span><span class="n">${money(-d.expenses)}</span></div>
          ${d.expense_breakdown.map((e) => `<div class="pl-row minor"><span>${esc(e.name)}</span><span>${money(-e.amount)}</span></div>`).join('')}
          <div class="pl-result ${loss ? 'loss' : ''}"><b>${loss ? 'Net loss' : 'Net profit'}</b><span class="n ${loss ? 'neg' : 'pos'}">${money(d.net_profit)}</span></div>
        </div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><div class="card-head"><h2>Where the money went</h2></div><div class="card-body">
          ${d.expense_breakdown.length ? `<div class="bars">${d.expense_breakdown.map((e) => `<div class="hbar"><div class="top"><span>${esc(e.name)}</span><span>${money(e.amount)}</span></div><div class="track"><div class="fill" style="width:${(e.amount / maxExp) * 100}%"></div></div></div>`).join('')}</div>`
            : '<p class="muted" style="margin:0">No expenses in this period.</p>'}
        </div></div>
        <div class="card no-print"><div class="card-head"><h2>6-month trend</h2><div class="legend"><span><i style="background:var(--primary)"></i>Sales</span><span><i style="background:var(--green)"></i>Profit</span></div></div>
          <div class="card-body" id="chart">${barChart(d.trend)}</div></div>
      </div>
    </div>`;
  $$('[data-p]', root).forEach((b) => { b.onclick = () => { remember('pl-period', b.dataset.p); profitLoss(root); }; });
  $('[data-print]', root).onclick = () => window.print();
  chartTips($('#chart', root), d.trend);
}
