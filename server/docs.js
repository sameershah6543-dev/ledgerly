// Generic transactional-document framework: every save runs in one DB transaction that
// (1) writes the document, (2) re-posts its journal entry / stock movements, (3) writes the audit trail.
// If any accounting rule is violated an error is thrown and the whole unit is rolled back.
import { all, get, run, insert, update, tx } from './db.js';
import { fail, r2 } from './util.js';
import { audit, diffRows } from './posting.js';
import { assertMoneyOk } from './finance.js';

export const docs = {};      // route key -> definition
export const docsByTable = {};
export function defineDoc(def) { docs[def.key] = def; docsByTable[def.table] = def; }

const nowStr = () => new Date().toLocaleString('sv-SE').replace('T', ' ');

export async function getRow(def, id) {
  const row = await get(`SELECT * FROM ${def.table} WHERE id=?`, id);
  if (!row) fail(`${def.label} not found`, 404);
  return row;
}
export async function getDoc(def, id) {
  const row = await getRow(def, id);
  if (def.lines) row.lines = await all(`SELECT * FROM ${def.lines.table} WHERE ${def.lines.fk}=? ORDER BY id`, id);
  return def.decorate ? await def.decorate(row) : row;
}

export async function saveDoc(def, body, id, user) {
  return await tx(async () => {
    const old = id ? await getRow(def, id) : null;
    if (old?.is_deleted) fail('This record is deleted. Restore it before editing.');
    const oldLines = old && def.lines ? await all(`SELECT * FROM ${def.lines.table} WHERE ${def.lines.fk}=? ORDER BY id`, id) : null;
    const { row, lines } = await def.normalize(body || {}, { old, oldLines, user, id });
    let rid = id;
    if (!old) rid = await insert(def.table, { ...row, created_by: user });
    else await update(def.table, id, { ...row, updated_at: nowStr(), updated_by: user });
    let newLines = null;
    if (def.lines) {
      await run(`DELETE FROM ${def.lines.table} WHERE ${def.lines.fk}=?`, rid);
      for (const l of lines || []) await insert(def.lines.table, { ...l, [def.lines.fk]: rid });
      newLines = await all(`SELECT * FROM ${def.lines.table} WHERE ${def.lines.fk}=? ORDER BY id`, rid);
    }
    await def.post(rid, user);
    await def.afterSave?.(rid, old);
    if (!old) await def.afterCreate?.(rid, body, user);
    const fresh = await getRow(def, rid);
    await checkMoney(def, old, fresh);
    const changes = old ? diffRows(old, fresh) : null;
    if (old && newLines && JSON.stringify(strip(oldLines)) !== JSON.stringify(strip(newLines))) {
      changes.lines = { from: `${oldLines.length} line(s) / ${sumNet(oldLines)}`, to: `${newLines.length} line(s) / ${sumNet(newLines)}` };
    }
    await audit({
      entity: def.table, entityId: rid, ref: fresh[def.numberField || 'number'], action: old ? 'updated' : 'created', user,
      oldAmount: old ? old[def.amountField] : null, newAmount: fresh[def.amountField], changes,
    });
    return await getDoc(def, rid);
  });
}
const strip = (ls) => ls.map(({ id, invoice_id, unit_cost, ...r }) => r);
const sumNet = (ls) => r2(ls.reduce((s, l) => s + (l.line_net || 0) + (l.line_tax || 0), 0));

export async function deleteDoc(def, id, user) {
  return await tx(async () => {
    const row = await getRow(def, id);
    if (row.is_deleted) fail('Already deleted');
    await def.canDelete?.(id, row);
    await run(`UPDATE ${def.table} SET is_deleted=1, deleted_at=?, deleted_by=? WHERE id=?`, nowStr(), user, id);
    await def.unpost(id, user);
    await checkMoney(def, row, null);
    await audit({ entity: def.table, entityId: id, ref: row[def.numberField || 'number'], action: 'deleted', user, oldAmount: row[def.amountField], newAmount: 0 });
    return { ok: true };
  });
}
export async function restoreDoc(def, id, user) {
  return await tx(async () => {
    const row = await getRow(def, id);
    if (!row.is_deleted) fail('Record is not deleted');
    await run(`UPDATE ${def.table} SET is_deleted=0, deleted_at=NULL, deleted_by=NULL WHERE id=?`, id);
    await def.post(id, user);
    await def.afterSave?.(id, row);
    await checkMoney(def, null, await getRow(def, id));
    await audit({ entity: def.table, entityId: id, ref: row[def.numberField || 'number'], action: 'restored', user, oldAmount: 0, newAmount: row[def.amountField] });
    return await getDoc(def, id);
  });
}

// Shared line calculation for sales & purchase invoices
export function calcLines(rawLines, { fallbackTax = 0 } = {}) {
  let subtotal = 0, discount = 0, tax = 0;
  const lines = rawLines.map((l) => {
    const qty = Number(l.qty), price = Number(l.unit_price), dp = Number(l.discount_pct || 0), tr = Number(l.tax_rate ?? fallbackTax ?? 0);
    const gross = r2(qty * price), disc = r2(gross * dp / 100), net = r2(gross - disc), t = r2(net * tr / 100);
    subtotal += gross; discount += disc; tax += t;
    return { ...l, qty, unit_price: price, discount_pct: dp, tax_rate: tr, line_net: net, line_tax: t };
  });
  return { lines, subtotal: r2(subtotal), discount_total: r2(discount), tax_total: r2(tax), total: r2(subtotal - discount + tax) };
}

// Ensure no cash/bank account is overdrawn after a change (checks the accounts before and after the edit)
async function checkMoney(def, a, b) {
  if (!def.moneyCols) return;
  const ids = new Set();
  for (const row of [a, b]) if (row) for (const c of def.moneyCols) if (row[c]) ids.add(row[c]);
  for (const i of ids) await assertMoneyOk(i);
}

// Update selected columns of a document (status changes, disposals...) and re-post it.
export async function patchDoc(def, id, patch, user, action = 'updated') {
  return await tx(async () => {
    const old = await getRow(def, id);
    if (old.is_deleted) fail('This record is deleted');
    await update(def.table, id, { ...patch, updated_at: nowStr(), updated_by: user });
    await def.post(id, user);
    await def.afterSave?.(id, old);
    const fresh = await getRow(def, id);
    await checkMoney(def, old, fresh);
    await audit({ entity: def.table, entityId: id, ref: fresh[def.numberField || 'number'], action, user, oldAmount: old[def.amountField], newAmount: fresh[def.amountField], changes: diffRows(old, fresh) });
    return await getDoc(def, id);
  });
}
