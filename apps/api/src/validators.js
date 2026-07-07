import { z } from "zod";
const uuid = z.string().uuid();
const money = z.coerce.number().finite().min(0).max(999999).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, "Amount can have at most two decimal places.");
const positiveMoney = money.refine((value) => value > 0, "Amount must be greater than zero.");
const strongPassword = z.string().min(12, "Password must contain at least 12 characters.").max(128).regex(/[a-z]/, "Password must contain a lowercase letter.").regex(/[A-Z]/, "Password must contain an uppercase letter.").regex(/\d/, "Password must contain a number.").regex(/[^A-Za-z0-9]/, "Password must contain a symbol.");
const username = z.string().trim().toLowerCase().min(3, "Username must contain at least 3 characters.").max(64).regex(/^[A-Za-z0-9._-]+$/, "Username can use letters, numbers, dots, underscores and hyphens only.");
const restaurantLoginId = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{12,32}$/, "Restaurant ID must contain 12\u201332 uppercase letters and numbers only.");
// Keep these optional so older terminals can continue updating an order without
// accidentally clearing stored customer details. Newer terminals always send them.
const optionalCustomerName = z.string().trim().max(120).optional();
const optionalCustomerMobile = z.string().trim().max(32).optional();
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a valid 24-hour time such as 09:00.");
const role = z.enum(["WAITER", "CASHIER", "MANAGER"]);
const permissionKeys = ["view_tables", "create_orders", "send_kot", "print_bill", "settle_payment", "view_reports", "view_customer_details", "edit_menu", "manage_tables", "void_orders", "reprint_bill", "apply_discount"];
const permissionShape = Object.fromEntries(permissionKeys.map((key) => [key, z.boolean().optional()]));
const permissionsSchema = z.object(permissionShape).partial();
const loginSchema = z.object({ restaurantId: restaurantLoginId, username, password: z.string().min(1).max(128), mode: z.enum(["ADMIN", "STAFF"]) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: strongPassword });
const adminAuthorizationSchema = z.object({ adminUsername: username, adminPassword: z.string().min(1).max(128) });
const createStaffSchema = z.object({ displayName: z.string().trim().min(2).max(120), username, password: strongPassword, role: role.default("CASHIER"), permissions: permissionsSchema.optional() });
const updateStaffSchema = z.object({ displayName: z.string().trim().min(2).max(120), username, isActive: z.boolean(), role, permissions: permissionsSchema.optional() });
const resetStaffPasswordSchema = z.object({ password: strongPassword, adminPassword: z.string().min(1).max(128) });
const menuItemSchema = z.object({
  categoryId: uuid,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300, "Description can contain at most 300 characters.").optional().default(''),
  price: money,
  gstRate: z.coerce.number().finite().min(0).max(100).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, "GST rate can have at most two decimal places."),
  gstInclusive: z.boolean().optional().default(false),
  availability: z.enum(["AVAILABLE", "OUT_OF_STOCK", "INACTIVE"]).optional().default("AVAILABLE"),
  addonGroups: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    minSelect: z.coerce.number().int().min(0).max(10).default(0),
    maxSelect: z.coerce.number().int().min(1).max(20).default(20),
    options: z.array(z.object({ name: z.string().trim().min(1).max(100), price: money })).min(1).max(20)
  }).refine((group) => group.minSelect <= group.maxSelect, { message: "Minimum selections cannot exceed maximum selections.", path: ["minSelect"] })).max(1).default([])
});
const categorySchema = z.object({ name: z.string().trim().min(1).max(80), foodType: z.enum(["VEG", "NON_VEG"]).default("VEG"), position: z.coerce.number().int().min(0).max(999).default(0) });
const cartItemSchema = z.object({ menuItemId: uuid, quantity: z.coerce.number().int().min(1).max(99), addonOptionIds: z.array(uuid).max(20).default([]) });
const orderDraftSchema = z.object({
  tableId: uuid.nullable().optional(),
  orderType: z.enum(['DINE_IN', 'TAKEAWAY']).default('DINE_IN'),
  items: z.array(cartItemSchema).min(1).max(100),
  discountType: z.enum(['PERCENT', 'FIXED']).nullable().optional(),
  discountValue: money.default(0),
  containerCharge: money.default(0),
  notes: z.string().trim().max(500).nullable().optional(),
  customerName: optionalCustomerName,
  customerMobile: optionalCustomerMobile,
});
const orderUpdateSchema = orderDraftSchema.extend({ expectedRevision: z.coerce.number().int().min(1) });
const orderActionSchema = z.object({ expectedRevision: z.coerce.number().int().min(1) });
const settleSchema = orderActionSchema.extend({ printBill: z.boolean().default(false), customerName: optionalCustomerName, customerMobile: optionalCustomerMobile, payments: z.array(z.object({ method: z.enum(["CASH", "UPI", "CARD"]), amount: positiveMoney, reference: z.string().trim().max(120).nullable().optional() })).min(1).max(3).superRefine((payments, context) => {
  const methods = payments.map((payment) => payment.method);
  if (new Set(methods).size !== methods.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Use each payment method only once. Combine amounts paid through the same method." });
}) });
const voidOrderSchema = z.object({ expectedRevision: z.coerce.number().int().min(1), reason: z.string().trim().min(3).max(250), voidPassword: z.string().min(1).max(128) });
const updateVoidPasswordSchema = z.object({ adminPassword: z.string().min(1).max(128), newVoidPassword: strongPassword });
const billPrintSchema = orderActionSchema.extend({ customerName: optionalCustomerName, customerMobile: optionalCustomerMobile });
const billReprintSchema = adminAuthorizationSchema;
const dashboardDateSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const dateRangeSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).refine((range) => range.to >= range.from, { message: "The end date cannot be before the start date.", path: ["to"] });
const gstin = z.string().trim().max(40).transform((value) => value.replace(/[\s-]+/g, "").toUpperCase()).refine((value) => !value || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value), "GSTIN must be 15 characters, for example 09ABCDE1234F1Z5.");
const restaurantSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  gstin,
  address: z.string().trim().max(500).default(''),
  phone: z.string().trim().max(30).default(''),
  billPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/, 'Bill prefix can use A–Z, 0–9 and hyphens only.'),
  openingTime: localTime.default('09:00'),
  closingTime: localTime.default('22:00'),
  containerChargeGstRate: z.coerce.number().finite().min(0).max(100).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, 'Container-charge GST can have at most two decimal places.').default(5),
}).refine((value) => value.closingTime > value.openingTime, { message: 'Closing time must be after opening time in V1.', path: ['closingTime'] });
const tableSchema = z.object({ name: z.string().trim().min(1).max(32), position: z.coerce.number().int().min(0).max(999).default(0) });
const superAdminLoginSchema = z.object({ username, password: z.string().min(1).max(128) });
const superAdminRestaurantStatusSchema = z.object({
  operationalStatus: z.enum(['SETUP_PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED']),
});
const optionalDate = z.preprocess((value) => value === '' ? null : value, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid YYYY-MM-DD date.').nullable().optional());
const optionalSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,80}$/, 'Use 2–80 lowercase letters, numbers or hyphens.').optional().or(z.literal(''));
const superAdminCreateRestaurantSchema = z.object({
  name: z.string().trim().min(1, 'Enter the restaurant name.').max(120),
  slug: optionalSlug,
  ownerDisplayName: z.string().trim().min(2, 'Enter the owner name.').max(120),
  ownerUsername: username,
});
const superAdminRestaurantBasicsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,80}$/, 'Use 2–80 lowercase letters, numbers or hyphens.'),
  phone: z.string().trim().max(30).default(''),
  address: z.string().trim().max(500).default(''),
  gstin,
  billPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/, 'Bill prefix can use A–Z, 0–9 and hyphens only.'),
  openingTime: localTime.default('09:00'),
  closingTime: localTime.default('22:00'),
}).refine((value) => value.closingTime > value.openingTime, { message: 'Closing time must be after opening time.', path: ['closingTime'] });
const superAdminCommercialSchema = z.object({
  // DirectQR has one annual licence. QR ordering is the product itself, not a
  // separately purchasable POS add-on.
  basePaymentStatus: z.enum(['NOT_PAID', 'PAID', 'EXPIRED']),
  baseLicenseStartDate: optionalDate,
  baseLicenseEndDate: optionalDate,
  supportPaymentStatus: z.enum(['NOT_STARTED', 'PAID', 'DUE', 'OVERDUE']),
  supportStartDate: optionalDate,
  supportLastPaymentDate: optionalDate,
  supportNextPaymentDue: optionalDate,
  // Compatibility fields are accepted from old screens but are never used as
  // DirectQR access gates.
  directQrOrdering: z.boolean().optional().default(true),
  qrOrderingPaymentStatus: z.enum(['NOT_PURCHASED', 'PAID', 'EXPIRED']).optional().default('NOT_PURCHASED'),
  qrOrderingStartDate: optionalDate,
  qrOrderingEndDate: optionalDate,
});
const superAdminSetupTaskSchema = z.object({
  isCompleted: z.boolean(),
});
const superAdminSupportSessionSchema = z.object({
  scopes: z.array(z.enum(['MENU', 'SETUP'])).min(1).max(2),
  reason: z.string().trim().min(3).max(500),
});
const tableBatchSchema = z.object({ count: z.coerce.number().int().min(1).max(100) });
const publicPassword = z.string().min(8, 'Password must contain at least 8 characters.').max(128);
const publicPhone = z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number.');
const publicCustomerRegisterSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  username,
  phone: publicPhone,
  password: publicPassword,
  captchaId: uuid,
  captchaAnswer: z.string().trim().min(1).max(8),
});
const publicCustomerLoginSchema = z.object({
  username,
  password: z.string().min(1).max(128),
  captchaId: uuid.optional(),
  captchaAnswer: z.string().trim().min(1).max(8).optional(),
});
const publicQrOrderSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,80}$/),
  tableToken: z.string().trim().regex(/^[a-f0-9]{24,64}$/i, 'Invalid table QR.'),
  items: z.array(cartItemSchema).min(1).max(50),
  guestCount: z.coerce.number().int().min(1).max(20).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
