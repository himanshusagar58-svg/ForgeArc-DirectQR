import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';

const isProduction = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CAPTCHA_TTL_MS = 10 * 60 * 1000;
const CAPTCHA_PEPPER = process.env.AUTH_PASSWORD_PEPPER || 'directqr-development-captcha-secret';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

function profile(row) {
  return { id: row.id, displayName: row.display_name, username: row.username, phone: row.phone };
}

export async function createCaptcha() {
  const left = crypto.randomInt(2, 10);
  const right = crypto.randomInt(1, 9);
  const answer = String(left + right);
  const { rows } = await query(
    `INSERT INTO customer_captcha_challenges (answer_hash, expires_at)
     VALUES ($1, now() + interval '10 minutes')
     RETURNING id`,
    [sha256(`${answer}:${CAPTCHA_PEPPER}`)]
  );
  return { captchaId: rows[0].id, question: `${left} + ${right} = ?`, expiresInSeconds: CAPTCHA_TTL_MS / 1000 };
}

export async function verifyCaptcha(captchaId, captchaAnswer) {
  if (!captchaId || !captchaAnswer) throw Object.assign(new Error('Complete the CAPTCHA before continuing.'), { status: 400 });
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, answer_hash, attempts, expires_at, consumed_at
       FROM customer_captcha_challenges WHERE id = $1 FOR UPDATE`,
      [captchaId]
    );
    const challenge = rows[0];
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() < Date.now() || Number(challenge.attempts) >= 4) {
      throw Object.assign(new Error('This CAPTCHA expired. Please refresh it and try again.'), { status: 400 });
    }
    const expected = sha256(`${String(captchaAnswer).trim()}:${CAPTCHA_PEPPER}`);
    const valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(challenge.answer_hash, 'hex'));
    if (!valid) {
      await client.query('UPDATE customer_captcha_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
      throw Object.assign(new Error('CAPTCHA answer is incorrect.'), { status: 400 });
    }
    await client.query('UPDATE customer_captcha_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);
  });
}

export async function createCustomerSession(customerId) {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
     VALUES ($1,$2,$3)`,
    [customerId, sha256(token), expiresAt]
  );
  return token;
}

export function setCustomerSessionCookie(res, token) {
  res.cookie('directqr_customer_session', token, cookieOptions());
}

export function clearCustomerSessionCookie(res) {
  res.clearCookie('directqr_customer_session', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
}

export async function requireCustomer(req, res, next) {
  try {
    const token = req.cookies?.directqr_customer_session;
    if (!token) return res.status(401).json({ message: 'Sign in to place a QR order.' });
    const { rows } = await query(
      `SELECT s.id AS session_id, c.id, c.display_name, c.username, c.phone, c.is_active
       FROM customer_sessions s
       JOIN customer_accounts c ON c.id = s.customer_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(token)]
    );
    const customer = rows[0];
    if (!customer?.is_active) {
      clearCustomerSessionCookie(res);
      return res.status(401).json({ message: 'Your customer session is no longer valid.' });
    }
    query('UPDATE customer_sessions SET last_seen_at = now() WHERE id = $1', [customer.session_id]).catch(() => {});
    req.customer = customer;
    return next();
  } catch {
    clearCustomerSessionCookie(res);
    return res.status(401).json({ message: 'Your customer session expired. Sign in again.' });
  }
}

export async function registerCustomer({ displayName, username, phone, password }) {
  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO customer_accounts (display_name, username, phone, password_hash)
     VALUES ($1,$2,$3,$4)
     RETURNING id, display_name, username, phone`,
    [displayName, username, phone, passwordHash]
  );
  return profile(rows[0]);
}

export async function loginCustomer({ username, password }) {
  const { rows } = await query(
    `SELECT id, display_name, username, phone, password_hash, is_active, failed_login_count, locked_until
     FROM customer_accounts WHERE lower(username) = lower($1)`,
    [username]
  );
  const customer = rows[0];
  const lockedUntil = customer?.locked_until ? new Date(customer.locked_until).getTime() : 0;
  if (customer?.is_active && lockedUntil > Date.now()) {
    throw Object.assign(new Error('This customer account is temporarily locked. Please try again later.'), { status: 423, captchaRequired: true });
  }
  const dummyHash = '$2a$12$pkxgaz2KaQTYwO1cGd/Ue.VQvvhUscqThN1jFord8F1yjw8lu7f72';
  const valid = Boolean(customer?.is_active) && await verifyPassword(password, customer?.password_hash || dummyHash);
  if (!valid) {
    if (customer?.is_active) {
      const failures = Number(customer.failed_login_count || 0) + 1;
      const locked = failures >= 8;
      await query(
        `UPDATE customer_accounts
         SET failed_login_count = $2,
             locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE NULL END,
             updated_at = now()
         WHERE id = $1`,
        [customer.id, failures, locked]
      );
      const error = Object.assign(new Error('Username or password is incorrect.'), { status: 401, captchaRequired: failures >= 3 });
      throw error;
    }
    throw Object.assign(new Error('Username or password is incorrect.'), { status: 401, captchaRequired: false });
  }
  await query('UPDATE customer_accounts SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [customer.id]);
  return profile(customer);
}

export function customerProfile(customer) {
  return profile(customer);
}
