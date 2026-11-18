# Unstuck for Android

A small native app that gets Unstuck Cloud alerts through Firebase Cloud Messaging at high priority and opens the
takeover in its own viewer. It's a beta, installed by hand (no Play Store yet). Apache-2.0, like the viewer and SDKs.

## How it keeps alerts private

- **The phone's own key.** Pairing creates a P-256 key pair on the phone. The private key stays in the Android Keystore
  (StrongBox when the phone has it) and can't be exported. Cloud only ever gets the public key.
- **Sealed alerts.** Cloud sends a data-only FCM message with the alert sealed to that key, the same blob web push
  carries (`protocol/src/alerts.ts`). Neither Cloud nor Google can read the link; the app unseals it on the phone.
- **The link stays on the phone.** The plain link exists only in memory and in the viewer's URL fragment, which is
  never sent over the network. Notifications carry the sealed link and unseal it again when tapped.
- **The viewer is the hosted one.** The app shows `view.unstuck.sh` in a WebView locked to that origin (anything else
  opens in your browser), with no JavaScript bridge and no file access. It's the same open-source viewer the browser
  shows, so there's no second copy to audit.
- **No battery drain.** No background service, no connection of its own: FCM wakes the app.

## Build

You need JDK 17+ and the Android SDK (`scripts/setup-sdk.sh` installs it into `~/android-sdk`).

```bash
./scripts/setup-sdk.sh
echo "sdk.dir=$HOME/android-sdk" > local.properties
./gradlew testProdDebugUnitTest assembleProdDebug
```

Two flavors: `prod` (`sh.unstuck.android`, unstuck.sh) and `staging` (`sh.unstuck.android.staging`, the staging
servers; installs next to prod).

Alerts need a Firebase project: put its `google-services.json` (shape: `google-services.example.json`) at
`app/google-services.json`. It is never committed. Without it the app builds and its tests run, but it can't receive
alerts, and a release build stops with "google-services.json missing". Anyone can build from source with their own
Firebase project; only the owner's signed build gets Unstuck Cloud's alerts.

The release signing key and its password are never committed.
