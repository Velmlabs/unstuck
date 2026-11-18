package sh.unstuck.android.ui

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.unstuck.android.pair.DeviceApi
import sh.unstuck.android.pair.MemoryPairingStore
import sh.unstuck.android.pair.PairException
import sh.unstuck.android.pair.Paired
import sh.unstuck.android.pair.Pairing

class AppModelTest {
    private val calls = mutableListOf<String>()
    private var testResult: () -> JSONObject? = { JSONObject("""{"results":[{"channel":"fcm","status":"sent"}]}""") }
    private var pairResult: () -> Paired = { Paired("dev_1", "tok_1") }
    private val api = object : DeviceApi {
        override suspend fun pair(code: String, publicKey: String, label: String): Paired = pairResult().also { calls += "pair $code $publicKey $label" }
        override suspend fun putFcm(deviceToken: String, token: String) { calls += "fcm $deviceToken $token"; fcmPut() }
        override suspend fun test(deviceToken: String): JSONObject? { calls += "test $deviceToken"; return testResult() }
        override suspend fun unpair(deviceToken: String) { calls += "unpair $deviceToken" }
        override suspend fun check(deviceToken: String) { calls += "check $deviceToken"; checkResult() }
    }
    private var checkResult: () -> Unit = {}
    private var fcmPut: () -> Unit = {}
    private var fcm: String? = "fcm-1"
    private var fcmDeleted = false
    private var keysDeleted = false
    private var battery = false
    private var notifications = true
    private var clock = 1_000_000L
    private val store = MemoryPairingStore()
    private fun model() = AppModel(
        store = store,
        api = api,
        publicKey = { "PUBKEY" },
        deleteKey = { keysDeleted = true },
        fcmToken = { fcm },
        deleteFcmToken = { fcmDeleted = true },
        label = "Pixel 8 · App",
        viewOrigin = "https://view.unstuck.sh",
        batteryUnrestricted = { battery },
        notificationsAllowed = { notifications },
        now = { clock },
    )

    @Test fun `welcome, pair, setup, home`() = runTest {
        val m = model()
        assertEquals(Screen.WELCOME, m.screen.value)
        m.pairWith("https://view.unstuck.sh/pair#c=ABCDEFGH")
        assertEquals(listOf("pair ABCDEFGH PUBKEY Pixel 8 · App", "fcm tok_1 fcm-1"), calls)
        assertEquals(Pairing("dev_1", "tok_1", "Pixel 8 · App"), store.load())
        assertEquals(Screen.SETUP, m.screen.value)
        m.finishSetup()
        assertEquals(Screen.HOME, m.screen.value)
        assertEquals(Screen.HOME, model().screen.value) // a paired phone opens on Home
    }

    @Test fun `bad input and expired codes say why`() = runTest {
        val m = model()
        m.pairWith("https://evil.test/pair#c=ABCDEFGH")
        assertEquals("That isn't an Unstuck pairing code for this app.", m.error.value)
        pairResult = { throw PairException.CodeExpired() }
        m.pairWith("ABCD-EFGH")
        assertTrue(m.error.value!!.startsWith("This code has expired"))
        assertEquals(Screen.WELCOME, m.screen.value)
    }

    @Test fun `the checklist shows the battery setting`() {
        val m = model()
        assertEquals(false, m.checklist().batteryUnrestricted)
        battery = true
        assertEquals(true, m.checklist().batteryUnrestricted)
    }

    @Test fun `unpair calls DELETE self, then wipes the key and the token`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        val m = model()
        m.unpair()
        assertEquals(listOf("unpair tok_1"), calls)
        assertTrue(keysDeleted)
        assertNull(store.load())
        assertEquals(Screen.WELCOME, m.screen.value)
    }

    @Test fun `a 401 on send test unpairs`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        testResult = { throw PairException.Unpaired() }
        val m = model()
        m.sendTest()
        assertNull(store.load())
        assertTrue(keysDeleted)
        assertEquals(Screen.WELCOME, m.screen.value)
    }

    @Test fun `send test reports what happened`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        val m = model()
        m.sendTest()
        assertEquals("Test alert sent. Waiting for it to arrive on this phone…", m.notice.value)
        testResult = { JSONObject("""{"results":[{"channel":"fcm","status":"not_configured"}]}""") }
        clock += AppModel.TEST_COOLDOWN_MS
        m.sendTest()
        assertEquals("Unstuck Cloud can't send app alerts yet.", m.notice.value)
    }

    @Test fun `I1 a failed token upload doesn't undo a pairing that worked`() = runTest {
        fcmPut = { throw java.io.IOException("offline") }
        val m = model()
        m.pairWith("ABCD-EFGH")
        assertEquals(Pairing("dev_1", "tok_1", "Pixel 8 · App"), store.load())
        assertEquals(Screen.SETUP, m.screen.value)
        assertNull(m.error.value)
    }

    @Test fun `I1 each launch while paired sends the current FCM token again`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        model().refresh()
        assertEquals(listOf("fcm tok_1 fcm-1"), calls)
    }

    @Test fun `I5 a launch after the phone was removed on the dashboard goes back to Welcome and wipes everything`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        fcmPut = { throw PairException.Unpaired() }
        val m = model()
        m.refresh()
        assertEquals(Screen.WELCOME, m.screen.value)
        assertTrue(keysDeleted)
        assertTrue(fcmDeleted)
        assertNull(store.load())
    }

    @Test fun `I5 without Firebase the launch check asks Cloud directly, and offline changes nothing`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        fcm = null
        checkResult = { throw java.io.IOException("offline") }
        val m = model()
        m.refresh()
        assertEquals(listOf("check tok_1"), calls)
        assertEquals(Screen.HOME, m.screen.value)
        checkResult = { throw PairException.Unpaired() }
        m.refresh()
        assertEquals(Screen.WELCOME, m.screen.value)
    }

    @Test fun `I2 unpair also deletes the FCM token`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        model().unpair()
        assertTrue(fcmDeleted)
    }

    @Test fun `refresh does nothing when not paired`() = runTest {
        model().refresh()
        assertTrue(calls.isEmpty())
    }

    @Test fun `a test that Cloud sent while notifications are off on this phone says they are off`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        notifications = false
        val m = model()
        m.sendTest()
        assertEquals("Cloud sent the test, but notifications are off for Unstuck on this phone, so it can't show. Tap Allow above.", m.notice.value)
    }

    @Test fun `send test cools down for 10 s between taps`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        val m = model()
        m.sendTest()
        m.sendTest()
        assertEquals(listOf("test tok_1"), calls)
        assertEquals(1_000_000L + AppModel.TEST_COOLDOWN_MS, m.testAgainAt.value)
        clock += AppModel.TEST_COOLDOWN_MS
        m.sendTest()
        assertEquals(listOf("test tok_1", "test tok_1"), calls)
    }

    @Test fun `the test step is done only when the test notification shows on this phone`() = runTest {
        store.save(Pairing("dev_1", "tok_1", "L"))
        val m = model()
        m.onTestArrived(clock - 1) // an old arrival, before this tap: doesn't count
        m.sendTest()
        assertEquals(false, m.testConfirmed.value)
        m.onTestArrived(clock + 2_400)
        assertEquals(true, m.testConfirmed.value)
        assertEquals("Test alert arrived on this phone after 2 s.", m.notice.value)
    }

    @Test fun `an arrival with nothing sent changes nothing`() = runTest {
        val m = model()
        m.onTestArrived(clock)
        assertEquals(false, m.testConfirmed.value)
        assertNull(m.notice.value)
    }
}
