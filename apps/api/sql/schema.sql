CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('OWNER', 'MANAGER', 'CASHIER', 'WAITER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('OPEN', 'COMPLETED', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('UNPAID', 'PARTIAL', 'PAID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('CASH', 'UPI', 'CARD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_event_type AS ENUM ('ORDER_OPENED', 'ORDER_UPDATED', 'KOT_SENT', 'SETTLED', 'BILL_PRINT_REQUESTED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  login_id VARCHAR(32) UNIQUE,
  phone VARCHAR(30),
  address TEXT,
  gstin VARCHAR(20),
  bill_prefix VARCHAR(20) NOT NULL DEFAULT 'ORD',
  currency VARCHAR(5) NOT NULL DEFAULT 'INR',
  logo_url TEXT,
  theme_color VARCHAR(16) NOT NULL DEFAULT '#E85D04',
  next_order_number BIGINT NOT NULL DEFAULT 1,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  opening_time TIME NOT NULL DEFAULT '09:00',
  closing_time TIME NOT NULL DEFAULT '22:00',
  void_password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  username VARCHAR(64) NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  role user_role NOT NULL DEFAULT 'CASHIER',
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until TIMESTAMPTZ,
  login_failure_window_started_at TIMESTAMPTZ,
  password_reset_required BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_restaurant_username ON users(restaurant_id, username);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(32) NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (restaurant_id, name)
);

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  food_type VARCHAR(7) NOT NULL DEFAULT 'VEG' CHECK (food_type IN ('VEG', 'NON_VEG')),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(300) NOT NULL DEFAULT '',
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  gst_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  availability VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE' CHECK (availability IN ('AVAILABLE', 'OUT_OF_STOCK', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS addon_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS addon_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addon_group_id UUID NOT NULL REFERENCES addon_groups(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID REFERENCES dining_tables(id) ON DELETE SET NULL,
  order_number BIGINT NOT NULL,
  status order_status NOT NULL DEFAULT 'OPEN',
  payment_status payment_status NOT NULL DEFAULT 'UNPAID',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_type VARCHAR(10) CHECK (discount_type IN ('PERCENT', 'FIXED') OR discount_type IS NULL),
  discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  round_off NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes VARCHAR(500),
  customer_name VARCHAR(120),
  customer_mobile VARCHAR(16),
  kot_sequence INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  void_reason VARCHAR(250),
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_authorized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ,
  bill_print_requested_at TIMESTAMPTZ,
  bill_locked_at TIMESTAMPTZ,
  restaurant_name_snapshot VARCHAR(120),
  restaurant_address_snapshot TEXT,
  restaurant_phone_snapshot VARCHAR(30),
  restaurant_gstin_snapshot VARCHAR(20),
  bill_prefix_snapshot VARCHAR(20),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, order_number)
);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name VARCHAR(120) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  gst_rate NUMERIC(5,2) NOT NULL,
  gst_inclusive BOOLEAN NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  sent_to_kitchen_qty INTEGER NOT NULL DEFAULT 0 CHECK (sent_to_kitchen_qty >= 0),
  addons_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  addon_unit_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_taxable_before_discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_cgst NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_sgst NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kot_prints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  business_date DATE,
  daily_kot_number INTEGER,
  sequence INTEGER NOT NULL,
  items JSONB NOT NULL,
  printed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id, sequence)
);

CREATE TABLE IF NOT EXISTS restaurant_kot_days (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  next_kot_number INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (restaurant_id, business_date)
);

CREATE TABLE IF NOT EXISTS order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type order_event_type NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe additive migrations for existing local databases.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS next_order_number BIGINT NOT NULL DEFAULT 1;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS login_id VARCHAR(32);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opening_time TIME NOT NULL DEFAULT '09:00';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS closing_time TIME NOT NULL DEFAULT '22:00';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS void_password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_failure_window_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE menu_items ALTER COLUMN gst_inclusive SET DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_mobile VARCHAR(16);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_off NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_print_requested_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_locked_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS void_authorized_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restaurant_name_snapshot VARCHAR(120);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restaurant_address_snapshot TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restaurant_phone_snapshot VARCHAR(30);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restaurant_gstin_snapshot VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_prefix_snapshot VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_cgst NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_sgst NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE kot_prints ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE;
ALTER TABLE kot_prints ADD COLUMN IF NOT EXISTS business_date DATE;
ALTER TABLE kot_prints ADD COLUMN IF NOT EXISTS daily_kot_number INTEGER;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS food_type VARCHAR(7) NOT NULL DEFAULT 'VEG';

