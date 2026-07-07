import { pool } from '../apps/api/src/db.js';
import { createSuperAdminFromEnvironment } from '../apps/api/src/superAdminAuth.js';

try {
  const result = await createSuperAdminFromEnvironment();
  if (result.created) console.log(`Created initial DirectQR Super Admin: ${result.username}`);
  else if (result.missingEnvironment) console.warn('No Super Admin exists yet. Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD, then restart to create the first account.');
  else console.log('Existing Super Admin account found.');
} finally {
  await pool.end();
}
