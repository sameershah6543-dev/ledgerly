import { all, get, run, getSetting } from './db.js';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const fail = (msg, status = 400) => { throw new AppError(msg, status); };
// async map that runs one item at a time (work inside a transaction must stay sequential)
export async function mapSeq(arr, fn) { const out = []; for (let i = 0; i < arr.length; i++) out.push(await fn(arr[i], i)); return out; }

export const r2 = (n) => { n = Number(n) || 0; return Math.round((n + Math.sign(n) * 1e-9) * 100) / 100; };
export const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
export const cents = (n) => Math.round((Number(n) || 0) * 100);

export function num(v, label, { min = null, required = false, def = 0 } = {}) {
  if (v === '' || v === null || v === undefined) { if (required) fail(`${label} is required`); return def; }
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${label} must be a number`);
  if (min !== null && n < min) fail(`${label} must be ${min === 0 ? 'zero or more' : 'at least ' + min}`);
  return n;
}
export const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
export function reqStr(v, label) { const s = str(v); if (!s) fail(`${label} is required`); return s; }
export function oneOf(v, list, label) { if (!list.includes(v)) fail(`${label} is invalid`); return v; }
export function id(v, label, required = true) {
  if (v === '' || v === null || v === undefined) { if (required) fail(`${label} is required`); return null; }
  const n = Number(v); if (!Number.isInteger(n) || n <= 0) fail(`${label} is invalid`); return n;
}

// ---- dates (all ISO yyyy-mm-dd, local time) ----
const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// APP_TIMEZONE (e.g. Asia/Karachi) keeps "today" right when the server runs in another time zone (Vercel = UTC)
const TZ = process.env.APP_TIMEZONE;
export const today = () => (TZ ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : iso(new Date()));
export function isoDate(v, label, required = true) {
  if (v === '' || v === null || v === undefined) { if (required) fail(`${label} is required`); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) fail(`${label} is not a valid date`);
  return v;
}
export const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return iso(d); };
export const addMonths = (s, n) => { const d = parseD(s); d.setDate(1); d.setMonth(d.getMonth() + n); return iso(d); };
export const monthEnd = (s) => { const d = parseD(s); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
export const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
export function fyStart(dateStr) {
  const m = Number(getSetting('fy_start_month', '1'));
  const d = parseD(dateStr);
  const y = d.getMonth() + 1 >= m ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${pad(m)}-01`;
}
export const fyEnd = (start) => addDays(addMonths(start, 12), -1);

// ---- numbering ----
const DEFAULT_FMT = {
  invoice: 'INV-{YYYY}-{0000}', bill: 'PI-{YYYY}-{0000}', receipt: 'RC-{YYYY}-{0000}', payment: 'PV-{YYYY}-{0000}',
  expense: 'EXP-{YYYY}-{0000}', revenue: 'REV-{YYYY}-{0000}', transfer: 'TR-{YYYY}-{0000}', capital: 'CAP-{0000}',
  liability: 'LIA-{0000}', asset: 'AST-{0000}', return: 'RET-{YYYY}-{0000}', adjustment: 'ADJ-{YYYY}-{0000}',
  depreciation: 'DEP-{0000}', journal: 'JE-{000000}',
};
export const NUMBER_KEYS = Object.keys(DEFAULT_FMT);
export const defaultFmt = (k) => DEFAULT_FMT[k];
function formatNumber(key, n, dateStr) {
  const fmt = getSetting(`fmt_${key}`) || DEFAULT_FMT[key];
  const d = dateStr || today();
  return fmt.replace(/\{(Y{2,4}|MM|0+)\}/g, (_, t) => {
    if (t === 'YYYY') return d.slice(0, 4);
    if (t === 'YY') return d.slice(2, 4);
    if (t === 'MM') return d.slice(5, 7);
    return String(n).padStart(t.length, '0');
  });
}
export async function peekNumber(key, dateStr) {
  const row = await get('SELECT next FROM sequences WHERE key=?', key);
  return formatNumber(key, row ? row.next : 1, dateStr);
}
export async function consumeNumber(key, dateStr) {
  const row = await get('SELECT next FROM sequences WHERE key=?', key);
  const n = row ? row.next : 1;
  await run('INSERT INTO sequences(key,next) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET next=excluded.next', key, n + 1);
  return formatNumber(key, n, dateStr);
}
// Use the caller's number if given (must be unique), otherwise generate the next one.
export async function claimNumber(key, provided, table, col, ownId, dateStr) {
  const p = str(provided);
  if (!p) return await consumeNumber(key, dateStr);
  const dup = await get(`SELECT id FROM ${table} WHERE ${col}=? AND id<>?`, p, ownId || 0);
  if (dup) fail(`Number "${p}" is already used`);
  if (p === await peekNumber(key, dateStr)) await consumeNumber(key, dateStr);
  return p;
}

