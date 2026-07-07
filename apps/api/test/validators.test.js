import test from 'node:test';
import assert from 'node:assert/strict';
import {
  restaurantSettingsSchema, settleSchema, billReprintSchema, dashboardDateSchema, orderDraftSchema,
  voidOrderSchema, createStaffSchema, loginSchema, categorySchema, billPrintSchema, updateVoidPasswordSchema, resetStaffPasswordSchema, menuItemSchema, publicCustomerRegisterSchema, publicQrOrderSchema,
} from '../src/validators.js';

const base = {
  expectedRevision: 2,
  printBill: false,
};

test('settlement accepts a valid split between distinct payment methods', () => {
  const parsed = settleSchema.parse({
    ...base,
    payments: [
      { method: 'CASH', amount: 100 },
      { method: 'UPI', amount: 150 },
    ],
  });
  assert.equal(parsed.payments.length, 2);
});

test('settlement rejects duplicate payment methods', () => {
  assert.throws(() => settleSchema.parse({
    ...base,
    payments: [
      { method: 'UPI', amount: 100 },
      { method: 'UPI', amount: 150 },
    ],
  }), /Use each payment method only once/);
});

test('settings normalize GSTIN spaces, hyphens and lowercase input', () => {
  const parsed = restaurantSettingsSchema.parse({
    name: 'Coffea',
    gstin: '09-abcde 1234f1z5',
    address: '',
    phone: '',
    billPrefix: 'cof',
  });
  assert.equal(parsed.gstin, '09ABCDE1234F1Z5');
  assert.equal(parsed.billPrefix, 'COF');
});

test('settings reject an incomplete GSTIN with a field-level validation message', () => {
  assert.throws(() => restaurantSettingsSchema.parse({
    name: 'Coffea', gstin: '09ABCDE1234F1Z', address: '', phone: '', billPrefix: 'COF',
  }), /GSTIN must be 15 characters/);
});

test('void request requires the shared Void Password', () => {
  assert.throws(() => voidOrderSchema.parse({
    expectedRevision: 3,
    reason: 'Customer left before preparation',
  }));
  const parsed = voidOrderSchema.parse({
    expectedRevision: 3, reason: 'Customer left before preparation', voidPassword: 'Void@2026!',
  });
  assert.equal(parsed.voidPassword, 'Void@2026!');
});

test('bill reprint accepts an admin authorization payload', () => {
  const parsed = billReprintSchema.parse({ adminUsername: 'owner', adminPassword: 'ValidPass@2026' });
  assert.equal(parsed.adminUsername, 'owner');
});

test('staff creation requires a strong password', () => {
  assert.throws(() => createStaffSchema.parse({ displayName: 'Rahul', username: 'rahul01', password: 'weak' }), /12 characters/);
  const parsed = createStaffSchema.parse({ displayName: 'Rahul', username: 'rahul01', password: 'StrongPass@2026' });
  assert.equal(parsed.username, 'rahul01');
});

test('login differentiates staff and admin sign in', () => {
  const parsed = loginSchema.parse({ restaurantId: 'FACOFFEA2026', username: 'coffea-demo', password: 'Coffea@2026!', mode: 'ADMIN' });
  assert.equal(parsed.mode, 'ADMIN');
  assert.equal(parsed.restaurantId, 'FACOFFEA2026');
});

test('login requires a generated Restaurant ID format', () => {
  assert.throws(() => loginSchema.parse({ restaurantId: 'coffea-demo', username: 'owner', password: 'anything', mode: 'ADMIN' }), /Restaurant ID/);
  assert.equal(loginSchema.parse({ restaurantId: 'faCoffea2026', username: 'owner', password: 'anything', mode: 'ADMIN' }).restaurantId, 'FACOFFEA2026');
});

test('owner dashboard date only accepts ISO calendar dates', () => {
  assert.equal(dashboardDateSchema.parse({ date: '2026-06-30' }).date, '2026-06-30');
  assert.throws(() => dashboardDateSchema.parse({ date: '30/06/2026' }));
});


