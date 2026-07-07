import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { ZodError } from "zod";
import { query, pool, withTransaction } from "./db.js";
import {
  createSession,
  setSessionCookies,
  clearSessionCookies,
  requireAuth,
  requireCsrf,
  requireRole,
  revokeCurrentSession,
  verifyPassword,
  hashPassword,
  requirePermission,
  hasPermission,
  normalizePermissions,
  defaultPermissions
} from "./auth.js";
import {
  loginSchema,
  changePasswordSchema,
  menuItemSchema,
  categorySchema,
  orderDraftSchema,
  orderUpdateSchema,
  orderActionSchema,
  settleSchema,
  voidOrderSchema,
  billReprintSchema,
  billPrintSchema,
  updateVoidPasswordSchema,
  dateRangeSchema,
  dashboardDateSchema,
  tableSchema,
  restaurantSettingsSchema,
  createStaffSchema,
  updateStaffSchema,
  resetStaffPasswordSchema,
  tableBatchSchema,
  superAdminLoginSchema,
  superAdminCreateRestaurantSchema,
  superAdminRestaurantBasicsSchema,
  superAdminRestaurantStatusSchema,
  superAdminCommercialSchema,
  superAdminSetupTaskSchema,
  superAdminSupportSessionSchema,
  publicCustomerRegisterSchema,
  publicCustomerLoginSchema,
  publicQrOrderSchema,
  qrRejectSchema,
  staffAddItemsSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema
} from "./validators.js";
import {
  saveDraft,
  printKot,
  reprintLatestKot,
  printDraftBill,
  settleOrder,
  reprintBill,
  voidOpenOrder,
  getOrder,
  prepareQrCart,
  acceptQrOrder,
  addStaffItems
} from "./services/orderService.js";
import { openRestaurantEventStream, publishRestaurantEvent } from "./sse.js";
import { pushConfiguration, savePushSubscription, removePushSubscription, notifyRestaurantQrOrder } from './push.js';
import {
  SETUP_TASKS,
  AUTOMATIC_SETUP_TASK_KEYS,
  MANUAL_SETUP_TASK_KEYS,
  dateOnly,
  commercialSchedule,
  commercialLifecycle,
  isSetupReady,
  isDateBefore,
} from "./superAdminLifecycle.js";
import {
  createSuperAdminSession,
  setSuperAdminSessionCookies,
  clearSuperAdminSessionCookies,
  requireSuperAdmin,
  requireSuperAdminCsrf,
  revokeSuperAdminSession,
  superAdminPayload,
  verifySuperAdminPassword,
} from "./superAdminAuth.js";
import {
  createCaptcha,
  verifyCaptcha,
  createCustomerSession,
  setCustomerSessionCookie,
  clearCustomerSessionCookie,
  requireCustomer,
  registerCustomer,
  loginCustomer,
  customerProfile
} from "./customerAuth.js";
const app = express();
const port = Number(process.env.PORT || 4e3);
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = (process.env.APP_ORIGIN || "http://localhost:5173").split(",").map((origin) => origin.trim()).filter(Boolean);
if (isProduction && process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "data:"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      // The app uses a per-restaurant CSS variable for controlled branding.
      // This permits inline style attributes but never inline scripts.
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: []
    }
  } : false,
  crossOriginResourcePolicy: { policy: "same-origin" },
  referrerPolicy: { policy: "no-referrer" }
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "X-CSRF-Token"]
}));
app.use(express.json({ limit: "100kb", strict: true }));
app.use(cookieParser());
app.use(morgan(isProduction ? "combined" : "dev"));
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  limit: 1500,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many requests. Try again later." }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  limit: 80,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body || {};
    return `${ipKeyGenerator(req.ip)}|${String(body.mode || "").toUpperCase()}|${String(body.restaurantId || "").toUpperCase()}|${String(body.username || "").toLowerCase()}`;
  },
  message: { message: "Too many attempts for this sign-in account. Try again later." }
});
const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many password confirmations. Try again later." }
});
app.use("/api", apiLimiter);
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, max-age=0, private");
  res.set("Pragma", "no-cache");
  next();
});
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function audit(client, restaurantId, userId, action, entityType, entityId, metadata = {}) {
  return client.query(
    `INSERT INTO audit_logs (restaurant_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [restaurantId, userId, action, entityType, entityId || null, JSON.stringify(metadata)]
  );
}
function userPayload(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    restaurantId: user.restaurant_id,
    restaurantName: user.restaurant_name,
    restaurantSlug: user.restaurant_slug,
    restaurantLoginId: user.restaurant_login_id,
    themeColor: user.theme_color,
    billPrefix: user.bill_prefix,
    timezone: user.timezone,
    openingTime: user.opening_time ? String(user.opening_time).slice(0, 5) : "09:00",
    closingTime: user.closing_time ? String(user.closing_time).slice(0, 5) : "22:00",
    restaurantStatus: user.operational_status || 'ACTIVE',
    mustChangePassword: Boolean(user.must_change_password),
    features: { directQrOrdering: Boolean(user.direct_qr_ordering) },
    permissions: normalizePermissions(user.role, user.permissions)
  };
}
async function confirmAdminAuthorization(req, { adminUsername, adminPassword }, action) {
  const dummyHash = "$2a$12$pkxgaz2KaQTYwO1cGd/Ue.VQvvhUscqThN1jFord8F1yjw8lu7f72";
  const { rows } = await query(
    `SELECT id, username, display_name, password_hash, is_active
     FROM users
     WHERE restaurant_id = $1 AND lower(username) = lower($2) AND role = 'OWNER'`,
    [req.user.restaurant_id, adminUsername]
  );
  const admin = rows[0];
  const valid = Boolean(admin?.is_active) && await verifyPassword(adminPassword, admin?.password_hash || dummyHash);
  const auditAction = valid ? "ADMIN_ACTION_AUTH_CONFIRMED" : "ADMIN_ACTION_AUTH_FAILED";
  await query(
    `INSERT INTO audit_logs (restaurant_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,'USER',$4,$5::jsonb)`,
    [
      req.user.restaurant_id,
      req.user.id,
      auditAction,
      admin?.id || null,
      JSON.stringify({ action, requestedBy: req.user.username, attemptedAdminUsername: adminUsername, authorizedAdminId: admin?.id || null })
    ]
  ).catch(() => {
  });
  if (!valid) throw Object.assign(new Error("Admin authorization failed."), { status: 403 });
  return admin;
}
async function confirmVoidPassword(req, voidPassword) {
  const { rows } = await query(
    "SELECT void_password_hash FROM restaurants WHERE id = $1",
    [req.user.restaurant_id]
  );
  const hash = rows[0]?.void_password_hash;
  const valid = Boolean(hash) && await verifyPassword(voidPassword, hash);
  await query(
    `INSERT INTO audit_logs (restaurant_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,'RESTAURANT',$1,$4::jsonb)`,
    [req.user.restaurant_id, req.user.id, valid ? "VOID_PASSWORD_CONFIRMED" : "VOID_PASSWORD_FAILED", JSON.stringify({ requestedBy: req.user.username })]
  ).catch(() => {
  });
  if (!valid) throw Object.assign(new Error("Void password is incorrect."), { status: 403 });
}
function assertDiscountPermission(req, draft) {
  const hasDiscount = Boolean(draft?.discountType) && Number(draft?.discountValue || 0) > 0;
  if (hasDiscount && !hasPermission(req.user, "apply_discount")) {
    throw Object.assign(new Error("You do not have permission to apply a discount."), { status: 403 });
  }
}

function qrSnapshotFromCalculated(calculated) {
  return calculated.lines.map((line) => ({
    menuItemId: line.menuItemId,
    itemName: line.itemName,
    unitPrice: Number(line.unitPrice),
    gstRate: Number(line.gstRate),
    quantity: Number(line.quantity),
    addons: line.addonsSnapshot || [],
    addonUnitTotal: Number(line.addonUnitTotal || 0),
    lineTotal: Number(line.lineTotalPaise || 0) / 100,
  }));
}
function qrOrderPayload(row) {
  return {
    id: row.id,
    status: row.status,
    tableId: row.table_id,
    tableName: row.table_name,
    customer: { displayName: row.customer_name, username: row.customer_username, phone: row.customer_phone },
    items: typeof row.items_snapshot === 'string' ? JSON.parse(row.items_snapshot) : row.items_snapshot,
    guestCount: row.guest_count == null ? null : Number(row.guest_count),
    notes: row.notes || '',
    subtotal: Number(row.subtotal || 0),
    gstAmount: Number(row.gst_amount || 0),
    grandTotal: Number(row.grand_total || 0),
    rejectionReason: row.rejection_reason || null,
    acceptedOrderId: row.accepted_order_id || null,
    receivedAt: row.created_at,
    processedAt: row.processed_at || null,
  };
}
async function findPublicOrderContext(slug, token) {
  const { rows } = await query(
    `SELECT r.id AS restaurant_id, r.name AS restaurant_name, r.slug, r.theme_color, r.opening_time, r.closing_time,
            d.id AS table_id, d.name AS table_name
     FROM public_table_tokens t
     JOIN restaurants r ON r.id = t.restaurant_id
     JOIN dining_tables d ON d.id = t.table_id
     LEFT JOIN restaurant_commercials c ON c.restaurant_id = r.id
     WHERE r.slug = $1 AND t.token = $2 AND t.is_active = TRUE AND d.is_active = TRUE
       AND r.operational_status IN ('SETUP_PENDING', 'ACTIVE')
       AND (
         -- Setup Pending outlets are allowed to complete their mandatory end-to-end QR test.
         r.operational_status = 'SETUP_PENDING'
         OR (
           c.base_payment_status = 'PAID'
           AND c.base_license_start_date IS NOT NULL
           AND ((now() AT TIME ZONE COALESCE(r.timezone, 'Asia/Kolkata'))::date
                < COALESCE(c.base_license_end_date, (c.base_license_start_date + INTERVAL '1 year')::date))
         )
       )`,
    [slug, token]
  );
  const context = rows[0];
  if (!context) throw Object.assign(new Error('This QR code is invalid or is no longer active. Please ask café staff for help.'), { status: 404 });
  return context;
}
async function publicRecommendationsForRestaurant(restaurantId) {
  // Recommendations are derived only from completed POS orders for this restaurant.
  // Current menu availability is enforced so customers never see unavailable items here.
  const { rows } = await query(
    `SELECT oi.menu_item_id AS item_id, SUM(oi.quantity)::integer AS order_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE o.restaurant_id = $1
       AND o.status = 'COMPLETED'
       AND oi.menu_item_id IS NOT NULL
       AND mi.restaurant_id = $1
       AND mi.is_active = TRUE
       AND mi.availability = 'AVAILABLE'
     GROUP BY oi.menu_item_id
     ORDER BY SUM(oi.quantity) DESC, MAX(o.completed_at) DESC NULLS LAST, oi.menu_item_id
     LIMIT 5`,
    [restaurantId]
  );
  return rows.map((row) => ({ itemId: row.item_id, orderCount: Number(row.order_count || 0) }));
}
async function publicMenuForRestaurant(restaurantId) {
  const { rows: categories } = await query(
    `SELECT id, name, position, food_type FROM categories
     WHERE restaurant_id = $1 AND is_active = TRUE ORDER BY position, name`,
    [restaurantId]
  );
  const { rows: itemRows } = await query(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.gst_rate, mi.gst_inclusive,
            mi.availability, c.food_type
     FROM menu_items mi
     JOIN categories c ON c.id = mi.category_id
     WHERE mi.restaurant_id = $1 AND mi.is_active = TRUE AND mi.availability = 'AVAILABLE'
     ORDER BY mi.name`,
    [restaurantId]
  );
  const itemIds = itemRows.map((row) => row.id);
  const { rows: addonRows } = itemIds.length ? await query(
    `SELECT ag.id AS group_id, ag.menu_item_id, ag.name AS group_name, ag.min_select, ag.max_select, ag.position AS group_position,
            ao.id AS option_id, ao.name AS option_name, ao.price AS option_price, ao.position AS option_position
     FROM addon_groups ag
     JOIN addon_options ao ON ao.addon_group_id = ag.id AND ao.is_active = TRUE
     WHERE ag.menu_item_id = ANY($1::uuid[])
     ORDER BY ag.position, ao.position, ao.name`,
    [itemIds]
  ) : { rows: [] };
  const groupsByItem = new Map();
  for (const row of addonRows) {
    const groups = groupsByItem.get(row.menu_item_id) || new Map();
    if (!groups.has(row.group_id)) groups.set(row.group_id, {
      id: row.group_id, name: row.group_name, minSelect: Number(row.min_select), maxSelect: Number(row.max_select), options: []
    });
    groups.get(row.group_id).options.push({ id: row.option_id, name: row.option_name, price: Number(row.option_price) });
    groupsByItem.set(row.menu_item_id, groups);
  }
  const itemsByCategory = new Map();
  for (const row of itemRows) {
    const items = itemsByCategory.get(row.category_id) || [];
    items.push({
      id: row.id,
      name: row.name,
      description: row.description || '',
      price: Number(row.price),
      gstRate: Number(row.gst_rate),
      gstInclusive: Boolean(row.gst_inclusive),
      availability: row.availability,
      foodType: row.food_type,
      addonGroups: [...(groupsByItem.get(row.id)?.values() || [])],
    });
    itemsByCategory.set(row.category_id, items);
  }
  return categories.map((category) => ({
    id: category.id, name: category.name, foodType: category.food_type,
    items: itemsByCategory.get(category.id) || []
  })).filter((category) => category.items.length > 0);
}
app.get("/api/health", asyncHandler(async (_req, res) => {
  await query("SELECT 1");
  res.json({ status: "ok", time: (/* @__PURE__ */ new Date()).toISOString() });
}));
app.post("/api/auth/login", authLimiter, asyncHandler(async (req, res) => {
  const { restaurantId, username, password, mode } = loginSchema.parse(req.body);
  const roleCondition = mode === "ADMIN" ? "u.role = 'OWNER'" : "u.role IN ('CASHIER', 'MANAGER', 'WAITER')";
  const { rows } = await query(
    `SELECT u.*, r.name AS restaurant_name, r.slug AS restaurant_slug, r.login_id AS restaurant_login_id,
            r.theme_color, r.bill_prefix, r.timezone, r.opening_time, r.closing_time, r.operational_status,
            TRUE AS direct_qr_ordering
     FROM users u
     JOIN restaurants r ON r.id = u.restaurant_id
     WHERE r.login_id = $1 AND lower(u.username) = lower($2) AND ${roleCondition}`,
    [restaurantId, username]
  );
  const user = rows[0];
  const dummyHash = "$2a$12$pkxgaz2KaQTYwO1cGd/Ue.VQvvhUscqThN1jFord8F1yjw8lu7f72";
  if (user?.is_active && ['SUSPENDED', 'DISABLED'].includes(user.operational_status)) {
    return res.status(403).json({ message: "This restaurant is currently unavailable. Contact DirectQR Support." });
  }
  if (user?.password_reset_required && user.is_active) {
    return res.status(423).json({
      message: "This staff account requires an Admin password reset before it can sign in.",
      passwordResetRequired: true
    });
  }
  const lockedUntilMs = user?.locked_until ? new Date(user.locked_until).getTime() : 0;
  if (user?.is_active && lockedUntilMs > Date.now()) {
    return res.status(423).json({
      message: "This sign-in account is temporarily locked. Try again when the timer ends.",
      lockoutUntil: user.locked_until,
      passwordResetRequired: false
    });
  }
  const valid = Boolean(user?.is_active) && await verifyPassword(password, user?.password_hash || dummyHash);
  if (!valid) {
    if (user?.is_active) {
      const now = Date.now();
      const started = user.login_failure_window_started_at ? new Date(user.login_failure_window_started_at).getTime() : 0;
      const priorFailures = !started || now - started > 24 * 60 * 60 * 1e3 ? 0 : Number(user.failed_login_count || 0);
      const failures = priorFailures + 1;
      let lockoutMinutes = 0;
      let resetRequired = false;
      if (mode === "STAFF") {
        if (failures === 5) lockoutMinutes = 15;
        else if (failures >= 6 && failures <= 9) lockoutMinutes = 30;
        else if (failures >= 10) resetRequired = true;
      } else if (failures % 5 === 0) {
        lockoutMinutes = 15;
      }
      const { rows: updatedRows } = await query(
        `UPDATE users
         SET failed_login_count = $2,
             login_failure_window_started_at = CASE WHEN $3 THEN now() ELSE COALESCE(login_failure_window_started_at, now()) END,
             locked_until = CASE WHEN $4::int > 0 THEN now() + ($4::text || ' minutes')::interval ELSE NULL END,
             password_reset_required = $5,
             updated_at = now()
         WHERE id = $1
         RETURNING locked_until, password_reset_required`,
        [user.id, failures, !started || now - started > 24 * 60 * 60 * 1e3, lockoutMinutes, resetRequired]
      );
      const updated = updatedRows[0];
      if (resetRequired) {
        return res.status(423).json({ message: "This staff account now requires an Admin password reset.", passwordResetRequired: true });
      }
      if (lockoutMinutes) {
        return res.status(423).json({
          message: `Too many incorrect sign-in attempts. This account is locked for ${lockoutMinutes} minutes.`,
          lockoutUntil: updated.locked_until,
          passwordResetRequired: false
        });
      }
    }
    return res.status(401).json({ message: "Incorrect sign-in details." });
  }
  await query(
    `UPDATE users
     SET last_login_at = now(), failed_login_count = 0, locked_until = NULL,
         login_failure_window_started_at = NULL, password_reset_required = FALSE, updated_at = now()
     WHERE id = $1`,
    [user.id]
  );
  const session = await createSession(user);
  setSessionCookies(res, session);
  return res.json({ user: userPayload(user) });
}));
app.post("/api/auth/change-password", requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  const { rows } = await query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!rows[0] || !await verifyPassword(currentPassword, rows[0].password_hash)) {
    return res.status(400).json({ message: "Current password is incorrect." });
  }
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users
       SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
           login_failure_window_started_at = NULL, password_reset_required = FALSE,
           must_change_password = FALSE, updated_at = now()
       WHERE id = $1`,
      [req.user.id, passwordHash]
    );
    await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.user.id]);
    await audit(client, req.user.restaurant_id, req.user.id, "PASSWORD_CHANGED", "USER", req.user.id);
    if (req.user.role === 'OWNER') {
      // This is deliberately automatic. The Super Admin cannot manually mark a
      // temporary credential as changed; only a successful owner password change can.
      await upsertSetupTask(client, {
        restaurantId: req.user.restaurant_id,
        taskKey: 'OWNER_PASSWORD_CHANGED',
        isCompleted: true,
        superAdminId: null,
      });
      await synchronizeSetupReadiness(client, req.user.restaurant_id, null);
    }
  });
  clearSessionCookies(res);
  res.status(204).end();
}));
app.post("/api/auth/logout", requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  await revokeCurrentSession(req.user.session_id);
  clearSessionCookies(res);
  res.status(204).end();
}));
app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: userPayload(req.user) });
});

// v1.7.3 Super Admin. Super Admin sessions are deliberately separate from outlet
// staff sessions so support work never needs an owner's credentials.
function formValidationError(message, details) {
  return Object.assign(new Error(message), { status: 400, details });
}

function validationDetail(path, message) {
  return { path, message };
}

function slugifyRestaurantName(name) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return base || 'restaurant';
}

async function uniqueRestaurantSlug(candidate, client = null) {
  const runner = client || { query };
  const base = slugifyRestaurantName(candidate);
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const slug = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    const { rows } = await runner.query('SELECT 1 FROM restaurants WHERE slug = $1', [slug]);
    if (!rows[0]) return slug;
  }
  throw Object.assign(new Error('Could not generate a unique restaurant URL slug.'), { status: 409 });
}

async function assertRequestedRestaurantSlugIsAvailable(slug, client) {
  const { rows } = await client.query('SELECT 1 FROM restaurants WHERE slug = $1', [slug]);
  if (rows[0]) {
    throw formValidationError('Review the highlighted restaurant details.', [
      validationDetail('slug', 'This DirectQR slug is already in use. Choose another one.'),
    ]);
  }
}

async function uniqueDirectQrRestaurantId(client) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `DQR${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows } = await client.query('SELECT 1 FROM restaurants WHERE login_id = $1', [code]);
    if (!rows[0]) return code;
  }
  throw Object.assign(new Error('Could not generate a unique DirectQR Restaurant ID.'), { status: 503 });
}

