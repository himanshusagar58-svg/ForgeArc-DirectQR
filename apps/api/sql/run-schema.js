import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');
const sql = await fs.readFile(schemaPath, 'utf8');

// PostgreSQL does not allow a newly added ENUM value to be used until the
// ALTER TYPE transaction has committed. v1.4.1 adds WAITER and immediately
// backfills role permissions, so run that ALTER in its own committed query.
const marker = '-- V1.4.1 role permissions, availability states and safe table-number reuse.';
const markerIndex = sql.indexOf(marker);
if (markerIndex === -1) {
  throw new Error(`Migration marker not found in ${schemaPath}.`);
}

const baseSql = sql.slice(0, markerIndex);
const migrationSql = sql
  .slice(markerIndex + marker.length)
  .replace(/ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'WAITER';\s*/i, '');

await pool.query(baseSql);
// This must be a separate statement/transaction before WAITER is referenced
// by the permission backfill below. Safe for both new and existing databases.
await pool.query("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'WAITER'");
await pool.query(migrationSql);

// Existing local/demo outlets receive a first shared Void Password only when none exists.
// Production provisioning should set a unique void password when creating the outlet.
const initialVoidPassword = process.env.DEFAULT_VOID_PASSWORD || 'Void@2026!';
const { rows: outletsWithoutVoidPassword } = await pool.query(
  'SELECT id FROM restaurants WHERE void_password_hash IS NULL',
);
for (const outlet of outletsWithoutVoidPassword) {
  await pool.query(
    'UPDATE restaurants SET void_password_hash = $2, updated_at = now() WHERE id = $1',
    [outlet.id, await hashPassword(initialVoidPassword)],
  );
}
console.log('Schema applied successfully.');
await pool.end();