test('category creation records vegetarian or non-vegetarian type', () => {
  assert.equal(categorySchema.parse({ name: 'Beverages', foodType: 'VEG' }).foodType, 'VEG');
  assert.equal(categorySchema.parse({ name: 'Chicken', foodType: 'NON_VEG' }).foodType, 'NON_VEG');
});

test('bill printing accepts optional free-form customer details', () => {
  const parsed = billPrintSchema.parse({ expectedRevision: 4, customerName: 'Walk-in guest', customerMobile: 'not-a-validated-number' });
  assert.equal(parsed.customerName, 'Walk-in guest');
  assert.equal(parsed.customerMobile, 'not-a-validated-number');
});

test('outlet time settings default to normal operating hours and reject closing before opening', () => {
  const defaults = restaurantSettingsSchema.parse({ name: 'Coffea', gstin: '', address: '', phone: '', billPrefix: 'COF' });
  assert.equal(defaults.openingTime, '09:00');
  assert.equal(defaults.closingTime, '22:00');
  assert.throws(() => restaurantSettingsSchema.parse({ name: 'Coffea', gstin: '', address: '', phone: '', billPrefix: 'COF', openingTime: '18:00', closingTime: '09:00' }), /Closing time/);
});

test('Void Password reset requires a strong replacement', () => {
  assert.throws(() => updateVoidPasswordSchema.parse({ adminPassword: 'Coffea@2026!', newVoidPassword: 'weak' }), /12 characters/);
  const parsed = updateVoidPasswordSchema.parse({ adminPassword: 'Coffea@2026!', newVoidPassword: 'NewVoidPass@2026' });
  assert.equal(parsed.newVoidPassword, 'NewVoidPass@2026');
});

test('staff role templates accept individual permission toggles', () => {
  const parsed = createStaffSchema.parse({
    displayName: 'Anita', username: 'anita.cashier', password: 'FixturePassword@2026', role: 'CASHIER',
    permissions: { view_reports: true, apply_discount: false, manage_tables: false },
  });
  assert.equal(parsed.role, 'CASHIER');
  assert.equal(parsed.permissions.view_reports, true);
  assert.equal(parsed.permissions.apply_discount, false);
});

test('staff reset requires the approving admin password field', () => {
  assert.throws(() => resetStaffPasswordSchema.parse({ password: 'FixturePassword@2026' }));
  const parsed = resetStaffPasswordSchema.parse({ password: 'FixturePassword@2026', adminPassword: 'AdminFixture@2026' });
  assert.equal(parsed.adminPassword, 'AdminFixture@2026');
});

test('menu items support available, out-of-stock and inactive states', () => {
  const baseItem = { categoryId: '123e4567-e89b-12d3-a456-426614174000', name: 'Iced Latte', price: 180, gstRate: 5, addonGroups: [] };
  assert.equal(menuItemSchema.parse({ ...baseItem, availability: 'AVAILABLE' }).availability, 'AVAILABLE');
  assert.equal(menuItemSchema.parse({ ...baseItem, availability: 'OUT_OF_STOCK' }).availability, 'OUT_OF_STOCK');
  assert.equal(menuItemSchema.parse({ ...baseItem, availability: 'INACTIVE' }).availability, 'INACTIVE');
});


test('menu items accept an optional customer-facing description', () => {
  const parsed = menuItemSchema.parse({
    categoryId: '123e4567-e89b-12d3-a456-426614174000', name: 'Iced Latte', description: 'Cold espresso with milk.', price: 180, gstRate: 5, addonGroups: [],
  });
  assert.equal(parsed.description, 'Cold espresso with milk.');
  assert.throws(() => menuItemSchema.parse({ ...parsed, description: 'x'.repeat(301) }), /300 characters/);
});

test('takeaway orders accept no table and a fixed container charge', () => {
  const parsed = orderDraftSchema.parse({
    tableId: null, orderType: 'TAKEAWAY', containerCharge: 12.5,
    items: [{ menuItemId: '123e4567-e89b-12d3-a456-426614174000', quantity: 1, addonOptionIds: [] }],
    discountValue: 0, notes: 'Pack separately',
  });
  assert.equal(parsed.orderType, 'TAKEAWAY');
  assert.equal(parsed.tableId, null);
  assert.equal(parsed.containerCharge, 12.5);
});

