import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from './db.js';

const isProduction = process.env.NODE_ENV === 'production';
const PEPPER = process.env.AUTH_PASSWORD_PEPPER || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (isProduction && PEPPER.length < 32) {
  throw new Error('AUTH_PASSWORD_PEPPER must be at least 32 characters in production.');
}

export const STAFF_PERMISSION_KEYS = [
  'view_tables', 'create_orders', 'send_kot', 'print_bill', 'settle_payment',
  'view_reports', 'view_customer_details', 'edit_menu', 'manage_tables',
  'void_orders', 'reprint_bill', 'apply_discount',
];

export const ROLE_TEMPLATES = {
  WAITER: {
    view_tables: true, create_orders: true, send_kot: true, print_bill: false,
    settle_payment: false, view_reports: false, view_customer_details: false,
    edit_menu: false, manage_tables: false, void_orders: true, reprint_bill: false,
    apply_discount: false,
  },
  CASHIER: {
    view_tables: true, create_orders: true, send_kot: true, print_bill: true,
    settle_payment: true, view_reports: true, view_customer_details: true,
    edit_menu: false, manage_tables: false, void_orders: true, reprint_bill: true,
    apply_discount: false,
  },
  MANAGER: {
    view_tables: true, create_orders: true, send_kot: true, print_bill: true,
    settle_payment: true, view_reports: true, view_customer_details: true,
    edit_menu: true, manage_tables: true, void_orders: true, reprint_bill: true,
    apply_discount: true,
  },
};

export function defaultPermissions(role = 'CASHIER') {
  if (role === 'OWNER') return Object.fromEntries(STAFF_PERMISSION_KEYS.map((key) => [key, true]));
  return { ...(ROLE_TEMPLATES[role] || ROLE_TEMPLATES.CASHIER) };
}

export function normalizePermissions(role, candidate) {
  const defaults = defaultPermissions(role);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return defaults;
  return Object.fromEntries(STAFF_PERMISSION_KEYS.map((key) => [key, Boolean(candidate[key] ?? defaults[key])])) ;
}

export function hasPermission(user, permission) {
  if (user?.role === 'OWNER') return true;
  return Boolean(user?.permissions?.[permission]);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ message: 'You do not have permission for this action.' });
    }
    return next();
  };
}

export function passwordWithPepper(password) {
  return `${password}${PEPPER}`;
}

export async function hashPassword(password) {
  return bcrypt.hash(passwordWithPepper(password), 12);
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(passwordWithPepper(password), passwordHash);
}

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

export async function createSession(user) {
  const token = crypto.randomBytes(48).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [user.id, sha256(token), sha256(csrf), expiresAt],
    );
  });

  return { token, csrf };
}

export function setSessionCookies(res, { token, csrf }) {
  res.cookie('directqr_session', token, cookieOptions(true));
  res.cookie('directqr_csrf', csrf, cookieOptions(false));
}

export function clearSessionCookies(res) {
  const options = { secure: isProduction, sameSite: 'lax', path: '/' };
  res.clearCookie('directqr_session', { ...options, httpOnly: true });
  res.clearCookie('directqr_csrf', { ...options, httpOnly: false });
}

export async function requireAuth(req, res, next) {
  try {
    const rawToken = req.cookies?.directqr_session;
    if (!rawToken) return res.status(401).json({ message: 'Authentication required.' });

    const { rows } = await query(
      `SELECT s.id AS session_id, s.csrf_hash, u.id, u.restaurant_id, u.username, u.display_name, u.role, u.permissions, u.is_active,
              u.must_change_password, r.name AS restaurant_name, r.slug AS restaurant_slug, r.login_id AS restaurant_login_id,
              r.theme_color, r.bill_prefix, r.timezone, r.opening_time, r.closing_time, r.operational_status,
              TRUE AS direct_qr_ordering
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN restaurants r ON r.id = u.restaurant_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(rawToken)],
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      clearSessionCookies(res);
      return res.status(401).json({ message: 'Session is no longer valid.' });
    }
    if (['SUSPENDED', 'DISABLED'].includes(user.operational_status)) {
      clearSessionCookies(res);
      return res.status(403).json({ message: 'This restaurant is currently unavailable. Contact DirectQR Support.' });
    }
    // A temporary owner credential is only allowed to inspect session state,
    // change its password, or sign out. This is enforced server-side so an
    // owner cannot bypass the first-login screen by calling business APIs directly.
    const passwordChangeAllowedPaths = new Set([
      '/api/auth/me',
      '/api/auth/change-password',
      '/api/auth/logout',
    ]);
    const requestPath = String(req.originalUrl || req.path || '').split('?')[0];
    if (user.must_change_password && !passwordChangeAllowedPaths.has(requestPath)) {
      return res.status(403).json({ message: 'Change the temporary password before using DirectQR.' });
    }
    // A newly provisioned outlet stays operationally locked until its real
    // onboarding checklist is complete. Owners may still inspect session state,
    // change their first password, and sign out; no POS business endpoint is open.
    if (user.operational_status === 'SETUP_PENDING' && !passwordChangeAllowedPaths.has(requestPath)) {
      return res.status(403).json({ message: 'DirectQR setup is still in progress. Contact DirectQR Support.' });
    }
    user.permissions = normalizePermissions(user.role, user.permissions);
    query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [user.session_id]).catch(() => {});
    req.user = user;
    return next();
  } catch {
    clearSessionCookies(res);
    return res.status(401).json({ message: 'Session expired or invalid.' });
  }
}

export function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || !req.user?.csrf_hash || !constantTimeHexEqual(sha256(token), req.user.csrf_hash)) {
    return res.status(403).json({ message: 'Invalid CSRF token.' });
  }
  return next();
}

export async function revokeCurrentSession(sessionId) {
  if (!sessionId) return;
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllUserSessions(userId) {
  await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission for this action.' });
    }
    return next();
  };
}
