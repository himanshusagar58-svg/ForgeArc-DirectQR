# DirectQR v1.0.1

DirectQR is a standalone QR-first restaurant ordering platform. It has its **own PostgreSQL database** and must never share the ForgeArc Mini POS database.

Customers scan a table QR, sign in or create a DirectQR account, submit an order request, and staff manually accept or reject it. Accepted requests become an open QR-originated table bill. Staff can add items to an open bill, print KOTs manually, print the final bill, and record cash, UPI, or card payment.

## Product boundary

Included:

- Customer QR menu, mandatory DirectQR signup/login, cart, item add-ons, notes, and status page
- DirectQR-wide customer accounts shared only among DirectQR restaurants
- Pending QR queue with staff accept/reject
- Multiple QR rounds on an open table bill
- Staff-added items only on an existing open QR bill
- Manual KOT printing, bill printing, settlement, void controls, menu and table management
- Basic owner reports: Executive Summary, Sales Summary, Customer Details, and Voided Orders
- Table QR preview, print, PNG download, and ZIP download
- DirectQR Super Admin onboarding, temporary owner passwords, setup checklist, status, commercial lifecycle, Support Mode, and audit trail
- Black, teal, and white staff console with professional SVG icons
- In-app repeating QR alert and Web Push/PWA notification support where the device/browser allows it

Excluded:

- Manual counter-created orders
- Manual table orders with no customer QR request
- Takeaway orders
- Inventory, loyalty, recipe costing, online payments, delivery-platform integrations, silent printing, or advanced analytics

## DirectQR ordering rules

1. Customers may browse before signing in, but an account is mandatory before submitting an order.
2. One DirectQR customer account can be used at multiple DirectQR restaurants. Each restaurant can access only its own related orders and customer relationship.
3. Each QR submission stays a separate pending request.
4. Staff manually accept or reject every request.
5. Accepted later requests merge into an existing open table bill.
6. A request cannot merge once a bill has been printed and is awaiting payment.
7. KOT printing is always manual.
8. Staff may add items only to an existing open DirectQR table bill. The API rejects manually created table/counter orders.

## Commercial model

- DirectQR Annual Licence: **₹3,000/year**
- Technical Support: **₹299/month**

On the Commercial tab after activation:

- `PAID` + licence start date calculates a one-year licence end date.
- The paid annual period is locked while current.
- Annual licence becomes `EXPIRED` on its end date and unlocks for renewal.
- Support payment date calculates the next due date one calendar month later.
- Support becomes `DUE` on the due date and `OVERDUE` seven calendar days later.
- Expiry does not automatically suspend the restaurant. That remains a Super Admin decision.

Initial onboarding covers initial restaurant basics, tables, menu/categories, QR test, and training. Routine menu, price, category, and table changes after go-live are owner-managed. Support covers product bugs and platform errors, not unlimited ongoing data-entry work.

## Super Admin and database separation

DirectQR includes the same onboarding and lifecycle model as the POS Super Admin, but it runs against the **separate DirectQR database**:

- Create a DirectQR restaurant
- Generate a DirectQR restaurant ID and table QR slug
- Create first owner with a one-time temporary password
- Force password change on first login
- Setup Pending → Active only after the required setup checklist is complete
- Manage DirectQR commercial status, support status, restaurant suspension/reactivation, Support Mode, and audit activity

The DirectQR Super Admin route is:

```text
/super-admin
```

A unified cross-product control-plane button inside the existing Mini POS Super Admin is intentionally not connected in this standalone package. It needs a secure service-to-service bridge after the DirectQR deployment URL and control secret are configured. Do not connect this app to the Mini POS database to work around that.

## Setup checklist

A DirectQR restaurant begins in `SETUP_PENDING`. It becomes `ACTIVE` automatically only when all required tasks are complete:

- Restaurant basics
- Owner account created
- Owner changed temporary password (automatic and shown last)
- At least one active category and one active menu item
- At least one active table
- GST/billing details
- Printer test
- DirectQR end-to-end test order accepted, printed, and settled
- Staff training
- Go-live confirmation

Owners can change their temporary password during setup but cannot enter the live DirectQR console until activation.

## Local development

Requirements: Node.js 22+, PostgreSQL 16+.

```bash
cp .env.example .env
npm install
npm run db:schema
npm run db:seed
npm run dev
```

Open the staff/owner console at `http://localhost:5173`.

The public customer page is served by the API at:

```text
http://localhost:8080/order/directqr-demo/<table-token>
```

Get a generated token through the owner console: **Live QR orders → QR codes**.

## Demo credentials

```text
Restaurant ID: DQRDEMO2026
Owner username: directqr-demo
Owner password: DirectQR@2026!
Shared void password: Void@2026!

Restaurant ID: DQRBISTRO2026
Owner username: directqr-bistro
Owner password: DirectQR@2026!
```

These credentials are for local development only. Change all passwords and secrets for any real deployment.

## Environment variables

```text
DATABASE_URL=<DirectQR PostgreSQL URL only>
AUTH_PASSWORD_PEPPER=<unique long random secret>
APP_ORIGIN=<DirectQR staff console URL>
PUBLIC_APP_URL=<DirectQR public URL used in table QR links>
NODE_ENV=production
TRUST_PROXY=true
DEFAULT_VOID_PASSWORD=<unique initial void password>
SUPER_ADMIN_USERNAME=<private DirectQR super-admin username>
SUPER_ADMIN_PASSWORD=<unique 12+ character password>
SUPER_ADMIN_DISPLAY_NAME=DirectQR Super Admin

# Optional but required for notification-bar push alerts
VAPID_SUBJECT=mailto:your-support-email@example.com
VAPID_PUBLIC_KEY=<generated VAPID public key>
VAPID_PRIVATE_KEY=<generated VAPID private key>
```

Generate VAPID keys locally with:

```bash
npm run push:keys
```

## Notifications

- When the staff console is open, new QR requests arrive through SSE and trigger the repeating order sound after staff enables sound once.
- Browser notification-bar alerts require user permission and supported browser/PWA capability.
- For iPhone/iPad, staff should install DirectQR to the Home Screen, open the installed web app, log in, and enable alerts.
- Device/browser settings, Focus mode, low-power restrictions, network loss, and user permission can suppress notifications. Do not promise notification delivery on every device/browser.
- Use the **Test notification** button in Settings during onboarding.

## Deploying on Render

Use a separate Render PostgreSQL database and separate Render Web Service. Follow [DEPLOYMENT.md](DEPLOYMENT.md) and [RENDER-TESTING.md](RENDER-TESTING.md).

## Validation performed for this package

- API syntax check
- Automated test suite
- React/Vite production build

Live PostgreSQL migration, deployed Render service, customer browser flow, PWA installation, and actual push delivery still require verification on your own environment.
