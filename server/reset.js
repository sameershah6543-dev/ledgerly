// Wipe the local database and reload the demo data:  npm run seed
// (for a Turso database use Settings -> Start fresh instead)
import fs from 'node:fs';
import path from 'node:path';
if (process.env.TURSO_DATABASE_URL) { console.log('Refusing to reset a Turso database from the command line.'); process.exit(1); }
const dir = path.resolve(process.env.DATA_DIR || 'data');
const db = path.resolve(process.env.DB_PATH || path.join(dir, 'accounting.db'));
for (const f of [db, `${db}-wal`, `${db}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
const { bootstrap } = await import('./bootstrap.js');
await bootstrap({ sample: true });
console.log('Database reset. Sign in with admin / Admin@123');
