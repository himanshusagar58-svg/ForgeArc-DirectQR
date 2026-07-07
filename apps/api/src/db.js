import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

// Workspace scripts run with apps/api as their current directory. Load the
// repository-level .env explicitly so development, schema, seed and API
// commands all use the same configuration.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(moduleDir, '../../../.env') });

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env at the repository root and configure PostgreSQL.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 10),
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

/**
 * POS mutations run at SERIALIZABLE isolation. PostgreSQL may ask for a retry
 * under a genuine concurrent edit; doing that here prevents duplicate KOTs,
 * duplicate settlements, and two open orders on one table.
 */
export async function withTransaction(work, { retries = 2 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      lastError = error;
      try { await client.query('ROLLBACK'); } catch { /* connection cleanup only */ }
      if (!RETRYABLE_TRANSACTION_CODES.has(error?.code) || attempt === retries) throw error;
    } finally {
      client.release();
    }
  }

  throw lastError;
}
