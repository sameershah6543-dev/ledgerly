// First-run setup: chart of accounts, default settings, admin user, realistic sample data.
import { get, setSetting, getSetting, loadSettings, ensureSchema, tx } from './db.js';
import { seedChart, loadSysAccounts } from './coa.js';
import { createUser } from './system.js';
import { docs, saveDoc } from './docs.js';
import './modules/sales.js'; import './modules/purchases.js'; import './modules/ledgers.js'; import './modules/stock.js';
import { saveMoneyAccount } from './modules/masters.js';
import { today, addDays, fyStart } from './util.js';

const DEFAULT_SETTINGS = {
  business_name: 'Ahad Trading Co.', business_address: '', business_phone: '',
  business_email: '', business_tax_no: '', currency_code: 'PKR', currency_symbol: 'Rs', date_format: 'DD/MM/YYYY',
  fy_start_month: '1', tax_enabled: '0', tax_name: 'GST', tax_rate: '0', default_due_days: '0', block_negative_cash: '0',
};

// Runs once per server start (and once per cold start on Vercel). The full setup only happens on a new database.
export async function bootstrap({ sample } = {}) {
  await ensureSchema();
  await loadSettings();
  if (getSetting('setup_done') !== '1') {
    await seedChart();
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (getSetting(k, null) === null) await setSetting(k, v);
    if (!await get('SELECT id FROM users LIMIT 1')) await createUser({ username: 'admin', name: 'Administrator', role: 'admin', password: process.env.ADMIN_PASSWORD || 'Admin@123' });
    await loadSysAccounts();
    const fresh = !await get('SELECT id FROM journal_entries LIMIT 1') && !await get('SELECT id FROM money_accounts LIMIT 1');
    if (fresh) {
      if (sample ?? process.env.NO_SAMPLE !== '1') await seedSample();
      else { // an empty company still needs somewhere to put money
        const open = fyStart(today());
        await saveMoneyAccount({ name: 'Cash in Hand', kind: 'cash', opening_balance: 0, opening_date: open }, null, 'system');
        await saveMoneyAccount({ name: 'Bank Account', kind: 'bank', opening_balance: 0, opening_date: open }, null, 'system');
      }
    }
    await setSetting('setup_done', '1');
  }
  await loadSysAccounts();
}

// A tiny demo: one phone bought and sold, one expense - enough to see how everything connects.
export async function seedSample() {
  const T = today(); const U = 'admin';
  const { createSale } = await import('./simple.js');
  await tx(async () => {
    const open = fyStart(T);
    const cash = (await saveMoneyAccount({ name: 'Cash in Hand', kind: 'cash', opening_balance: 0, opening_date: open }, null, U)).id;
    await saveMoneyAccount({ name: 'Bank Account', kind: 'bank', opening_balance: 0, opening_date: open }, null, U);
    await createSale({ item_name: 'iPhone 13 (128GB)', qty: 1, unit_cost: 150000, supplier_name: 'Hall Road Traders', unit_price: 172000,
      money_account_id: cash, cost_account_id: cash, date: addDays(T, -2), note: 'Demo sale' }, U);
    await saveDoc(docs.expenses, { date: addDays(T, -5), category_id: (await get("SELECT id FROM categories WHERE kind='expense' AND name='Rent'")).id, amount: 15000, description: 'Shop rent (demo)', mode: 'paid', method: 'Cash', money_account_id: cash }, null, U);
  });
  console.log('Demo data loaded.');
}
