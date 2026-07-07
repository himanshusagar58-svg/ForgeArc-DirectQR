# DirectQR v1.0.1 — Live acceptance test

Run this only after deploying to HTTPS.

## Core QR flow

1. Sign in as the test restaurant owner.
2. Open **Live QR orders → QR codes**.
3. Download or print a QR code for one table.
4. On a second device, scan the QR.
5. Confirm the customer can browse without an account but cannot submit until DirectQR login/signup completes.
6. Create a DirectQR customer account.
7. Submit an order with an add-on and note.
8. Confirm it appears as Pending in the staff console.
9. Accept it; confirm an open table bill is created.
10. Submit a second order from the same QR and accept it; confirm it merges into the same open bill.
11. Print KOT manually. Confirm acceptance did not print automatically.
12. Add an item from the staff console to the same open bill; confirm it appears in the bill.
13. Print the bill. Then submit another QR order and confirm staff cannot merge it into the bill awaiting payment.
14. Settle the bill using Cash, UPI, and Card test cases.

## Notifications

1. In the staff console, click **Enable order sound** once.
2. Submit a new QR request and verify the sound repeats while the queue contains a pending order.
3. Accept or reject the request and verify sound stops after queue is clear.
4. In Settings, enable browser alerts and press Test notification.
5. On iPhone/iPad, add DirectQR to the Home Screen first, open it from Home Screen, then grant notification permission.

## Tenant isolation

1. Create two DirectQR restaurants.
2. Sign in as staff at restaurant A.
3. Verify restaurant A cannot view restaurant B menu, tables, QR requests, orders, reports, or QR codes.
4. Register a customer at restaurant A. Sign into restaurant B customer page with the same DirectQR account. Verify the account works but restaurant B sees only its own orders.

## Super Admin lifecycle

1. Create a new DirectQR restaurant.
2. Confirm status begins at Setup Pending and commercial tab is hidden.
3. Verify owner login forces password change and blocks console access until setup activation.
4. Complete all setup tasks and confirm automatic activation.
5. Confirm an active restaurant cannot move back to Setup Pending.
6. Test Suspend, Disabled, and Reactivate states.
7. Confirm Commercials shows ₹3,000 annual licence and ₹299/month support.

## Reports

1. Settle at least two non-voided orders.
2. Confirm Executive Summary, Sales Summary, Customer Details, and Voided Orders load.
3. Confirm reports are tenant-scoped.
4. Void a test order and confirm revenue reports do not include it while Voided Orders does.
