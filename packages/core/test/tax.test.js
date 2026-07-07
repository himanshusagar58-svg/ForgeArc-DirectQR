import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCart, toPaise } from '../tax.js';

test('before-tax cart calculates tax before final round-off', () => {
  const result = calculateCart([
    { unitPrice: 180, addonUnitTotal: 40, quantity: 1, gstRate: 5, gstInclusive: false },
  ], null, 0);

  assert.equal(result.totals.subtotal, 220);
  assert.equal(result.totals.taxableAmount, 220);
  assert.equal(result.totals.gstAmount, 11);
  assert.equal(result.totals.cgstAmount + result.totals.sgstAmount, 11);
  assert.equal(result.totals.roundOff, 0);
  assert.equal(result.totals.grandTotal, 231);
});

test('nearest rupee round-off is stored separately and uses .50 upward', () => {
  const result = calculateCart([
    { unitPrice: 99.5, addonUnitTotal: 0, quantity: 1, gstRate: 5, gstInclusive: false },
  ], null, 0);

  // ₹99.50 + 5% = ₹104.48, rounded to ₹104.
  assert.equal(result.totals.unroundedGrandTotal, 104.48);
  assert.equal(result.totals.roundOff, -0.48);
  assert.equal(result.totals.grandTotal, 104);

  const fifty = calculateCart([
    { unitPrice: 100.48, addonUnitTotal: 0, quantity: 1, gstRate: 0, gstInclusive: false },
  ], null, 0);
  assert.equal(fifty.totals.unroundedGrandTotal, 100.48);
  assert.equal(fifty.totals.grandTotal, 100);

  const up = calculateCart([
    { unitPrice: 100.5, addonUnitTotal: 0, quantity: 1, gstRate: 0, gstInclusive: false },
  ], null, 0);
  assert.equal(up.totals.unroundedGrandTotal, 100.5);
  assert.equal(up.totals.grandTotal, 101);
  assert.equal(up.totals.roundOff, 0.5);
});

test('discount allocates before GST and retains exact total', () => {
  const result = calculateCart([
    { unitPrice: 100, addonUnitTotal: 0, quantity: 1, gstRate: 5, gstInclusive: false },
    { unitPrice: 100, addonUnitTotal: 0, quantity: 1, gstRate: 5, gstInclusive: false },
  ], 'FIXED', 10);

  assert.equal(result.totals.subtotal, 200);
  assert.equal(result.totals.discountAmount, 10);
  assert.equal(result.totals.taxableAmount, 190);
  assert.equal(result.totals.gstAmount, 9.5);
  assert.equal(result.totals.grandTotal, 200);
  assert.equal(toPaise(result.totals.grandTotal), 20000);
});

test('add-on amounts are included in the before-tax subtotal and final tax', () => {
  const result = calculateCart([
    { unitPrice: 180, addonUnitTotal: 40, quantity: 2, gstRate: 5, gstInclusive: false },
  ], null, 0);

  assert.equal(result.totals.subtotal, 440);
  assert.equal(result.totals.taxableAmount, 440);
  assert.equal(result.totals.gstAmount, 22);
  assert.equal(result.totals.grandTotal, 462);
});

test('fixed discount cannot exceed the before-tax cart subtotal', () => {
  const result = calculateCart([
    { unitPrice: 80, addonUnitTotal: 0, quantity: 1, gstRate: 5, gstInclusive: false },
  ], 'FIXED', 9999);

  assert.equal(result.totals.discountAmount, 80);
  assert.equal(result.totals.taxableAmount, 0);
  assert.equal(result.totals.gstAmount, 0);
  assert.equal(result.totals.grandTotal, 0);
});

test('container charge is non-discountable and its GST is included before round-off', () => {
  const result = calculateCart([
    { unitPrice: 100, addonUnitTotal: 0, quantity: 1, gstRate: 5, gstInclusive: false },
  ], 'FIXED', 10, { containerCharge: 10, containerGstRate: 5 });

  assert.equal(result.totals.discountAmount, 10);
  assert.equal(result.totals.containerCharge, 10);
  assert.equal(result.totals.containerTaxableAmount, 10);
  assert.equal(result.totals.containerGstAmount, 0.5);
  assert.equal(result.totals.containerCgstAmount, 0.25);
  assert.equal(result.totals.containerSgstAmount, 0.25);
  assert.equal(result.totals.taxableAmount, 100);
  assert.equal(result.totals.gstAmount, 5);
  assert.equal(result.totals.grandTotal, 105);
});
