export const SETUP_TASKS = [
  { key: 'BASICS', label: 'Restaurant basics saved', mode: 'AUTOMATIC' },
  { key: 'OWNER_ACCOUNT', label: 'Owner account created', mode: 'AUTOMATIC' },
  { key: 'MENU', label: 'Menu configured', mode: 'AUTOMATIC' },
  { key: 'TABLES', label: 'Tables configured', mode: 'AUTOMATIC' },
  { key: 'GST_BILLING', label: 'GST and bill details reviewed', mode: 'MANUAL' },
  { key: 'PRINTER_TEST', label: 'Printer test completed', mode: 'MANUAL' },
  { key: 'QR_SETUP', label: 'DirectQR test order accepted, printed and settled', mode: 'MANUAL' },
  { key: 'STAFF_TRAINING', label: 'Staff training completed', mode: 'MANUAL' },
  { key: 'GO_LIVE', label: 'Go-live confirmed', mode: 'MANUAL' },
  { key: 'OWNER_PASSWORD_CHANGED', label: 'Owner changed temporary password', mode: 'AUTOMATIC' },
];

export const AUTOMATIC_SETUP_TASK_KEYS = new Set(
  SETUP_TASKS.filter((task) => task.mode === 'AUTOMATIC').map((task) => task.key),
);

export const MANUAL_SETUP_TASK_KEYS = new Set(
  SETUP_TASKS.filter((task) => task.mode === 'MANUAL').map((task) => task.key),
);

/**
 * Normalize PostgreSQL DATE strings and Date objects to an ISO calendar date.
 * Date inputs only accept YYYY-MM-DD, so never return a locale-formatted value.
 */