-- V1.4 outlet operations additions. Existing categories default to Vegetarian until the owner updates them.
UPDATE categories SET food_type = 'VEG' WHERE food_type IS NULL OR food_type NOT IN ('VEG', 'NON_VEG');
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_food_type_check;
ALTER TABLE categories ADD CONSTRAINT categories_food_type_check CHECK (food_type IN ('VEG', 'NON_VEG'));

-- New restaurants start with the normal T1–T4 layout. Tables are ordinary records and can still be deactivated when free.
CREATE OR REPLACE FUNCTION forgearc_create_default_tables() RETURNS trigger AS $$
BEGIN
  INSERT INTO dining_tables (restaurant_id, name, position)
  VALUES (NEW.id, 'T1', 1), (NEW.id, 'T2', 2), (NEW.id, 'T3', 3), (NEW.id, 'T4', 4)
  ON CONFLICT (restaurant_id, name) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forgearc_default_tables_after_restaurant_insert ON restaurants;
CREATE TRIGGER forgearc_default_tables_after_restaurant_insert
AFTER INSERT ON restaurants
FOR EACH ROW EXECUTE FUNCTION forgearc_create_default_tables();

-- V1.3 immutable Restaurant IDs. Existing demo outlets receive predictable IDs;
-- all other outlets receive a generated 16-character ID derived from their UUID.
UPDATE restaurants
SET login_id = CASE lower(slug)
  WHEN 'coffea-demo' THEN 'FACOFFEA2026'
  WHEN 'forgearc-test' THEN 'FABISTRO2026'
  ELSE 'FA' || upper(substr(replace(id::text, '-', ''), 1, 14))
END
WHERE login_id IS NULL OR login_id !~ '^[A-Z0-9]{12,32}$';

UPDATE kot_prints kp
SET restaurant_id = o.restaurant_id
FROM orders o
WHERE o.id = kp.order_id AND kp.restaurant_id IS NULL;

UPDATE kot_prints
SET business_date = printed_at::date
WHERE business_date IS NULL;

-- V1 menu prices are always before-tax. Existing order-item snapshots are
-- deliberately untouched, so historic orders remain internally consistent.
UPDATE menu_items SET gst_inclusive = FALSE WHERE gst_inclusive = TRUE;

UPDATE restaurants r
SET next_order_number = GREATEST(
  r.next_order_number,
  COALESCE((SELECT MAX(o.order_number) + 1 FROM orders o WHERE o.restaurant_id = r.id), 1)
);

UPDATE orders
SET cgst_amount = trunc(gst_amount * 100 / 2) / 100,
    sgst_amount = gst_amount - (trunc(gst_amount * 100 / 2) / 100)
WHERE gst_amount <> 0 AND cgst_amount = 0 AND sgst_amount = 0;

UPDATE order_items
SET line_cgst = trunc(line_gst * 100 / 2) / 100,
    line_sgst = line_gst - (trunc(line_gst * 100 / 2) / 100)
WHERE line_gst <> 0 AND line_cgst = 0 AND line_sgst = 0;

UPDATE orders
SET round_off = round(grand_total) - grand_total
WHERE status = 'COMPLETED' AND round_off = 0 AND grand_total <> round(grand_total);

UPDATE orders o
SET restaurant_name_snapshot = r.name,
    restaurant_address_snapshot = r.address,
    restaurant_phone_snapshot = r.phone,
    restaurant_gstin_snapshot = r.gstin,
    bill_prefix_snapshot = r.bill_prefix