function temporaryPassword() {
  // Always contains upper/lowercase, a number and a symbol. It is returned once
  // to the Super Admin UI and is never written to audit logs or stored in plain text.
  return `Fa!${crypto.randomBytes(10).toString('base64url')}9Z`;
}

async function upsertSetupTask(client, { restaurantId, taskKey, isCompleted, superAdminId = null }) {
  await client.query(
    `INSERT INTO restaurant_setup_tasks
       (restaurant_id, task_key, is_completed, completed_at, completed_by_super_admin_id)
     VALUES ($1,$2,$3,
       CASE WHEN $3 THEN now() ELSE NULL END,
       CASE WHEN $3 THEN $4::uuid ELSE NULL::uuid END)
     ON CONFLICT (restaurant_id, task_key) DO UPDATE SET
       is_completed = EXCLUDED.is_completed,
       completed_at = CASE
         WHEN restaurant_setup_tasks.is_completed IS DISTINCT FROM EXCLUDED.is_completed
         THEN EXCLUDED.completed_at
         ELSE restaurant_setup_tasks.completed_at
       END,
       completed_by_super_admin_id = CASE
         WHEN restaurant_setup_tasks.is_completed IS DISTINCT FROM EXCLUDED.is_completed
         THEN EXCLUDED.completed_by_super_admin_id
         ELSE restaurant_setup_tasks.completed_by_super_admin_id
       END`,
    [restaurantId, taskKey, Boolean(isCompleted), superAdminId],
  );
}

async function synchronizeSetupReadiness(client, restaurantId, superAdminId = null) {
  const { rows } = await client.query(
    `SELECT r.id, r.operational_status, r.name, r.slug, r.phone, r.address, r.bill_prefix,
            r.opening_time, r.closing_time,
            EXISTS(SELECT 1 FROM users u WHERE u.restaurant_id = r.id AND u.role = 'OWNER') AS has_owner,
            EXISTS(SELECT 1 FROM categories c WHERE c.restaurant_id = r.id AND c.is_active = TRUE) AS has_category,
            EXISTS(SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.is_active = TRUE) AS has_menu_item,
            EXISTS(SELECT 1 FROM dining_tables d WHERE d.restaurant_id = r.id AND d.is_active = TRUE) AS has_table
     FROM restaurants r WHERE r.id = $1 FOR UPDATE`,
    [restaurantId],
  );
  const restaurant = rows[0];
  if (!restaurant) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });

  const automaticStates = {
    BASICS: Boolean(restaurant.name && restaurant.slug && restaurant.phone && restaurant.address && restaurant.bill_prefix && restaurant.opening_time && restaurant.closing_time),
    OWNER_ACCOUNT: Boolean(restaurant.has_owner),
    MENU: Boolean(restaurant.has_category && restaurant.has_menu_item),
    TABLES: Boolean(restaurant.has_table),
  };
  for (const [taskKey, isCompleted] of Object.entries(automaticStates)) {
    await upsertSetupTask(client, { restaurantId, taskKey, isCompleted, superAdminId });
  }

  const { rows: tasks } = await client.query(
    `SELECT task_key, is_completed, completed_at FROM restaurant_setup_tasks WHERE restaurant_id = $1`,
    [restaurantId],
  );
  const ready = isSetupReady(tasks);
  let activated = false;
  if (restaurant.operational_status === 'SETUP_PENDING' && ready) {
    await client.query(
      `UPDATE restaurants SET operational_status = 'ACTIVE', updated_at = now() WHERE id = $1`,
      [restaurantId],
    );
    activated = true;
    if (superAdminId) {
      await writeSuperAdminAudit(client, superAdminId, restaurantId, 'RESTAURANT_AUTO_ACTIVATED', 'RESTAURANT', restaurantId, {
        after: { operationalStatus: 'ACTIVE' },
        metadata: { source: 'setup-checklist-complete' },
      });
    }
  }
  return { tasks, ready, activated };
}

function setupSummary(taskRows) {
  const byKey = new Map(taskRows.map((task) => [task.task_key || task.key, task]));
  const tasks = SETUP_TASKS.map((definition) => {
    const row = byKey.get(definition.key);
    return {
      key: definition.key,
      label: definition.label,
      mode: definition.mode,
      isCompleted: Boolean(row?.is_completed ?? row?.isCompleted),
      completedAt: row?.completed_at || row?.completedAt || null,
    };
  });
  return {
    completed: tasks.filter((task) => task.isCompleted).length,
    total: tasks.length,
    blockers: tasks.filter((task) => !task.isCompleted).map((task) => task.label),
    tasks,
  };
}

function validateCommercialLifecycle(payload, { timezone = 'Asia/Kolkata' } = {}) {
  const details = [];
  const schedule = commercialSchedule(payload);
  const lifecycle = commercialLifecycle({ ...payload, ...schedule, timezone });

  if (payload.basePaymentStatus === 'PAID' && !schedule.baseLicenseStartDate) {
    details.push(validationDetail('baseLicenseStartDate', 'Select the DirectQR licence start date after marking it paid.'));
  }
  if (isDateBefore(schedule.baseLicenseEndDate, schedule.baseLicenseStartDate)) {
    details.push(validationDetail('baseLicenseEndDate', 'The DirectQR licence end date cannot be before the start date.'));
  }
  if (payload.supportPaymentStatus === 'PAID' && !schedule.supportLastPaymentDate) {
    details.push(validationDetail('supportLastPaymentDate', 'Enter the technical-support payment date after marking support paid.'));
  }
  if (isDateBefore(schedule.supportLastPaymentDate, schedule.supportStartDate)) {
    details.push(validationDetail('supportLastPaymentDate', 'The most recent support payment cannot be before support started.'));
  }
  if (isDateBefore(schedule.supportNextPaymentDue, schedule.supportLastPaymentDate || schedule.supportStartDate)) {
    details.push(validationDetail('supportNextPaymentDue', 'The next support payment date cannot be before the most recent payment.'));
  }

  if (details.length) throw formValidationError('Review the highlighted commercial fields.', details);
  return lifecycle;
}
function commercialPayload(row = {}) {
  const lifecycle = commercialLifecycle({
    timezone: row.timezone || 'Asia/Kolkata',
    basePaymentStatus: row.base_payment_status || 'NOT_PAID',
    baseLicenseStartDate: dateOnly(row.base_license_start_date),
    baseLicenseEndDate: dateOnly(row.base_license_end_date),
    supportPaymentStatus: row.support_payment_status || 'NOT_STARTED',
    supportStartDate: dateOnly(row.support_start_date),
    supportLastPaymentDate: dateOnly(row.support_last_payment_date),
    supportNextPaymentDue: dateOnly(row.support_next_payment_due),
  });
  return {
    productName: 'DirectQR',
    basePackageName: row.base_package_name || 'DirectQR Annual Licence',
    baseLicenseAmount: Number(row.base_license_amount ?? 3000),
    basePaymentCycle: 'YEARLY',
    basePaymentStatus: lifecycle.basePaymentStatus,
    baseLicenseStartDate: lifecycle.baseLicenseStartDate,
    baseLicenseEndDate: lifecycle.baseLicenseEndDate,
    baseIsCurrent: lifecycle.baseIsCurrent,
    supportAmount: Number(row.support_amount ?? 299),
    supportPaymentCycle: 'MONTHLY',
    supportPaymentStatus: lifecycle.supportPaymentStatus,
    supportStartDate: lifecycle.supportStartDate,
    supportLastPaymentDate: lifecycle.supportLastPaymentDate,
    supportNextPaymentDue: lifecycle.supportNextPaymentDue,
    supportIsCurrent: lifecycle.supportIsCurrent,
    commercialToday: lifecycle.today,
  };
}
function validateCommercialLock({ payload, before }) {
  const current = commercialPayload(before);
  const proposed = commercialSchedule(payload);
  const details = [];

  if (current.baseIsCurrent && (
    payload.basePaymentStatus !== 'PAID'
    || dateOnly(proposed.baseLicenseStartDate) !== current.baseLicenseStartDate
    || dateOnly(proposed.baseLicenseEndDate) !== current.baseLicenseEndDate
  )) {
    details.push(validationDetail('basePaymentStatus', 'The current Base Package is locked until it expires.'));
  }

  if (current.supportIsCurrent && (
    payload.supportPaymentStatus !== 'PAID'
    || dateOnly(proposed.supportStartDate) !== current.supportStartDate
    || dateOnly(proposed.supportLastPaymentDate) !== current.supportLastPaymentDate
    || dateOnly(proposed.supportNextPaymentDue) !== current.supportNextPaymentDue
  )) {
    details.push(validationDetail('supportPaymentStatus', 'Technical Support is locked until its next payment due date.'));
  }


  if (details.length) throw formValidationError('Current commercial periods are locked.', details);
}

function restaurantPayload(row, setup = null) {
  const commercial = commercialPayload(row);
  const effectiveDirectQrOrdering = !['SUSPENDED', 'DISABLED'].includes(row.operational_status || 'ACTIVE');
  return {
    id: row.id,
    forgeArcRestaurantId: row.login_id,
    name: row.name,
    slug: row.slug,
    operationalStatus: row.operational_status || 'ACTIVE',
    phone: row.phone || '',
    address: row.address || '',
    gstin: row.gstin || '',
    billPrefix: row.bill_prefix,
    openingTime: row.opening_time ? String(row.opening_time).slice(0, 5) : '09:00',
    closingTime: row.closing_time ? String(row.closing_time).slice(0, 5) : '22:00',
    createdAt: row.created_at || null,
    directQrOrdering: effectiveDirectQrOrdering,
    owner: row.owner_id ? {
      id: row.owner_id,
      username: row.owner_username,
      displayName: row.owner_display_name,
      isActive: Boolean(row.owner_is_active),
      mustChangePassword: Boolean(row.owner_must_change_password),
      lastLoginAt: row.owner_last_login_at || null,
    } : null,
    commercial,
    setup: setup || { completed: 0, total: 0, tasks: [] },
  };
}

