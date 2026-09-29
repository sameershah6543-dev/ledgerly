// Database layer on libSQL: a local SQLite file for development, or a Turso database when
// TURSO_DATABASE_URL is set (used on Vercel). Every query is async; tx() gives a unit of work that
// commits or rolls back as a whole, and nested tx() calls become savepoints.
import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const REMOTE = process.env.TURSO_DATABASE_URL || '';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const DB_PATH = REMOTE ? null : path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'accounting.db'));
export const DB_LABEL = REMOTE ? REMOTE.replace(/\?.*$/, '') : DB_PATH;
if (!REMOTE) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const client = createClient(REMOTE
  ? { url: REMOTE, authToken: process.env.TURSO_AUTH_TOKEN }
  : { url: `file:${DB_PATH.split(path.sep).join('/')}` });

// the open transaction (if any) for the current request flows through async calls
const als = new AsyncLocalStorage();
const conn = () => als.getStore()?.tx || client;
const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const rowsOf = (rs) => rs.rows.map((r) => { const o = {}; rs.columns.forEach((c, i) => { o[c] = r[i]; }); return o; });

export const all = async (sql, ...p) => rowsOf(await conn().execute({ sql, args: clean(p) }));
export const get = async (sql, ...p) => (await all(sql, ...p))[0];
export const run = async (sql, ...p) => {
  const r = await conn().execute({ sql, args: clean(p) });
  return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
};
export const exec = (sql) => conn().executeMultiple(sql);
export const insert = async (table, row) => {
  const keys = Object.keys(row);
  const r = await run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  return r.lastInsertRowid;
};
export const update = (table, id, row) => {
  const keys = Object.keys(row);
  return run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => row[k]), id);
};

// Nestable transaction - any thrown error rolls the whole unit back.
// Keep work inside a transaction sequential (no Promise.all): it shares one connection.
export async function tx(fn) {
  const store = als.getStore();
  if (store?.tx) {
    const name = `sp${++store.depth}`;
    await store.tx.execute(`SAVEPOINT ${name}`);
    try { const r = await fn(); await store.tx.execute(`RELEASE ${name}`); store.depth--; return r; }
    catch (e) { await store.tx.execute(`ROLLBACK TO ${name}`); await store.tx.execute(`RELEASE ${name}`); store.depth--; throw e; }
  }
  const t = await client.transaction('write');
  try {
    const r = await als.run({ tx: t, depth: 0 }, fn);
    await t.commit();
    return r;
  } catch (e) {
    try { await t.rollback(); } catch { /* connection already closed */ }
    throw e;
  } finally { t.close(); }
}

const COMMON = `is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), created_by TEXT, updated_at TEXT, updated_by TEXT`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'admin',
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sequences(key TEXT PRIMARY KEY, next INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  subtype TEXT NOT NULL, description TEXT, active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0, sys_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('expense','revenue','product','asset','liability')),
  name TEXT NOT NULL, account_id INTEGER REFERENCES accounts(id), active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, name));

CREATE TABLE IF NOT EXISTS money_accounts(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('cash','bank','credit_card','wallet','other')),
  account_id INTEGER NOT NULL REFERENCES accounts(id), opening_balance REAL NOT NULL DEFAULT 0,
  opening_date TEXT NOT NULL, account_no TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS parties(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('customer','supplier')), name TEXT NOT NULL,
  email TEXT, phone TEXT, address TEXT, tax_no TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(kind, name));

CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE, category_id INTEGER REFERENCES categories(id),
  unit TEXT DEFAULT 'pcs', purchase_price REAL NOT NULL DEFAULT 0, selling_price REAL NOT NULL DEFAULT 0,
  opening_stock REAL NOT NULL DEFAULT 0, opening_date TEXT, min_stock REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES parties(id), location TEXT, notes TEXT,
  is_service INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('opening','purchase','sale','sales_return','purchase_return','adjustment')),
  qty REAL NOT NULL, value REAL NOT NULL, source_type TEXT, source_id INTEGER, memo TEXT);
