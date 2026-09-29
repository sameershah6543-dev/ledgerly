// One-time check that the app works against your Turso database, run BEFORE the first deploy.
// It builds the tables, records a demo sale / expense / restock, verifies the books,
// then removes everything again so the live site starts fresh.
//   node --env-file=.env test/turso-check.mjs
if (!process.env.TURSO_DATABASE_URL) { console.log('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env first.'); process.exit(1); }
const { client, all, getSetting, loadSettings, ensureSchema } = await import('../server/db.js');

await ensureSchema(); await loadSettings();
if (getSetting('setup_done') === '1' && !process.argv.includes('--force')) {
  console.log('This database is already in use - not touching it. (Pass --force to wipe and test anyway.)');
  process.exit(1);
}
const t0 = Date.now();
const { bootstrap } = await import('../server/bootstrap.js');
const Simple = await import('../server/simple.js');
const S = await import('../server/system.js');
let failed = 0; const ok = (c, m) => { console.log(`${c ? '  ✔' : '  ✘ FAIL:'} ${m}`); if (!c) failed++; };
try {
  await bootstrap({ sample: true });
  ok(true, `Tables and demo data created (${Date.now() - t0} ms)`);
  const cash = (await Simple.moneyList())[0].id;
  let t = Date.now();
  const sale = await Simple.createSale({ item_name: 'Test phone', qty: 1, unit_price: 50000, unit_cost: 40000, money_account_id: cash }, 'check');
  ok((await Simple.salesList()).rows.find((r) => r.id === sale.id)?.profit === 10000, `Sale with custom profit saved (${Date.now() - t} ms)`);
  t = Date.now();
  const s = await Simple.summary({});
  ok(s.sales === 172000 + 50000, `Dashboard figures correct (${Date.now() - t} ms)`);
  const item = (await Simple.inventory()).rows.find((r) => r.name.startsWith('iPhone'));
  await Simple.restock({ item_id: item.id, qty: 2, unit_cost: 150000, money_account_id: cash }, 'check');
  ok((await Simple.inventory()).rows.find((r) => r.id === item.id).stock === 4, 'Restock saved');
  let rolledBack = false;
  try { await Simple.createSale({ item_id: item.id, qty: 99, unit_price: 1, money_account_id: cash }, 'check'); } catch { rolledBack = true; }
  ok(rolledBack && (await Simple.salesList()).rows.length === 2, 'A rejected sale leaves nothing behind (transactions work)');
  const integ = await S.integrity(); ok(integ.ok, 'Books balanced and consistent');
} catch (e) { failed++; console.log('  ✘ FAIL:', e.message); }
// leave the database empty for the real deployment
// drop children before parents (foreign keys are enforced), a few passes until nothing is left
for (let pass = 0; pass < 10; pass++) {
  const left = await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'");
  if (!left.length) break;
  for (const { name } of left) { try { await client.execute(`DROP TABLE IF EXISTS "${name}"`); } catch { /* still referenced - next pass */ } }
}
console.log(`\n${failed ? `✘ ${failed} check(s) failed` : '✔ Turso works - database cleaned, ready to deploy'} (total ${Date.now() - t0} ms)`);
process.exit(failed ? 1 : 0);
