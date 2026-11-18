package sh.unstuck.android.pair

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairApiTest {
    private val server = MockWebServer()
    private lateinit var api: PairApi

    @Before fun start() {
        server.start()
        api = PairApi(server.url("/").toString().trimEnd('/'))
    }

    @After fun stop() = server.shutdown()

    @Test fun `pair request`() = runTest {
        server.enqueue(MockResponse().setBody("""{"deviceId":"dev_1","deviceToken":"tok_1"}"""))
        assertEquals(Paired("dev_1", "tok_1"), api.pair("ABCDEFGH", "PUBKEY", "Pixel 8 · App"))
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/v1/devices/pair", req.path)
        val body = JSONObject(req.body.readUtf8())
        assertEquals("ABCDEFGH", body.getString("code"))
        assertEquals("PUBKEY", body.getString("publicKey"))
        assertEquals("Pixel 8 · App", body.getString("label"))
        assertEquals("android", body.getString("kind"))
    }

    @Test fun `pair errors`() = runTest {
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":"code_expired"}"""))
        assertTrue(runCatching { api.pair("ABCDEFGH", "K", "L") }.exceptionOrNull() is PairException.CodeExpired)
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"rate_limited"}"""))
        assertTrue(runCatching { api.pair("ABCDEFGH", "K", "L") }.exceptionOrNull() is PairException.RateLimited)
    }

    @Test fun `self calls send Authorization Bearer and the right method and path`() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        api.putFcm("tok_1", "fcm-token")
        server.takeRequest().let {
            assertEquals("PUT /api/v1/devices/self/fcm", "${it.method} ${it.path}")
            assertEquals("Bearer tok_1", it.getHeader("Authorization"))
            assertEquals("fcm-token", JSONObject(it.body.readUtf8()).getString("token"))
        }
        server.enqueue(MockResponse().setBody("""{"results":[{"channel":"fcm","status":"sent"}]}"""))
        api.test("tok_1")
        assertEquals("POST /api/v1/devices/self/test", server.takeRequest().let { "${it.method} ${it.path}" })
        server.enqueue(MockResponse().setResponseCode(204))
        api.unpair("tok_1")
        assertEquals("DELETE /api/v1/devices/self", server.takeRequest().let { "${it.method} ${it.path}" })
        server.enqueue(MockResponse().setBody("""{"keyName":"laptop"}"""))
        assertEquals("laptop", api.sender("tok_1", "sess_1"))
        assertEquals("GET /api/v1/devices/self/alerts/sess_1", server.takeRequest().let { "${it.method} ${it.path}" })
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not_sent_by_unstuck"}"""))
        assertNull(api.sender("tok_1", "sess_2"))
    }

    @Test fun `a 401 on a self call is Unpaired`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))
        assertTrue(runCatching { api.putFcm("tok_gone", "t") }.exceptionOrNull() is PairException.Unpaired)
        server.enqueue(MockResponse().setResponseCode(401))
        assertTrue(runCatching { api.sender("tok_gone", "s") }.exceptionOrNull() is PairException.Unpaired)
    }
}
