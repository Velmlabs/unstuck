package sh.unstuck.android.pair

import java.net.URI

/** The server's pairing code alphabet (worker/alerts/devices.ts CODE_ALPHABET): no 0, O, 1, I or L. */
const val CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
private val CODE = Regex("^[$CODE_ALPHABET]{8}$")

/**
 * A scanned QR URL (`<viewOrigin>/pair[?api=…]#c=<code>`, on exactly this build's viewer origin; `?api=` is ignored:
 * the app only talks to its own server) or a typed code (dash, spaces and lowercase allowed). The normalized
 * 8-character code, or null.
 */
fun parsePairInput(text: String, viewOrigin: String): String? {
    val s = text.trim()
    if (s.contains("://")) {
        val u = runCatching { URI(s) }.getOrNull() ?: return null
        val want = URI(viewOrigin)
        if (u.scheme != want.scheme || u.host != want.host || u.port != want.port || u.path != "/pair") return null
        val code = (u.rawFragment ?: return null).split('&').firstOrNull { it.startsWith("c=") }?.removePrefix("c=") ?: return null
        return normalizeCode(code)
    }
    return normalizeCode(s)
}

fun normalizeCode(s: String): String? = s.replace(Regex("[-\\s]"), "").uppercase().takeIf { CODE.matches(it) }
