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
import sh.unstuck.android.pair.EncryptedPairingStore
import sh.unstuck.android.pair.PairApi
import sh.unstuck.android.pair.PairException

/** FCM wakes the app with a data message; the alert is unsealed here, on the phone. */
class UnstuckMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(message: RemoteMessage) {
        val spec = AlertHandler.handle(message.data, System.currentTimeMillis()) { link -> unseal(this, link) } ?: return
        Notifications.show(this, spec)
    }

    /** FCM tokens rotate: Cloud gets the new one (if this phone is paired). */
    override fun onNewToken(token: String) {
        val store = EncryptedPairingStore(this)
        val pairing = store.load() ?: return
        scope.launch {
            try {
                PairApi(BuildConfig.API_ORIGIN).putFcm(pairing.deviceToken, token)
            } catch (e: PairException.Unpaired) {
                store.clear()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        /** Unseals a sealed link with this phone's key; null if it isn't for this phone or can't be opened. */
        fun unseal(context: android.content.Context, link: String): AlertPayload? {
            val parsed = AlertCrypto.parseAlertLink(link) ?: return null
            val pairing = EncryptedPairingStore(context).load() ?: return null
            if (parsed.deviceId != pairing.deviceId) return null
            return AlertCrypto.open(DeviceKeys(context).privateKey(), parsed.deviceId, parsed.sessionId, parsed.blob)
        }
    }
}