async function writeSuperAdminAudit(client, superAdminId, restaurantId, action, entityType, entityId = null, { before = {}, after = {}, metadata = {}, supportSessionId = null } = {}) {
  await client.query(
    `INSERT INTO super_admin_audit_logs
       (super_admin_id, restaurant_id, support_session_id, action, entity_type, entity_id, before_data, after_data, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
    [superAdminId, restaurantId || null, supportSessionId || null, action, entityType, entityId || null, JSON.stringify(before), JSON.stringify(after), JSON.stringify(metadata)],
  );
}

async function listSuperAdminRestaurants() {
  const { rows } = await query(
    `SELECT r.*, f.direct_qr_ordering,
            c.base_package_name, c.base_license_amount, c.base_payment_cycle, c.base_payment_status,
            TO_CHAR(c.base_license_start_date, 'YYYY-MM-DD') AS base_license_start_date,
            TO_CHAR(c.base_license_end_date, 'YYYY-MM-DD') AS base_license_end_date,
            c.support_amount, c.support_payment_cycle, c.support_payment_status,
            TO_CHAR(c.support_start_date, 'YYYY-MM-DD') AS support_start_date,
            TO_CHAR(c.support_last_payment_date, 'YYYY-MM-DD') AS support_last_payment_date,
            TO_CHAR(c.support_next_payment_due, 'YYYY-MM-DD') AS support_next_payment_due,
            c.qr_ordering_amount, c.qr_ordering_payment_cycle, c.qr_ordering_payment_status,
            TO_CHAR(c.qr_ordering_start_date, 'YYYY-MM-DD') AS qr_ordering_start_date,
            TO_CHAR(c.qr_ordering_end_date, 'YYYY-MM-DD') AS qr_ordering_end_date,
            owner.id AS owner_id, owner.username AS owner_username, owner.display_name AS owner_display_name,
            owner.is_active AS owner_is_active, owner.must_change_password AS owner_must_change_password,
            owner.last_login_at AS owner_last_login_at
     FROM restaurants r
     LEFT JOIN restaurant_features f ON f.restaurant_id = r.id
     LEFT JOIN restaurant_commercials c ON c.restaurant_id = r.id
     LEFT JOIN LATERAL (
       SELECT id, username, display_name, is_active, must_change_password, last_login_at
       FROM users WHERE restaurant_id = r.id AND role = 'OWNER'
       ORDER BY created_at ASC LIMIT 1
     ) owner ON TRUE
     ORDER BY r.created_at DESC, r.name ASC`,
  );
  const ids = rows.map((row) => row.id);
  const { rows: tasks } = ids.length ? await query(
    `SELECT restaurant_id, task_key, is_completed, completed_at
     FROM restaurant_setup_tasks WHERE restaurant_id = ANY($1::uuid[])`,
    [ids],
  ) : { rows: [] };
  const taskByRestaurant = new Map();
  for (const task of tasks) {
    const list = taskByRestaurant.get(task.restaurant_id) || [];
    list.push(task);
    taskByRestaurant.set(task.restaurant_id, list);
  }
  return rows.map((row) => restaurantPayload(row, setupSummary(taskByRestaurant.get(row.id) || [])));
}

async function getSuperAdminRestaurant(restaurantId) {
  const { rows } = await query(
    `SELECT r.*, f.direct_qr_ordering,
            c.base_package_name, c.base_license_amount, c.base_payment_cycle, c.base_payment_status,
            TO_CHAR(c.base_license_start_date, 'YYYY-MM-DD') AS base_license_start_date,
            TO_CHAR(c.base_license_end_date, 'YYYY-MM-DD') AS base_license_end_date,
            c.support_amount, c.support_payment_cycle, c.support_payment_status,
            TO_CHAR(c.support_start_date, 'YYYY-MM-DD') AS support_start_date,
            TO_CHAR(c.support_last_payment_date, 'YYYY-MM-DD') AS support_last_payment_date,
            TO_CHAR(c.support_next_payment_due, 'YYYY-MM-DD') AS support_next_payment_due,
            c.qr_ordering_amount, c.qr_ordering_payment_cycle, c.qr_ordering_payment_status,
            TO_CHAR(c.qr_ordering_start_date, 'YYYY-MM-DD') AS qr_ordering_start_date,
            TO_CHAR(c.qr_ordering_end_date, 'YYYY-MM-DD') AS qr_ordering_end_date,
            owner.id AS owner_id, owner.username AS owner_username, owner.display_name AS owner_display_name,
            owner.is_active AS owner_is_active, owner.must_change_password AS owner_must_change_password,
            owner.last_login_at AS owner_last_login_at
     FROM restaurants r
     LEFT JOIN restaurant_features f ON f.restaurant_id = r.id
     LEFT JOIN restaurant_commercials c ON c.restaurant_id = r.id
     LEFT JOIN LATERAL (
       SELECT id, username, display_name, is_active, must_change_password, last_login_at
       FROM users WHERE restaurant_id = r.id AND role = 'OWNER'
       ORDER BY created_at ASC LIMIT 1
     ) owner ON TRUE
     WHERE r.id = $1`,
    [restaurantId],
  );
  const restaurant = rows[0];
  if (!restaurant) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
  const { rows: tasks } = await query(
    `SELECT task_key, is_completed, completed_at
     FROM restaurant_setup_tasks WHERE restaurant_id = $1`,
    [restaurantId],
  );
  const { rows: auditRows } = await query(
    `SELECT l.id, l.action, l.entity_type, l.entity_id, l.metadata, l.created_at,
            a.display_name AS actor_name, s.reason AS support_reason
     FROM super_admin_audit_logs l
     LEFT JOIN super_admin_users a ON a.id = l.super_admin_id
     LEFT JOIN super_admin_support_sessions s ON s.id = l.support_session_id
     WHERE l.restaurant_id = $1
     ORDER BY l.created_at DESC LIMIT 30`,
    [restaurantId],
  );
  return {
    restaurant: restaurantPayload(restaurant, setupSummary(tasks)),
    auditLogs: auditRows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      metadata: row.metadata || {},
      actorName: row.actor_name || 'DirectQR Super Admin',
      supportReason: row.support_reason || null,
      createdAt: row.created_at,
    })),
  };
}

function requireSupportScope(scope) {
  return asyncHandler(async (req, res, next) => {
    const supportSessionId = req.get('x-directqr-support-session');
    const restaurantId = req.params.restaurantId;
    if (!supportSessionId) return res.status(403).json({ message: 'Enter a controlled Support Mode session before making this change.' });
    const { rows } = await query(
      `SELECT id, restaurant_id, scopes, reason, expires_at
       FROM super_admin_support_sessions
       WHERE id = $1 AND super_admin_id = $2 AND restaurant_id = $3
         AND closed_at IS NULL AND expires_at > now()`,
      [supportSessionId, req.superAdmin.id, restaurantId],
    );
    const supportSession = rows[0];
    const scopes = Array.isArray(supportSession?.scopes) ? supportSession.scopes : [];
    if (!supportSession || !scopes.includes(scope)) {
      return res.status(403).json({ message: 'This Support Mode session does not permit that action.' });
    }
    req.supportSession = supportSession;
    return next();
  });
}

async function superAdminMenuPayload(restaurantId) {
  const { rows: categories } = await query(
    `SELECT id, name, position, food_type, is_active FROM categories
     WHERE restaurant_id = $1 ORDER BY is_active DESC, position, name`,
    [restaurantId],
  );
  const { rows: itemRows } = await query(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.gst_rate, mi.gst_inclusive,
            mi.is_active, mi.availability
     FROM menu_items mi
     WHERE mi.restaurant_id = $1
     ORDER BY mi.is_active DESC, mi.name`,
    [restaurantId],
  );
  const itemIds = itemRows.map((row) => row.id);
  const { rows: addonRows } = itemIds.length ? await query(
    `SELECT ag.id AS group_id, ag.menu_item_id, ag.name AS group_name, ag.min_select, ag.max_select, ag.position AS group_position,
            ao.id AS option_id, ao.name AS option_name, ao.price AS option_price, ao.position AS option_position
     FROM addon_groups ag
     JOIN addon_options ao ON ao.addon_group_id = ag.id AND ao.is_active = TRUE
     WHERE ag.menu_item_id = ANY($1::uuid[])
     ORDER BY ag.position, ao.position, ao.name`,
    [itemIds],
  ) : { rows: [] };
  const groupsByItem = new Map();
  for (const row of addonRows) {
    const groupMap = groupsByItem.get(row.menu_item_id) || new Map();
    if (!groupMap.has(row.group_id)) groupMap.set(row.group_id, {
      id: row.group_id,
      name: row.group_name,
      minSelect: Number(row.min_select),
      maxSelect: Number(row.max_select),
      options: [],
    });
    groupMap.get(row.group_id).options.push({ id: row.option_id, name: row.option_name, price: Number(row.option_price) });
    groupsByItem.set(row.menu_item_id, groupMap);
  }
  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      position: Number(category.position || 0),
      foodType: category.food_type,
      isActive: Boolean(category.is_active),
    })),
    items: itemRows.map((item) => ({
      id: item.id,
      categoryId: item.category_id,
      name: item.name,
      description: item.description || '',
      price: Number(item.price),
      gstRate: Number(item.gst_rate),
      gstInclusive: Boolean(item.gst_inclusive),
      isActive: Boolean(item.is_active),
      availability: item.availability,
      addonGroups: [...(groupsByItem.get(item.id)?.values() || [])],
    })),
  };
}

app.post('/api/super-admin/auth/login', authLimiter, asyncHandler(async (req, res) => {
  const { username, password } = superAdminLoginSchema.parse(req.body);
  const { rows } = await query(
    `SELECT id, username, password_hash, display_name, is_active
     FROM super_admin_users WHERE lower(username) = lower($1)`,
    [username],
  );
  const admin = rows[0];
  const dummyHash = '$2a$12$pkxgaz2KaQTYwO1cGd/Ue.VQvvhUscqThN1jFord8F1yjw8lu7f72';
  const valid = Boolean(admin?.is_active) && await verifySuperAdminPassword(password, admin?.password_hash || dummyHash);
  if (!valid) throw Object.assign(new Error('Incorrect Super Admin sign-in details.'), { status: 401 });
  await query('UPDATE super_admin_users SET last_login_at = now(), updated_at = now() WHERE id = $1', [admin.id]);
  const session = await createSuperAdminSession(admin);
  setSuperAdminSessionCookies(res, session);
  res.json({ superAdmin: superAdminPayload(admin) });
}));

app.post('/api/super-admin/auth/logout', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  await revokeSuperAdminSession(req.superAdmin.session_id);
  clearSuperAdminSessionCookies(res);
  res.status(204).end();
}));

app.get('/api/super-admin/auth/me', requireSuperAdmin, (req, res) => {
  res.json({ superAdmin: superAdminPayload(req.superAdmin) });
});

app.get('/api/super-admin/restaurants', requireSuperAdmin, asyncHandler(async (_req, res) => {
  res.json({ restaurants: await listSuperAdminRestaurants() });
}));

app.post('/api/super-admin/restaurants', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const payload = superAdminCreateRestaurantSchema.parse(req.body);
  const result = await withTransaction(async (client) => {
    const slug = payload.slug
      ? payload.slug
      : await uniqueRestaurantSlug(payload.name, client);
    if (payload.slug) await assertRequestedRestaurantSlugIsAvailable(slug, client);
    const loginId = await uniqueDirectQrRestaurantId(client);
    const tempPassword = temporaryPassword();
    const passwordHash = await hashPassword(tempPassword);
    const { rows: restaurantRows } = await client.query(
      `INSERT INTO restaurants (name, slug, login_id, operational_status)
       VALUES ($1,$2,$3,'SETUP_PENDING')
       RETURNING *`,
      [payload.name, slug, loginId],
    );
    const restaurant = restaurantRows[0];
    const { rows: ownerRows } = await client.query(
      `INSERT INTO users (restaurant_id, username, password_hash, display_name, role, permissions, must_change_password)
       VALUES ($1,$2,$3,$4,'OWNER','{}'::jsonb,TRUE)
       RETURNING id, username, display_name, is_active, must_change_password`,
      [restaurant.id, payload.ownerUsername, passwordHash, payload.ownerDisplayName],
    );
    await client.query(
      `INSERT INTO restaurant_features (restaurant_id, direct_qr_ordering, updated_by_super_admin_id)
       VALUES ($1,TRUE,$2)`,
      [restaurant.id, req.superAdmin.id],
    );
    await client.query(
      `INSERT INTO restaurant_commercials (restaurant_id, updated_by_super_admin_id)
       VALUES ($1,$2)`,
      [restaurant.id, req.superAdmin.id],
    );
    for (const task of SETUP_TASKS) {
      await upsertSetupTask(client, {
        restaurantId: restaurant.id,
        taskKey: task.key,
        isCompleted: false,
        superAdminId: null,
      });
    }
    await synchronizeSetupReadiness(client, restaurant.id, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, restaurant.id, 'RESTAURANT_CREATED', 'RESTAURANT', restaurant.id, {
      after: { name: restaurant.name, slug: restaurant.slug, forgeArcRestaurantId: restaurant.login_id, ownerUsername: ownerRows[0].username },
      metadata: { operationalStatus: 'SETUP_PENDING' },
    });
    return { restaurantId: restaurant.id, temporaryPassword: tempPassword };
  });
  const detail = await getSuperAdminRestaurant(result.restaurantId);
  res.status(201).json({ ...detail, temporaryOwnerPassword: result.temporaryPassword });
}));

