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
    private val deleteFcmToken: suspend () -> Unit,
    private val label: String,
    private val viewOrigin: String,
    private val batteryUnrestricted: () -> Boolean,
    private val notificationsAllowed: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) {
    companion object {
        /** Between test alerts (the dashboard waits as long); Cloud also allows 5 a minute per phone. */
        const val TEST_COOLDOWN_MS = 10_000L
    }

    private var testSentAt = 0L
    private val _testConfirmed = MutableStateFlow(false)
    /** A test alert showed on this phone after the last tap on Send: alerts really arrive. */
    val testConfirmed: StateFlow<Boolean> = _testConfirmed

    private val _testAgainAt = MutableStateFlow(0L)
    /** When Send a test alert works again (0 or the past: now). */
    val testAgainAt: StateFlow<Long> = _testAgainAt

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
            // The pairing worked; a token that doesn't go up now goes up on the next launch (refresh).
            runCatching { fcmToken()?.let { api.putFcm(paired.deviceToken, it) } }
            _screen.value = Screen.SETUP
        } catch (e: PairException) {
            _error.value = e.message
        } catch (e: Exception) {
            _error.value = "Couldn't reach Unstuck Cloud. Check the connection and try again."
        }
    }

    /**
     * On each launch while paired: send Cloud the current FCM token again (it may have rotated, or Cloud dropped it), or,
     * without Firebase, just ask Cloud whether this phone is still paired. A 401 forgets the pairing; offline changes nothing.
     */
    suspend fun refresh() {
        val p = store.load() ?: return
        try {
            val token = runCatching { fcmToken() }.getOrNull()
            if (token != null) api.putFcm(p.deviceToken, token) else api.check(p.deviceToken)
        } catch (e: PairException.Unpaired) {
            forget()
        } catch (_: Exception) {
        }
    }

    /** A test notification showed at [at] (TestAlerts): it confirms the test only if it came after the tap. */
    fun onTestArrived(at: Long) {
        if (testSentAt == 0L || at < testSentAt) return
        _testConfirmed.value = true
        _notice.value = "Test alert arrived on this phone after ${(at - testSentAt) / 1000} s."
        testSentAt = 0L
    }

    fun finishSetup() {
        _screen.value = Screen.HOME
    }

    suspend fun sendTest() {
        if (now() < _testAgainAt.value) return
        val p = store.load() ?: return forget()
        val tappedAt = now()
        _testAgainAt.value = tappedAt + TEST_COOLDOWN_MS
        _notice.value = try {
            val status = api.test(p.deviceToken)?.optJSONArray("results")?.optJSONObject(0)?.optString("status")
            when (status) {
                "sent" -> if (notificationsAllowed()) "Test alert sent. Waiting for it to arrive on this phone…".also { testSentAt = tappedAt }
                else "Cloud sent the test, but notifications are off for Unstuck on this phone, so it can't show. Tap Allow above."
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

    private suspend fun forget() {
        runCatching { deleteFcmToken() }
        deleteKey()
        store.clear()
        _notice.value = null
        _screen.value = Screen.WELCOME
    }
}
