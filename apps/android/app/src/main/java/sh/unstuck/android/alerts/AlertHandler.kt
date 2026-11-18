package sh.unstuck.android.alerts

import sh.unstuck.android.crypto.AlertPayload
import sh.unstuck.android.viewer.trustedAlertLink

/** What to show for one FCM message. `openLink` is the sealed link (unsealed again on tap), never the plain one. */
data class NotificationSpec(val id: Int, val title: String, val body: String, val channel: String = Notifications.CHANNEL, val openLink: String?)

/**
 * Turns Cloud's FCM data (`{kind:'takeover', link, keyName}` or `{kind:'test'}`) into a notification. `open` unseals a
 * sealed link with this phone's key (null when it can't). Expired alerts aren't shown; one notification per session.
 * A link off [viewOrigin], or sealed for another device than [deviceId] (an old pairing that shares the FCM token),
 * shows nothing: neither would open here.
 */
object AlertHandler {
    private const val TEST_ID = 1

    fun handle(data: Map<String, String>, now: Long, viewOrigin: String, deviceId: String?, open: (String) -> AlertPayload?): NotificationSpec? = when (data["kind"]) {
        "test" -> test(data, now)
        "takeover" -> takeover(data, now, viewOrigin, deviceId, open)
        else -> null
    }

    /** Each test is its own notification (a negative id: never a takeover's), and says how long it took to arrive. */
    private fun test(data: Map<String, String>, now: Long): NotificationSpec {
        val sentAt = data["sentAt"]?.toLongOrNull()
        val took = sentAt?.let { (now - it).coerceAtLeast(0) / 1000 }
        val body = if (took == null) "Alerts reach this phone." else "Alerts reach this phone. This one arrived ${seconds(took)} after Unstuck Cloud sent it."
        return NotificationSpec(-(1 + (now / 1000 % 1_000_000).toInt()), "Test alert from Unstuck", body, openLink = null)
    }

    private fun seconds(s: Long) = if (s < 60) "$s s" else "${s / 60} min ${s % 60} s"

    private fun takeover(data: Map<String, String>, now: Long, viewOrigin: String, deviceId: String?, open: (String) -> AlertPayload?): NotificationSpec? {
        val link = data["link"] ?: return null
        val parsed = trustedAlertLink(link, viewOrigin) ?: return null
        if (deviceId == null || parsed.deviceId != deviceId) return null
        val id = idFor(parsed.sessionId)
        val p = runCatching { open(link) }.getOrNull() ?: return NotificationSpec(id, "Your agent needs you", "Open it to see what's needed.", openLink = link)
        if (p.expiresAt <= now) return null
        val about = listOf(p.reason, p.site).filter { it.isNotBlank() }.joinToString(" · ")
        val key = data["keyName"].orEmpty()
        return NotificationSpec(
            id,
            if (about.isEmpty()) "Your agent needs you" else "Your agent needs you: $about",
            if (key.isEmpty()) "Sent by Unstuck Cloud" else "Sent by key: $key",
            openLink = link,
        )
    }

    /** Stable per session (a second delivery replaces the first), never the test alert's id. */
    fun idFor(sessionId: String): Int = (sessionId.hashCode() and 0x7fffffff).coerceAtLeast(TEST_ID + 1)
}
