package sh.unstuck.android.pair

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging

/**
 * The one way this phone forgets its pairing (unpaired on the dashboard, a 401, or Unpair): the pairing, the device key
 * and the FCM token all go, so a new pairing starts with a new key and Cloud's old device row can't share the token.
 */
object Forget {
    fun all(context: Context) {
        runCatching { EncryptedPairingStore(context).clear() }
        runCatching { DeviceKeys(context).delete() }
        deleteFcmToken()
    }

    /** No-op without Firebase config. */
    fun deleteFcmToken() {
        runCatching { FirebaseMessaging.getInstance().deleteToken() }
    }
}
