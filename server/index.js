import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, DB_LABEL } from './db.js';
import { AppError, fail, today } from './util.js';
import './modules/sales.js'; import './modules/purchases.js'; import './modules/ledgers.js'; import './modules/stock.js';
import { deleteItem } from './modules/stock.js';
import * as M from './modules/masters.js';
import * as S from './system.js';
import * as Simple from './simple.js';
import { bootstrap } from './bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; object-src 'none'");
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

// set up the database once per process (once per cold start on Vercel); retried if it fails
let booting = null;
export const ready = () => (booting ??= bootstrap().catch((e) => { booting = null; throw e; }));

// ---------------- auth middleware ----------------
const cookie = (req, n) => (req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === n)?.[1];
const api = express.Router();
const wrap = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res)).then((r) => { if (r !== undefined && !res.headersSent) res.json(r); }, next);
};
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : next(new AppError('Administrator access required', 403)));
const uname = (req) => req.user.username;
const secure = (req) => (req.headers['x-forwarded-proto'] || '').includes('https') || req.secure;

// every API call: make sure the database is ready, refresh settings, check the session
api.use((req, res, next) => {
  (async () => {
    await ready();
    await loadSettings();
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') fail('Invalid request', 403);
    if (req.path === '/auth/login') return;
    const user = await S.userFromToken(cookie(req, 'sid'));
    if (!user) fail('Please sign in', 401);
    if (req.method !== 'GET' && user.role === 'viewer' && req.path !== '/auth/logout') fail('Your account has read-only access', 403);
    req.user = user;
  })().then(() => next(), next);
});

// ---------------- auth & users ----------------
api.post('/auth/login', wrap(async (req, res) => {
  const { token, user } = await S.login(req.body.username, req.body.password);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure(req) ? '; Secure' : ''}`);
  return { user };
}));
api.post('/auth/logout', wrap(async (req, res) => { await S.logout(cookie(req, 'sid')); res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok: true }; }));
api.get('/auth/me', wrap(async (req) => ({ user: req.user, settings: await S.publicSettings() })));
api.post('/auth/password', wrap(async (req) => { await S.changePassword(req.user.id, req.body.current, req.body.next); return { ok: true }; }));
api.get('/users', admin, wrap(() => S.listUsers()));
api.post('/users', admin, wrap((req) => S.saveUser(req.body, null, req.user)));
api.put('/users/:id', admin, wrap((req) => S.saveUser(req.body, Number(req.params.id), req.user)));

// ---------------- settings & categories ----------------
api.get('/settings', wrap(() => S.publicSettings()));
api.put('/settings', admin, wrap((req) => S.saveSettings(req.body)));
api.get('/categories', wrap((req) => M.listCategories(req.query.kind)));
api.post('/categories', wrap((req) => M.saveCategory(req.body, null, uname(req))));

// ---------------- simple mode (the everyday screens) ----------------
api.get('/simple/summary', wrap((req) => Simple.summary(req.query)));
api.get('/simple/sales', wrap((req) => Simple.salesList(req.query)));
api.post('/simple/sales', wrap((req) => Simple.createSale(req.body, uname(req))));
api.put('/simple/sales/:id', wrap((req) => Simple.updateSale(Number(req.params.id), req.body, uname(req))));
api.delete('/simple/sales/:id', wrap((req) => Simple.deleteSale(Number(req.params.id), uname(req))));
api.get('/simple/expenses', wrap((req) => Simple.expenseList(req.query)));
api.get('/simple/expense-categories', wrap(() => Simple.expenseCategories()));
api.post('/simple/expenses', wrap((req) => Simple.saveExpense(req.body, null, uname(req))));
api.put('/simple/expenses/:id', wrap((req) => Simple.saveExpense(req.body, Number(req.params.id), uname(req))));
api.delete('/simple/expenses/:id', wrap((req) => Simple.deleteExpense(Number(req.params.id), uname(req))));
api.get('/simple/inventory', wrap((req) => Simple.inventory(req.query)));
api.post('/simple/products', wrap((req) => Simple.saveProduct(req.body, null, uname(req))));
api.put('/simple/products/:id', wrap((req) => Simple.saveProduct(req.body, Number(req.params.id), uname(req))));
api.delete('/simple/products/:id', wrap((req) => deleteItem(Number(req.params.id), uname(req))));
api.get('/simple/products/:id/history', wrap((req) => Simple.stockHistory(Number(req.params.id))));
api.post('/simple/restock', wrap((req) => Simple.restock(req.body, uname(req))));
api.get('/simple/money', wrap(() => Simple.moneyList()));
api.get('/simple/owed/:kind', wrap((req) => Simple.openList(req.params.kind === 'pay' ? 'pay' : 'receive')));
api.post('/simple/settle', wrap((req) => Simple.settle(req.body, uname(req))));
api.get('/simple/people', wrap((req) => Simple.people(req.query)));
api.get('/simple/ledger', wrap((req) => Simple.ledger(req.query.name)));
api.get('/simple/names', wrap(() => Simple.names()));
api.get('/simple/item-names', wrap(() => Simple.itemNames()));
api.get('/simple/stock', wrap((req) => Simple.stockList(req.query)));
api.post('/simple/stock', wrap((req) => Simple.addStock(req.body, uname(req))));
api.put('/simple/stock/:id', wrap((req) => Simple.updateStock(Number(req.params.id), req.body, uname(req))));
api.delete('/simple/stock/:id', wrap((req) => Simple.deleteStock(Number(req.params.id), uname(req))));
api.delete('/simple/money/:type/:id', wrap((req) => Simple.deleteMoney(req.params.type, Number(req.params.id), uname(req))));
api.post('/simple/clear-all', admin, wrap((req) => { if (req.body.confirm !== 'DELETE') fail('Type DELETE to confirm'); return Simple.clearAllData(); }));

// ---------------- checks & backup ----------------
api.get('/integrity', wrap(() => S.integrity()));
api.get('/backup', admin, wrap(async (req, res) => {
  const data = await S.exportAll();
  res.setHeader('Content-Disposition', `attachment; filename="ledgerly-backup-${today()}.json"`);
  res.json(data);
}));

app.use('/api', api);
app.use('/api', (req, res, next) => next(new AppError('Not found', 404)));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  let status = err.status || 500; let message = err.message;
  if (!(err instanceof AppError)) {
    if (/UNIQUE constraint failed/.test(message)) { status = 400; message = 'That value already exists (must be unique).'; }
    else if (/FOREIGN KEY|CHECK constraint|NOT NULL constraint/.test(message)) { status = 400; message = 'Invalid or missing data: ' + message.replace(/^.*?:\s*/, ''); }
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed request'; }
    else { console.error(err); status = 500; message = 'Unexpected error: ' + message; }
  }
  res.status(status).json({ error: message });
});

// ---------------- local server (Vercel imports `app` from api/index.js instead) ----------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ready();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`\n  Ledgerly is running on http://localhost:${port}`);
    console.log(`  Database: ${DB_LABEL}\n  Sign in with admin / Admin@123 (change it in Settings)\n`);
  });
}
