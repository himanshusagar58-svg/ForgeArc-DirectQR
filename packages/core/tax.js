function toPaise(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid monetary value.');
    return Math.round((value + Number.EPSILON) * 100);
  }

  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Invalid monetary value.');

  const negative = text.startsWith('-');
  const [wholeRaw, fractionRaw = ''] = (negative ? text.slice(1) : text).split('.');
  const paise = Number(wholeRaw) * 100 + Number((fractionRaw + '00').slice(0, 2));
  return negative ? -paise : paise;
}

function moneyToString(paise) {
  const amount = Math.trunc(paise);
  const negative = amount < 0 ? '-' : '';
  const absolute = Math.abs(amount);
  return `${negative}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function moneyToNumber(paise) {
  return Number(moneyToString(paise));
}

function toRateBasisPoints(rate) {
  const number = Number(rate);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error('Invalid GST rate.');
  return Math.round((number + Number.EPSILON) * 100);
}

function roundDivide(numerator, denominator) {
  if (denominator <= 0) throw new Error('Invalid divisor.');
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function allocateProRata(totalDiscountPaise, lineAmounts) {
  const total = lineAmounts.reduce((sum, amount) => sum + amount, 0);
  if (!total || !totalDiscountPaise) return lineAmounts.map(() => 0);

  const allocations = lineAmounts.map((amount, index) => {
    const numerator = totalDiscountPaise * amount;
    return { index, amount: Math.floor(numerator / total), remainder: numerator % total };
  });

  const allocated = allocations.reduce((sum, item) => sum + item.amount, 0);
  const remaining = totalDiscountPaise - allocated;
  allocations.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) allocations[index].amount += 1;
  allocations.sort((a, b) => a.index - b.index);
  return allocations.map((item) => item.amount);
}

function splitGst(gstPaise) {
  const cgstPaise = Math.floor(gstPaise / 2);
  return { cgstPaise, sgstPaise: gstPaise - cgstPaise };
}

/**
 * Calculate a cart using paise as the source of truth.
 *
 * `options.containerCharge` is a fixed, non-discountable, tax-exclusive
 * operational charge. It is deliberately calculated outside the item discount
 * allocation, while still contributing to taxable value, GST and grand total.
 */
function calculateCart(cart, discountType, rawDiscountValue, options = {}) {
  const prepared = cart.map((item) => {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Invalid quantity.');

    const unitPaise = toPaise(item.unitPrice) + toPaise(item.addonUnitTotal || 0);
    const displayAmountPaise = unitPaise * quantity;
    return {
      ...item,
      quantity,
      unitPaise,
      displayAmountPaise,
      gstRateBps: toRateBasisPoints(item.gstRate),
      gstInclusive: Boolean(item.gstInclusive),
    };
  });

  const menuTotalPaise = prepared.reduce((sum, line) => sum + line.displayAmountPaise, 0);

  let discountPaise = 0;
  if (discountType === 'PERCENT') {
    const percentBps = Math.min(10_000, Math.max(0, Math.round(Number(rawDiscountValue || 0) * 100)));
    discountPaise = roundDivide(menuTotalPaise * percentBps, 10_000);
  } else if (discountType === 'FIXED') {
    discountPaise = Math.min(menuTotalPaise, Math.max(0, toPaise(rawDiscountValue || 0)));
  }

  const discountAllocations = allocateProRata(discountPaise, prepared.map((line) => line.displayAmountPaise));
  const lines = prepared.map((line, index) => {
    const discount = discountAllocations[index];
    const discountedDisplay = line.displayAmountPaise - discount;
    let taxableBeforeDiscount;
    let taxableAfterDiscount;
    let gst;
    let lineTotal;

    if (line.gstInclusive) {
      const divisor = 10_000 + line.gstRateBps;
      taxableBeforeDiscount = roundDivide(line.displayAmountPaise * 10_000, divisor);
      taxableAfterDiscount = roundDivide(discountedDisplay * 10_000, divisor);
      gst = discountedDisplay - taxableAfterDiscount;
      lineTotal = discountedDisplay;
    } else {
      taxableBeforeDiscount = line.displayAmountPaise;
      taxableAfterDiscount = discountedDisplay;
      gst = roundDivide(taxableAfterDiscount * line.gstRateBps, 10_000);
      lineTotal = taxableAfterDiscount + gst;
    }

    const { cgstPaise, sgstPaise } = splitGst(gst);
    return {
      ...line,
      taxableBeforeDiscountPaise: taxableBeforeDiscount,
      taxableAfterDiscountPaise: taxableAfterDiscount,
      discountPaise: discount,
      gstPaise: gst,
      cgstPaise,
      sgstPaise,
      lineTotalPaise: lineTotal,
    };
  });

  const rawContainerCharge = options.containerCharge ?? 0;
  const containerChargePaise = Math.max(0, toPaise(rawContainerCharge));
  const containerGstRateBps = toRateBasisPoints(options.containerGstRate ?? 0);
  const containerGstPaise = containerChargePaise
    ? roundDivide(containerChargePaise * containerGstRateBps, 10_000)
    : 0;
  const { cgstPaise: containerCgstPaise, sgstPaise: containerSgstPaise } = splitGst(containerGstPaise);
  const containerLineTotalPaise = containerChargePaise + containerGstPaise;

  const menuTaxableAmountPaise = lines.reduce((sum, line) => sum + line.taxableAfterDiscountPaise, 0);
  const menuGstAmountPaise = lines.reduce((sum, line) => sum + line.gstPaise, 0);
  const menuCgstAmountPaise = lines.reduce((sum, line) => sum + line.cgstPaise, 0);
  const menuSgstAmountPaise = lines.reduce((sum, line) => sum + line.sgstPaise, 0);
  const menuGrandTotalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);

  const taxableAmountPaise = menuTaxableAmountPaise + containerChargePaise;
  const gstAmountPaise = menuGstAmountPaise + containerGstPaise;
  const cgstAmountPaise = menuCgstAmountPaise + containerCgstPaise;
  const sgstAmountPaise = menuSgstAmountPaise + containerSgstPaise;
  const unroundedGrandTotalPaise = menuGrandTotalPaise + containerLineTotalPaise;
  const grandTotalPaise = Math.round(unroundedGrandTotalPaise / 100) * 100;
  const roundOffPaise = grandTotalPaise - unroundedGrandTotalPaise;

  const totals = {
    subtotalPaise: menuTotalPaise,
    discountAmountPaise: discountPaise,
    taxableAmountPaise,
    gstAmountPaise,
    cgstAmountPaise,
    sgstAmountPaise,
    unroundedGrandTotalPaise,
    roundOffPaise,
    grandTotalPaise,
    containerChargePaise,
    containerGstRateBps,
    containerTaxableAmountPaise: containerChargePaise,
    containerGstPaise,
    containerCgstPaise,
    containerSgstPaise,
    containerLineTotalPaise,
    subtotal: moneyToNumber(menuTotalPaise),
    discountAmount: moneyToNumber(discountPaise),
    taxableAmount: moneyToNumber(taxableAmountPaise),
    gstAmount: moneyToNumber(gstAmountPaise),
    cgstAmount: moneyToNumber(cgstAmountPaise),
    sgstAmount: moneyToNumber(sgstAmountPaise),
    unroundedGrandTotal: moneyToNumber(unroundedGrandTotalPaise),
    roundOff: moneyToNumber(roundOffPaise),
    grandTotal: moneyToNumber(grandTotalPaise),
    containerCharge: moneyToNumber(containerChargePaise),
    containerGstRate: containerGstRateBps / 100,
    containerTaxableAmount: moneyToNumber(containerChargePaise),
    containerGstAmount: moneyToNumber(containerGstPaise),
    containerCgstAmount: moneyToNumber(containerCgstPaise),
    containerSgstAmount: moneyToNumber(containerSgstPaise),
    containerLineTotal: moneyToNumber(containerLineTotalPaise),
  };

  return { lines, totals };
}

export {
  calculateCart,
  moneyToNumber,
  moneyToString,
  toPaise,
  toRateBasisPoints,
};
