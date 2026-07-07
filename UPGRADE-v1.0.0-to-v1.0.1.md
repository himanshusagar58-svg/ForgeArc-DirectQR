# DirectQR v1.0.0 → v1.0.1

## What this release fixes

- Restores the DirectQR operator console, Super Admin, and customer QR page to the same light visual system used by ForgeArc Mini POS.
- Removes the conflicting black/teal override that caused low-contrast text and inconsistent panels.
- Stops looping QR sound immediately once the pending QR queue is empty, including cancelling already-scheduled tones.
- Makes browser notification setup more robust after a VAPID key change and avoids cache-stale service workers.
- Keeps DirectQR online if VAPID environment variables are malformed; the notification UI now reports configuration failure instead of crashing the whole service.

## Render upgrade

1. Replace the current DirectQR GitHub repository contents with this release and push to `main`.
2. In Render, deploy the latest commit.
3. Keep the existing DirectQR database and all current environment variables. No SQL command is required.
4. After deployment, force-refresh the browser (`Ctrl + Shift + R`).
5. If you previously tried notifications, open DirectQR in the staff browser and click **Enable mobile alerts** again. The application will replace a stale subscription automatically when VAPID keys changed.
6. Test a QR order: create a pending request, enable sound, accept/reject it, and verify sound stops immediately.

## Browser notification note

Web Push requires notification permission and a browser/device push service. DirectQR supports the standard Push API, but a browser can still deny or block its own push service. In Brave, permit notifications and Push Messaging for the site; on iPhone/iPad, install DirectQR to the Home Screen before enabling alerts. The live DirectQR console and looping sound remain the fallback when browser push is unavailable.
