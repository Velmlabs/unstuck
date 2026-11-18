package sh.unstuck.android.viewer

import sh.unstuck.android.crypto.AlertCrypto
import sh.unstuck.android.crypto.AlertLink
import sh.unstuck.android.crypto.AlertPayload
import java.net.URI
import java.net.URLEncoder

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

/**
 * The viewer URL the WebView opens: the alert's viewer URL plus `#t=…&k=…[&m=q|a]&from=…&r=…&s=…[&q=…]`, built on the
 * phone from the unsealed payload (the viewer honors from/r/s/q only inside this app: its user agent).
 */
fun viewerUrl(link: AlertLink, p: AlertPayload, keyName: String): String = buildString {
    append(link.viewerUrl).append("#t=").append(enc(p.t)).append("&k=").append(enc(p.k))
    when (p.mode) {
        "question" -> append("&m=q")
        "approval" -> append("&m=a")
    }
    append("&from=").append(enc(keyName)).append("&r=").append(enc(p.reason)).append("&s=").append(enc(p.site))
    p.question?.let { append("&q=").append(enc(it)) }
}

/** Only the viewer's own origin (https, exact host, default port) loads in the WebView; anything else opens outside. */
fun allowed(url: String, viewOrigin: String): Boolean {
    val u = runCatching { URI(url) }.getOrNull() ?: return false
    val v = URI(viewOrigin)
    return u.scheme == "https" && u.scheme == v.scheme && u.host != null && u.host.equals(v.host, ignoreCase = true) && u.port == v.port
}

private val VIEWER_PATH = Regex("^/v/\\d+\\.\\d+\\.\\d+/s/[A-Za-z0-9_-]+$")

/**
 * A sealed alert link, only when it points at the viewer itself: [viewOrigin] exactly, no user info, and the path
 * `/v/<x.y.z>/s/<session>` (what Cloud's checkViewerUrl accepts). Checked before unsealing, so a link naming any other
 * page (sent by whoever can reach this app through FCM) never gets the plain `#t=…&k=…`.
 */
fun trustedAlertLink(link: String, viewOrigin: String): AlertLink? {
    val parsed = AlertCrypto.parseAlertLink(link) ?: return null
    val u = runCatching { URI(parsed.viewerUrl) }.getOrNull() ?: return null
    if (!allowed(parsed.viewerUrl, viewOrigin) || u.rawUserInfo != null || !VIEWER_PATH.matches(u.rawPath ?: "")) return null
    return parsed
}

enum class ViewerState { LIVE, ENDED, HANDED_BACK, OTHER }

/** The viewer reports its state in document.title (no JS bridge). */
fun viewerState(title: String?): ViewerState = when (title) {
    "Unstuck · live" -> ViewerState.LIVE
    "Unstuck · ended" -> ViewerState.ENDED
    "Unstuck · handed back" -> ViewerState.HANDED_BACK
    else -> ViewerState.OTHER
}
