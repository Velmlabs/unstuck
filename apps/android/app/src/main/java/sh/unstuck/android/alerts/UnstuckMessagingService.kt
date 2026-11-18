package sh.unstuck.android.alerts

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import sh.unstuck.android.BuildConfig
import sh.unstuck.android.crypto.AlertCrypto
import sh.unstuck.android.crypto.AlertPayload
import sh.unstuck.android.pair.DeviceKeys
import sh.unstuck.android.pair.Forget
import sh.unstuck.android.pair.EncryptedPairingStore
import sh.unstuck.android.pair.PairApi
import sh.unstuck.android.pair.PairException
import sh.unstuck.android.viewer.trustedAlertLink

/** FCM wakes the app with a data message; the alert is unsealed here, on the phone. */
class UnstuckMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(message: RemoteMessage) {
        val deviceId = runCatching { EncryptedPairingStore(this).load()?.deviceId }.getOrNull()
        val now = System.currentTimeMillis()
        val spec = AlertHandler.handle(message.data, now, BuildConfig.VIEW_ORIGIN, deviceId) { link -> unseal(this, link) } ?: return
        Notifications.show(this, spec)
        // Only a notification the person can see counts as "the test arrived".
        if (message.data["kind"] == "test" && Notifications.canShow(this)) TestAlerts.shown(now)
    }

    /** FCM tokens rotate: Cloud gets the new one (if this phone is paired). */
    override fun onNewToken(token: String) {
        val store = EncryptedPairingStore(this)
        val pairing = store.load() ?: return
        scope.launch {
            try {
                PairApi(BuildConfig.API_ORIGIN).putFcm(pairing.deviceToken, token)
            } catch (e: PairException.Unpaired) {
                Forget.all(this@UnstuckMessagingService)
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        /**
         * Unseals a sealed link with this phone's key; null if it isn't the viewer's, isn't for this phone, or can't be
         * opened (including key store trouble: the caller then shows the generic alert).
         */
        fun unseal(context: android.content.Context, link: String): AlertPayload? = runCatching {
            val parsed = trustedAlertLink(link, BuildConfig.VIEW_ORIGIN) ?: return null
            val pairing = EncryptedPairingStore(context).load() ?: return null
            if (parsed.deviceId != pairing.deviceId) return null
            AlertCrypto.open(DeviceKeys(context).privateKey(), parsed.deviceId, parsed.sessionId, parsed.blob)
        }.getOrNull()
    }
}
