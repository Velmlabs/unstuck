package sh.unstuck.android.ui

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import sh.unstuck.android.pair.DeviceApi
import sh.unstuck.android.pair.PairException
import sh.unstuck.android.pair.Pairing
import sh.unstuck.android.pair.PairingStore
import sh.unstuck.android.pair.parsePairInput

enum class Screen { WELCOME, SETUP, HOME }

data class Checklist(val notificationsAllowed: Boolean, val batteryUnrestricted: Boolean)

/** The app's few screens and what they do: pair, the setup checklist, send a test alert, unpair. */
class AppModel(
    private val store: PairingStore,
    private val api: DeviceApi,
    private val publicKey: () -> String,
    private val deleteKey: () -> Unit,
    private val fcmToken: suspend () -> String?,
    private val label: String,
    private val viewOrigin: String,
    private val batteryUnrestricted: () -> Boolean,
    private val notificationsAllowed: () -> Boolean,
) {
    private val _screen = MutableStateFlow(if (store.load() == null) Screen.WELCOME else Screen.HOME)
    val screen: StateFlow<Screen> = _screen
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice

    fun pairing(): Pairing? = store.load()

    fun checklist() = Checklist(notificationsAllowed(), batteryUnrestricted())

    /** A scanned QR URL or a typed code. */
    suspend fun pairWith(input: String) {
        _error.value = null
        val code = parsePairInput(input, viewOrigin) ?: run {
            _error.value = "That isn't an Unstuck pairing code for this app."
            return
        }
        try {
            val paired = api.pair(code, publicKey(), label)
            store.save(Pairing(paired.deviceId, paired.deviceToken, label))
            fcmToken()?.let { api.putFcm(paired.deviceToken, it) }
            _screen.value = Screen.SETUP
        } catch (e: PairException) {
            _error.value = e.message
        } catch (e: Exception) {
            _error.value = "Couldn't reach Unstuck Cloud. Check the connection and try again."
        }
    }

    fun finishSetup() {
        _screen.value = Screen.HOME
    }

    suspend fun sendTest() {
        val p = store.load() ?: return forget()
        _notice.value = try {
            val status = api.test(p.deviceToken)?.optJSONArray("results")?.optJSONObject(0)?.optString("status")
            when (status) {
                "sent" -> "Test alert sent. It should arrive in a few seconds."
                "not_configured" -> "Unstuck Cloud can't send app alerts yet."
                null, "" -> "The test alert didn't go out: this phone has no app channel yet. Pair again."
                else -> "The test alert didn't go out ($status)."
            }
        } catch (e: PairException.Unpaired) {
            return forget()
        } catch (e: PairException) {
            e.message
        } catch (e: Exception) {
            "Couldn't reach Unstuck Cloud. Check the connection and try again."
        }
    }

    /** Removes this phone from the account (best effort), then wipes its key and token. */
    suspend fun unpair() {
        store.load()?.let { runCatching { api.unpair(it.deviceToken) } }
        forget()
    }

    private fun forget() {
        deleteKey()
        store.clear()
        _notice.value = null
        _screen.value = Screen.WELCOME
    }
}