FROM restaurants r
WHERE r.id = o.restaurant_id
  AND o.status = 'COMPLETED'
  AND o.restaurant_name_snapshot IS NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_restaurant_username ON users(restaurant_id, username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_login_id ON restaurants(login_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kot_daily_unique ON kot_prints(restaurant_id, business_date, daily_kot_number) WHERE daily_kot_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_order_per_table
  ON orders(table_id) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON dining_tables(restaurant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id, category_id, is_active);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status ON orders(restaurant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(restaurant_id, completed_at DESC) WHERE status = 'COMPLETED';
CREATE INDEX IF NOT EXISTS idx_orders_voided ON orders(restaurant_id, voided_at DESC) WHERE status = 'VOID';
CREATE INDEX IF NOT EXISTS idx_orders_table_open ON orders(table_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_kot_prints_order ON kot_prints(order_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_restaurant ON audit_logs(restaurant_id, created_at DESC);


-- V1.4.1 role permissions, availability states and safe table-number reuse.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'WAITER';
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS availability VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_availability_check;
ALTER TABLE menu_items ADD CONSTRAINT menu_items_availability_check CHECK (availability IN ('AVAILABLE', 'OUT_OF_STOCK', 'INACTIVE'));
UPDATE menu_items SET availability = 'INACTIVE'
WHERE is_active = FALSE AND availability <> 'INACTIVE';
UPDATE menu_items SET availability = 'AVAILABLE'
WHERE is_active = TRUE AND (availability IS NULL OR availability NOT IN ('AVAILABLE', 'OUT_OF_STOCK', 'INACTIVE'));
UPDATE users SET permissions = CASE role
  WHEN 'WAITER' THEN '{"view_tables":true,"create_orders":true,"send_kot":true,"print_bill":false,"settle_payment":false,"view_reports":false,"view_customer_details":false,"edit_menu":false,"manage_tables":false,"void_orders":true,"reprint_bill":false,"apply_discount":false}'::jsonb
  WHEN 'MANAGER' THEN '{"view_tables":true,"create_orders":true,"send_kot":true,"print_bill":true,"settle_payment":true,"view_reports":true,"view_customer_details":true,"edit_menu":true,"manage_tables":true,"void_orders":true,"reprint_bill":true,"apply_discount":true}'::jsonb
  WHEN 'CASHIER' THEN '{"view_tables":true,"create_orders":true,"send_kot":true,"print_bill":true,"settle_payment":true,"view_reports":true,"view_customer_details":true,"edit_menu":false,"manage_tables":false,"void_orders":true,"reprint_bill":true,"apply_discount":false}'::jsonb
  ELSE permissions END
WHERE permissions = '{}'::jsonb OR permissions IS NULL;

-- V1.4.3 UI stabilisation: takeaway orders and fixed container charges.
-- All statements are additive so this file can be applied to an existing V1.4.2 database.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS container_charge_gst_rate NUMERIC(5,2) NOT NULL DEFAULT 5;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(16) NOT NULL DEFAULT 'DINE_IN',
  ADD COLUMN IF NOT EXISTS takeaway_token INTEGER,
  ADD COLUMN IF NOT EXISTS takeaway_business_date DATE,
  ADD COLUMN IF NOT EXISTS container_charge NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS container_gst_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS container_taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS container_cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS container_sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS container_gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check CHECK (order_type IN ('DINE_IN', 'TAKEAWAY'));

CREATE TABLE IF NOT EXISTS restaurant_takeaway_days (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  next_takeaway_number INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (restaurant_id, business_date)
);

UPDATE orders
SET order_type = 'DINE_IN'
WHERE order_type IS NULL OR order_type NOT IN ('DINE_IN', 'TAKEAWAY');

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_takeaway_daily_token
  ON orders(restaurant_id, takeaway_business_date, takeaway_token)
  WHERE order_type = 'TAKEAWAY' AND takeaway_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_open_takeaway
  ON orders(restaurant_id, order_type, status, created_at DESC)
  WHERE order_type = 'TAKEAWAY' AND status = 'OPEN';


-- V1.4.4 order detail persistence and launch refinements.
-- Customer contact storage matches the validated 32-character field used by the POS UI.
ALTER TABLE orders ALTER COLUMN customer_mobile TYPE VARCHAR(32);

-- V1.5.0 DirectQR integration. QR requests are deliberately kept separate from
-- operational POS orders until restaurant staff accept them.
DO $$ BEGIN
  CREATE TYPE qr_order_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public_table_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (table_id)
);

CREATE TABLE IF NOT EXISTS customer_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(120) NOT NULL,
  username VARCHAR(64) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_username_ci
  ON customer_accounts (lower(username));

CREATE TABLE IF NOT EXISTS customer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_captcha_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES dining_tables(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  status qr_order_status NOT NULL DEFAULT 'PENDING',
  requested_items JSONB NOT NULL,
  items_snapshot JSONB NOT NULL,
  guest_count INTEGER CHECK (guest_count IS NULL OR (guest_count >= 1 AND guest_count <= 20)),
  notes VARCHAR(500),
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  round_off NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  accepted_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  rejection_reason VARCHAR(250),
  processed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing tables receive high-entropy QR tokens automatically. The owner can
-- retrieve each token through the protected QR-link endpoint after upgrade.
INSERT INTO public_table_tokens (restaurant_id, table_id, token)
SELECT d.restaurant_id, d.id, encode(gen_random_bytes(18), 'hex')
FROM dining_tables d
LEFT JOIN public_table_tokens t ON t.table_id = d.id
WHERE t.id IS NULL;

CREATE INDEX IF NOT EXISTS idx_public_table_tokens_lookup
  ON public_table_tokens (restaurant_id, token) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_customer_sessions_active
  ON customer_sessions(customer_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customer_captcha_active
  ON customer_captcha_challenges(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_qr_orders_restaurant_status
  ON qr_orders(restaurant_id, status, created_at DESC);
-- v1.6.2: several guests may submit separate QR requests for one table.
-- A single customer may still have only one unreviewed request at that table.
DROP INDEX IF EXISTS idx_one_pending_qr_order_per_table;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_qr_order_per_customer_table
  ON qr_orders(table_id, customer_id) WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION forgearc_create_public_table_token() RETURNS trigger AS $$
BEGIN
  INSERT INTO public_table_tokens (restaurant_id, table_id, token)
  VALUES (NEW.restaurant_id, NEW.id, encode(gen_random_bytes(18), 'hex'))
  ON CONFLICT (table_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forgearc_public_table_token_after_insert ON dining_tables;
CREATE TRIGGER forgearc_public_table_token_after_insert
AFTER INSERT ON dining_tables
FOR EACH ROW EXECUTE FUNCTION forgearc_create_public_table_token();


-- V1.5.2: optional customer-facing descriptions for DirectQR menu items.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS description VARCHAR(300) NOT NULL DEFAULT '';

-- v1.7.0 — ForgeArc Super Admin and commercial controls.
-- These structures are additive so existing single-outlet deployments retain their current data.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS operational_status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_operational_status_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_operational_status_check
  CHECK (operational_status IN ('SETUP_PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS super_admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_super_admin_users_username_ci
  ON super_admin_users (lower(username));

CREATE TABLE IF NOT EXISTS super_admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id UUID NOT NULL REFERENCES super_admin_users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_super_admin_sessions_active
  ON super_admin_sessions(super_admin_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS restaurant_features (
  restaurant_id UUID PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  direct_qr_ordering BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_super_admin_id UUID REFERENCES super_admin_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_commercials (
  restaurant_id UUID PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  base_package_name VARCHAR(120) NOT NULL DEFAULT 'ForgeArc Mini POS Base Package',
  base_license_amount NUMERIC(12,2) NOT NULL DEFAULT 3999 CHECK (base_license_amount >= 0),
  base_payment_cycle VARCHAR(20) NOT NULL DEFAULT 'YEARLY' CHECK (base_payment_cycle = 'YEARLY'),
  base_payment_status VARCHAR(24) NOT NULL DEFAULT 'NOT_PAID'
    CHECK (base_payment_status IN ('NOT_PAID', 'PAID', 'EXPIRED')),
  base_license_start_date DATE,
  base_license_end_date DATE,
  support_amount NUMERIC(12,2) NOT NULL DEFAULT 299 CHECK (support_amount >= 0),
  support_payment_cycle VARCHAR(20) NOT NULL DEFAULT 'MONTHLY' CHECK (support_payment_cycle = 'MONTHLY'),
  support_payment_status VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (support_payment_status IN ('NOT_STARTED', 'PAID', 'DUE', 'OVERDUE')),
  support_start_date DATE,
  support_last_payment_date DATE,
  support_next_payment_due DATE,
  qr_ordering_amount NUMERIC(12,2) NOT NULL DEFAULT 1499 CHECK (qr_ordering_amount >= 0),
  qr_ordering_payment_cycle VARCHAR(20) NOT NULL DEFAULT 'YEARLY' CHECK (qr_ordering_payment_cycle = 'YEARLY'),
  qr_ordering_payment_status VARCHAR(24) NOT NULL DEFAULT 'NOT_PURCHASED'
    CHECK (qr_ordering_payment_status IN ('NOT_PURCHASED', 'PAID', 'EXPIRED')),
  qr_ordering_start_date DATE,
  qr_ordering_end_date DATE,
  updated_by_super_admin_id UUID REFERENCES super_admin_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (base_license_end_date IS NULL OR base_license_start_date IS NULL OR base_license_end_date >= base_license_start_date),
  CHECK (support_next_payment_due IS NULL OR support_start_date IS NULL OR support_next_payment_due >= support_start_date),
  CHECK (qr_ordering_end_date IS NULL OR qr_ordering_start_date IS NULL OR qr_ordering_end_date >= qr_ordering_start_date)
);

-- v1.7.3 commercial lifecycle migration. Older Super Admin builds used
-- DUE_SOON/EXPIRED variants that no longer match the supported state machine.
-- Normalize them first, then replace the generated CHECK constraints safely.
UPDATE restaurant_commercials
SET base_payment_status = CASE
  WHEN base_license_start_date IS NULL THEN 'NOT_PAID'
  ELSE 'PAID'
END
WHERE base_payment_status IN ('DUE_SOON', 'OVERDUE');

UPDATE restaurant_commercials
SET support_payment_status = CASE
  WHEN COALESCE(support_last_payment_date, support_start_date) IS NULL THEN 'NOT_STARTED'
  ELSE 'PAID'
END
WHERE support_payment_status IN ('DUE_SOON', 'EXPIRED');

UPDATE restaurant_commercials
SET qr_ordering_payment_status = CASE
  WHEN qr_ordering_start_date IS NULL THEN 'NOT_PURCHASED'
  ELSE 'PAID'
END
WHERE qr_ordering_payment_status IN ('DUE_SOON', 'OVERDUE');

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'restaurant_commercials'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%base_payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE restaurant_commercials DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  ALTER TABLE restaurant_commercials
    ADD CONSTRAINT restaurant_commercials_base_payment_status_check
    CHECK (base_payment_status IN ('NOT_PAID', 'PAID', 'EXPIRED'));

  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'restaurant_commercials'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%support_payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE restaurant_commercials DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  ALTER TABLE restaurant_commercials
    ADD CONSTRAINT restaurant_commercials_support_payment_status_check
    CHECK (support_payment_status IN ('NOT_STARTED', 'PAID', 'DUE', 'OVERDUE'));

  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'restaurant_commercials'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%qr_ordering_payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE restaurant_commercials DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  ALTER TABLE restaurant_commercials
    ADD CONSTRAINT restaurant_commercials_qr_payment_status_check
    CHECK (qr_ordering_payment_status IN ('NOT_PURCHASED', 'PAID', 'EXPIRED'));
END $$;

CREATE TABLE IF NOT EXISTS restaurant_setup_tasks (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  task_key VARCHAR(48) NOT NULL,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  completed_by_super_admin_id UUID REFERENCES super_admin_users(id) ON DELETE SET NULL,
  PRIMARY KEY (restaurant_id, task_key),
  CHECK (task_key IN ('BASICS', 'OWNER_ACCOUNT', 'OWNER_PASSWORD_CHANGED', 'MENU', 'TABLES', 'GST_BILLING', 'PRINTER_TEST', 'QR_SETUP', 'STAFF_TRAINING', 'GO_LIVE'))
);

CREATE TABLE IF NOT EXISTS super_admin_support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id UUID NOT NULL REFERENCES super_admin_users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason VARCHAR(500) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(scopes) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_super_admin_support_sessions_active
  ON super_admin_support_sessions(restaurant_id, expires_at) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS super_admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id UUID REFERENCES super_admin_users(id) ON DELETE SET NULL,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  support_session_id UUID REFERENCES super_admin_support_sessions(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  before_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_super_admin_audit_logs_restaurant
  ON super_admin_audit_logs(restaurant_id, created_at DESC);

-- Existing restaurants remain operational and gain default commercial/feature rows.
UPDATE restaurants SET operational_status = 'ACTIVE'
WHERE operational_status IS NULL OR operational_status NOT IN ('SETUP_PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');
INSERT INTO restaurant_features (restaurant_id, direct_qr_ordering)
SELECT r.id, TRUE
FROM restaurants r
WHERE NOT EXISTS (SELECT 1 FROM restaurant_features f WHERE f.restaurant_id = r.id)
ON CONFLICT (restaurant_id) DO NOTHING;
INSERT INTO restaurant_commercials (restaurant_id, base_payment_status)
SELECT r.id, 'PAID'
FROM restaurants r
WHERE NOT EXISTS (SELECT 1 FROM restaurant_commercials c WHERE c.restaurant_id = r.id)
ON CONFLICT (restaurant_id) DO NOTHING;
INSERT INTO restaurant_setup_tasks (restaurant_id, task_key, is_completed)
SELECT r.id, task.task_key, CASE WHEN task.task_key = 'OWNER_ACCOUNT' THEN TRUE ELSE FALSE END
FROM restaurants r
CROSS JOIN (VALUES
  ('BASICS'), ('OWNER_ACCOUNT'), ('OWNER_PASSWORD_CHANGED'), ('MENU'), ('TABLES'),
  ('GST_BILLING'), ('PRINTER_TEST'), ('QR_SETUP'), ('STAFF_TRAINING'), ('GO_LIVE')
) AS task(task_key)
ON CONFLICT (restaurant_id, task_key) DO NOTHING;

-- DirectQR v1.0.0 standalone product safeguards.
-- This schema is intended for a dedicated DirectQR PostgreSQL database.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source VARCHAR(24) NOT NULL DEFAULT 'DIRECT_QR';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_source_check CHECK (order_source = 'DIRECT_QR');
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_source VARCHAR(24) NOT NULL DEFAULT 'QR_CUSTOMER';
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_line_source_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_line_source_check CHECK (line_source IN ('QR_CUSTOMER', 'STAFF'));
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- DirectQR uses the Base licence fields as its own annual licence, not a POS/QR add-on.
ALTER TABLE restaurant_commercials ALTER COLUMN base_package_name SET DEFAULT 'DirectQR Annual Licence';
ALTER TABLE restaurant_commercials ALTER COLUMN base_license_amount SET DEFAULT 3000;
ALTER TABLE restaurant_features ALTER COLUMN direct_qr_ordering SET DEFAULT TRUE;

-- Device/browser push subscriptions are scoped to the DirectQR staff/owner account.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_message VARCHAR(300)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_restaurant_user
  ON push_subscriptions(restaurant_id, user_id, updated_at DESC);

-- DirectQR has a mandatory end-to-end QR test during onboarding.
ALTER TABLE restaurant_setup_tasks DROP CONSTRAINT IF EXISTS restaurant_setup_tasks_task_key_check;
ALTER TABLE restaurant_setup_tasks ADD CONSTRAINT restaurant_setup_tasks_task_key_check
  CHECK (task_key IN ('BASICS', 'OWNER_ACCOUNT', 'OWNER_PASSWORD_CHANGED', 'MENU', 'TABLES', 'GST_BILLING', 'PRINTER_TEST', 'QR_SETUP', 'STAFF_TRAINING', 'GO_LIVE'));
