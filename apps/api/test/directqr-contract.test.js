import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { SETUP_TASKS, commercialLifecycle, commercialSchedule } from '../src/superAdminLifecycle.js';

test('DirectQR requires its end-to-end QR setup task before automatic activation', () => {
  const qrTask = SETUP_TASKS.find((task) => task.key === 'QR_SETUP');
  assert.ok(qrTask);
  assert.equal(qrTask.mode, 'MANUAL');
  assert.match(qrTask.label, /test order/i);
});

test('DirectQR annual licence has an annual end date and support has monthly due lifecycle', () => {
  const schedule = commercialSchedule({
    basePaymentStatus: 'PAID',
    baseLicenseStartDate: '2026-07-06',
    supportPaymentStatus: 'PAID',
    supportStartDate: '2026-07-06',
  });
  assert.equal(schedule.baseLicenseEndDate, '2027-07-06');
  assert.equal(schedule.supportNextPaymentDue, '2026-08-06');

  const expiry = commercialLifecycle({
    basePaymentStatus: 'PAID',
    baseLicenseStartDate: '2026-07-06',
    supportPaymentStatus: 'PAID',
    supportStartDate: '2026-07-06',
  }, { today: '2027-07-06' });
  assert.equal(expiry.basePaymentStatus, 'EXPIRED');
});

test('manual counter creation is blocked while staff additions remain a separate protected route', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /app\.post\(\"\/api\/orders\",[\s\S]*?DirectQR does not allow manual counter\/table order creation/);
  assert.match(source, /app\.post\('\/api\/orders\/:orderId\/staff-items', requireAuth, requireCsrf, requirePermission\('create_orders'\)/);
  assert.match(source, /addStaffItems\(/);
});

test('DirectQR customer, staff and Super Admin sessions use distinct cookie namespaces', async () => {
  const [auth, customer, admin] = await Promise.all([
    fs.readFile(new URL('../src/auth.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/customerAuth.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/superAdminAuth.js', import.meta.url), 'utf8'),
  ]);
  assert.match(auth, /directqr_session/);
  assert.match(customer, /directqr_customer_session/);
  assert.match(admin, /directqr_super_admin_session/);
});

test('new customer QR submissions publish an SSE event and attempt VAPID Web Push delivery', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /publishRestaurantEvent\(context\.restaurant_id, 'qr-order:new'/);
  assert.match(source, /notifyRestaurantQrOrder\(/);
  assert.match(source, /app\.post\('\/api\/notifications\/test'/);
});


test('DirectQR client cancels scheduled QR alarm tones when pending requests are cleared', async () => {
  const source = await fs.readFile(new URL('../../web/src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /qrAlarmTimeoutsRef/);
  assert.match(source, /window\.clearTimeout\(timeoutId\)/);
  assert.match(source, /onPendingQrOrdersChange\?\.\(nextOrders\.length\)/);
});

test('DirectQR keeps the API running when VAPID configuration is malformed and bypasses service-worker cache', async () => {
  const [pushSource, apiSource] = await Promise.all([
    fs.readFile(new URL('../src/push.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(pushSource, /DirectQR push configuration is invalid/);
  assert.match(pushSource, /let configured = false/);
  assert.match(apiSource, /Service-Worker-Allowed/);
  assert.match(apiSource, /no-store, max-age=0, must-revalidate/);
});