export function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function parseDateParts(value) {
  const normalized = dateOnly(value);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addCalendarYears(value, years = 1) {
  const parts = parseDateParts(value);
  if (!parts) return null;
  const year = parts.year + years;
  return formatDate({ year, month: parts.month, day: Math.min(parts.day, daysInMonth(year, parts.month)) });
}

export function addCalendarMonths(value, months = 1) {
  const parts = parseDateParts(value);
  if (!parts) return null;
  const absoluteMonth = (parts.year * 12) + (parts.month - 1) + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  return formatDate({ year, month, day: Math.min(parts.day, daysInMonth(year, month)) });
}

export function addCalendarDays(value, days = 1) {
  const parts = parseDateParts(value);
  if (!parts) return null;
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatDate({ year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate() });
}

export function currentDateInTimeZone(timeZone = 'Asia/Kolkata', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isDateBefore(left, right) {
  const a = dateOnly(left);
  const b = dateOnly(right);
  return Boolean(a && b && a < b);
}

export function isDateOnOrAfter(left, right) {
  const a = dateOnly(left);
  const b = dateOnly(right);
  return Boolean(a && b && a >= b);
}

export function isSetupReady(taskRows) {
  const completed = new Map((taskRows || []).map((task) => [task.task_key || task.key, Boolean(task.is_completed ?? task.isCompleted)]));
  return SETUP_TASKS.every((task) => completed.get(task.key) === true);
}

/**
 * Calculate dates from commercial inputs. Read-only end/due fields are always
 * derived here on the server; browser-calculated values are never trusted.
 */
export function commercialSchedule(payload) {
  const baseStatus = payload.basePaymentStatus || 'NOT_PAID';
  const supportStatus = payload.supportPaymentStatus || 'NOT_STARTED';
  const qrStatus = payload.qrOrderingPaymentStatus || 'NOT_PURCHASED';

  const baseStart = baseStatus === 'NOT_PAID' ? null : dateOnly(payload.baseLicenseStartDate);
  const supportStartInput = supportStatus === 'NOT_STARTED' ? null : dateOnly(payload.supportStartDate);
  const supportLastPaymentInput = supportStatus === 'NOT_STARTED' ? null : dateOnly(payload.supportLastPaymentDate);
  const supportAnchor = supportLastPaymentInput || supportStartInput;
  const qrStart = qrStatus === 'NOT_PURCHASED' ? null : dateOnly(payload.qrOrderingStartDate);

  return {
    baseLicenseStartDate: baseStart,
    baseLicenseEndDate: baseStatus === 'NOT_PAID'
      ? null
      : (baseStatus === 'PAID' && baseStart ? addCalendarYears(baseStart, 1) : dateOnly(payload.baseLicenseEndDate)),
    supportStartDate: supportStatus === 'NOT_STARTED'
      ? null
      : (supportStartInput || supportAnchor),
    supportLastPaymentDate: supportStatus === 'NOT_STARTED'
      ? null
      : supportAnchor,
    supportNextPaymentDue: supportStatus === 'NOT_STARTED'
      ? null
      : (supportAnchor ? addCalendarMonths(supportAnchor, 1) : dateOnly(payload.supportNextPaymentDue)),
    qrOrderingStartDate: qrStart,
    qrOrderingEndDate: qrStatus === 'NOT_PURCHASED'
      ? null
      : (qrStatus === 'PAID' && qrStart ? addCalendarYears(qrStart, 1) : dateOnly(payload.qrOrderingEndDate)),
  };
}

/**
 * Derive the effective commercial state on every read. This intentionally does
 * not require a cron job: a due/expired state is accurate whenever an outlet,
 * owner session, or DirectQR page is opened.
 */
export function commercialLifecycle(payload, { today = currentDateInTimeZone(payload?.timezone || 'Asia/Kolkata') } = {}) {
  const scheduled = commercialSchedule(payload || {});
  const normalizedToday = dateOnly(today) || currentDateInTimeZone(payload?.timezone || 'Asia/Kolkata');

  let basePaymentStatus = payload?.basePaymentStatus || 'NOT_PAID';
  if (['DUE_SOON', 'OVERDUE'].includes(basePaymentStatus)) basePaymentStatus = scheduled.baseLicenseStartDate ? 'PAID' : 'NOT_PAID';
  if (basePaymentStatus === 'PAID' && scheduled.baseLicenseEndDate && isDateOnOrAfter(normalizedToday, scheduled.baseLicenseEndDate)) {
    basePaymentStatus = 'EXPIRED';
  }

  let supportPaymentStatus = payload?.supportPaymentStatus || 'NOT_STARTED';
  if (['DUE_SOON', 'EXPIRED'].includes(supportPaymentStatus)) supportPaymentStatus = scheduled.supportLastPaymentDate ? 'PAID' : 'NOT_STARTED';
  if (['PAID', 'DUE', 'OVERDUE'].includes(supportPaymentStatus) && scheduled.supportNextPaymentDue) {
    if (normalizedToday < scheduled.supportNextPaymentDue) {
      supportPaymentStatus = 'PAID';
    } else if (normalizedToday < addCalendarDays(scheduled.supportNextPaymentDue, 7)) {
      supportPaymentStatus = 'DUE';
    } else {
      supportPaymentStatus = 'OVERDUE';
    }
  }

  let qrOrderingPaymentStatus = payload?.qrOrderingPaymentStatus || 'NOT_PURCHASED';
  if (['DUE_SOON', 'OVERDUE'].includes(qrOrderingPaymentStatus)) qrOrderingPaymentStatus = scheduled.qrOrderingStartDate ? 'PAID' : 'NOT_PURCHASED';
  if (qrOrderingPaymentStatus === 'PAID' && scheduled.qrOrderingEndDate && isDateOnOrAfter(normalizedToday, scheduled.qrOrderingEndDate)) {
    qrOrderingPaymentStatus = 'EXPIRED';
  }

  const baseIsCurrent = basePaymentStatus === 'PAID'
    && Boolean(scheduled.baseLicenseStartDate && scheduled.baseLicenseEndDate)
    && normalizedToday < scheduled.baseLicenseEndDate;
  const supportIsCurrent = supportPaymentStatus === 'PAID'
    && Boolean(scheduled.supportLastPaymentDate && scheduled.supportNextPaymentDue)
    && normalizedToday < scheduled.supportNextPaymentDue;
  const qrIsCurrent = qrOrderingPaymentStatus === 'PAID'
    && Boolean(scheduled.qrOrderingStartDate && scheduled.qrOrderingEndDate)
    && normalizedToday < scheduled.qrOrderingEndDate;
  const qrLegacyAccess = Boolean(payload?.directQrOrdering)
    && !scheduled.qrOrderingStartDate
    && !scheduled.qrOrderingEndDate;

  return {
    ...scheduled,
    today: normalizedToday,
    basePaymentStatus,
    supportPaymentStatus,
    qrOrderingPaymentStatus,
    baseIsCurrent,
    supportIsCurrent,
    qrIsCurrent,
    qrEligible: qrIsCurrent,
    qrLegacyAccess,
  };
}
