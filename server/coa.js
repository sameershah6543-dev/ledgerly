// Chart of accounts helpers + default chart.
import { all, get, run, insert, update } from './db.js';
import { fail, r2 } from './util.js';

export const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
export const SUBTYPES = {
  asset: ['cash', 'bank', 'wallet', 'receivable', 'tax_receivable', 'inventory', 'other_current', 'fixed_asset', 'accum_depr', 'other_asset'],
  liability: ['payable', 'tax_payable', 'credit_card', 'other_liability', 'loan', 'long_term'],
  equity: ['capital', 'retained', 'drawings', 'obe'],
  revenue: ['sales', 'service', 'other_revenue'],
  expense: ['cogs', 'opex', 'depreciation'],
};
export const SUBTYPE_LABEL = {
  cash: 'Cash', bank: 'Bank', wallet: 'Digital Wallet', receivable: 'Accounts Receivable', tax_receivable: 'Tax Receivable',
  inventory: 'Inventory', other_current: 'Other Current Assets', fixed_asset: 'Fixed Assets', accum_depr: 'Accumulated Depreciation',
  other_asset: 'Other Assets', payable: 'Accounts Payable', tax_payable: 'Taxes Payable', credit_card: 'Credit Cards',
  other_liability: 'Other Liabilities', loan: 'Loans', long_term: 'Long-Term Liabilities', capital: 'Owner Capital',
  retained: 'Retained Earnings', drawings: 'Drawings', obe: 'Opening Balance Equity', sales: 'Sales Revenue',
  service: 'Service Revenue', other_revenue: 'Other Revenue', cogs: 'Cost of Goods Sold', opex: 'Operating Expenses',
  depreciation: 'Depreciation',
};
export const CASH_SUBTYPES = ['cash', 'bank', 'wallet'];
export const isDebitNormal = (a) => a.type === 'asset' || a.type === 'expense'; // contra accounts (accumulated depreciation) simply show a negative natural balance

// [sys_key, code, name, type, subtype]
const DEFAULTS = [
  ['AR', '1100', 'Accounts Receivable', 'asset', 'receivable'],
  ['TAX_RECEIVABLE', '1150', 'Sales Tax Receivable (Input Tax)', 'asset', 'tax_receivable'],
  ['INVENTORY', '1200', 'Inventory', 'asset', 'inventory'],
  [null, '1510', 'Equipment', 'asset', 'fixed_asset'], [null, '1520', 'Furniture & Fixtures', 'asset', 'fixed_asset'],
  [null, '1530', 'Vehicles', 'asset', 'fixed_asset'], [null, '1540', 'Property & Buildings', 'asset', 'fixed_asset'],
  [null, '1550', 'Computers & IT Equipment', 'asset', 'fixed_asset'], [null, '1590', 'Other Fixed Assets', 'asset', 'fixed_asset'],
  ['ACC_DEPR', '1600', 'Accumulated Depreciation', 'asset', 'accum_depr'],
  [null, '1900', 'Other Current Assets', 'asset', 'other_current'], [null, '1950', 'Other Assets', 'asset', 'other_asset'],
  ['AP', '2000', 'Accounts Payable', 'liability', 'payable'],
  ['TAX_PAYABLE', '2100', 'Sales Tax Payable', 'liability', 'tax_payable'],
  [null, '2110', 'Taxes Payable', 'liability', 'tax_payable'],
  [null, '2200', 'Business Loans', 'liability', 'loan'], [null, '2210', 'Bank Loans', 'liability', 'loan'],
  [null, '2220', 'Credit Card Payables', 'liability', 'credit_card'], [null, '2230', 'Supplier Payables', 'liability', 'other_liability'],
  [null, '2240', 'Employee Payables', 'liability', 'other_liability'], [null, '2250', 'Accrued Expenses', 'liability', 'other_liability'],
  [null, '2290', 'Other Short-Term Liabilities', 'liability', 'other_liability'], [null, '2500', 'Long-Term Liabilities', 'liability', 'long_term'],
  ['OWNER_CAPITAL', '3000', 'Owner Capital', 'equity', 'capital'], ['RETAINED', '3100', 'Retained Earnings', 'equity', 'retained'],
  ['DRAWINGS', '3200', 'Owner Drawings', 'equity', 'drawings'], ['OBE', '3900', 'Opening Balance Equity', 'equity', 'obe'],
  ['SALES', '4000', 'Sales Revenue', 'revenue', 'sales'], ['SERVICE', '4100', 'Service Revenue', 'revenue', 'service'],
  ['OTHER_REV', '4200', 'Other Revenue', 'revenue', 'other_revenue'], ['DISPOSAL_GAIN', '4300', 'Gain / (Loss) on Asset Disposal', 'revenue', 'other_revenue'],
  ['SALES_RETURNS', '4900', 'Sales Returns & Allowances', 'revenue', 'sales'],
  ['COGS', '5000', 'Cost of Goods Sold', 'expense', 'cogs'], ['INV_ADJ', '5100', 'Inventory Adjustments', 'expense', 'cogs'],
  ['DEPR_EXP', '6140', 'Depreciation Expense', 'expense', 'depreciation'],
];
// Default expense accounts (also seeded as expense categories)
export const DEFAULT_EXPENSES = [
  ['6000', 'Salaries'], ['6010', 'Rent'], ['6020', 'Utilities'], ['6021', 'Electricity'], ['6022', 'Internet'], ['6023', 'Telephone'],
  ['6030', 'Transportation'], ['6031', 'Fuel'], ['6040', 'Office Supplies'], ['6050', 'Marketing'], ['6051', 'Advertising'],
  ['6060', 'Software & Subscriptions'], ['6070', 'Repairs & Maintenance'], ['6080', 'Travel'], ['6090', 'Meals'],
  ['6100', 'Professional Fees'], ['6110', 'Bank Charges'], ['6120', 'Taxes'], ['6130', 'Insurance'], ['6900', 'Miscellaneous'], ['6990', 'Other Expenses'],
];

