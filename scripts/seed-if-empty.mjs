import pg from 'pg';
import { spawn } from 'node:child_process';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required before initializing the DirectQR database.');
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed: node ${args.join(' ')}`));
    });
  });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

try {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM restaurants');
  if (Number(rows[0]?.count || 0) === 0) {
    console.log('No restaurant found. Seeding the safe demo outlet for this temporary test deployment.');
    await pool.end();
    await runNode(['apps/api/sql/seed.js']);
  } else {
    console.log('Existing restaurant data found. Skipping demo seed.');
    await pool.end();
  }
} catch (error) {
  await pool.end().catch(() => {});
  throw error;
}