CREATE INDEX IF NOT EXISTS ix_sm_item ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS ix_sm_src ON stock_movements(source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_entries(
  id INTEGER PRIMARY KEY, entry_no TEXT UNIQUE NOT NULL, date TEXT NOT NULL, memo TEXT,
  source_type TEXT NOT NULL, source_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','void')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), created_by TEXT,
  UNIQUE(source_type, source_id));
CREATE INDEX IF NOT EXISTS ix_je_date ON journal_entries(date);
CREATE TABLE IF NOT EXISTS journal_lines(
  id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id), debit REAL NOT NULL DEFAULT 0 CHECK(debit>=0),
  credit REAL NOT NULL DEFAULT 0 CHECK(credit>=0), party_id INTEGER REFERENCES parties(id), memo TEXT);
CREATE INDEX IF NOT EXISTS ix_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS ix_jl_acc ON journal_lines(account_id);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now','localtime')), user TEXT,
  entity TEXT NOT NULL, entity_id INTEGER NOT NULL, ref TEXT, action TEXT NOT NULL,
  old_amount REAL, new_amount REAL, changes TEXT);
CREATE INDEX IF NOT EXISTS ix_audit_ent ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS sales_invoices(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, due_date TEXT,
  customer_id INTEGER NOT NULL REFERENCES parties(id),
  state TEXT NOT NULL DEFAULT 'sent' CHECK(state IN ('draft','sent','cancelled')),
  subtotal REAL NOT NULL DEFAULT 0, discount_total REAL NOT NULL DEFAULT 0, tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0, notes TEXT, terms TEXT, attachment TEXT, ${COMMON});
CREATE TABLE IF NOT EXISTS sales_invoice_lines(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id), description TEXT, qty REAL NOT NULL, unit_price REAL NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0,
  revenue_account_id INTEGER REFERENCES accounts(id), line_net REAL NOT NULL DEFAULT 0, line_tax REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS purchase_invoices(
  id INTEGER PRIMARY KEY, number TEXT NOT NULL, reference TEXT, date TEXT NOT NULL, due_date TEXT,
  supplier_id INTEGER NOT NULL REFERENCES parties(id),
  state TEXT NOT NULL DEFAULT 'posted' CHECK(state IN ('posted','cancelled')),
  subtotal REAL NOT NULL DEFAULT 0, discount_total REAL NOT NULL DEFAULT 0, tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0, notes TEXT, attachment TEXT, ${COMMON});
