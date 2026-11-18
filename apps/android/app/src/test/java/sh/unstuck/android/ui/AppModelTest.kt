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
        override suspend fun putFcm(deviceToken: String, token: String) { calls += "fcm $deviceToken $token" }
        override suspend fun test(deviceToken: String): JSONObject? { calls += "test $deviceToken"; return testResult() }
        override suspend fun unpair(deviceToken: String) { calls += "unpair $deviceToken" }
    }
    private var keysDeleted = false
    private var battery = false
    private val store = MemoryPairingStore()
    private fun model() = AppModel(
        store = store,
        api = api,
        publicKey = { "PUBKEY" },
        deleteKey = { keysDeleted = true },
        fcmToken = { "fcm-1" },
        label = "Pixel 8 · App",
        viewOrigin = "https://view.unstuck.sh",
        batteryUnrestricted = { battery },
        notificationsAllowed = { true },
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
        assertEquals("Test alert sent. It should arrive in a few seconds.", m.notice.value)
        testResult = { JSONObject("""{"results":[{"channel":"fcm","status":"not_configured"}]}""") }
        m.sendTest()
        assertEquals("Unstuck Cloud can't send app alerts yet.", m.notice.value)
    }
}
