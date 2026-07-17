// Firebase Cloud Messaging — the only way an Android phone rings while the app is
// closed. Socket.io covers the app-is-open case and nothing else; FCM is what makes
// a new prescription reach the PRO who has their phone in their pocket.
//
// Credentials come from FIREBASE_SERVICE_ACCOUNT (a JSON string, which is how Render
// takes it) or from a service-account file on disk for local work. With neither, every
// send logs and reports not_configured — the same seam the SMS and email adapters use,
// so the app runs fine on a laptop with no Firebase project attached.
//
// firebase-admin v13+ is modular only: the old `admin.credential.cert()` namespace is
// gone, and reaching for it yields `undefined is not a function` rather than a helpful
// error. Import from the subpaths.

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// Heads-up + sound + vibrate on Android 8+ is a property of the CHANNEL, not the
// message. The app creates a channel with this exact id at startup; if the two ever
// disagree, Android silently drops the notification into the low-priority tray and
// the phone never makes a sound.
const CHANNEL_ID = 'heritage-alerts';

let app = null;
let initialised = false;

function credential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      // Render's env editor tends to hand back the JSON with escaped newlines in
      // private_key; JSON.parse un-escapes them, which is exactly what cert() wants.
      return cert(JSON.parse(raw));
    } catch (error) {
      // Loud on purpose. A malformed key here means every phone goes quiet, and the
      // only symptom is silence — there is no failing request to notice.
      console.error('[push] FIREBASE_SERVICE_ACCOUNT is set but unusable:', error.message);
      return null;
    }
  }

  const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE
    || require('path').join(__dirname, '..', 'firebase-service-account.json');

  if (!require('fs').existsSync(file)) return null;   // genuinely not configured

  try {
    return cert(require(file));
  } catch (error) {
    // The file exists but is broken — that is a mistake to shout about, not to treat
    // as "no Firebase configured".
    console.error(`[push] ${file} exists but could not be loaded:`, error.message);
    return null;
  }
}

function init() {
  if (initialised) return app;
  initialised = true;

  const cred = credential();
  if (!cred) {
    console.log('[push] no Firebase credentials — push notifications will only be logged.');
    return null;
  }

  // Re-using an existing app matters for the test suite, which loads this module more
  // than once; initializeApp twice throws.
  app = getApps().length ? getApps()[0] : initializeApp({ credential: cred });
  console.log('[push] Firebase ready — devices will be woken by FCM.');
  return app;
}

const isConfigured = () => Boolean(init());

// A token dies when the app is uninstalled, storage is cleared, or Android decides to
// reissue it. FCM tells us so; carrying on with a dead token means every later send to
// that user fails too, so the caller is told to forget it.
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * @returns {Promise<{sent: boolean, reason?: string, dead?: boolean}>}
 *   `dead: true` means the caller should clear this token from the user's record.
 */
async function send(token, title, body, data = {}) {
  if (!token) return { sent: false, reason: 'no_token' };

  const ready = init();
  if (!ready) {
    console.log(`[push:dev] -> ${String(token).slice(0, 12)}…: ${title} — ${body}`);
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await getMessaging(ready).send({
      token,
      // The `notification` block is what lets Android draw the notification itself
      // while the app is dead. A data-only message would need the app to be alive to
      // render it — which is the very thing that is broken today.
      notification: { title, body },
      data: Object.fromEntries(
        // FCM rejects non-string data values outright rather than coercing them.
        Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
      ),
      android: {
        // "high" is what gets a sleeping phone woken out of Doze. Normal priority is
        // batched and can sit for minutes — useless for "an agent is at your door".
        priority: 'high',
        notification: {
          channelId: CHANNEL_ID,
          sound: 'default',
          defaultVibrateTimings: true,
          icon: 'ic_notification',
          color: '#5E111B',   // C.maroon — the same brand colour the app is built in
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
        headers: { 'apns-priority': '10' },
      },
    });
    return { sent: true };
  } catch (error) {
    const code = error?.errorInfo?.code || error?.code;
    if (DEAD_TOKEN.has(code)) return { sent: false, reason: 'dead_token', dead: true };
    throw error;
  }
}

module.exports = { send, isConfigured, CHANNEL_ID };
