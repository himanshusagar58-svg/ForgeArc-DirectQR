import crypto from 'node:crypto';
import { query } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';

const isProduction = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function constantTimeHexEqual(one, two) {
  if (!one || !two || one.length !== two.length) return false;
  return crypto.timingSafeEqual(Buffer.from(one, 'hex'), Buffer.from(two, 'hex'));
}

function cookieOptions(httpOnly) {
  return {
    httpOnly,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

export function superAdminPayload(admin) {
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.display_name,
  };
}

export async function createSuperAdminSession(admin) {
  const token = crypto.randomBytes(48).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO super_admin_sessions (super_admin_id, token_hash, csrf_hash, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [admin.id, sha256(token), sha256(csrf), expiresAt],
  );
  return { token, csrf };
}

export function setSuperAdminSessionCookies(res, { token, csrf }) {
  res.cookie('directqr_super_admin_session', token, cookieOptions(true));
  res.cookie('directqr_super_admin_csrf', csrf, cookieOptions(false));
}

export function clearSuperAdminSessionCookies(res) {
  const options = { secure: isProduction, sameSite: 'lax', path: '/' };
  res.clearCookie('directqr_super_admin_session', { ...options, httpOnly: true });
  res.clearCookie('directqr_super_admin_csrf', { ...options, httpOnly: false });
}

export async function requireSuperAdmin(req, res, next) {
  try {
    const rawToken = req.cookies?.directqr_super_admin_session;
    if (!rawToken) return res.status(401).json({ message: 'Super Admin authentication required.' });
    const { rows } = await query(
      `SELECT s.id AS session_id, s.csrf_hash, a.id, a.username, a.display_name, a.is_active
       FROM super_admin_sessions s
       JOIN super_admin_users a ON a.id = s.super_admin_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(rawToken)],
    );
    const admin = rows[0];
    if (!admin?.is_active) {
      clearSuperAdminSessionCookies(res);
      return res.status(401).json({ message: 'Super Admin session is no longer valid.' });
    }
    query('UPDATE super_admin_sessions SET last_seen_at = now() WHERE id = $1', [admin.session_id]).catch(() => {});
    req.superAdmin = admin;
    return next();
  } catch {
    clearSuperAdminSessionCookies(res);
    return res.status(401).json({ message: 'Super Admin session expired or is invalid.' });
  }
}

export function requireSuperAdminCsrf(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || !req.superAdmin?.csrf_hash || !constantTimeHexEqual(sha256(token), req.superAdmin.csrf_hash)) {
    return res.status(403).json({ message: 'Invalid Super Admin CSRF token.' });
  }
  return next();
}

export async function revokeSuperAdminSession(sessionId) {
  if (!sessionId) return;
  await query('UPDATE super_admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function createSuperAdminFromEnvironment() {
  const username = String(process.env.SUPER_ADMIN_USERNAME || '').trim().toLowerCase();
  const password = String(process.env.SUPER_ADMIN_PASSWORD || '');
  const displayName = String(process.env.SUPER_ADMIN_DISPLAY_NAME || 'DirectQR Super Admin').trim();
  const isProd = process.env.NODE_ENV === 'production';

  const { rows: existing } = await query('SELECT id FROM super_admin_users LIMIT 1');
  if (existing[0]) return { created: false };
  if (!username || !password) {
    if (isProd) throw new Error('Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD before first production startup.');
    return { created: false, missingEnvironment: true };
  }
  if (!/^[a-z0-9._-]{3,64}$/i.test(username)) {
    throw new Error('SUPER_ADMIN_USERNAME must use 3–64 letters, numbers, dots, underscores or hyphens.');
  }
  if (password.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must contain at least 12 characters.');
  }
  const passwordHash = await hashPassword(password);
  await query(
    `INSERT INTO super_admin_users (username, password_hash, display_name)
     VALUES ($1,$2,$3)`,
    [username, passwordHash, displayName || 'DirectQR Super Admin'],
  );
  return { created: true, username };
}

export async function verifySuperAdminPassword(password, hash) {
  return verifyPassword(password, hash);
}