app.get('/api/super-admin/restaurants/:restaurantId', requireSuperAdmin, asyncHandler(async (req, res) => {
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

async function updateSuperAdminRestaurantBasics({ restaurantId, payload, superAdminId, supportSessionId = null }) {
  return withTransaction(async (client) => {
    const { rows: beforeRows } = await client.query(
      `SELECT name, slug, phone, address, gstin, bill_prefix, opening_time, closing_time
       FROM restaurants WHERE id = $1 FOR UPDATE`,
      [restaurantId],
    );
    const before = beforeRows[0];
    if (!before) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
    const { rows: slugRows } = await client.query(
      `SELECT 1 FROM restaurants WHERE slug = $1 AND id <> $2`,
      [payload.slug, restaurantId],
    );
    if (slugRows[0]) {
      throw formValidationError('Review the highlighted restaurant details.', [
        validationDetail('slug', 'This DirectQR slug is already in use. Choose another one.'),
      ]);
    }
    const { rows } = await client.query(
      `UPDATE restaurants
       SET name = $2, slug = $3, phone = NULLIF($4,''), address = NULLIF($5,''), gstin = NULLIF($6,''),
           bill_prefix = $7, opening_time = $8::time, closing_time = $9::time, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [restaurantId, payload.name, payload.slug, payload.phone, payload.address, payload.gstin, payload.billPrefix, payload.openingTime, payload.closingTime],
    );
    await synchronizeSetupReadiness(client, restaurantId, superAdminId);
    await writeSuperAdminAudit(client, superAdminId, restaurantId, 'RESTAURANT_BASICS_UPDATED', 'RESTAURANT', restaurantId, {
      before: { name: before.name, slug: before.slug, phone: before.phone, address: before.address, gstin: before.gstin, billPrefix: before.bill_prefix },
      after: { name: rows[0].name, slug: rows[0].slug, phone: rows[0].phone, address: rows[0].address, gstin: rows[0].gstin, billPrefix: rows[0].bill_prefix },
      supportSessionId,
    });
    return rows[0];
  });
}

app.put('/api/super-admin/restaurants/:restaurantId/basics', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const payload = superAdminRestaurantBasicsSchema.parse(req.body);
  await updateSuperAdminRestaurantBasics({ restaurantId: req.params.restaurantId, payload, superAdminId: req.superAdmin.id });
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

app.put('/api/super-admin/restaurants/:restaurantId/status', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const { operationalStatus } = superAdminRestaurantStatusSchema.parse(req.body);
  await withTransaction(async (client) => {
    const { rows: beforeRows } = await client.query('SELECT operational_status FROM restaurants WHERE id = $1 FOR UPDATE', [req.params.restaurantId]);
    const currentStatus = beforeRows[0]?.operational_status;
    if (!currentStatus) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
    if (currentStatus === 'SETUP_PENDING') {
      throw Object.assign(new Error('Setup Pending is automatic. Complete the required checklist items to activate this restaurant.'), { status: 400 });
    }
    const allowedTargets = currentStatus === 'ACTIVE'
      ? new Set(['SUSPENDED', 'DISABLED'])
      : new Set(['ACTIVE']);
    if (!allowedTargets.has(operationalStatus)) {
      throw Object.assign(new Error('Active restaurants cannot return to Setup Pending. Use Suspend, Disable, or Reactivate instead.'), { status: 400 });
    }
    await client.query('UPDATE restaurants SET operational_status = $2, updated_at = now() WHERE id = $1', [req.params.restaurantId, operationalStatus]);
    if (['SUSPENDED', 'DISABLED'].includes(operationalStatus)) {
      await client.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id IN (SELECT id FROM users WHERE restaurant_id = $1) AND revoked_at IS NULL`,
        [req.params.restaurantId],
      );
    }
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'RESTAURANT_STATUS_UPDATED', 'RESTAURANT', req.params.restaurantId, {
      before: { operationalStatus: currentStatus },
      after: { operationalStatus },
    });
  });
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

app.put('/api/super-admin/restaurants/:restaurantId/commercial', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const payload = superAdminCommercialSchema.parse(req.body);
  await withTransaction(async (client) => {
    // Lock only the guaranteed restaurant row. PostgreSQL cannot lock nullable
    // LEFT JOIN sides (commercial/features may not exist for legacy rows).
    const { rows: restaurantRows } = await client.query(
      `SELECT operational_status, timezone FROM restaurants WHERE id = $1 FOR UPDATE`,
      [req.params.restaurantId],
    );
    const lockedRestaurant = restaurantRows[0];
    if (!lockedRestaurant) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });

    const { rows: commercialRows } = await client.query(
      `SELECT * FROM restaurant_commercials WHERE restaurant_id = $1`,
      [req.params.restaurantId],
    );
    const { rows: featureRows } = await client.query(
      `SELECT direct_qr_ordering FROM restaurant_features WHERE restaurant_id = $1`,
      [req.params.restaurantId],
    );
    const before = {
      ...lockedRestaurant,
      ...(commercialRows[0] || {}),
      direct_qr_ordering: Boolean(featureRows[0]?.direct_qr_ordering),
    };
    if (before.operational_status === 'SETUP_PENDING') {
      throw Object.assign(new Error('Complete outlet setup before configuring DirectQR commercial access.'), { status: 400 });
    }

    const beforeCommercial = commercialPayload(before);
    validateCommercialLock({ payload, before });
    const lifecycle = validateCommercialLifecycle(payload, {
      timezone: lockedRestaurant.timezone || 'Asia/Kolkata',
    });
    // In this standalone product the annual DirectQR licence is the access
    // entitlement; it is not a second QR add-on switch.
    const effectiveQrEnabled = true;

    await client.query(
      `INSERT INTO restaurant_commercials
         (restaurant_id, base_payment_status, base_license_start_date, base_license_end_date,
          support_payment_status, support_start_date, support_last_payment_date, support_next_payment_due,
          qr_ordering_payment_status, qr_ordering_start_date, qr_ordering_end_date, updated_by_super_admin_id)
       VALUES ($1,$2,$3::date,$4::date,$5,$6::date,$7::date,$8::date,$9,$10::date,$11::date,$12)
       ON CONFLICT (restaurant_id) DO UPDATE SET
         base_payment_status = EXCLUDED.base_payment_status,
         base_license_start_date = EXCLUDED.base_license_start_date,
         base_license_end_date = EXCLUDED.base_license_end_date,
         support_payment_status = EXCLUDED.support_payment_status,
         support_start_date = EXCLUDED.support_start_date,
         support_last_payment_date = EXCLUDED.support_last_payment_date,
         support_next_payment_due = EXCLUDED.support_next_payment_due,
         qr_ordering_payment_status = EXCLUDED.qr_ordering_payment_status,
         qr_ordering_start_date = EXCLUDED.qr_ordering_start_date,
         qr_ordering_end_date = EXCLUDED.qr_ordering_end_date,
         updated_by_super_admin_id = EXCLUDED.updated_by_super_admin_id,
         updated_at = now()`,
      [req.params.restaurantId, lifecycle.basePaymentStatus, lifecycle.baseLicenseStartDate, lifecycle.baseLicenseEndDate,
       lifecycle.supportPaymentStatus, lifecycle.supportStartDate, lifecycle.supportLastPaymentDate, lifecycle.supportNextPaymentDue,
       'NOT_PURCHASED', null, null, req.superAdmin.id],
    );
    await client.query(
      `INSERT INTO restaurant_features (restaurant_id, direct_qr_ordering, updated_by_super_admin_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (restaurant_id) DO UPDATE SET direct_qr_ordering = EXCLUDED.direct_qr_ordering,
         updated_by_super_admin_id = EXCLUDED.updated_by_super_admin_id, updated_at = now()`,
      [req.params.restaurantId, effectiveQrEnabled, req.superAdmin.id],
    );
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'COMMERCIALS_UPDATED', 'RESTAURANT_COMMERCIAL', req.params.restaurantId, {
      before: { directQrOrdering: Boolean(before.direct_qr_ordering), commercial: beforeCommercial },
      after: {
        directQrOrdering: effectiveQrEnabled,
        commercial: {
          ...commercialPayload({ ...before, ...{
            base_payment_status: lifecycle.basePaymentStatus,
            base_license_start_date: lifecycle.baseLicenseStartDate,
            base_license_end_date: lifecycle.baseLicenseEndDate,
            support_payment_status: lifecycle.supportPaymentStatus,
            support_start_date: lifecycle.supportStartDate,
            support_last_payment_date: lifecycle.supportLastPaymentDate,
            support_next_payment_due: lifecycle.supportNextPaymentDue,
            qr_ordering_payment_status: 'NOT_PURCHASED',
            qr_ordering_start_date: null,
            qr_ordering_end_date: null,
            direct_qr_ordering: effectiveQrEnabled,
          } }),
        },
      },
    });
  });
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

app.post('/api/super-admin/restaurants/:restaurantId/owner/reset-password', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, username FROM users
       WHERE restaurant_id = $1 AND role = 'OWNER'
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [req.params.restaurantId],
    );
    const owner = rows[0];
    if (!owner) throw Object.assign(new Error('No owner account exists for this restaurant.'), { status: 404 });
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    await client.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = TRUE, password_reset_required = FALSE,
           failed_login_count = 0, locked_until = NULL, login_failure_window_started_at = NULL, updated_at = now()
       WHERE id = $1`,
      [owner.id, passwordHash],
    );
    await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [owner.id]);
    await upsertSetupTask(client, {
      restaurantId: req.params.restaurantId,
      taskKey: 'OWNER_PASSWORD_CHANGED',
      isCompleted: false,
      superAdminId: req.superAdmin.id,
    });
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'OWNER_PASSWORD_RESET', 'USER', owner.id, {
      metadata: { ownerUsername: owner.username },
    });
    return { password, username: owner.username };
  });
  res.json({ ownerUsername: result.username, temporaryOwnerPassword: result.password });
}));

app.put('/api/super-admin/restaurants/:restaurantId/setup-tasks/:taskKey', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const { isCompleted } = superAdminSetupTaskSchema.parse(req.body);
  const taskKey = String(req.params.taskKey || '').toUpperCase();
  if (!MANUAL_SETUP_TASK_KEYS.has(taskKey)) {
    throw Object.assign(new Error('This checklist task is completed automatically from real restaurant data and cannot be changed manually.'), { status: 400 });
  }
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT operational_status FROM restaurants WHERE id = $1 FOR UPDATE', [req.params.restaurantId]);
    if (!rows[0]) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
    if (rows[0].operational_status !== 'SETUP_PENDING') {
      throw Object.assign(new Error('The onboarding checklist is locked after a restaurant becomes active.'), { status: 400 });
    }
    await upsertSetupTask(client, { restaurantId: req.params.restaurantId, taskKey, isCompleted, superAdminId: req.superAdmin.id });
    const outcome = await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SETUP_TASK_UPDATED', 'SETUP_TASK', null, {
      after: { taskKey, isCompleted, autoActivated: outcome.activated },
    });
  });
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

app.put('/api/super-admin/support/:restaurantId/setup-tasks/:taskKey', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('SETUP'), asyncHandler(async (req, res) => {
  const { isCompleted } = superAdminSetupTaskSchema.parse(req.body);
  const taskKey = String(req.params.taskKey || '').toUpperCase();
  if (!MANUAL_SETUP_TASK_KEYS.has(taskKey)) {
    throw Object.assign(new Error('This checklist task is completed automatically from real restaurant data and cannot be changed manually.'), { status: 400 });
  }
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT operational_status FROM restaurants WHERE id = $1 FOR UPDATE', [req.params.restaurantId]);
    if (!rows[0]) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
    if (rows[0].operational_status !== 'SETUP_PENDING') {
      throw Object.assign(new Error('The onboarding checklist is locked after a restaurant becomes active.'), { status: 400 });
    }
    await upsertSetupTask(client, { restaurantId: req.params.restaurantId, taskKey, isCompleted, superAdminId: req.superAdmin.id });
    const outcome = await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_SETUP_TASK_UPDATED', 'SETUP_TASK', null, {
      after: { taskKey, isCompleted, autoActivated: outcome.activated }, supportSessionId: req.supportSession.id,
    });
  });
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

app.post('/api/super-admin/restaurants/:restaurantId/support-sessions', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const payload = superAdminSupportSessionSchema.parse(req.body);
  const { rows: restaurantRows } = await query('SELECT id, name FROM restaurants WHERE id = $1', [req.params.restaurantId]);
  if (!restaurantRows[0]) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
  const { rows } = await query(
    `INSERT INTO super_admin_support_sessions (super_admin_id, restaurant_id, scopes, reason, expires_at)
     VALUES ($1,$2,$3::jsonb,$4,now() + interval '2 hours')
     RETURNING id, restaurant_id, scopes, reason, started_at, expires_at`,
    [req.superAdmin.id, req.params.restaurantId, JSON.stringify(payload.scopes), payload.reason],
  );
  await withTransaction(async (client) => {
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_MODE_ENTERED', 'SUPPORT_SESSION', rows[0].id, {
      metadata: { scopes: payload.scopes, reason: payload.reason, expiresAt: rows[0].expires_at },
      supportSessionId: rows[0].id,
    });
  });
  res.status(201).json({ supportSession: { id: rows[0].id, restaurantId: rows[0].restaurant_id, scopes: rows[0].scopes, reason: rows[0].reason, startedAt: rows[0].started_at, expiresAt: rows[0].expires_at } });
}));

app.post('/api/super-admin/support-sessions/:supportSessionId/close', requireSuperAdmin, requireSuperAdminCsrf, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE super_admin_support_sessions
     SET closed_at = now()
     WHERE id = $1 AND super_admin_id = $2 AND closed_at IS NULL
     RETURNING id, restaurant_id`,
    [req.params.supportSessionId, req.superAdmin.id],
  );
  if (!rows[0]) throw Object.assign(new Error('Support Mode session not found or already closed.'), { status: 404 });
  await withTransaction(async (client) => {
    await writeSuperAdminAudit(client, req.superAdmin.id, rows[0].restaurant_id, 'SUPPORT_MODE_CLOSED', 'SUPPORT_SESSION', rows[0].id, { supportSessionId: rows[0].id });
  });
  res.status(204).end();
}));

app.put('/api/super-admin/support/:restaurantId/basics', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('SETUP'), asyncHandler(async (req, res) => {
  const payload = superAdminRestaurantBasicsSchema.parse(req.body);
  await updateSuperAdminRestaurantBasics({
    restaurantId: req.params.restaurantId,
    payload,
    superAdminId: req.superAdmin.id,
    supportSessionId: req.supportSession.id,
  });
  res.json(await getSuperAdminRestaurant(req.params.restaurantId));
}));

app.get('/api/super-admin/support/:restaurantId/menu', requireSuperAdmin, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  res.json(await superAdminMenuPayload(req.params.restaurantId));
}));

app.post('/api/super-admin/support/:restaurantId/categories', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  const payload = categorySchema.parse(req.body);
  const category = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO categories (restaurant_id, name, position, food_type)
       VALUES ($1,$2,$3,$4) RETURNING id, name, position, food_type`,
      [req.params.restaurantId, payload.name, payload.position, payload.foodType],
    );
    await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_CATEGORY_CREATED', 'CATEGORY', rows[0].id, {
      after: { name: rows[0].name, foodType: rows[0].food_type }, supportSessionId: req.supportSession.id,
    });
    return rows[0];
  });
  res.status(201).json({ category: { id: category.id, name: category.name, position: Number(category.position || 0), foodType: category.food_type } });
}));

app.put('/api/super-admin/support/:restaurantId/categories/:categoryId', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  const payload = categorySchema.parse(req.body);
  const category = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE categories SET name = $3, position = $4, food_type = $5
       WHERE id = $1 AND restaurant_id = $2 RETURNING id, name, position, food_type`,
      [req.params.categoryId, req.params.restaurantId, payload.name, payload.position, payload.foodType],
    );
    if (!rows[0]) throw Object.assign(new Error('Category not found.'), { status: 404 });
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_CATEGORY_UPDATED', 'CATEGORY', rows[0].id, {
      after: { name: rows[0].name, foodType: rows[0].food_type }, supportSessionId: req.supportSession.id,
    });
    return rows[0];
  });
  res.json({ category: { id: category.id, name: category.name, position: Number(category.position || 0), foodType: category.food_type } });
}));

app.delete('/api/super-admin/support/:restaurantId/categories/:categoryId', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const { rows: itemCount } = await client.query(
      `SELECT COUNT(*)::int AS count FROM menu_items
       WHERE category_id = $1 AND restaurant_id = $2 AND is_active = TRUE`,
      [req.params.categoryId, req.params.restaurantId],
    );
    if (Number(itemCount[0]?.count || 0) > 0) throw Object.assign(new Error('Move or deactivate category items before deleting this category.'), { status: 400 });
    const { rowCount } = await client.query(
      `UPDATE categories SET is_active = FALSE WHERE id = $1 AND restaurant_id = $2`,
      [req.params.categoryId, req.params.restaurantId],
    );
    if (!rowCount) throw Object.assign(new Error('Category not found.'), { status: 404 });
    await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_CATEGORY_DEACTIVATED', 'CATEGORY', req.params.categoryId, { supportSessionId: req.supportSession.id });
  });
  res.status(204).end();
}));

app.post('/api/super-admin/support/:restaurantId/menu-items', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  const payload = menuItemSchema.parse(req.body);
  const item = await withTransaction(async (client) => {
    const created = await writeMenuItem(client, req.params.restaurantId, null, payload);
    await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_MENU_ITEM_CREATED', 'MENU_ITEM', created.id, {
      after: { name: payload.name }, supportSessionId: req.supportSession.id,
    });
    return created;
  });
  res.status(201).json({ item });
}));

app.put('/api/super-admin/support/:restaurantId/menu-items/:itemId', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  const payload = menuItemSchema.parse(req.body);
  const item = await withTransaction(async (client) => {
    const updated = await writeMenuItem(client, req.params.restaurantId, req.params.itemId, payload);
    await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_MENU_ITEM_UPDATED', 'MENU_ITEM', updated.id, {
      after: { name: payload.name }, supportSessionId: req.supportSession.id,
    });
    return updated;
  });
  res.json({ item });
}));

app.delete('/api/super-admin/support/:restaurantId/menu-items/:itemId', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('MENU'), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE menu_items SET is_active = FALSE, availability = 'INACTIVE', updated_at = now()
       WHERE id = $1 AND restaurant_id = $2`,
      [req.params.itemId, req.params.restaurantId],
    );
    if (!rowCount) throw Object.assign(new Error('Menu item not found.'), { status: 404 });
    await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_MENU_ITEM_DEACTIVATED', 'MENU_ITEM', req.params.itemId, { supportSessionId: req.supportSession.id });
  });
  res.status(204).end();
}));

// Setup Support table tooling is intentionally small: during onboarding the
// Super Admin can provision a numbered table set without using an owner account.
app.get('/api/super-admin/support/:restaurantId/tables', requireSuperAdmin, requireSupportScope('SETUP'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, position, is_active
     FROM dining_tables
     WHERE restaurant_id = $1
     ORDER BY is_active DESC, position, name`,
    [req.params.restaurantId],
  );
  res.json({
    tables: rows.map((row) => ({
      id: row.id,
      name: row.name,
      position: Number(row.position || 0),
      isActive: Boolean(row.is_active),
    })),
  });
}));

