// Double-entry posting engine, stock movement helpers and audit trail.
import { all, get, run, insert, update, tx } from './db.js';
import { fail, r2, cents, consumeNumber } from './util.js';

// ---------------------------------------------------------------------------
// Journal
// lines: [{account, debit, credit, party?, memo?}]  (account = accounts.id)
// Re-posting the same (sourceType, sourceId) replaces its previous lines, so
// editing a document always keeps the ledger in sync with the document.
// ---------------------------------------------------------------------------
export async function postEntry({ sourceType, sourceId, date, memo, lines, user }) {
  const clean = lines
    .map((l) => ({ account: l.account, debit: r2(l.debit || 0), credit: r2(l.credit || 0), party: l.party || null, memo: l.memo || null }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  for (const l of clean) {
    if (!l.account) fail('Journal line without an account', 500);
    if (l.debit > 0 && l.credit > 0) fail('A journal line cannot have both debit and credit', 500);
  }
  const d = clean.reduce((s, l) => s + cents(l.debit), 0);
  const c = clean.reduce((s, l) => s + cents(l.credit), 0);
  if (d !== c) fail(`Unbalanced entry: debits ${d / 100} <> credits ${c / 100}`, 500);
  const existing = await get('SELECT * FROM journal_entries WHERE source_type=? AND source_id=?', sourceType, sourceId);
  if (!clean.length) { if (existing) await voidEntry(sourceType, sourceId); return null; }
  return await tx(async () => {
    let entryId;
    if (existing) {
      entryId = existing.id;
      await update('journal_entries', entryId, { date, memo: memo || null, status: 'posted' });
      await run('DELETE FROM journal_lines WHERE entry_id=?', entryId);
    } else {
      entryId = await insert('journal_entries', { entry_no: await consumeNumber('journal', date), date, memo: memo || null, source_type: sourceType, source_id: sourceId, created_by: user || null });
    }
    for (const l of clean) await insert('journal_lines', { entry_id: entryId, account_id: l.account, debit: l.debit, credit: l.credit, party_id: l.party, memo: l.memo });
    return entryId;
  });
}
export async function voidEntry(sourceType, sourceId) {
  await run("UPDATE journal_entries SET status='void' WHERE source_type=? AND source_id=?", sourceType, sourceId);
}
export async function purgeEntry(sourceType, sourceId) {
  await run('DELETE FROM journal_entries WHERE source_type=? AND source_id=?', sourceType, sourceId);
}

// ---------------------------------------------------------------------------
// Stock (weighted-average cost). Movement value is always signed like qty.
// ---------------------------------------------------------------------------
export async function stockOf(itemId) {
  const r = await get('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(value),0) v FROM stock_movements WHERE item_id=?', itemId);
  return { qty: r.q, value: r2(r.v) };
}
export async function avgCost(itemId) {
  const { qty, value } = await stockOf(itemId);
  if (qty > 0.0000001 && value > 0) return value / qty;
  const it = await get('SELECT purchase_price FROM items WHERE id=?', itemId);
  return it ? it.purchase_price : 0;
}
export async function addMovement({ itemId, date, type, qty, value, sourceType, sourceId, memo }) {
  await insert('stock_movements', { item_id: itemId, date, type, qty, value: r2(value), source_type: sourceType, source_id: sourceId, memo: memo || null });
}
export async function clearMovements(sourceType, sourceId) {
  const ids = (await all('SELECT DISTINCT item_id FROM stock_movements WHERE source_type=? AND source_id=?', sourceType, sourceId)).map((r) => r.item_id);
  await run('DELETE FROM stock_movements WHERE source_type=? AND source_id=?', sourceType, sourceId);
  return ids;
}
// Stock must never go negative - keeps quantity + inventory value consistent.
export async function assertStock(itemIds) {
  for (const id of new Set(itemIds)) {
    const { qty, value } = await stockOf(id);
    if (qty < -0.0000001) {
      const it = await get('SELECT name FROM items WHERE id=?', id);
      fail(`Insufficient stock for "${it?.name}" - this change would leave ${qty} in stock`);
    }
    if (qty <= 0.0000001 && Math.abs(value) > 0.005 && qty >= -0.0000001) {
      // rounding residue on an emptied item: fold into zero by adjusting the latest movement
      const last = await get('SELECT id,value FROM stock_movements WHERE item_id=? ORDER BY id DESC LIMIT 1', id);
      if (last) await run('UPDATE stock_movements SET value=? WHERE id=?', r2(last.value - value), last.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
const SKIP = new Set(['updated_at', 'updated_by', 'created_at', 'created_by', 'is_deleted', 'deleted_at', 'deleted_by', 'id']);
export function diffRows(oldRow, newRow) {
  const out = {};
  for (const k of Object.keys(newRow || {})) {
    if (SKIP.has(k)) continue;
    const a = oldRow?.[k] ?? null; const b = newRow[k] ?? null;
    if (String(a) !== String(b)) out[k] = { from: a, to: b };
  }
  return out;
}
export async function audit({ entity, entityId, ref, action, user, oldAmount = null, newAmount = null, changes = null }) {
  await insert('audit_log', {
    entity, entity_id: entityId, ref: ref || null, action, user: user || 'system',
    old_amount: oldAmount, new_amount: newAmount, changes: changes && Object.keys(changes).length ? JSON.stringify(changes) : null,
  });
}