// ---- generic list query: wraps any SELECT, adds search / filter / sort / paging / sums ----
export async function listQuery(baseSql, baseParams, q, o) {
  const where = []; const params = [];
  const term = str(q.q);
  if (term && o.search?.length) {
    where.push('(' + o.search.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ') + ')');
    o.search.forEach(() => params.push(`%${term}%`));
  }
  if (o.dateCol) {
    if (q.from) { where.push(`${o.dateCol} >= ?`); params.push(q.from); }
    if (q.to) { where.push(`${o.dateCol} <= ?`); params.push(q.to); }
  }
  for (const f of o.filters || []) {
    if (q[f] !== undefined && q[f] !== '' && q[f] !== 'all') { where.push(`${f} = ?`); params.push(/(_id|active|is_service)$/.test(f) && /^-?\d+$/.test(q[f]) ? Number(q[f]) : q[f]); }
  }
  const W = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sortable = o.sortable || [];
  let sort = sortable.includes(q.sort) ? q.sort : o.defaultSort || 'id';
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : String(q.dir).toLowerCase() === 'desc' ? 'DESC' : o.defaultDir || 'DESC';
  const all_ = q.size === 'all';
  const size = all_ ? 0 : Math.min(200, Math.max(1, parseInt(q.size) || 25));
  const page = Math.max(1, parseInt(q.page) || 1);
  const total = (await get(`SELECT COUNT(*) n FROM (${baseSql}) t${W}`, ...baseParams, ...params)).n;
  const sums = {};
  if (o.sums?.length) {
    const r = await get(`SELECT ${o.sums.map((c) => `COALESCE(SUM(${c}),0) AS ${c}`).join(',')} FROM (${baseSql}) t${W}`, ...baseParams, ...params);
    for (const c of o.sums) sums[c] = r2(r[c]);
  }
  const rows = await all(
    `SELECT * FROM (${baseSql}) t${W} ORDER BY ${sort} ${dir}, id DESC${all_ ? '' : ' LIMIT ? OFFSET ?'}`,
    ...baseParams, ...params, ...(all_ ? [] : [size, (page - 1) * size]));
  return { columns: o.columns, sortable, rows, total, page, size: all_ ? total : size, summary: sums };
}

// status expression shared by invoices / bills / revenue entries
export function statusSql({ total, paid, due, state = "'sent'", draft = true }) {
  return `CASE WHEN ${state}='cancelled' THEN 'Cancelled' ${draft ? `WHEN ${state}='draft' THEN 'Draft'` : ''}
    WHEN ${total} - ${paid} <= 0.005 THEN 'Paid'
    WHEN ${due} IS NOT NULL AND ${due} < :TODAY: THEN 'Overdue'
    WHEN ${paid} > 0.005 THEN 'Partially Paid'
    ELSE '${draft ? 'Sent' : 'Unpaid'}' END`;
}
// :TODAY: is replaced by a literal date string (safe: generated server-side)
export const withToday = (sql) => sql.replaceAll(':TODAY:', `'${today()}'`);
