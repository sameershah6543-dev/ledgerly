import { S, $, $$, esc, api, GET, icon, remember } from './core.js';
import { dashboard } from './pages/dashboard.js';
import { sales } from './pages/sales.js';
import { expenses } from './pages/expenses.js';
import { inventory } from './pages/inventory.js';
import { profitLoss } from './pages/profit.js';
import { settings } from './pages/settings.js';
import { owed } from './pages/owed.js';
import { ledgers } from './pages/ledgers.js';

const NAV = [ // [route, sidebar label, phone label, icon, page, in phone tab bar]
  ['dashboard', 'Dashboard', 'Home', 'home', dashboard, true],
  ['sales', 'Sales', 'Sales', 'sales', sales, true],
  ['expenses', 'Expenses', 'Expenses', 'expense', expenses, true],
  ['inventory', 'Inventory', 'Stock', 'box', inventory, false],
  ['owed', 'Receivables & Payables', 'Owed', 'swap', owed, true],
  ['ledgers', 'Ledgers', 'Ledgers', 'book', ledgers, false],
  ['profit', 'Profit & Loss', 'Profit', 'chart', profitLoss, false],
];
// phones: everything not in the tab bar lives on the "More" page
async function more(root) {
  const items = [...NAV.filter((n) => !n[5]), ['settings', 'Settings', '', 'gear']];
  root.innerHTML = `<div class="page-head"><div><h1>More</h1><p>Everything else in Ledgerly.</p></div></div>
    <div class="card more-list">${items.map(([k, label, , ic]) => `<a href="#/${k}">${icon(ic)}<span>${label}</span>${icon('chevron')}</a>`).join('')}</div>`;
}
const ROUTES = Object.fromEntries([...NAV.map((n) => [n[0], n[4]]), ['settings', settings], ['more', more]]);
const app = $('#app');

// ---------------------------------------------------------------- theme
function applyTheme() { const t = remember('theme'); if (t) document.documentElement.dataset.theme = t; }
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function toggleTheme() { remember('theme', isDark() ? 'light' : 'dark'); applyTheme(); $$('[data-theme-btn]').forEach((b) => { b.innerHTML = icon(isDark() ? 'sun' : 'moon'); }); }
applyTheme();

const brand = () => `<div class="brand"><div class="mark">${icon('logo')}</div><div><b>Ledgerly</b><small>${esc(S.settings.business_name || '')}</small></div></div>`;

// ---------------------------------------------------------------- sign in
function showLogin(msg) {
  app.innerHTML = `<div class="login"><form class="login-card" id="lf">
    <div class="brand"><div class="mark">${icon('logo')}</div><div><b>Ledgerly</b><small>Shop accounts made simple</small></div></div>
    <h1>Welcome back</h1><p class="muted" style="margin:6px 0 0">Sign in to see your sales, stock and profit.</p>
    <div class="fields"><div class="form-error ${msg ? '' : 'hidden'}" id="le" style="margin:0">${esc(msg || '')}</div>
      <div class="field"><label for="u">Username</label><input class="input" id="u" autocomplete="username" autofocus></div>
      <div class="field"><label for="p">Password</label><input class="input" id="p" type="password" autocomplete="current-password"></div></div>
    <button class="btn primary" id="lb">Sign in</button>
    ${/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '<p class="demo">Demo login: <b>admin</b> / <b>Admin@123</b></p>' : ''}</form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#lb'); b.disabled = true; b.textContent = 'Signing in…'; $('#le').classList.add('hidden');
    try { await api('POST', '/api/auth/login', { username: $('#u').value, password: $('#p').value }); await boot(); }
    catch (x) { $('#le').textContent = x.message; $('#le').classList.remove('hidden'); b.disabled = false; b.textContent = 'Sign in'; }
  };
}
document.addEventListener('auth-required', () => showLogin('Your session has ended. Please sign in again.'));

// ---------------------------------------------------------------- shell
function shell() {
  const link = ([k, label, , ic]) => `<a href="#/${k}" data-k="${k}">${icon(ic)}<span>${label}</span></a>`;
  app.innerHTML = `<div class="shell">
    <aside class="sidebar">${brand()}<nav class="nav">${NAV.map(link).join('')}<div class="sep"></div>${link(['settings', 'Settings', '', 'gear'])}</nav>
      <div class="side-foot"><div class="avatar">${esc((S.user.name || '?')[0].toUpperCase())}</div><div class="who">${esc(S.user.name)}</div>
        <button class="icon-btn" data-theme-btn title="Light / dark" aria-label="Switch light or dark mode">${icon(isDark() ? 'sun' : 'moon')}</button>
        <button class="icon-btn" data-logout title="Sign out" aria-label="Sign out">${icon('logout')}</button></div></aside>
    <div class="main"><header class="mobile-top">${brand()}<div style="display:flex;gap:4px">
        <button class="icon-btn" data-theme-btn aria-label="Switch light or dark mode">${icon(isDark() ? 'sun' : 'moon')}</button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${icon('gear')}</a></div></header>
      <main class="content" id="view"></main></div>
    <nav class="tabbar">${NAV.filter((n) => n[5]).map(([k, , short, ic]) => `<a href="#/${k}" data-k="${k}">${icon(ic)}<span>${short}</span></a>`).join('')}<a href="#/more" data-k="more" data-more>${icon('more')}<span>More</span></a></nav></div>`;
  $$('[data-theme-btn]').forEach((b) => { b.onclick = toggleTheme; });
  $('[data-logout]').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } showLogin(); };
}
document.addEventListener('settings-changed', async () => { S.settings = await GET('/api/settings'); $$('.brand small').forEach((s, i) => { if (i < 2) s.textContent = S.settings.business_name; }); });

// ---------------------------------------------------------------- router
let token = 0;
export async function route() {
  const view = $('#view'); if (!view) return;
  const [path, query] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?');
  const page = ROUTES[path] ? path : 'dashboard';
  const onMore = !NAV.find((n) => n[0] === page)?.[5] && page !== 'dashboard';
  $$('[data-k]').forEach((a) => a.classList.toggle('active', a.dataset.k === page || (a.hasAttribute('data-more') && onMore)));
  const me = ++token; window.scrollTo(0, 0);
  view.innerHTML = '<div class="spinner"></div>';
  const holder = document.createElement('div');
  try {
    await ROUTES[page](holder, new URLSearchParams(query || ''));
    if (me === token) { view.innerHTML = ''; view.append(holder); }
  } catch (e) {
    if (me === token) view.innerHTML = `<div class="empty"><b>Could not load this page</b>${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
document.addEventListener('data-changed', route);

async function boot() {
  try { const me = await GET('/api/auth/me'); S.user = me.user; S.settings = me.settings; } catch { return showLogin(); }
  shell(); await route();
}
boot();
