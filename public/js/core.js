// Shared helpers: state, API, formatting, icons, toasts, modal dialogs.
export const S = { user: null, settings: {} };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- API
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('Cannot reach the app. Make sure Ledgerly is running.'); }
  let data = null; try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !url.includes('/auth/login')) { document.dispatchEvent(new CustomEvent('auth-required')); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error(data?.error || `Something went wrong (${res.status})`);
  return data;
}
export const GET = (url, p = {}) => {
  const u = new URLSearchParams(); for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  const s = u.toString(); return api('GET', url + (s ? `?${s}` : ''));
};

// ---------------------------------------------------------------- formatting
const cur = () => S.settings.currency_symbol || S.settings.currency_code || '';
export function money(n, { sign = false } = {}) {
  const v = Number(n) || 0; const a = Math.abs(v);
  const s = a.toLocaleString('en-US', { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return `${v < -0.004 ? '−' : sign && v > 0.004 ? '+' : ''}${cur()} ${s}`.trim();
}
export const qty = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
export const compact = (n) => {
  const a = Math.abs(n); const s = a >= 1e7 ? (a / 1e6).toFixed(0) + 'M' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(0) + 'k' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : String(Math.round(a));
  return (n < 0 ? '−' : '') + s.replace('.0', '');
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fdate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MON[m - 1]} ${y}`;
}
export const monthName = (ym) => MON[Number(ym.slice(5, 7)) - 1];
const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDate(new Date());

// Named periods used across screens
export const PERIODS = [['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['all', 'All time']];
export function period(key) {
  const d = new Date(); const y = d.getFullYear(), m = d.getMonth();
  if (key === 'today') return { from: today(), to: today() };
  if (key === 'month') return { from: isoDate(new Date(y, m, 1)), to: today() };
  if (key === 'last') return { from: isoDate(new Date(y, m - 1, 1)), to: isoDate(new Date(y, m, 0)) };
  if (key === 'year') return { from: `${y}-01-01`, to: today() };
  if (key === 'lastyear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  return { from: '', to: '' };
}
export const periodLabel = (key) => (PERIODS.find(([k]) => k === key) || [, 'All time'])[1];
export const remember = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* storage unavailable */ } return v; };

// ---------------------------------------------------------------- icons (Lucide-style strokes)
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  sales: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  expense: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  wallet: '<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15V7"/><circle cx="16" cy="14" r="1.2"/>',
  bank: '<path d="M3 21h18M4 10h16M12 3l9 5H3z"/><path d="M6 10v8M10 10v8M14 10v8M18 10v8"/>',
  up: '<path d="M7 17 17 7M8 7h9v9"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  logo: '<path d="M8 5v14h10"/>',
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5A2.5 2.5 0 0 0 4 21.5"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M9 7h7M9 11h5"/>',
  swap: '<path d="M7 7h13l-4-4M17 17H4l4 4"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};
export const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;

// ---------------------------------------------------------------- toasts
export function toast(msg, err = false) {
  const t = document.createElement('div'); t.className = `toast${err ? ' err' : ''}`;
  t.innerHTML = `${icon(err ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 5000 : 2800);
}

// ---------------------------------------------------------------- modal
// modal({ title, sub, body, submit, danger?, onSubmit(form) => truthy to close, onDelete?, wide?, onOpen?(root) })
export function modal(o) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<form class="modal ${o.wide ? 'wide' : ''}" novalidate>
    <div class="modal-head"><div><h2>${esc(o.title)}</h2>${o.sub ? `<p>${esc(o.sub)}</p>` : ''}</div><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body"><div class="form-error hidden"></div>${o.body}</div>
    <div class="modal-foot">${o.onDelete ? `<button type="button" class="btn danger left" data-del>${icon('trash')} Delete</button>` : ''}
      <button type="button" class="btn ghost" data-close>Cancel</button>${o.submit === false ? '' : `<button class="btn ${o.danger ? 'solid-danger' : 'primary'}" type="submit">${esc(o.submit || 'Save')}</button>`}</div></form>`;
  document.body.append(ov);
  const form = $('form', ov); const errBox = $('.form-error', ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  $$('[data-close]', ov).forEach((b) => { b.onclick = close; });
  const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); errBox.scrollIntoView({ block: 'nearest' }); };
  const busy = async (btn, fn) => {
    const label = btn.innerHTML; btn.disabled = true; errBox.classList.add('hidden');
    try { if (await fn()) close(); } catch (e) { showErr(e.message); } finally { btn.disabled = false; btn.innerHTML = label; }
  };
  form.onsubmit = (e) => { e.preventDefault(); busy($('[type=submit]', form), () => o.onSubmit(form)); };
  if (o.onDelete) $('[data-del]', ov).onclick = (e) => { const b = e.currentTarget; if (b.dataset.sure) busy(b, o.onDelete); else { b.dataset.sure = '1'; b.innerHTML = `${icon('trash')} Tap again to delete`; } };
  o.onOpen?.(form);
  setTimeout(() => $('input:not([type=hidden]):not([type=radio]), select', form)?.focus(), 30);
  return { form, close, showErr };
}
export const val = (form, name) => form.elements[name]?.value?.trim?.() ?? '';
export const confirmBox = (title, text, submit = 'Delete') => new Promise((resolve) => {
  let done = false;
  const m = modal({ title, body: `<p style="margin:0;color:var(--text-2)">${esc(text)}</p>`, submit, danger: true, onSubmit: () => { done = true; resolve(true); return true; } });
  new MutationObserver((_, obs) => { if (!document.body.contains(m.form)) { obs.disconnect(); if (!done) resolve(false); } }).observe(document.body, { childList: true });
});

// input helpers
export const moneyInput = (name, value = '', attrs = '') =>
  `<div class="prefix" style="--pw:${Math.max(1, cur().length) * 0.62}em"><span>${esc(cur())}</span><input class="input money" name="${name}" type="number" inputmode="decimal" step="any" min="0" value="${esc(value)}" ${attrs}></div>`;
export const moneyOptions = (accounts, selected) => accounts.map((a) => `<label><input type="radio" name="money_account_id" value="${a.id}" ${String(a.id) === String(selected) ? 'checked' : ''}>${icon(a.kind === 'cash' ? 'wallet' : 'bank')}${esc(a.name)}</label>`).join('');
export const emptyState = (ic, title, text, btn = '') => `<div class="empty"><div class="ic">${icon(ic)}</div><b>${esc(title)}</b>${esc(text)}${btn}</div>`;