const qrRejectSchema = z.object({ reason: z.string().trim().min(3).max(250).optional() });
const staffAddItemsSchema = z.object({
  expectedRevision: z.coerce.number().int().min(1),
  items: z.array(cartItemSchema).min(1).max(50),
  note: z.string().trim().max(300).optional().default(''),
});
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(1000), auth: z.string().min(5).max(1000) }),
});
const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });
export {
  adminAuthorizationSchema,
  billPrintSchema,
  billReprintSchema,
  cartItemSchema,
  categorySchema,
  changePasswordSchema,
  createStaffSchema,
  dashboardDateSchema,
  dateRangeSchema,
  loginSchema,
  menuItemSchema,
  orderActionSchema,
  orderDraftSchema,
  orderUpdateSchema,
  permissionsSchema,
  resetStaffPasswordSchema,
  publicCustomerRegisterSchema,
  publicCustomerLoginSchema,
  publicQrOrderSchema,
  qrRejectSchema,
  staffAddItemsSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
  restaurantSettingsSchema,
  settleSchema,
  strongPassword,
  superAdminCommercialSchema,
  superAdminCreateRestaurantSchema,
  superAdminLoginSchema,
  superAdminRestaurantBasicsSchema,
  superAdminRestaurantStatusSchema,
  superAdminSetupTaskSchema,
  superAdminSupportSessionSchema,
  tableBatchSchema,
  tableSchema,
  updateStaffSchema,
  updateVoidPasswordSchema,
  voidOrderSchema
};
