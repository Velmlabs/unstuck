package sh.unstuck.android.crypto

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/** Unseals the alerts protocol/scripts/alert-vectors.ts sealed with the protocol's own sealAlert. */
class AlertCryptoTest {
    private val fixture = JSONObject(File("../../../protocol/test/fixtures/alert-vectors.json").readText())
    private val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.getUrlDecoder().decode(fixture.getString("devicePrivateKeyPkcs8"))))
    private val vectors = fixture.getJSONArray("vectors").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    @Test fun `opens every protocol vector`() {
        for (v in vectors) {
            val p = v.getJSONObject("payload")
            val opened = AlertCrypto.open(key, v.getString("deviceId"), v.getString("sessionId"), v.getString("blob"))!!
            assertEquals(p.getString("t"), opened.t)
            assertEquals(p.getString("k"), opened.k)
            assertEquals(p.getString("reason"), opened.reason)
            assertEquals(p.getString("site"), opened.site)
            assertEquals(p.getLong("expiresAt"), opened.expiresAt)
            assertEquals(p.optString("mode").ifEmpty { null }, opened.mode)
            assertEquals(p.optString("question").ifEmpty { null }, opened.question)
        }
    }

    @Test fun `a tampered blob is null`() {
        val v = vectors[0]
        val bytes = Base64.getUrlDecoder().decode(v.getString("blob"))
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        assertNull(AlertCrypto.open(key, v.getString("deviceId"), v.getString("sessionId"), Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)))
        assertNull(AlertCrypto.open(key, v.getString("deviceId"), v.getString("sessionId"), "not-a-blob"))
    }

    @Test fun `wrong device id or session id is null`() {
        val v = vectors[0]
        assertNull(AlertCrypto.open(key, "dev_other", v.getString("sessionId"), v.getString("blob")))
        assertNull(AlertCrypto.open(key, v.getString("deviceId"), "sess_other", v.getString("blob")))
    }

    @Test fun `rawPublicKey is 65 bytes starting 0x04, base64url, and matches the protocol's spelling`() {
        val pub = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().public as ECPublicKey
        val raw = AlertCrypto.rawPublicKey(pub)
        assertEquals(87, raw.length)
        assertEquals(true, Regex("^[A-Za-z0-9_-]{87}$").matches(raw))
        val bytes = Base64.getUrlDecoder().decode(raw)
        assertEquals(65, bytes.size)
        assertEquals(4, bytes[0].toInt())
    }

    @Test fun `parseAlertLink takes the device id, blob and session id`() {
        val l = AlertCrypto.parseAlertLink("https://view.unstuck.sh/v/0.5.0/s/sess_abc?r=wss%3A%2F%2Frelay.unstuck.sh#x=dev_1.QUJD")!!
        assertEquals("https://view.unstuck.sh/v/0.5.0/s/sess_abc?r=wss%3A%2F%2Frelay.unstuck.sh", l.viewerUrl)
        assertEquals("sess_abc", l.sessionId)
        assertEquals("dev_1", l.deviceId)
        assertEquals("QUJD", l.blob)
        assertNull(AlertCrypto.parseAlertLink("https://view.unstuck.sh/v/0.5.0/s/sess_abc#t=TOK&k=KEY"))
        assertNull(AlertCrypto.parseAlertLink("https://view.unstuck.sh/#x=dev_1.QUJD"))
    }
}