test('order draft rejects invalid order type and imprecise container charge', () => {
  const baseDraft = { tableId: null, orderType: 'TAKEAWAY', items: [{ menuItemId: '123e4567-e89b-12d3-a456-426614174000', quantity: 1, addonOptionIds: [] }] };
  assert.throws(() => orderDraftSchema.parse({ ...baseDraft, orderType: 'DELIVERY' }));
  assert.throws(() => orderDraftSchema.parse({ ...baseDraft, containerCharge: 1.999 }), /two decimal places/);
});

test('container charge GST settings are validated and default to five percent', () => {
  const defaults = restaurantSettingsSchema.parse({ name: 'Coffea', gstin: '', address: '', phone: '', billPrefix: 'COF' });
  assert.equal(defaults.containerChargeGstRate, 5);
  assert.equal(restaurantSettingsSchema.parse({ name: 'Coffea', gstin: '', address: '', phone: '', billPrefix: 'COF', containerChargeGstRate: 12 }).containerChargeGstRate, 12);
  assert.throws(() => restaurantSettingsSchema.parse({ name: 'Coffea', gstin: '', address: '', phone: '', billPrefix: 'COF', containerChargeGstRate: 1.999 }), /two decimal places/);
});


test('order draft accepts customer details for persistence before KOT or bill actions', () => {
  const parsed = orderDraftSchema.parse({
    tableId: '123e4567-e89b-12d3-a456-426614174000', orderType: 'DINE_IN',
    items: [{ menuItemId: '123e4567-e89b-12d3-a456-426614174000', quantity: 1, addonOptionIds: [] }],
    customerName: 'Aarav Sharma', customerMobile: '9876543210',
  });
  assert.equal(parsed.customerName, 'Aarav Sharma');
  assert.equal(parsed.customerMobile, '9876543210');
});

test('order draft leaves customer fields undefined when an older terminal does not send them', () => {
  const parsed = orderDraftSchema.parse({
    tableId: '123e4567-e89b-12d3-a456-426614174000', orderType: 'DINE_IN',
    items: [{ menuItemId: '123e4567-e89b-12d3-a456-426614174000', quantity: 1, addonOptionIds: [] }],
  });
  assert.equal(parsed.customerName, undefined);
  assert.equal(parsed.customerMobile, undefined);
});


test('bill print leaves customer fields undefined when a legacy terminal omits them', () => {
  const parsed = billPrintSchema.parse({ expectedRevision: 4 });
  assert.equal(parsed.customerName, undefined);
  assert.equal(parsed.customerMobile, undefined);
});


test('DirectQR customer registration requires an account profile and server CAPTCHA', () => {
  const parsed = publicCustomerRegisterSchema.parse({
    displayName: 'Aarav Sharma', username: 'aarav.sharma', phone: '9876543210', password: 'CafePass@1',
    captchaId: '123e4567-e89b-12d3-a456-426614174000', captchaAnswer: '12',
  });
  assert.equal(parsed.username, 'aarav.sharma');
  assert.equal(parsed.phone, '9876543210');
  assert.throws(() => publicCustomerRegisterSchema.parse({ ...parsed, captchaId: undefined }));
});

test('DirectQR order payload requires an opaque table token and valid menu lines', () => {
  const parsed = publicQrOrderSchema.parse({
    slug: 'coffea-demo', tableToken: '1a2b3c4d5e6f7890a1b2c3d4e5f60718', guestCount: 2, notes: 'Less sugar',
    items: [{ menuItemId: '123e4567-e89b-12d3-a456-426614174000', quantity: 2, addonOptionIds: [] }],
  });
  assert.equal(parsed.slug, 'coffea-demo');
  assert.equal(parsed.guestCount, 2);
  assert.throws(() => publicQrOrderSchema.parse({ ...parsed, tableToken: 'T1' }), /Invalid table QR/);
});
