# DirectQR v1.0.0 — Render deployment

## Critical separation rule

Create a **new PostgreSQL database** for DirectQR. Do not use the ForgeArc Mini POS database URL. DirectQR has its own customer accounts, sessions, tables, menus, orders, QR requests, commercial records, and Super Admin data.

## 1. Create the DirectQR PostgreSQL database

In Render:

1. Create PostgreSQL.
2. Give it an unmistakable name, for example `directqr-production-db`.
3. Copy its internal or external connection URL as appropriate for the DirectQR service.
4. Do not run `npm run db:seed` against a client database.

## 2. Create the DirectQR Web Service

1. Push this package to a separate GitHub repository, for example `directqr`.
2. Create a Render Web Service from that repository.
3. Select Docker as the runtime.
4. Keep Dockerfile path as `Dockerfile`.
5. Link the new DirectQR PostgreSQL database through `DATABASE_URL`.

The Docker startup command runs the schema, bootstraps the first Super Admin if needed, skips demo seed if restaurant data already exists, and starts the API.

## 3. Add environment variables

```text
DATABASE_URL=<new DirectQR database URL>
AUTH_PASSWORD_PEPPER=<unique long random secret>
APP_ORIGIN=https://<your-directqr-service>.onrender.com
PUBLIC_APP_URL=https://<your-directqr-service>.onrender.com
NODE_ENV=production
TRUST_PROXY=true
DEFAULT_VOID_PASSWORD=<unique initial void password>
SUPER_ADMIN_USERNAME=<private username>
SUPER_ADMIN_PASSWORD=<unique password, 20+ characters recommended>
SUPER_ADMIN_DISPLAY_NAME=DirectQR Super Admin
```

For browser notifications, also add:

```text
VAPID_SUBJECT=mailto:<your support email>
VAPID_PUBLIC_KEY=<generated public key>
VAPID_PRIVATE_KEY=<generated private key>
```

Generate VAPID values locally before deployment:

```bash
npm run push:keys
```

Keep all values in Render Environment settings. Never commit `.env` files, VAPID private keys, database URLs, password peppers, or admin passwords.

## 4. First deployment checks

After Render deploys, open:

```text
https://<your-directqr-service>.onrender.com/super-admin
```

Sign in with `SUPER_ADMIN_USERNAME` and `SUPER_ADMIN_PASSWORD`.

Create a test DirectQR restaurant. Store the generated temporary owner password immediately because it is shown once only.

## 5. Owner onboarding checks

For the test restaurant:

1. Save restaurant basics.
2. Enter Setup Support.
3. Add initial menu category and active menu item.
4. Confirm at least one table exists.
5. Complete GST/billing and printer test.
6. Print/download a table QR.
7. Scan it on another device.
8. Register a DirectQR customer and submit an order request.
9. Accept it in Live QR Orders.
10. Manually print KOT.
11. Print bill and settle payment.
12. Mark the QR setup, staff training, and go-live setup tasks complete.
13. Confirm the owner changes their temporary password.
14. Verify activation happens automatically only after all required checklist tasks are completed.
15. In Commercial, set the DirectQR annual licence to Paid and choose a start date. Verify the end date is calculated one year later.
16. Set Support to Paid with a payment date. Verify the next due date is one month later.
17. In Settings on a staff phone/browser, enable alerts and run Test notification.

## 6. Operational notes

- Table QR URLs depend on `PUBLIC_APP_URL`. Set it before printing/download QR codes.
- KOT/bill printing uses the browser print flow. A hosted Render service cannot directly print to a café USB thermal printer.
- Use a paid/responsive hosting plan before using live café alerts. A sleeping free service can delay order delivery.
- Configure automated backups for the DirectQR database and test a restore before onboarding paid clients.
- Super Admin is not protected by URL secrecy. Keep the credentials, Render account, GitHub account, and database access private and secured with MFA.

## Current architecture note

This is a standalone DirectQR deployment. Its Super Admin uses the same onboarding logic as Mini POS but operates against the DirectQR database. A later secure control-plane bridge can add a DirectQR entry point inside the Mini POS Super Admin; do not combine databases.
