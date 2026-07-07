import webpush from 'web-push';
import { query } from './db.js';

const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const subject = String(process.env.VAPID_SUBJECT || 'mailto:support@directqr.local').trim();
let configured = false;
let configurationError = null;

if (publicKey && privateKey) {
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  } catch (error) {
    configurationError = String(error?.message || 'Invalid VAPID configuration.');
    console.error('DirectQR push configuration is invalid:', configurationError);
  }
} else {
  configurationError = 'Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in the DirectQR service environment.';
}

export function pushConfiguration() {
  return { configured, publicKey: configured ? publicKey : null, error: configurationError };
}

export function assertPushConfigured() {
  if (!configured) {
    throw Object.assign(new Error(`Push notifications are not configured: ${configurationError || 'missing VAPID keys.'}`), { status: 503 });
  }
}

export async function savePushSubscription({ restaurantId, userId, subscription }) {
  assertPushConfigured();
  const endpoint = String(subscription?.endpoint || '').trim();
  const p256dh = String(subscription?.keys?.p256dh || '').trim();
  const auth = String(subscription?.keys?.auth || '').trim();
  if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) {
    throw Object.assign(new Error('The browser returned an invalid notification subscription.'), { status: 400 });
  }
  await query(
    `INSERT INTO push_subscriptions (restaurant_id, user_id, endpoint, subscription)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (endpoint) DO UPDATE SET restaurant_id = EXCLUDED.restaurant_id,
       user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription,
       updated_at = now(), last_error_at = NULL, last_error_message = NULL`,
    [restaurantId, userId, endpoint, JSON.stringify(subscription)],
  );
}

export async function removePushSubscription({ userId, endpoint }) {
  if (!endpoint) return;
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

function payloadForOrder({ orderId, tableName, total }) {
  return JSON.stringify({
    title: 'New DirectQR order',
    body: `${tableName || 'Table'} · ${Number(total || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}`,
    orderId,
    url: `/?view=qr-orders&order=${encodeURIComponent(orderId || '')}`,
    tag: `directqr-order-${orderId || 'new'}`,
  });
}

export async function notifyRestaurantQrOrder({ restaurantId, orderId, tableName, total, userId = null, title = null, body = null }) {
  if (!configured) return { attempted: 0, sent: 0, skipped: true };
  const params = userId ? [restaurantId, userId] : [restaurantId];
  const userClause = userId ? ' AND user_id = $2' : '';
  const { rows } = await query(
    `SELECT id, endpoint, subscription FROM push_subscriptions
     WHERE restaurant_id = $1${userClause} ORDER BY updated_at DESC`,
    params,
  );
  const payload = title || body
    ? JSON.stringify({ title: title || 'DirectQR test alert', body: body || 'Notifications are working on this device.', orderId, url: '/?view=tables', tag: 'directqr-test' })
    : payloadForOrder({ orderId, tableName, total });
  const result = await Promise.allSettled(rows.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, payload, { TTL: 60, urgency: 'high' });
      await query('UPDATE push_subscriptions SET last_success_at = now(), last_error_at = NULL, last_error_message = NULL WHERE id = $1', [row.id]);
      return { id: row.id, sent: true };
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
      } else {
        await query('UPDATE push_subscriptions SET last_error_at = now(), last_error_message = $2 WHERE id = $1', [row.id, String(error?.message || 'Push failed').slice(0, 300)]);
      }
      return { id: row.id, sent: false };
    }
  }));
  return {
    attempted: rows.length,
    sent: result.filter((entry) => entry.status === 'fulfilled' && entry.value?.sent).length,
  };
}
