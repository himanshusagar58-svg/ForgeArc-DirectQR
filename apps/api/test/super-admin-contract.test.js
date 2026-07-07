import test from 'node:test';
import assert from 'node:assert/strict';
import {
  superAdminCreateRestaurantSchema,
  superAdminCommercialSchema,
} from '../src/validators.js';

test('Super Admin restaurant creation accepts only onboarding identity fields', () => {
  const parsed = superAdminCreateRestaurantSchema.parse({
    name: 'Coffea Bareilly',
    slug: '',
    ownerDisplayName: 'Coffea Owner',
    ownerUsername: 'coffea.owner',
    basePaymentStatus: 'PAID',
    directQrOrdering: true,
  });
  assert.deepEqual(parsed, {
    name: 'Coffea Bareilly',
    slug: '',
    ownerDisplayName: 'Coffea Owner',
    ownerUsername: 'coffea.owner',
  });
});

test('Super Admin commercial schema turns blank browser date inputs into null', () => {
  const parsed = superAdminCommercialSchema.parse({
    basePaymentStatus: 'NOT_PAID',
    baseLicenseStartDate: '',
    baseLicenseEndDate: '',
    supportPaymentStatus: 'NOT_STARTED',
    supportStartDate: '',
    supportLastPaymentDate: '',
    supportNextPaymentDue: '',
    directQrOrdering: false,
    qrOrderingPaymentStatus: 'NOT_PURCHASED',
    qrOrderingStartDate: '',
    qrOrderingEndDate: '',
  });
  assert.equal(parsed.baseLicenseStartDate, null);
  assert.equal(parsed.supportLastPaymentDate, null);
  assert.equal(parsed.qrOrderingEndDate, null);
});

test('Super Admin commercial schema accepts the derived Support Due state and rejects retired states', () => {
  const due = superAdminCommercialSchema.parse({
    basePaymentStatus: 'NOT_PAID',
    supportPaymentStatus: 'DUE',
    supportStartDate: '2026-07-06',
    supportLastPaymentDate: '2026-07-06',
    supportNextPaymentDue: '2026-08-06',
    directQrOrdering: false,
    qrOrderingPaymentStatus: 'NOT_PURCHASED',
  });
  assert.equal(due.supportPaymentStatus, 'DUE');
  assert.throws(() => superAdminCommercialSchema.parse({ ...due, supportPaymentStatus: 'DUE_SOON' }));
});

test('Super Admin onboarding credentials reject malformed owner usernames', () => {
  assert.throws(() => superAdminCreateRestaurantSchema.parse({
    name: 'Coffea Bareilly',
    slug: 'coffea-bareilly',
    ownerDisplayName: 'Owner',
    ownerUsername: 'not allowed!',
  }));
});

test('setup task SQL explicitly casts the Super Admin actor to UUID', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /CASE WHEN \$3 THEN \$4::uuid ELSE NULL::uuid END/);
});

test('commercial save locks only the restaurant row before reading optional commercial records', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /SELECT operational_status, timezone FROM restaurants WHERE id = \$1 FOR UPDATE/);
  assert.match(source, /SELECT \* FROM restaurant_commercials WHERE restaurant_id = \$1/);
  assert.match(source, /SELECT direct_qr_ordering FROM restaurant_features WHERE restaurant_id = \$1/);
  assert.doesNotMatch(source, /LEFT JOIN restaurant_commercials c ON c\.restaurant_id = r\.id[\s\S]{0,220}WHERE r\.id = \$1 FOR UPDATE/);
});


test('commercial reads expose date-only values and lifecycle-safe date writes', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /TO_CHAR\(c\.base_license_start_date, 'YYYY-MM-DD'\)/);
  assert.match(source, /VALUES \(\$1,\$2,\$3::date,\$4::date/);
});