app.post('/api/super-admin/support/:restaurantId/tables/bulk', requireSuperAdmin, requireSuperAdminCsrf, requireSupportScope('SETUP'), asyncHandler(async (req, res) => {
  const { count } = tableBatchSchema.parse(req.body);
  const tables = await withTransaction(async (client) => {
    const { rows: restaurantRows } = await client.query(
      `SELECT operational_status FROM restaurants WHERE id = $1 FOR UPDATE`,
      [req.params.restaurantId],
    );
    const restaurant = restaurantRows[0];
    if (!restaurant) throw Object.assign(new Error('Restaurant not found.'), { status: 404 });
    if (restaurant.operational_status !== 'SETUP_PENDING') {
      throw Object.assign(new Error('Table setup is locked after the restaurant becomes active. Use the restaurant POS table controls for live changes.'), { status: 400 });
    }
    const { rows: existingRows } = await client.query(
      `SELECT name, position FROM dining_tables WHERE restaurant_id = $1 ORDER BY position, name FOR UPDATE`,
      [req.params.restaurantId],
    );
    const existingNumbers = new Set(existingRows.map((row) => /^T(\d+)$/i.exec(row.name)?.[1]).filter(Boolean).map(Number));
    let nextNumber = 1;
    const maxPosition = existingRows.reduce((max, row) => Math.max(max, Number(row.position || 0)), 0);
    const created = [];
    for (let index = 0; index < count; index += 1) {
      while (existingNumbers.has(nextNumber)) nextNumber += 1;
      const name = `T${nextNumber}`;
      const { rows } = await client.query(
        `INSERT INTO dining_tables (restaurant_id, name, position)
         VALUES ($1,$2,$3)
         RETURNING id, name, position, is_active`,
        [req.params.restaurantId, name, maxPosition + index + 1],
      );
      created.push(rows[0]);
      existingNumbers.add(nextNumber);
      nextNumber += 1;
    }
    await synchronizeSetupReadiness(client, req.params.restaurantId, req.superAdmin.id);
    await writeSuperAdminAudit(client, req.superAdmin.id, req.params.restaurantId, 'SUPPORT_TABLES_CREATED', 'RESTAURANT', req.params.restaurantId, {
      after: { count: created.length, tableNames: created.map((table) => table.name) },
      supportSessionId: req.supportSession.id,
    });
    return created;
  });
  res.status(201).json({
    tables: tables.map((row) => ({ id: row.id, name: row.name, position: Number(row.position || 0), isActive: Boolean(row.is_active) })),
  });
}));

// DirectQR public ordering endpoints. Customer accounts are independent from
// POS staff accounts and use a separate session cookie namespace.
app.get('/api/public/captcha', asyncHandler(async (_req, res) => {
  res.json(await createCaptcha());
}));
app.post('/api/public/customers/register', asyncHandler(async (req, res) => {
  const payload = publicCustomerRegisterSchema.parse(req.body);
  await verifyCaptcha(payload.captchaId, payload.captchaAnswer);
  const customer = await registerCustomer(payload);
  const token = await createCustomerSession(customer.id);
  setCustomerSessionCookie(res, token);
  res.status(201).json({ customer });
}));
app.post('/api/public/customers/login', asyncHandler(async (req, res) => {
  const payload = publicCustomerLoginSchema.parse(req.body);
  // The first release deliberately keeps CAPTCHA on every public sign-in.
  // It avoids a paid OTP provider while making automated account attacks harder.
  await verifyCaptcha(payload.captchaId, payload.captchaAnswer);
  const customer = await loginCustomer(payload);
  const token = await createCustomerSession(customer.id);
  setCustomerSessionCookie(res, token);
  res.json({ customer });
}));
app.get('/api/public/customers/me', requireCustomer, (req, res) => {
  res.json({ customer: customerProfile(req.customer) });
});
app.post('/api/public/customers/logout', requireCustomer, asyncHandler(async (req, res) => {
  await query('UPDATE customer_sessions SET revoked_at = now() WHERE id = $1', [req.customer.session_id]);
  clearCustomerSessionCookie(res);
  res.status(204).end();
}));
app.get('/api/public/order-context/:slug/:token', asyncHandler(async (req, res) => {
  const context = await findPublicOrderContext(String(req.params.slug || '').toLowerCase(), String(req.params.token || ''));
  const [categories, recommendations] = await Promise.all([
    publicMenuForRestaurant(context.restaurant_id),
    publicRecommendationsForRestaurant(context.restaurant_id),
  ]);
  res.json({
    restaurant: {
      name: context.restaurant_name,
      slug: context.slug,
      themeColor: context.theme_color,
      openingTime: String(context.opening_time).slice(0, 5),
      closingTime: String(context.closing_time).slice(0, 5),
    },
    table: { id: context.table_id, name: context.table_name },
    categories,
    recommendations,
  });
}));
app.post('/api/public/qr-orders', requireCustomer, asyncHandler(async (req, res) => {
  const payload = publicQrOrderSchema.parse(req.body);
  const context = await findPublicOrderContext(payload.slug, payload.tableToken);
  const created = await withTransaction(async (client) => {
    const { rows: tableRows } = await client.query(
      `SELECT d.id, d.name
       FROM dining_tables d
       WHERE d.id = $1 AND d.restaurant_id = $2 AND d.is_active = TRUE
       FOR SHARE`,
      [context.table_id, context.restaurant_id]
    );
    if (!tableRows[0]) throw Object.assign(new Error('This table is no longer available for QR ordering.'), { status: 409 });
    const { rows: pending } = await client.query(
      `SELECT id FROM qr_orders
       WHERE table_id = $1 AND customer_id = $2 AND status = 'PENDING'
       FOR UPDATE`,
      [context.table_id, req.customer.id]
    );
    if (pending[0]) throw Object.assign(new Error('You already have an order request waiting for staff at this table. Please wait for it to be accepted or rejected.'), { status: 409 });
    // Existing open table orders are intentionally allowed. On acceptance the
    // request merges into that running table bill instead of replacing it.
    const prepared = await prepareQrCart(client, { restaurantId: context.restaurant_id, items: payload.items });
    const totals = prepared.calculated.totals;
    const { rows } = await client.query(
      `INSERT INTO qr_orders
        (restaurant_id, table_id, customer_id, requested_items, items_snapshot, guest_count, notes,
         subtotal, taxable_amount, cgst_amount, sgst_amount, gst_amount, round_off, grand_total)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, status, created_at`,
      [
        context.restaurant_id, context.table_id, req.customer.id,
        JSON.stringify(payload.items), JSON.stringify(qrSnapshotFromCalculated(prepared.calculated)),
        payload.guestCount || null, payload.notes || null,
        totals.subtotal, totals.taxableAmount, totals.cgstAmount, totals.sgstAmount,
        totals.gstAmount, totals.roundOff, totals.grandTotal,
      ]
    );
    await client.query(
      `INSERT INTO audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'QR_ORDER_REQUESTED','QR_ORDER',$2,$3::jsonb)`,
      [context.restaurant_id, rows[0].id, JSON.stringify({ tableId: context.table_id, customerId: req.customer.id })]
    );
    return { id: rows[0].id, status: rows[0].status, createdAt: rows[0].created_at, total: totals.grandTotal, tableName: tableRows[0].name };
  });
  publishRestaurantEvent(context.restaurant_id, 'qr-order:new', { qrOrderId: created.id, tableName: created.tableName, total: created.total });
  notifyRestaurantQrOrder({ restaurantId: context.restaurant_id, orderId: created.id, tableName: created.tableName, total: created.total }).catch((error) => {
    console.warn('DirectQR push delivery failed:', error?.message || error);
  });
  res.status(201).json({ order: created });
}));
app.get('/api/public/qr-orders/:id', requireCustomer, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT q.*, d.name AS table_name, c.display_name AS customer_name, c.username AS customer_username, c.phone AS customer_phone
     FROM qr_orders q
     JOIN dining_tables d ON d.id = q.table_id
     JOIN customer_accounts c ON c.id = q.customer_id
     WHERE q.id = $1 AND q.customer_id = $2`,
    [req.params.id, req.customer.id]
  );
  if (!rows[0]) throw Object.assign(new Error('QR order not found.'), { status: 404 });
  res.json({ order: qrOrderPayload(rows[0]) });
}));

function requireDirectQrOrdering(_req, _res, next) {
  // DirectQR is the product itself. Commercial expiry blocks new public QR
  // submissions but staff can still review, settle and audit old orders.
  return next();
}

app.get('/api/notifications/config', requireAuth, (req, res) => {
  res.json({ ...pushConfiguration(), notificationPermission: null, product: 'DirectQR' });
});
app.post('/api/notifications/subscribe', requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  const subscription = pushSubscriptionSchema.parse(req.body);
  await savePushSubscription({ restaurantId: req.user.restaurant_id, userId: req.user.id, subscription });
  res.status(204).end();
}));
app.post('/api/notifications/unsubscribe', requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  const { endpoint } = pushUnsubscribeSchema.parse(req.body);
  await removePushSubscription({ userId: req.user.id, endpoint });
  res.status(204).end();
}));
app.post('/api/notifications/test', requireAuth, requireCsrf, asyncHandler(async (req, res) => {
  const result = await notifyRestaurantQrOrder({ restaurantId: req.user.restaurant_id, userId: req.user.id, orderId: 'test', tableName: 'Test notification', total: 0, title: 'DirectQR test alert', body: 'Notifications are working on this device.' });
  res.json(result);
}));
app.get('/api/events/stream', requireAuth, requirePermission('view_tables'), openRestaurantEventStream);
app.get('/api/qr-orders', requireAuth, requireDirectQrOrdering, requirePermission('view_tables'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT q.*, d.name AS table_name, c.display_name AS customer_name, c.username AS customer_username, c.phone AS customer_phone
     FROM qr_orders q
     JOIN dining_tables d ON d.id = q.table_id
     JOIN customer_accounts c ON c.id = q.customer_id
     WHERE q.restaurant_id = $1 AND q.status = 'PENDING'
     ORDER BY q.created_at ASC`,
    [req.user.restaurant_id]
  );
  res.json({ orders: rows.map(qrOrderPayload) });
}));
app.post('/api/qr-orders/:id/accept', requireAuth, requireCsrf, requireDirectQrOrdering, requirePermission('create_orders'), asyncHandler(async (req, res) => {
  const result = await acceptQrOrder({ restaurantId: req.user.restaurant_id, userId: req.user.id, qrOrderId: req.params.id });
  publishRestaurantEvent(req.user.restaurant_id, 'qr-order:accepted', { qrOrderId: req.params.id, orderId: result.orderId });
  res.json({ orderId: result.orderId, tableId: result.tableId, revision: result.revision, mergedIntoExistingOrder: Boolean(result.mergedIntoExistingOrder) });
}));
app.post('/api/qr-orders/:id/reject', requireAuth, requireCsrf, requireDirectQrOrdering, requirePermission('create_orders'), asyncHandler(async (req, res) => {
  const { reason } = qrRejectSchema.parse(req.body || {});
  const { rows } = await query(
    `UPDATE qr_orders
     SET status = 'REJECTED', rejection_reason = $3, processed_by = $4, processed_at = now(), updated_at = now()
     WHERE id = $1 AND restaurant_id = $2 AND status = 'PENDING'
     RETURNING id`,
    [req.params.id, req.user.restaurant_id, reason || 'Restaurant could not accept this order right now.', req.user.id]
  );
  if (!rows[0]) throw Object.assign(new Error('This QR order has already been processed.'), { status: 409 });
  await audit({ query }, req.user.restaurant_id, req.user.id, 'QR_ORDER_REJECTED', 'QR_ORDER', req.params.id, { reason: reason || null });
  publishRestaurantEvent(req.user.restaurant_id, 'qr-order:rejected', { qrOrderId: req.params.id });
  res.status(204).end();
}));
app.post('/api/orders/:orderId/staff-items', requireAuth, requireCsrf, requirePermission('create_orders'), asyncHandler(async (req, res) => {
  const payload = staffAddItemsSchema.parse(req.body || {});
  const result = await addStaffItems({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId,
    expectedRevision: payload.expectedRevision,
    items: payload.items,
    note: payload.note,
  });
  publishRestaurantEvent(req.user.restaurant_id, 'directqr:staff-items-added', { orderId: req.params.orderId });
  res.json(result);
}));
app.get('/api/qr/table-codes', requireAuth, requireDirectQrOrdering, requireRole('OWNER'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.name AS restaurant_name, r.slug, d.id, d.name AS table_name, d.position, t.token
     FROM dining_tables d
     JOIN restaurants r ON r.id = d.restaurant_id
     JOIN public_table_tokens t ON t.table_id = d.id AND t.is_active = TRUE
     WHERE d.restaurant_id = $1 AND d.is_active = TRUE
     ORDER BY d.position, d.name`,
    [req.user.restaurant_id]
  );
  const configuredBase = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  const base = configuredBase || `${req.protocol}://${req.get('host')}`;
  const restaurantName = rows[0]?.restaurant_name || req.user.restaurant_name || 'Restaurant';
  res.json({
    restaurantName,
    tables: rows.map((row) => ({
      id: row.id,
      tableName: row.table_name,
      position: Number(row.position || 0),
      url: `${base}/order/${row.slug}/${row.token}`
    }))
  });
}));
app.get('/api/tables/:id/qr-link', requireAuth, requireDirectQrOrdering, requireRole('OWNER'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.slug, t.token
     FROM dining_tables d
     JOIN restaurants r ON r.id = d.restaurant_id
     JOIN public_table_tokens t ON t.table_id = d.id AND t.is_active = TRUE
     WHERE d.id = $1 AND d.restaurant_id = $2`,
    [req.params.id, req.user.restaurant_id]
  );
  if (!rows[0]) throw Object.assign(new Error('No active QR token exists for this table.'), { status: 404 });
  const configuredBase = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  const base = configuredBase || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/order/${rows[0].slug}/${rows[0].token}`, token: rows[0].token });
}));
app.get("/api/tables", requireAuth, requirePermission("view_tables"), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.name, t.position,
       o.id AS open_order_id, o.order_number, o.grand_total, o.kot_sequence, o.revision, o.bill_locked_at, o.created_at AS order_created_at,
       COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = o.id), 0)::int AS item_count,
       COALESCE((SELECT SUM(GREATEST(quantity - sent_to_kitchen_qty, 0)) FROM order_items WHERE order_id = o.id), 0)::int AS unsent_item_count
     FROM dining_tables t
     LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'OPEN'
     WHERE t.restaurant_id = $1 AND t.is_active = true
     ORDER BY t.position, t.name`,
    [req.user.restaurant_id]
  );
  res.json({ tables: rows.map((table) => ({ ...table, grand_total: Number(table.grand_total || 0), revision: table.revision ? Number(table.revision) : null, unsent_item_count: Number(table.unsent_item_count || 0) })) });
}));
app.get('/api/takeaways', requireAuth, requirePermission('view_tables'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT o.id AS open_order_id, o.order_number, o.grand_total, o.kot_sequence, o.revision, o.bill_locked_at,
            o.created_at AS order_created_at, o.order_type, o.takeaway_token, o.takeaway_business_date,
            COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id = o.id), 0)::int AS item_count,
            COALESCE((SELECT SUM(GREATEST(quantity - sent_to_kitchen_qty, 0)) FROM order_items WHERE order_id = o.id), 0)::int AS unsent_item_count
     FROM orders o
     WHERE o.restaurant_id = $1 AND o.status = 'OPEN' AND o.order_type = 'TAKEAWAY'
     ORDER BY o.created_at ASC`,
    [req.user.restaurant_id]
  );
  res.json({
    takeaways: rows.map((order) => ({
      ...order,
      order_type: 'TAKEAWAY',
      grand_total: Number(order.grand_total || 0),
      revision: Number(order.revision || 1),
      takeaway_token: Number(order.takeaway_token || 0),
      unsent_item_count: Number(order.unsent_item_count || 0),
    })),
  });
}));

