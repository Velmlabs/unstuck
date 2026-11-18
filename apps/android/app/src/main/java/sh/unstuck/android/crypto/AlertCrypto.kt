package sh.unstuck.android.crypto

import org.json.JSONObject
import java.math.BigInteger
import java.net.URI
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** What a sealed alert carries (protocol/src/alerts.ts AlertPayload). */
data class AlertPayload(
    val t: String,
    val k: String,
    val reason: String,
    val site: String,
    val expiresAt: Long,
    val mode: String? = null,
    val question: String? = null,
)

/** A sealed alert link: the viewer URL plus `#x=<deviceId>.<blob>`; the session id is the path's last segment. */
data class AlertLink(val viewerUrl: String, val sessionId: String, val deviceId: String, val blob: String)

/**
 * Unseals alerts exactly as protocol/src/alerts.ts seals them: ephemeral ECDH P-256 → HKDF-SHA-256 (salt = session id,
 * info = "unstuck/notify/1|<deviceId>") → AES-256-GCM (12-byte IV after the 65-byte ephemeral key, AAD
 * "unstuck/notify/1|<sessionId>|<deviceId>"). Any failure is null: the caller shows a generic alert.
 */
object AlertCrypto {
    private const val PUB_BYTES = 65
    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16
    private val b64d = Base64.getUrlDecoder()
    private val b64e = Base64.getUrlEncoder().withoutPadding()
    private val p256: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    }

    fun open(privateKey: PrivateKey, deviceId: String, sessionId: String, blob: String): AlertPayload? = try {
        val bytes = b64d.decode(blob)
        require(bytes.size > PUB_BYTES + IV_BYTES + TAG_BYTES && bytes[0].toInt() == 4)
        val eph = publicKeyFromRaw(bytes.copyOfRange(0, PUB_BYTES))
        val iv = bytes.copyOfRange(PUB_BYTES, PUB_BYTES + IV_BYTES)
        val sealed = bytes.copyOfRange(PUB_BYTES + IV_BYTES, bytes.size)
        val secret = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(eph, true)
            generateSecret()
        }
        val aesKey = hkdfSha256(secret, sessionId.toByteArray(), "unstuck/notify/1|$deviceId".toByteArray(), 32)
        val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(TAG_BYTES * 8, iv))
            updateAAD("unstuck/notify/1|$sessionId|$deviceId".toByteArray())
            doFinal(sealed)
        }
        parsePayload(String(plain, Charsets.UTF_8))
    } catch (e: Exception) {
        null
    }

    /** The raw 65-byte uncompressed point, base64url without padding: what /api/v1/devices/pair expects. */
    fun rawPublicKey(pub: ECPublicKey): String {
        val out = ByteArray(PUB_BYTES)
        out[0] = 4
        fixed32(pub.w.affineX).copyInto(out, 1)
        fixed32(pub.w.affineY).copyInto(out, 33)
        return b64e.encodeToString(out)
    }

    fun parseAlertLink(link: String): AlertLink? {
        val hash = link.indexOf('#')
        if (hash < 0) return null
        val m = Regex("^x=([^.&=]+)\\.([^.&=]+)$").find(link.substring(hash + 1)) ?: return null
        val viewerUrl = link.substring(0, hash)
        val segments = (URI(viewerUrl).path ?: "").split('/').filter { it.isNotEmpty() }
        if (segments.size < 2 || !Regex("^[A-Za-z0-9_-]+$").matches(segments.last())) return null
        return AlertLink(viewerUrl, segments.last(), m.groupValues[1], m.groupValues[2])
    }

    private fun parsePayload(json: String): AlertPayload? {
        val o = JSONObject(json)
        val t = o.opt("t") as? String ?: return null
        val k = o.opt("k") as? String ?: return null
        val reason = o.opt("reason") as? String ?: return null
        val site = o.opt("site") as? String ?: return null
        val expiresAt = (o.opt("expiresAt") as? Number)?.toLong() ?: return null
        return AlertPayload(t, k, reason, site, expiresAt, o.opt("mode") as? String, o.opt("question") as? String)
    }

    private fun publicKeyFromRaw(raw: ByteArray): ECPublicKey {
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, p256)) as ECPublicKey
    }

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    /** RFC 5869 with SHA-256 (one block is enough for 32 bytes). */
    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(ikm)
        }
        val okm = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(prk, "HmacSHA256"))
            update(info)
            update(1)
            doFinal()
        }
        return okm.copyOf(length)
    }
}
