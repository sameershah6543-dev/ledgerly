import { S, $, esc, api, icon, toast, modal, val } from '../core.js';

export async function settings(root) {
  const s = S.settings; const admin = S.user.role === 'admin';
  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Your business details, password and data.</p></div></div>
    <div class="grid" style="max-width:720px">
      <form class="card" id="biz"><div class="card-head"><h2>Business</h2></div><div class="card-body"><div class="fields">
        <div class="field full"><label>Business name</label><input class="input" name="business_name" value="${esc(s.business_name)}" ${admin ? '' : 'disabled'}></div>
        <div class="field"><label>Currency symbol</label><input class="input" name="currency_symbol" value="${esc(s.currency_symbol)}" placeholder="Rs" ${admin ? '' : 'disabled'}></div>
        <div class="field"><label>Currency code</label><input class="input" name="currency_code" value="${esc(s.currency_code)}" maxlength="3" placeholder="PKR" ${admin ? '' : 'disabled'}></div>
        <div class="field full"><label>Phone <span class="opt">(optional)</span></label><input class="input" name="business_phone" value="${esc(s.business_phone)}" ${admin ? '' : 'disabled'}></div>
      </div>${admin ? '<div style="margin-top:18px"><button class="btn primary">Save</button></div>' : ''}</div></form>

      <form class="card" id="pw"><div class="card-head"><h2>Password</h2></div><div class="card-body"><div class="fields">
        <div class="field full"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>
        <div class="field"><label>New password</label><input class="input" type="password" name="next" autocomplete="new-password"></div>
        <div class="field"><label>Repeat new password</label><input class="input" type="password" name="again" autocomplete="new-password"></div>
      </div><div style="margin-top:18px"><button class="btn primary">Change password</button></div></div></form>

      ${admin ? `<div class="card"><div class="card-head"><h2>Your data</h2></div><div class="card-body">
        <p style="margin:0 0 16px;color:var(--text-2)">Download a backup copy of everything, or clear the demo entries and start with your own.</p>
        <div class="actions"><a class="btn" href="/api/backup">Download backup</a><button class="btn danger" data-clear>${icon('trash')} Start fresh (delete all entries)</button></div></div></div>` : ''}
    </div>`;

  $('#biz', root).onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try {
      await api('PUT', '/api/settings', { business_name: val(f, 'business_name'), currency_symbol: val(f, 'currency_symbol'), currency_code: val(f, 'currency_code').toUpperCase(), business_phone: val(f, 'business_phone') });
      document.dispatchEvent(new CustomEvent('settings-changed')); toast('Business details saved');
    } catch (x) { toast(x.message, true); }
  };
  $('#pw', root).onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (val(f, 'next') !== val(f, 'again')) return toast('The new passwords do not match', true);
    try { await api('POST', '/api/auth/password', { current: f.elements.current.value, next: f.elements.next.value }); f.reset(); toast('Password changed'); } catch (x) { toast(x.message, true); }
  };
  const clear = $('[data-clear]', root);
  if (clear) clear.onclick = () => modal({
    title: 'Start fresh?', sub: 'This permanently deletes every sale, expense, product and stock record.', submit: 'Delete everything', danger: true,
    body: `<p style="margin:0 0 14px;color:var(--text-2)">Your settings, login, cash and bank accounts and expense categories are kept. Consider downloading a backup first.</p>
      <div class="field"><label>Type <b>DELETE</b> to confirm</label><input class="input" name="confirm" autocomplete="off"></div>`,
    async onSubmit(f) {
      if (val(f, 'confirm') !== 'DELETE') throw new Error('Type DELETE (in capitals) to confirm');
      await api('POST', '/api/simple/clear-all', { confirm: 'DELETE' }); toast('All entries deleted — you’re starting fresh');
      location.hash = '#/dashboard'; return true;
    },
  });
}