const RANGES = {
  cash: [1010, 1099], bank: [1010, 1099], wallet: [1010, 1099], fixed_asset: [1560, 1589], other_asset: [1960, 1999], other_current: [1910, 1949],
  credit_card: [2260, 2289], other_liability: [2300, 2499], loan: [2300, 2499], long_term: [2510, 2599], payable: [2600, 2699], tax_payable: [2700, 2799],
  equity: [3300, 3899], revenue: [4400, 4899], cogs: [5200, 5899], opex: [6200, 6899],
};
export async function allocCode(type, subtype) {
  const [lo, hi] = RANGES[subtype] || RANGES[type] || { asset: [1960, 1999], liability: [2800, 2899], equity: [3300, 3899], revenue: [4400, 4899], expense: [6200, 6899] }[type];
  const used = new Set((await all('SELECT code FROM accounts')).map((r) => r.code));
  for (const step of [10, 1]) for (let c = lo; c <= hi; c += step) if (!used.has(String(c))) return String(c);
  fail('No free account code available in this range; enter a code manually');
}

// System account ids never change once created, so they are loaded once and read synchronously.
let sysCache = {};
export async function loadSysAccounts() {
  const c = {}; for (const r of await all('SELECT id,sys_key FROM accounts WHERE sys_key IS NOT NULL')) c[r.sys_key] = r.id;
  sysCache = c;
}
export const resetAccountCache = async () => await loadSysAccounts();
export function sys(key) {
  const id = sysCache[key]; if (!id) fail(`System account ${key} is missing`, 500); return id;
}
export const getAccount = async (id) => await get('SELECT * FROM accounts WHERE id=?', id);

export async function createAccount({ code, name, type, subtype, description = null, is_system = 0, sys_key = null }) {
  if (!TYPES.includes(type)) fail('Invalid account type');
  if (!SUBTYPES[type].includes(subtype)) fail('Invalid account group for this type');
  if (!String(name || '').trim()) fail('Account name is required');
  code = String(code || '').trim() || await allocCode(type, subtype);
  if (await get('SELECT id FROM accounts WHERE code=?', code)) fail(`Account code ${code} already exists`);
  const id = await insert('accounts', { code, name: String(name).trim(), type, subtype, description, is_system, sys_key });
  if (sys_key) sysCache = { ...sysCache, [sys_key]: id };
  return id;
}

export async function seedChart() {
  const codes = new Set((await all('SELECT code FROM accounts')).map((r) => r.code));
  for (const [key, code, name, type, subtype] of DEFAULTS)
    if (!codes.has(code)) await createAccount({ code, name, type, subtype, is_system: key ? 1 : 0, sys_key: key });
  for (const [code, name] of DEFAULT_EXPENSES) {
    let acc = await get('SELECT id FROM accounts WHERE code=?', code);
    if (!acc) acc = { id: await createAccount({ code, name, type: 'expense', subtype: 'opex' }) };
    if (!await get("SELECT id FROM categories WHERE kind='expense' AND name=?", name)) await insert('categories', { kind: 'expense', name, account_id: acc.id });
  }
  const cat = async (kind, name, code) => {
    const acc = await get('SELECT id FROM accounts WHERE code=?', code);
    if (!await get('SELECT id FROM categories WHERE kind=? AND name=?', kind, name)) await insert('categories', { kind, name, account_id: acc ? acc.id : null });
  };
  for (const [kind, name, code] of [['revenue', 'Product Sales', '4000'], ['revenue', 'Service Revenue', '4100'], ['revenue', 'Other Revenue', '4200'],
    ['asset', 'Equipment', '1510'], ['asset', 'Furniture', '1520'], ['asset', 'Vehicles', '1530'], ['asset', 'Property', '1540'],
    ['asset', 'Computers', '1550'], ['asset', 'Other Fixed Assets', '1590'], ['asset', 'Other Current Assets', '1900'],
    ['liability', 'Business Loans', '2200'], ['liability', 'Bank Loans', '2210'], ['liability', 'Credit Card Payables', '2220'],
    ['liability', 'Supplier Payables', '2230'], ['liability', 'Employee Payables', '2240'], ['liability', 'Taxes Payable', '2110'],
    ['liability', 'Accrued Expenses', '2250'], ['liability', 'Other Short-Term Liabilities', '2290'], ['liability', 'Long-Term Liabilities', '2500'],
    ...['General', 'Electronics', 'Accessories', 'Stationery', 'Furniture', 'Services'].map((p) => ['product', p, '0'])]) await cat(kind, name, code);
}

export async function accountBalance(accountId, upTo = '9999-12-31') {
  const r = await get(`SELECT COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_id=? AND je.status='posted' AND je.date<=?`, accountId, upTo);
  return r2(r.d - r.c);
}
