import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_TASKS,
  addCalendarDays,
  addCalendarMonths,
  addCalendarYears,
  commercialLifecycle,
  commercialSchedule,
  dateOnly,
  isSetupReady,
} from '../src/superAdminLifecycle.js';

test('calendar annual dates preserve the anniversary date where possible', () => {
  assert.equal(addCalendarYears('2026-07-06'), '2027-07-06');
  assert.equal(addCalendarYears('2024-02-29'), '2025-02-28');
});

test('calendar monthly and daily support dates preserve valid calendar boundaries', () => {
  assert.equal(addCalendarMonths('2026-07-06'), '2026-08-06');
  assert.equal(addCalendarMonths('2026-01-31'), '2026-02-28');
  assert.equal(addCalendarDays('2026-08-06', 7), '2026-08-13');
});

test('date-only conversion supports PostgreSQL date objects and ISO calendar dates', () => {
  assert.equal(dateOnly(new Date('2026-07-06T00:00:00.000Z')), '2026-07-06');
  assert.equal(dateOnly('2026-07-06T00:00:00.000Z'), '2026-07-06');
  assert.equal(dateOnly('06/07/2026'), null);
});

test('commercial schedule calculates end and next-due dates from paid anchors', () => {
  const result = commercialSchedule({
    basePaymentStatus: 'PAID',
    baseLicenseStartDate: '2026-07-06',
    baseLicenseEndDate: null,
    supportPaymentStatus: 'PAID',
    supportStartDate: '2026-07-06',
    supportLastPaymentDate: null,
    supportNextPaymentDue: null,
    qrOrderingPaymentStatus: 'PAID',
    qrOrderingStartDate: '2026-07-06',
    qrOrderingEndDate: null,
  });
  assert.equal(result.baseLicenseEndDate, '2027-07-06');
  assert.equal(result.supportLastPaymentDate, '2026-07-06');
  assert.equal(result.supportNextPaymentDue, '2026-08-06');
  assert.equal(result.qrOrderingEndDate, '2027-07-06');
});

test('base and QR annual entitlements expire on their anniversary date', () => {
  const result = commercialLifecycle({
    basePaymentStatus: 'PAID',
    baseLicenseStartDate: '2026-07-06',
    supportPaymentStatus: 'NOT_STARTED',
    qrOrderingPaymentStatus: 'PAID',
    qrOrderingStartDate: '2026-07-06',
    directQrOrdering: true,
  }, { today: '2027-07-06' });

  assert.equal(result.basePaymentStatus, 'EXPIRED');
  assert.equal(result.baseIsCurrent, false);
  assert.equal(result.qrOrderingPaymentStatus, 'EXPIRED');
  assert.equal(result.qrEligible, false);
});

test('support moves from paid to due then overdue seven calendar days after its due date', () => {
  const source = {
    basePaymentStatus: 'NOT_PAID',
    supportPaymentStatus: 'PAID',
    supportStartDate: '2026-07-06',
    supportLastPaymentDate: '2026-07-06',
    qrOrderingPaymentStatus: 'NOT_PURCHASED',
  };

  assert.equal(commercialLifecycle(source, { today: '2026-08-05' }).supportPaymentStatus, 'PAID');
  assert.equal(commercialLifecycle(source, { today: '2026-08-06' }).supportPaymentStatus, 'DUE');
  assert.equal(commercialLifecycle(source, { today: '2026-08-12' }).supportPaymentStatus, 'DUE');
  assert.equal(commercialLifecycle(source, { today: '2026-08-13' }).supportPaymentStatus, 'OVERDUE');
});

test('legacy live QR access remains available only while QR commercial dates are absent', () => {
  const legacy = commercialLifecycle({
    basePaymentStatus: 'NOT_PAID',
    supportPaymentStatus: 'NOT_STARTED',
    qrOrderingPaymentStatus: 'NOT_PURCHASED',
    directQrOrdering: true,
  }, { today: '2026-07-06' });
  assert.equal(legacy.qrLegacyAccess, true);

  const datedExpired = commercialLifecycle({
    basePaymentStatus: 'NOT_PAID',
    supportPaymentStatus: 'NOT_STARTED',
    qrOrderingPaymentStatus: 'PAID',
    qrOrderingStartDate: '2025-07-06',
    directQrOrdering: true,
  }, { today: '2026-07-06' });
  assert.equal(datedExpired.qrLegacyAccess, false);
  assert.equal(datedExpired.qrEligible, false);
});

test('setup becomes ready only when every core task is complete', () => {
  const missingOwnerPassword = SETUP_TASKS
    .filter((task) => task.key !== 'OWNER_PASSWORD_CHANGED')
    .map((task) => ({ task_key: task.key, is_completed: true }));
  assert.equal(isSetupReady(missingOwnerPassword), false);
  assert.equal(isSetupReady(SETUP_TASKS.map((task) => ({ task_key: task.key, is_completed: true }))), true);
});