app.get("/api/menu", requireAuth, asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === "true" && hasPermission(req.user, "edit_menu");
  const { rows: categories } = await query(
    `SELECT id, name, food_type, position
     FROM categories
     WHERE restaurant_id = $1 AND is_active = true
     ORDER BY position, name`,
    [req.user.restaurant_id]
  );
  const { rows: items } = await query(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.gst_rate, mi.gst_inclusive, mi.is_active, mi.availability,
       COALESCE(json_agg(DISTINCT jsonb_build_object(
         'id', ag.id, 'name', ag.name, 'minSelect', ag.min_select, 'maxSelect', ag.max_select, 'position', ag.position
       )) FILTER (WHERE ag.id IS NOT NULL), '[]') AS addon_groups
     FROM menu_items mi
     LEFT JOIN addon_groups ag ON ag.menu_item_id = mi.id
     WHERE mi.restaurant_id = $1 AND (($2::boolean = TRUE) OR (mi.is_active = TRUE AND mi.availability = 'AVAILABLE'))
     GROUP BY mi.id
     ORDER BY mi.is_active DESC, mi.name`,
    [req.user.restaurant_id, includeInactive]
  );
  const { rows: options } = await query(
    `SELECT ao.id, ao.addon_group_id, ao.name, ao.price, ao.position
     FROM addon_options ao
     JOIN addon_groups ag ON ag.id = ao.addon_group_id
     JOIN menu_items mi ON mi.id = ag.menu_item_id
     WHERE mi.restaurant_id = $1 AND (($2::boolean = TRUE) OR (mi.is_active = TRUE AND mi.availability = 'AVAILABLE')) AND ao.is_active = true
     ORDER BY ao.position, ao.name`,
    [req.user.restaurant_id, includeInactive]
  );
  const { rows: outletRows } = await query(
    'SELECT container_charge_gst_rate FROM restaurants WHERE id = $1',
    [req.user.restaurant_id]
  );
  const containerChargeGstRate = Number(outletRows[0]?.container_charge_gst_rate || 0);

  const optionsByGroup = /* @__PURE__ */ new Map();
  options.forEach((option) => {
    const group = optionsByGroup.get(option.addon_group_id) || [];
    group.push({ id: option.id, name: option.name, price: Number(option.price) });
    optionsByGroup.set(option.addon_group_id, group);
  });
  res.json({
    containerChargeGstRate,
    categories: categories.map((category) => ({ id: category.id, name: category.name, position: Number(category.position || 0), foodType: category.food_type || "VEG" })),
    items: items.map((item) => ({
      id: item.id,
      categoryId: item.category_id,
      name: item.name,
      description: item.description || '',
      price: Number(item.price),
      gstRate: Number(item.gst_rate),
      gstInclusive: item.gst_inclusive,
      isActive: item.is_active,
      availability: item.availability || (item.is_active ? "AVAILABLE" : "INACTIVE"),
      addonGroups: item.addon_groups.map((group) => ({ ...group, options: optionsByGroup.get(group.id) || [] }))
    }))
  });
}));
app.get("/api/orders/:orderId", requireAuth, requirePermission("view_tables"), asyncHandler(async (req, res) => {
  const order = await getOrder(query, req.user.restaurant_id, req.params.orderId);
  if (!order) return res.status(404).json({ message: "Order not found." });
  res.json({ order });
}));
app.post("/api/orders", requireAuth, requireCsrf, requirePermission("create_orders"), asyncHandler(async (_req, _res) => {
  throw Object.assign(new Error('DirectQR does not allow manual counter/table order creation. Accept a customer QR request first.'), { status: 403 });
}));
app.put("/api/orders/:orderId", requireAuth, requireCsrf, requirePermission("create_orders"), asyncHandler(async (req, res) => {
  const payload = orderUpdateSchema.parse(req.body);
  assertDiscountPermission(req, payload);
  const { rows } = await query(
    `SELECT order_source, status, bill_locked_at FROM orders WHERE id = $1 AND restaurant_id = $2`,
    [req.params.orderId, req.user.restaurant_id],
  );
  const order = rows[0];
  if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
  if ((order.order_source || 'DIRECT_QR') !== 'DIRECT_QR') throw Object.assign(new Error('Only DirectQR-originated orders can be changed here.'), { status: 403 });
  if (order.status !== 'OPEN' || order.bill_locked_at) throw Object.assign(new Error('This bill is locked and cannot be changed.'), { status: 400 });
  const { expectedRevision, ...draft } = payload;
  const result = await saveDraft({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId,
    draft,
    expectedRevision,
    lineSource: 'STAFF',
  });
  await audit({ query }, req.user.restaurant_id, req.user.id, 'DIRECTQR_STAFF_ORDER_EDITED', 'ORDER', req.params.orderId, { source: 'STAFF' });
  res.json(result);
}));
app.post("/api/orders/:orderId/kot", requireAuth, requireCsrf, requirePermission("send_kot"), asyncHandler(async (req, res) => {
  const { expectedRevision } = orderActionSchema.parse(req.body);
  const result = await printKot({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId,
    expectedRevision
  });
  res.json(result);
}));
app.post("/api/orders/:orderId/kot/reprint", requireAuth, requireCsrf, requirePermission("send_kot"), asyncHandler(async (req, res) => {
  const result = await reprintLatestKot({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId
  });
  res.json(result);
}));
app.post("/api/orders/:orderId/bill/print", requireAuth, requireCsrf, requirePermission("print_bill"), asyncHandler(async (req, res) => {
  const payload = billPrintSchema.parse(req.body);
  const order = await printDraftBill({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId,
    expectedRevision: payload.expectedRevision,
    customerName: payload.customerName,
    customerMobile: payload.customerMobile
  });
  res.json({ order });
}));
app.post("/api/orders/:orderId/settle", requireAuth, requireCsrf, requirePermission("settle_payment"), asyncHandler(async (req, res) => {
  const payload = settleSchema.parse(req.body);
  const order = await settleOrder({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId,
    expectedRevision: payload.expectedRevision,
    payments: payload.payments,
    printBill: payload.printBill,
    customerName: payload.customerName,
    customerMobile: payload.customerMobile
  });
  res.json({ order });
}));
app.post("/api/orders/:orderId/bill/reprint", requireAuth, requireCsrf, requirePermission("reprint_bill"), sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const authorization = billReprintSchema.parse(req.body);
  const admin = await confirmAdminAuthorization(req, authorization, "BILL_REPRINT");
  const order = await reprintBill({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    authorizedByUserId: admin.id,
    orderId: req.params.orderId
  });
  res.json({ order });
}));
app.post("/api/orders/:orderId/void", requireAuth, requireCsrf, requirePermission("void_orders"), sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const payload = voidOrderSchema.parse(req.body);
  await confirmVoidPassword(req, payload.voidPassword);
  const result = await voidOpenOrder({
    restaurantId: req.user.restaurant_id,
    userId: req.user.id,
    orderId: req.params.orderId,
    expectedRevision: payload.expectedRevision,
    reason: payload.reason
  });
  res.json(result);
}));
app.get("/api/kot-view", requireAuth, requirePermission("view_tables"), asyncHandler(async (req, res) => {
  const { rows: orders } = await query(
    `SELECT o.id, o.table_id, o.order_number, o.kot_sequence, o.created_at, o.bill_locked_at,
            o.order_type, o.takeaway_token, t.name AS table_name
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     WHERE o.restaurant_id = $1 AND o.status = 'OPEN'
     ORDER BY o.created_at ASC`,
    [req.user.restaurant_id]
  );
  if (!orders.length) return res.json({ orders: [] });
  const orderIds = orders.map((order) => order.id);
  const [itemsResult, kotResult] = await Promise.all([
    query(
      `SELECT id, order_id, item_name, quantity, sent_to_kitchen_qty, addons_snapshot, created_at
       FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY created_at`,
      [orderIds]
    ),
    query(
      `SELECT order_id, sequence, daily_kot_number, items, printed_at
       FROM kot_prints WHERE order_id = ANY($1::uuid[]) ORDER BY sequence`,
      [orderIds]
    )
  ]);
  const kotsByOrder = /* @__PURE__ */ new Map();
  kotResult.rows.forEach((row) => {
    const list = kotsByOrder.get(row.order_id) || [];
    list.push({
      sequence: Number(row.sequence),
      dailyKotNumber: Number(row.daily_kot_number || row.sequence),
      printedAt: row.printed_at,
      items: Array.isArray(row.items) ? row.items : JSON.parse(row.items || "[]")
    });
    kotsByOrder.set(row.order_id, list);
  });
  const itemsByOrder = /* @__PURE__ */ new Map();
  itemsResult.rows.forEach((row) => {
    const list = itemsByOrder.get(row.order_id) || [];
    const addons = Array.isArray(row.addons_snapshot) ? row.addons_snapshot : JSON.parse(row.addons_snapshot || "[]");
    list.push({ id: row.id, itemName: row.item_name, quantity: Number(row.quantity), sentQuantity: Number(row.sent_to_kitchen_qty), addons });
    itemsByOrder.set(row.order_id, list);
  });
  const signature = (item) => `${item.itemName}|${(item.addons || []).map((addon) => addon.id || addon.name).sort().join(",")}`;
  res.json({ orders: orders.map((order) => {
    const kotBatches = kotsByOrder.get(order.id) || [];
    const allItems = (itemsByOrder.get(order.id) || []).map((item) => {
      const sentKotNumbers = kotBatches.filter((kot) => kot.items.some((kotItem) => kotItem.lineId && kotItem.lineId === item.id || !kotItem.lineId && signature(kotItem) === signature(item))).map((kot) => kot.dailyKotNumber);
      return { ...item, unsentQuantity: Math.max(0, item.quantity - item.sentQuantity), sentKotNumbers };
    });
    return {
      id: order.id,
      tableId: order.table_id,
      orderType: order.order_type || 'DINE_IN',
      takeawayToken: order.takeaway_token == null ? null : Number(order.takeaway_token),
      orderNumber: Number(order.order_number),
      tableName: order.table_name,
      kotCount: Number(order.kot_sequence || 0),
      billLockedAt: order.bill_locked_at,
      createdAt: order.created_at,
      items: allItems,
      kotBatches
    };
  }) });
}));
app.get("/api/dashboard/owner", requireAuth, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const { date } = dashboardDateSchema.parse(req.query);
  const timezone = req.user.timezone || "Asia/Kolkata";
  const rangeSql = `completed_at >= ($2::date::timestamp AT TIME ZONE $3)
                    AND completed_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`;
  const [settingsResult, summaryResult, openResult, recentResult, ongoingResult, voidResult, topQuantityResult, topRevenueResult, hourlyResult] = await Promise.all([
    query("SELECT opening_time, closing_time FROM restaurants WHERE id = $1", [req.user.restaurant_id]),
    query(
      `WITH completed_orders AS (
         SELECT id, subtotal, discount_amount, cgst_amount, sgst_amount, gst_amount, round_off, grand_total, container_charge
         FROM orders WHERE restaurant_id = $1 AND status = 'COMPLETED' AND ${rangeSql}
       ), payment_totals AS (
         SELECT p.method, SUM(p.amount) AS amount FROM payments p JOIN completed_orders o ON o.id = p.order_id GROUP BY p.method
       )
       SELECT (SELECT COUNT(*)::int FROM completed_orders) AS order_count,
         COALESCE((SELECT SUM(subtotal) FROM completed_orders),0) AS subtotal_sale,
         COALESCE((SELECT SUM(discount_amount) FROM completed_orders),0) AS discount_total,
         COALESCE((SELECT SUM(container_charge) FROM completed_orders),0) AS container_charge_total,
         COALESCE((SELECT SUM(cgst_amount) FROM completed_orders),0) AS cgst_total,
         COALESCE((SELECT SUM(sgst_amount) FROM completed_orders),0) AS sgst_total,
         COALESCE((SELECT SUM(gst_amount) FROM completed_orders),0) AS total_gst,
         COALESCE((SELECT SUM(round_off) FROM completed_orders),0) AS round_off_total,
         COALESCE((SELECT SUM(grand_total) FROM completed_orders),0) AS grand_sale,
         COALESCE((SELECT amount FROM payment_totals WHERE method='CASH'),0) AS cash_payment,
         COALESCE((SELECT amount FROM payment_totals WHERE method='UPI'),0) AS upi_payment,
         COALESCE((SELECT amount FROM payment_totals WHERE method='CARD'),0) AS card_payment`,
      [req.user.restaurant_id, date, timezone]
    ),
    query(`SELECT COUNT(*)::int AS open_order_count, COALESCE(SUM(grand_total),0) AS open_order_value FROM orders WHERE restaurant_id=$1 AND status='OPEN'`, [req.user.restaurant_id]),
    query(
      `SELECT o.id,o.order_number,o.completed_at,o.grand_total,o.order_type,o.takeaway_token,t.name AS table_name,
        COALESCE(json_agg(json_build_object('method',p.method,'amount',p.amount)) FILTER (WHERE p.id IS NOT NULL),'[]') AS payments
       FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id LEFT JOIN payments p ON p.order_id=o.id
       WHERE o.restaurant_id=$1 AND o.status='COMPLETED' AND ${rangeSql}
       GROUP BY o.id,t.name ORDER BY o.completed_at DESC LIMIT 8`,
      [req.user.restaurant_id, date, timezone]
    ),
    query(
      `SELECT o.id,o.order_number,o.created_at,o.grand_total,o.kot_sequence,o.bill_locked_at,o.order_type,o.takeaway_token,t.name AS table_name,COALESCE(SUM(oi.quantity),0)::int AS item_count
       FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id LEFT JOIN order_items oi ON oi.order_id=o.id
       WHERE o.restaurant_id=$1 AND o.status='OPEN' GROUP BY o.id,t.name ORDER BY o.created_at ASC LIMIT 12`,
      [req.user.restaurant_id]
    ),
    query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(grand_total),0) AS value FROM orders WHERE restaurant_id=$1 AND status='VOID' AND voided_at >= ($2::date::timestamp AT TIME ZONE $3) AND voided_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`, [req.user.restaurant_id, date, timezone]),
    query(
      `SELECT oi.item_name, SUM(oi.quantity)::int AS quantity, COALESCE(SUM(oi.line_total),0) AS revenue
       FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.restaurant_id=$1 AND o.status='COMPLETED' AND ${rangeSql}
       GROUP BY oi.item_name ORDER BY quantity DESC, revenue DESC, oi.item_name LIMIT 5`,
      [req.user.restaurant_id, date, timezone]
    ),
    query(
      `SELECT oi.item_name, SUM(oi.quantity)::int AS quantity, COALESCE(SUM(oi.line_total),0) AS revenue
       FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.restaurant_id=$1 AND o.status='COMPLETED' AND ${rangeSql}
       GROUP BY oi.item_name ORDER BY revenue DESC, quantity DESC, oi.item_name LIMIT 5`,
      [req.user.restaurant_id, date, timezone]
    ),
    query(`SELECT completed_at, grand_total FROM orders WHERE restaurant_id=$1 AND status='COMPLETED' AND ${rangeSql} ORDER BY completed_at`, [req.user.restaurant_id, date, timezone])
  ]);
  const summaryRow = summaryResult.rows[0];
  const summary = Object.fromEntries(Object.entries(summaryRow).map(([key, value]) => [key, key === "order_count" ? Number(value) : Number(value || 0)]));
  const setting = settingsResult.rows[0] || { opening_time: "09:00:00", closing_time: "22:00:00" };
  const parseTime = (value) => {
    const [h, m] = String(value).slice(0, 5).split(":").map(Number);
    return h * 60 + m;
  };
  const openingMinutes = parseTime(setting.opening_time);
  const closingMinutes = parseTime(setting.closing_time);
  const buckets = [];
  for (let startMinute = openingMinutes; startMinute < closingMinutes; startMinute += 180) {
    buckets.push({ startMinute, endMinute: Math.min(startMinute + 180, closingMinutes), sales: 0 });
  }
  hourlyResult.rows.forEach((row) => {
    const local = new Date(row.completed_at).toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
    const minute = local[0] * 60 + local[1];
    const bucket = buckets.find((candidate) => minute >= candidate.startMinute && minute < candidate.endMinute);
    if (bucket) bucket.sales += Number(row.grand_total || 0);
  });
  const label = (minutes) => {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    const d = new Date(Date.UTC(2020, 0, 1, h, m));
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(d);
  };
  res.json({
    date,
    summary,
    outletTimings: { openingTime: String(setting.opening_time).slice(0, 5), closingTime: String(setting.closing_time).slice(0, 5) },
    open: { count: Number(openResult.rows[0].open_order_count || 0), value: Number(openResult.rows[0].open_order_value || 0) },
    voids: { count: Number(voidResult.rows[0].count || 0), value: Number(voidResult.rows[0].value || 0) },
    topOrdered: topQuantityResult.rows.map((row) => ({ itemName: row.item_name, quantity: Number(row.quantity), revenue: Number(row.revenue) })),
    topRevenue: topRevenueResult.rows.map((row) => ({ itemName: row.item_name, quantity: Number(row.quantity), revenue: Number(row.revenue) })),
    salesByHour: buckets.map((bucket) => ({ label: `${label(bucket.startMinute)}\u2013${label(bucket.endMinute)}`, sales: Number(bucket.sales) })),
    recentOrders: recentResult.rows.map((row) => ({ id: row.id, orderNumber: Number(row.order_number), completedAt: row.completed_at, tableName: row.table_name, orderType: row.order_type || 'DINE_IN', takeawayToken: row.takeaway_token == null ? null : Number(row.takeaway_token), grandTotal: Number(row.grand_total), payments: row.payments.map((payment) => ({ ...payment, amount: Number(payment.amount) })) })),
    ongoingOrders: ongoingResult.rows.map((row) => ({ id: row.id, orderNumber: Number(row.order_number), createdAt: row.created_at, tableName: row.table_name, orderType: row.order_type || 'DINE_IN', takeawayToken: row.takeaway_token == null ? null : Number(row.takeaway_token), grandTotal: Number(row.grand_total), kotSequence: Number(row.kot_sequence), itemCount: Number(row.item_count), billLockedAt: row.bill_locked_at }))
  });
}));
app.get("/api/reports/executive", requireAuth, requirePermission("view_reports"), asyncHandler(async (req, res) => {
  const range = dateRangeSchema.parse(req.query);
  const timezone = req.user.timezone || "Asia/Kolkata";
  const { rows } = await query(
    `WITH completed_orders AS (
       SELECT id, subtotal, taxable_amount, discount_amount, cgst_amount, sgst_amount, gst_amount, round_off, grand_total, container_charge
       FROM orders
       WHERE restaurant_id = $1 AND status = 'COMPLETED'
         AND completed_at >= ($2::date::timestamp AT TIME ZONE $4)
         AND completed_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
     ), payment_totals AS (
       SELECT p.method, SUM(p.amount) AS amount
       FROM payments p
       JOIN completed_orders o ON o.id = p.order_id
       GROUP BY p.method
     )
     SELECT
       (SELECT COUNT(*)::int FROM completed_orders) AS order_count,
       COALESCE((SELECT SUM(subtotal) FROM completed_orders), 0) AS subtotal_sale,
       COALESCE((SELECT SUM(taxable_amount) FROM completed_orders), 0) AS taxable_sale,
       COALESCE((SELECT SUM(discount_amount) FROM completed_orders), 0) AS discount_total,
       COALESCE((SELECT SUM(container_charge) FROM completed_orders), 0) AS container_charge_total,
       COALESCE((SELECT SUM(cgst_amount) FROM completed_orders), 0) AS cgst_total,
       COALESCE((SELECT SUM(sgst_amount) FROM completed_orders), 0) AS sgst_total,
       COALESCE((SELECT SUM(gst_amount) FROM completed_orders), 0) AS total_gst,
       COALESCE((SELECT SUM(round_off) FROM completed_orders), 0) AS round_off_total,
       COALESCE((SELECT SUM(grand_total) FROM completed_orders), 0) AS grand_sale,
       COALESCE((SELECT amount FROM payment_totals WHERE method = 'CASH'), 0) AS cash_payment,
       COALESCE((SELECT amount FROM payment_totals WHERE method = 'UPI'), 0) AS upi_payment,
       COALESCE((SELECT amount FROM payment_totals WHERE method = 'CARD'), 0) AS card_payment`,
    [req.user.restaurant_id, range.from, range.to, timezone]
  );
  const row = rows[0];
  res.json({ summary: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === "order_count" ? value : Number(value)])) });
}));
app.get("/api/reports/sales", requireAuth, requirePermission("view_reports"), asyncHandler(async (req, res) => {
  const range = dateRangeSchema.parse(req.query);
  const timezone = req.user.timezone || "Asia/Kolkata";
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.completed_at, t.name AS table_name, o.order_type, o.takeaway_token, o.subtotal, o.taxable_amount,
            o.discount_amount, o.container_charge, o.container_gst_rate, o.container_gst_amount, o.cgst_amount, o.sgst_amount, o.gst_amount, o.round_off, o.grand_total,
      COALESCE(json_agg(json_build_object('method', p.method, 'amount', p.amount)) FILTER (WHERE p.id IS NOT NULL), '[]') AS payments
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN payments p ON p.order_id = o.id
     WHERE o.restaurant_id = $1 AND o.status = 'COMPLETED'
       AND o.completed_at >= ($2::date::timestamp AT TIME ZONE $4)
       AND o.completed_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
     GROUP BY o.id, t.name
     ORDER BY o.completed_at DESC`,
    [req.user.restaurant_id, range.from, range.to, timezone]
  );
  res.json({ orders: rows.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    completedAt: row.completed_at,
    tableName: row.table_name,
    orderType: row.order_type || 'DINE_IN',
    takeawayToken: row.takeaway_token == null ? null : Number(row.takeaway_token),
    subtotal: Number(row.subtotal),
    taxableAmount: Number(row.taxable_amount),
    discountAmount: Number(row.discount_amount),
    containerCharge: Number(row.container_charge || 0),
    containerGstRate: Number(row.container_gst_rate || 0),
    containerGstAmount: Number(row.container_gst_amount || 0),
    cgstAmount: Number(row.cgst_amount),
    sgstAmount: Number(row.sgst_amount),
    gstAmount: Number(row.gst_amount),
    roundOff: Number(row.round_off),
    grandTotal: Number(row.grand_total),
    payments: row.payments.map((payment) => ({ ...payment, amount: Number(payment.amount) }))
  })) });
}));
app.get("/api/reports/voids", requireAuth, requirePermission("view_reports"), asyncHandler(async (req, res) => {
  const range = dateRangeSchema.parse(req.query);
  const timezone = req.user.timezone || "Asia/Kolkata";
  const { rows } = await query(
    `SELECT o.id, o.order_number, o.voided_at, t.name AS table_name, o.subtotal, o.gst_amount, o.round_off,
            o.grand_total, o.void_reason, o.kot_sequence, u.display_name AS voided_by,
            ua.display_name AS authorized_by
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN users u ON u.id = o.voided_by
     LEFT JOIN users ua ON ua.id = o.void_authorized_by
     WHERE o.restaurant_id = $1 AND o.status = 'VOID'
       AND o.voided_at >= ($2::date::timestamp AT TIME ZONE $4)
       AND o.voided_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
     ORDER BY o.voided_at DESC`,
    [req.user.restaurant_id, range.from, range.to, timezone]
  );
  res.json({ orders: rows.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    voidedAt: row.voided_at,
    tableName: row.table_name,
    subtotal: Number(row.subtotal),
    gstAmount: Number(row.gst_amount),
    roundOff: Number(row.round_off),
    grandTotal: Number(row.grand_total),
    reason: row.void_reason,
    kotSent: Number(row.kot_sequence) > 0,
    voidedBy: row.voided_by || "\u2014",
    authorizedBy: row.authorized_by || "Shared void password"
  })) });
}));
app.get("/api/reports/customers", requireAuth, requirePermission("view_customer_details"), asyncHandler(async (req, res) => {
  const range = dateRangeSchema.parse(req.query);
  const timezone = req.user.timezone || "Asia/Kolkata";
  const { rows } = await query(
    `SELECT NULLIF(btrim(customer_name), '') AS customer_name, NULLIF(btrim(customer_mobile), '') AS customer_mobile
     FROM orders
     WHERE restaurant_id = $1 AND status = 'COMPLETED'
       AND completed_at >= ($2::date::timestamp AT TIME ZONE $4)
       AND completed_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
       AND (NULLIF(btrim(customer_name), '') IS NOT NULL OR NULLIF(btrim(customer_mobile), '') IS NOT NULL)
     GROUP BY NULLIF(btrim(customer_name), ''), NULLIF(btrim(customer_mobile), '')
     ORDER BY customer_name NULLS LAST, customer_mobile NULLS LAST`,
    [req.user.restaurant_id, range.from, range.to, timezone]
  );
  res.json({ customers: rows.map((row) => ({ name: row.customer_name || "", mobile: row.customer_mobile || "" })) });
}));
app.get("/api/staff", requireAuth, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, username, display_name, role, permissions, is_active, locked_until, password_reset_required, last_login_at, created_at, updated_at
     FROM users
     WHERE restaurant_id = $1 AND role IN ('WAITER', 'CASHIER', 'MANAGER')
     ORDER BY is_active DESC, display_name, username`,
    [req.user.restaurant_id]
  );
  res.json({ staff: rows.map((staff) => ({
    id: staff.id,
    username: staff.username,
    displayName: staff.display_name,
    role: staff.role,
    permissions: normalizePermissions(staff.role, staff.permissions),
    isActive: staff.is_active,
    lockedUntil: staff.locked_until,
    passwordResetRequired: staff.password_reset_required,
    lastLoginAt: staff.last_login_at,
    createdAt: staff.created_at,
    updatedAt: staff.updated_at
  })) });
}));
app.post("/api/staff", requireAuth, requireCsrf, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const payload = createStaffSchema.parse(req.body);
  if (payload.username.toLowerCase() === String(req.user.restaurant_login_id || req.user.restaurant_slug).toLowerCase()) {
    throw Object.assign(new Error("Staff username cannot match the Restaurant ID."), { status: 400 });
  }
  const staff = await withTransaction(async (client) => {
    const passwordHash = await hashPassword(payload.password);
    const { rows } = await client.query(
      `INSERT INTO users (restaurant_id, username, password_hash, display_name, role, permissions)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING id, username, display_name, role, permissions, is_active, last_login_at, created_at`,
      [req.user.restaurant_id, payload.username, passwordHash, payload.displayName, payload.role, JSON.stringify(normalizePermissions(payload.role, payload.permissions))]
    );
    await audit(client, req.user.restaurant_id, req.user.id, "STAFF_CREATED", "USER", rows[0].id, { username: rows[0].username, displayName: rows[0].display_name, role: rows[0].role });
    return rows[0];
  });
  res.status(201).json({ staff: { id: staff.id, username: staff.username, displayName: staff.display_name, role: staff.role, permissions: normalizePermissions(staff.role, staff.permissions), isActive: staff.is_active, lastLoginAt: staff.last_login_at, createdAt: staff.created_at } });
}));
app.put("/api/staff/:id", requireAuth, requireCsrf, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const payload = updateStaffSchema.parse(req.body);
  if (payload.username.toLowerCase() === String(req.user.restaurant_login_id || req.user.restaurant_slug).toLowerCase()) {
    throw Object.assign(new Error("Staff username cannot match the Restaurant ID."), { status: 400 });
  }
  const staff = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE users
       SET username = $3, display_name = $4, is_active = $5, role = $6, permissions = $7::jsonb, updated_at = now()
       WHERE id = $1 AND restaurant_id = $2 AND role IN ('WAITER', 'CASHIER', 'MANAGER')
       RETURNING id, username, display_name, role, permissions, is_active, last_login_at, created_at, updated_at`,
      [req.params.id, req.user.restaurant_id, payload.username, payload.displayName, payload.isActive, payload.role, JSON.stringify(normalizePermissions(payload.role, payload.permissions))]
    );
    if (!rows[0]) throw Object.assign(new Error("Staff account not found."), { status: 404 });
    if (!payload.isActive) await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [rows[0].id]);
    await audit(client, req.user.restaurant_id, req.user.id, payload.isActive ? "STAFF_UPDATED" : "STAFF_DEACTIVATED", "USER", rows[0].id, { username: rows[0].username, displayName: rows[0].display_name });
    return rows[0];
  });
  res.json({ staff: { id: staff.id, username: staff.username, displayName: staff.display_name, role: staff.role, permissions: normalizePermissions(staff.role, staff.permissions), isActive: staff.is_active, lastLoginAt: staff.last_login_at, createdAt: staff.created_at, updatedAt: staff.updated_at } });
}));
app.post("/api/staff/:id/reset-password", requireAuth, requireCsrf, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const payload = resetStaffPasswordSchema.parse(req.body);
  const { rows: adminRows } = await query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!adminRows[0] || !await verifyPassword(payload.adminPassword, adminRows[0].password_hash)) throw Object.assign(new Error("Admin password is incorrect."), { status: 403 });
  const staff = await withTransaction(async (client) => {
    const passwordHash = await hashPassword(payload.password);
    const { rows } = await client.query(
      `UPDATE users
       SET password_hash = $3, failed_login_count = 0, locked_until = NULL, login_failure_window_started_at = NULL, password_reset_required = FALSE, updated_at = now()
       WHERE id = $1 AND restaurant_id = $2 AND role IN ('WAITER', 'CASHIER', 'MANAGER')
       RETURNING id, username, display_name`,
      [req.params.id, req.user.restaurant_id, passwordHash]
    );
    if (!rows[0]) throw Object.assign(new Error("Staff account not found."), { status: 404 });
    await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [rows[0].id]);
    await audit(client, req.user.restaurant_id, req.user.id, "STAFF_PASSWORD_RESET", "USER", rows[0].id, { username: rows[0].username });
    return rows[0];
  });
  res.json({ staff: { id: staff.id, username: staff.username, displayName: staff.display_name } });
}));
app.get("/api/settings", requireAuth, requireRole("OWNER"), asyncHandler(async (req, res) => {
  let settings = null;
  if (req.user.role === "OWNER") {
    const { rows: restaurantRows } = await query(
      `SELECT name, gstin, address, phone, bill_prefix, timezone, theme_color, login_id, opening_time, closing_time, container_charge_gst_rate
       FROM restaurants WHERE id = $1`,
      [req.user.restaurant_id]
    );
    const restaurant = restaurantRows[0];
    settings = {
      name: restaurant.name,
      gstin: restaurant.gstin || "",
      address: restaurant.address || "",
      phone: restaurant.phone || "",
      billPrefix: restaurant.bill_prefix,
      timezone: restaurant.timezone,
      themeColor: restaurant.theme_color,
      restaurantLoginId: restaurant.login_id,
      openingTime: String(restaurant.opening_time).slice(0, 5),
      closingTime: String(restaurant.closing_time).slice(0, 5),
      containerChargeGstRate: Number(restaurant.container_charge_gst_rate || 0),
    };
  }
  res.json({ settings });
}));
app.put("/api/settings", requireAuth, requireCsrf, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const payload = restaurantSettingsSchema.parse(req.body);
  const settings = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE restaurants
       SET name=$2,gstin=NULLIF($3,''),address=NULLIF($4,''),phone=NULLIF($5,''),bill_prefix=$6,
           opening_time=$7::time, closing_time=$8::time, container_charge_gst_rate=$9, updated_at=now()
       WHERE id=$1
       RETURNING name,gstin,address,phone,bill_prefix,timezone,theme_color,login_id,opening_time,closing_time,container_charge_gst_rate`,
      [req.user.restaurant_id, payload.name, payload.gstin, payload.address, payload.phone, payload.billPrefix, payload.openingTime, payload.closingTime, payload.containerChargeGstRate]
    );
    await audit(client, req.user.restaurant_id, req.user.id, "RESTAURANT_SETTINGS_UPDATED", "RESTAURANT", req.user.restaurant_id, { name: payload.name, gstin: payload.gstin || null, billPrefix: payload.billPrefix, openingTime: payload.openingTime, closingTime: payload.closingTime, containerChargeGstRate: payload.containerChargeGstRate });
    return rows[0];
  });
  res.json({ settings: { name: settings.name, gstin: settings.gstin || '', address: settings.address || '', phone: settings.phone || '', billPrefix: settings.bill_prefix, timezone: settings.timezone, themeColor: settings.theme_color, restaurantLoginId: settings.login_id, openingTime: String(settings.opening_time).slice(0, 5), closingTime: String(settings.closing_time).slice(0, 5), containerChargeGstRate: Number(settings.container_charge_gst_rate || 0) } });
}));
app.put("/api/settings/void-password", requireAuth, requireCsrf, requireRole("OWNER"), sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const payload = updateVoidPasswordSchema.parse(req.body);
  const { rows } = await query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
  if (!rows[0] || !await verifyPassword(payload.adminPassword, rows[0].password_hash)) throw Object.assign(new Error("Admin password is incorrect."), { status: 403 });
  const newHash = await hashPassword(payload.newVoidPassword);
  await withTransaction(async (client) => {
    await client.query("UPDATE restaurants SET void_password_hash=$2,updated_at=now() WHERE id=$1", [req.user.restaurant_id, newHash]);
    await audit(client, req.user.restaurant_id, req.user.id, "VOID_PASSWORD_RESET", "RESTAURANT", req.user.restaurant_id);
  });
  res.status(204).end();
}));
app.post("/api/categories", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  const payload = categorySchema.parse(req.body);
  const category = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO categories (restaurant_id, name, position, food_type) VALUES ($1,$2,$3,$4) RETURNING id, name, position, food_type",
      [req.user.restaurant_id, payload.name, payload.position, payload.foodType]
    );
    await audit(client, req.user.restaurant_id, req.user.id, "CATEGORY_CREATED", "CATEGORY", rows[0].id, { name: payload.name, foodType: payload.foodType });
    return rows[0];
  });
  res.status(201).json({ category });
}));
app.put("/api/categories/:id", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  const payload = categorySchema.parse(req.body);
  const category = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE categories
       SET name = $3, position = $4, food_type = $5
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id, name, position, food_type`,
      [req.params.id, req.user.restaurant_id, payload.name, payload.position, payload.foodType]
    );
    if (!rows[0]) throw Object.assign(new Error("Category not found."), { status: 404 });
    await audit(client, req.user.restaurant_id, req.user.id, "CATEGORY_UPDATED", "CATEGORY", rows[0].id, { name: payload.name, foodType: payload.foodType });
    return rows[0];
  });
  res.json({ category });
}));
app.delete("/api/categories/:id", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const { rows: itemCount } = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM menu_items
       WHERE category_id = $1 AND restaurant_id = $2 AND is_active = true`,
      [req.params.id, req.user.restaurant_id]
    );
    if (itemCount[0].count > 0) throw Object.assign(new Error("Move or deactivate category items before deleting this category."), { status: 400 });
    const { rowCount } = await client.query(
      "UPDATE categories SET is_active = false WHERE id = $1 AND restaurant_id = $2",
      [req.params.id, req.user.restaurant_id]
    );
    if (!rowCount) throw Object.assign(new Error("Category not found."), { status: 404 });
    await audit(client, req.user.restaurant_id, req.user.id, "CATEGORY_DEACTIVATED", "CATEGORY", req.params.id);
  });
  res.status(204).end();
}));
async function assertRestaurantCategory(client, restaurantId, categoryId) {
  const { rows } = await client.query(
    "SELECT id FROM categories WHERE id = $1 AND restaurant_id = $2 AND is_active = true",
    [categoryId, restaurantId]
  );
  if (!rows[0]) throw Object.assign(new Error("Category not found."), { status: 400 });
}
async function writeMenuItem(client, restaurantId, itemId, payload) {
  await assertRestaurantCategory(client, restaurantId, payload.categoryId);
  // Deactivation is performed through the dedicated endpoint. Treat any stale
  // INACTIVE dropdown payload from an older browser as Out of Stock so a normal
  // create/edit save never fails on the legacy availability path. Availability
  // and active-state are deliberately not derived from the same SQL parameter:
  // PostgreSQL otherwise infers incompatible TEXT and VARCHAR parameter types.
  const availability = payload.availability === 'INACTIVE' ? 'OUT_OF_STOCK' : payload.availability;
  let item;
  if (itemId) {
    const result = await client.query(
      `UPDATE menu_items
       SET category_id = $3, name = $4, description = $5, price = $6, gst_rate = $7, gst_inclusive = FALSE, availability = $8, is_active = TRUE, updated_at = now()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id`,
      [itemId, restaurantId, payload.categoryId, payload.name, payload.description, payload.price, payload.gstRate, availability]
    );
    item = result.rows[0];
    if (!item) throw Object.assign(new Error("Menu item not found."), { status: 404 });
    await client.query("DELETE FROM addon_groups WHERE menu_item_id = $1", [item.id]);
  } else {
    const result = await client.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, gst_rate, gst_inclusive, availability, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,TRUE)
       RETURNING id`,
      [restaurantId, payload.categoryId, payload.name, payload.description, payload.price, payload.gstRate, availability]
    );
    item = result.rows[0];
  }
  for (let groupIndex = 0; groupIndex < payload.addonGroups.length; groupIndex += 1) {
    const groupData = payload.addonGroups[groupIndex];
    const group = await client.query(
      `INSERT INTO addon_groups (menu_item_id, name, min_select, max_select, position)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [item.id, groupData.name, groupData.minSelect, groupData.maxSelect, groupIndex]
    );
    for (let optionIndex = 0; optionIndex < groupData.options.length; optionIndex += 1) {
      const option = groupData.options[optionIndex];
      await client.query(
        `INSERT INTO addon_options (addon_group_id, name, price, position)
         VALUES ($1,$2,$3,$4)`,
        [group.rows[0].id, option.name, option.price, optionIndex]
      );
    }
  }
  return item;
}
app.post("/api/menu-items", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  const payload = menuItemSchema.parse(req.body);
  const item = await withTransaction(async (client) => {
    const created = await writeMenuItem(client, req.user.restaurant_id, null, payload);
    await audit(client, req.user.restaurant_id, req.user.id, "MENU_ITEM_CREATED", "MENU_ITEM", created.id, { name: payload.name });
    return created;
  });
  res.status(201).json({ item });
}));
app.put("/api/menu-items/:id", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  const payload = menuItemSchema.parse(req.body);
  const item = await withTransaction(async (client) => {
    const updated = await writeMenuItem(client, req.user.restaurant_id, req.params.id, payload);
    await audit(client, req.user.restaurant_id, req.user.id, "MENU_ITEM_UPDATED", "MENU_ITEM", updated.id, { name: payload.name });
    return updated;
  });
  res.json({ item });
}));
app.delete("/api/menu-items/:id", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE menu_items
       SET is_active = false, availability = 'INACTIVE', updated_at = now()
       WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.user.restaurant_id]
    );
    if (!rowCount) throw Object.assign(new Error("Menu item not found."), { status: 404 });
    await audit(client, req.user.restaurant_id, req.user.id, "MENU_ITEM_DEACTIVATED", "MENU_ITEM", req.params.id);
  });
  res.status(204).end();
}));
app.post("/api/menu-items/:id/reactivate", requireAuth, requireCsrf, requirePermission("edit_menu"), asyncHandler(async (req, res) => {
  const item = await withTransaction(async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT mi.id, mi.name, mi.category_id, mi.is_active, c.is_active AS category_active
       FROM menu_items mi
       JOIN categories c ON c.id = mi.category_id
       WHERE mi.id = $1 AND mi.restaurant_id = $2
       FOR UPDATE OF mi`,
      [req.params.id, req.user.restaurant_id]
    );
    const current = currentRows[0];
    if (!current) throw Object.assign(new Error("Menu item not found."), { status: 404 });
    if (!current.category_active) throw Object.assign(new Error("Reactivate the item category before reactivating this item."), { status: 400 });
    if (current.is_active) return current;
    const { rows } = await client.query(
      `UPDATE menu_items
       SET is_active = true, availability = 'AVAILABLE', updated_at = now()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id, name, category_id, is_active`,
      [req.params.id, req.user.restaurant_id]
    );
    await audit(client, req.user.restaurant_id, req.user.id, "MENU_ITEM_REACTIVATED", "MENU_ITEM", rows[0].id, { name: rows[0].name });
    return rows[0];
  });
  res.json({ item: { id: item.id, name: item.name, categoryId: item.category_id, isActive: item.is_active } });
}));
app.post("/api/tables/bulk", requireAuth, requireCsrf, requirePermission("manage_tables"), asyncHandler(async (req, res) => {
  const { count } = tableBatchSchema.parse(req.body);
  const created = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query(
      `SELECT name, position FROM dining_tables WHERE restaurant_id = $1 ORDER BY position, name FOR UPDATE`,
      [req.user.restaurant_id]
    );
    const existingNumbers = new Set(existingRows.map((row) => /^T(\d+)$/i.exec(row.name)?.[1]).filter(Boolean).map(Number));
    let nextNumber = 1;
    const newTables = [];
    const maxPosition = existingRows.reduce((max, row) => Math.max(max, Number(row.position || 0)), 0);
    for (let index = 0; index < count; index += 1) {
      while (existingNumbers.has(nextNumber)) nextNumber += 1;
      const name = `T${nextNumber}`;
      const { rows } = await client.query(
        `INSERT INTO dining_tables (restaurant_id, name, position)
         VALUES ($1,$2,$3) RETURNING id, name, position, is_active`,
        [req.user.restaurant_id, name, maxPosition + index + 1]
      );
      existingNumbers.add(nextNumber);
      newTables.push(rows[0]);
      nextNumber += 1;
    }
    await audit(client, req.user.restaurant_id, req.user.id, "TABLES_CREATED_BULK", "RESTAURANT", req.user.restaurant_id, { count, tableNames: newTables.map((table) => table.name) });
    return newTables;
  });
  res.status(201).json({ tables: created });
}));
app.post("/api/tables/next", requireAuth, requireCsrf, requirePermission("manage_tables"), asyncHandler(async (req, res) => {
  const table = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, name, position, is_active FROM dining_tables WHERE restaurant_id = $1 FOR UPDATE`,
      [req.user.restaurant_id]
    );
    const activeNumbers = new Set(rows.filter((row) => row.is_active).map((row) => /^T(\d+)$/i.exec(row.name)?.[1]).filter(Boolean).map(Number));
    let nextNumber = 1;
    while (activeNumbers.has(nextNumber)) nextNumber += 1;
    const name = `T${nextNumber}`;
    const nextPosition = rows.filter((row) => row.is_active).reduce((max, row) => Math.max(max, Number(row.position || 0)), 0) + 1;
    const archived = rows.find((row) => !row.is_active && row.name.toUpperCase() === name);
    let result;
    if (archived) {
      result = await client.query(`UPDATE dining_tables SET is_active = TRUE, position = $2 WHERE id = $1 RETURNING id,name,position,is_active`, [archived.id, nextPosition]);
    } else {
      result = await client.query(`INSERT INTO dining_tables (restaurant_id,name,position) VALUES($1,$2,$3) RETURNING id,name,position,is_active`, [req.user.restaurant_id, name, nextPosition]);
    }
    await audit(client, req.user.restaurant_id, req.user.id, "TABLE_CREATED", "TABLE", result.rows[0].id, { name, source: "table-view-plus", reusedArchived: Boolean(archived) });
    return result.rows[0];
  });
  res.status(201).json({ table });
}));
app.post("/api/tables", requireAuth, requireCsrf, requirePermission("manage_tables"), asyncHandler(async (req, res) => {
  const payload = tableSchema.parse(req.body);
  const table = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO dining_tables (restaurant_id, name, position)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [req.user.restaurant_id, payload.name, payload.position]
    );
    await audit(client, req.user.restaurant_id, req.user.id, "TABLE_CREATED", "TABLE", rows[0].id, { name: payload.name });
    return rows[0];
  });
  res.status(201).json({ table });
}));
app.put("/api/tables/:id", requireAuth, requireCsrf, requirePermission("manage_tables"), asyncHandler(async (req, res) => {
  const payload = tableSchema.parse(req.body);
  const table = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE dining_tables
       SET name = $3, position = $4
       WHERE id = $1 AND restaurant_id = $2 AND is_active = true
       RETURNING id, name, position, is_active`,
      [req.params.id, req.user.restaurant_id, payload.name, payload.position]
    );
    if (!rows[0]) throw Object.assign(new Error("Table not found."), { status: 404 });
    await audit(client, req.user.restaurant_id, req.user.id, "TABLE_UPDATED", "TABLE", rows[0].id, { name: rows[0].name, position: rows[0].position });
    return rows[0];
  });
  res.json({ table });
}));
app.delete("/api/tables/:id", requireAuth, requireCsrf, requirePermission("manage_tables"), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const { rows: tableRows } = await client.query(
      `SELECT id
       FROM dining_tables
       WHERE id = $1 AND restaurant_id = $2 AND is_active = true
       FOR UPDATE`,
      [req.params.id, req.user.restaurant_id]
    );
    if (!tableRows[0]) throw Object.assign(new Error("Table not found."), { status: 404 });
    const { rows: open } = await client.query(
      `SELECT id FROM orders
       WHERE table_id = $1 AND restaurant_id = $2 AND status = 'OPEN'`,
      [req.params.id, req.user.restaurant_id]
    );
    if (open[0]) throw Object.assign(new Error("Cannot deactivate a table with an open order."), { status: 400 });
    await client.query("UPDATE dining_tables SET is_active = false WHERE id = $1", [req.params.id]);
    await audit(client, req.user.restaurant_id, req.user.id, "TABLE_DEACTIVATED", "TABLE", req.params.id);
  });
  res.status(204).end();
}));
const here = path.dirname(fileURLToPath(import.meta.url));
const directQrDist = path.resolve(here, "../public/directqr");
const directQrCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "img-src 'self' data:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
function sendDirectQrFile(file) {
  return (_req, res) => {
    res.set('Content-Security-Policy', directQrCsp);
    res.set('Cache-Control', 'no-store, max-age=0, private');
    return res.sendFile(path.join(directQrDist, file));
  };
}
if (fs.existsSync(directQrDist)) {
  app.use('/order/assets', express.static(path.join(directQrDist, 'assets'), { maxAge: '1h', etag: true }));
  app.get('/order/privacy-policy.html', sendDirectQrFile('privacy-policy.html'));
  app.get('/order/:slug/:token', sendDirectQrFile('index.html'));
}
const clientDist = path.resolve(here, "../../web/dist");
if (isProduction && fs.existsSync(clientDist)) {
  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
    return res.sendFile(path.join(clientDist, 'sw.js'));
  });
  app.use(express.static(clientDist, { maxAge: "1h", etag: true }));
  app.get("{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith('/order')) return next();
    return res.sendFile(path.join(clientDist, "index.html"));
  });
}
app.use((error, _req, res, _next) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Invalid request data.",
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  if (error?.code === "23505") return res.status(409).json({ message: "A record with that value already exists." });
  if (error?.code === "23514") return res.status(400).json({ message: "One of the values does not meet the POS data rules. Review the highlighted form values and try again." });
  if (error?.code === "23503") return res.status(400).json({ message: "The selected category or related menu data is no longer available. Reload Menu Management and try again." });
  if (error?.code === "42703" || error?.code === "42P01") return res.status(503).json({ message: "The POS database schema is out of date. Run npm run db:schema, then restart the API before retrying.", code: "SCHEMA_MIGRATION_REQUIRED" });
  if (error?.code === "40001" || error?.code === "40P01") return res.status(409).json({ message: "The record changed while processing. Reload and retry." });
  if (error?.status) {
    return res.status(error.status).json({
      message: error.message,
      ...(Array.isArray(error.details) ? { details: error.details } : {}),
    });
  }
  if (error?.message === "Origin is not allowed by CORS.") return res.status(403).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: "Unexpected server error." });
});
app.listen(port, () => console.log(`DirectQR API running on http://localhost:${port}`));
process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