CREATE TABLE IF NOT EXISTS purchase_invoice_lines(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id), description TEXT, qty REAL NOT NULL, unit_price REAL NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0,
  expense_account_id INTEGER REFERENCES accounts(id), line_net REAL NOT NULL DEFAULT 0, line_tax REAL NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'customer' CHECK(kind IN ('customer','other')),
  customer_id INTEGER REFERENCES parties(id), ref_type TEXT CHECK(ref_type IN ('invoice','revenue')), ref_id INTEGER,
  credit_account_id INTEGER REFERENCES accounts(id), source_name TEXT, amount REAL NOT NULL CHECK(amount>0),
  method TEXT, money_account_id INTEGER NOT NULL REFERENCES money_accounts(id),
  description TEXT, notes TEXT, attachment TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, party_id INTEGER REFERENCES parties(id),
  payee_name TEXT, category TEXT NOT NULL CHECK(category IN ('supplier_invoice','expense_bill','liability','other')),
  ref_type TEXT CHECK(ref_type IN ('purchase_invoice','expense','liability')), ref_id INTEGER,
  debit_account_id INTEGER REFERENCES accounts(id), amount REAL NOT NULL CHECK(amount>0), method TEXT,
  money_account_id INTEGER NOT NULL REFERENCES money_accounts(id), description TEXT, notes TEXT, attachment TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id), description TEXT, amount REAL NOT NULL CHECK(amount>0),
  mode TEXT NOT NULL DEFAULT 'paid' CHECK(mode IN ('paid','credit')), method TEXT,
  money_account_id INTEGER REFERENCES money_accounts(id), vendor_id INTEGER REFERENCES parties(id), vendor_name TEXT,
  invoice_ref TEXT, due_date TEXT, notes TEXT, attachment TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS revenue_entries(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES parties(id),
  category_id INTEGER NOT NULL REFERENCES categories(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
  description TEXT, reference TEXT, amount REAL NOT NULL CHECK(amount>0), due_date TEXT, notes TEXT, attachment TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS liabilities(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id), creditor TEXT, date TEXT NOT NULL,
  original_amount REAL NOT NULL CHECK(original_amount>0), due_date TEXT, payment_schedule TEXT, installment_amount REAL,
  offset_type TEXT NOT NULL DEFAULT 'opening' CHECK(offset_type IN ('cash','expense','opening')),
  money_account_id INTEGER REFERENCES money_accounts(id), expense_account_id INTEGER REFERENCES accounts(id),
  notes TEXT, attachment TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS capital_transactions(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, investor TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('initial_capital','additional_investment','owner_contribution','withdrawal','drawing','other_in','other_out')),
  amount REAL NOT NULL CHECK(amount>0), money_account_id INTEGER NOT NULL REFERENCES money_accounts(id),
  description TEXT, reference TEXT, notes TEXT, attachment TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS assets(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id), description TEXT, purchase_date TEXT NOT NULL,
  purchase_value REAL NOT NULL CHECK(purchase_value>0), salvage_value REAL NOT NULL DEFAULT 0, payment_method TEXT,
  supplier TEXT, reference TEXT, notes TEXT, attachment TEXT,
  source TEXT NOT NULL DEFAULT 'paid' CHECK(source IN ('paid','opening')), money_account_id INTEGER REFERENCES money_accounts(id),
  depreciable INTEGER NOT NULL DEFAULT 0, dep_method TEXT DEFAULT 'straight_line', useful_life_years REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disposed')),
  disposal_date TEXT, disposal_proceeds REAL, disposal_account_id INTEGER REFERENCES money_accounts(id), ${COMMON});
CREATE TABLE IF NOT EXISTS asset_depreciations(
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0),
  number TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS transfers(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES money_accounts(id), to_account_id INTEGER NOT NULL REFERENCES money_accounts(id),
  amount REAL NOT NULL CHECK(amount>0), description TEXT, reference TEXT, notes TEXT, ${COMMON},
  CHECK(from_account_id<>to_account_id));

CREATE TABLE IF NOT EXISTS stock_returns(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('sales','purchase')),
  item_id INTEGER NOT NULL REFERENCES items(id), party_id INTEGER NOT NULL REFERENCES parties(id), ref_id INTEGER,
  qty REAL NOT NULL CHECK(qty>0), unit_price REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  settlement TEXT NOT NULL DEFAULT 'credit' CHECK(settlement IN ('credit','refund')), money_account_id INTEGER REFERENCES money_accounts(id),
  reason TEXT, notes TEXT, ${COMMON});

CREATE TABLE IF NOT EXISTS stock_adjustments(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, reason TEXT, notes TEXT, ${COMMON});
`;

// Create tables (idempotent) and apply additive migrations.
export async function ensureSchema() {
  if (!REMOTE) { try { await client.execute('PRAGMA journal_mode=WAL'); } catch { /* not supported */ } }
  await client.executeMultiple(SCHEMA);
  for (const sql of ['ALTER TABLE sales_invoice_lines ADD COLUMN cost_override REAL']) {
    try { await client.execute(sql); } catch { /* column already exists */ }
  }
}

// ---- settings: read synchronously from a cache that is refreshed at the start of every request ----
let settingsCache = {};
export async function loadSettings() {
  const c = {};
  for (const r of await all('SELECT key,value FROM settings')) c[r.key] = r.value;
  settingsCache = c;
  return c;
}
export const getSettings = () => settingsCache;
export const getSetting = (k, d = '') => { const v = settingsCache[k]; return v === undefined || v === null ? d : v; };
export async function setSetting(k, v) {
  const s = v === null || v === undefined ? '' : String(v);
  await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, s);
  settingsCache = { ...settingsCache, [k]: s };
}
