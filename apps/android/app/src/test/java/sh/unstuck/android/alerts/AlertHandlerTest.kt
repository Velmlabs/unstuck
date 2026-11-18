package sh.unstuck.android.alerts

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import sh.unstuck.android.crypto.AlertPayload

@RunWith(RobolectricTestRunner::class)
class AlertHandlerTest {
    private val now = 1_800_000_000_000L
    private val link = "https://view.unstuck.sh/v/0.5.0/s/sess_1?r=x#x=dev_1.BLOB"
    private val payload = AlertPayload("TOK", "KEY", "Solve the CAPTCHA", "shop.example", now + 60_000)
    private val opens = { _: String -> payload }
    private val fails = { _: String -> null as AlertPayload? }
    private val VIEW = "https://view.unstuck.sh"
    private val DEV = "dev_1"
    private fun takeover(l: String) = mapOf("kind" to "takeover", "link" to l, "keyName" to "laptop")

    @Test fun `C1 a link that isn't on the viewer origin is dropped before unsealing`() {
        var opened = false
        val spy = { _: String -> opened = true; payload }
        for (bad in listOf(
            "https://evil.test/v/0.5.0/s/sess_1?r=x#x=dev_1.BLOB",
            "http://view.unstuck.sh/v/0.5.0/s/sess_1?r=x#x=dev_1.BLOB",
            "https://view.unstuck.sh.evil.test/v/0.5.0/s/sess_1?r=x#x=dev_1.BLOB",
            "https://view.unstuck.sh:444/v/0.5.0/s/sess_1?r=x#x=dev_1.BLOB",
            "https://user@view.unstuck.sh/v/0.5.0/s/sess_1?r=x#x=dev_1.BLOB",
            "https://view.unstuck.sh/evil/s/sess_1?r=x#x=dev_1.BLOB",
        )) assertNull(bad, AlertHandler.handle(takeover(bad), now, VIEW, DEV, spy))
        assertFalse(opened)
    }

    @Test fun `I2 an alert sealed for another device (an old pairing) is dropped, not shown as a generic alert`() {
        assertNull(AlertHandler.handle(takeover(link.replace("dev_1", "dev_old")), now, VIEW, DEV, fails))
        assertNull(AlertHandler.handle(takeover(link), now, VIEW, null, opens)) // not paired
    }

    @Test fun `I4 an unseal that throws (key store trouble) still shows the generic alert`() {
        val n = AlertHandler.handle(takeover(link), now, VIEW, DEV) { throw IllegalStateException("keystore") }!!
        assertEquals("Your agent needs you", n.title)
    }

    @Test fun `takeover alert`() {
        val n = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "laptop"), now, VIEW, DEV, opens)!!
        assertEquals("Your agent needs you: Solve the CAPTCHA · shop.example", n.title)
        assertEquals("Sent by key: laptop", n.body)
        assertEquals("takeovers", n.channel)
    }

    @Test fun `test alert`() {
        val n = AlertHandler.handle(mapOf("kind" to "test"), now, VIEW, DEV, opens)!!
        assertEquals("Test alert from Unstuck", n.title)
        assertEquals("Alerts reach this phone.", n.body)
        assertNull(n.openLink)
    }

    @Test fun `a test alert says how long it took, and each test is its own notification`() {
        val a = AlertHandler.handle(mapOf("kind" to "test", "sentAt" to (now - 3_400).toString()), now, VIEW, DEV, opens)!!
        assertEquals("Alerts reach this phone. This one arrived 3 s after Unstuck Cloud sent it.", a.body)
        val b = AlertHandler.handle(mapOf("kind" to "test", "sentAt" to (now - 95_000).toString()), now + 1_000, VIEW, DEV, opens)!!
        assertEquals("Alerts reach this phone. This one arrived 1 min 36 s after Unstuck Cloud sent it.", b.body)
        assertTrue("two tests don't replace each other", a.id != b.id)
        assertTrue("never a takeover's id", a.id < 0 && b.id < 0)
    }

    @Test fun `unseal fails shows the generic alert`() {
        val n = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "laptop"), now, VIEW, DEV, fails)!!
        assertEquals("Your agent needs you", n.title)
        assertEquals(link, n.openLink)
    }

    @Test fun `expired alerts are not shown`() {
        assertNull(AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now, VIEW, DEV, { payload.copy(expiresAt = now - 1) }))
    }

    @Test fun `one notification per session id`() {
        val a = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now, VIEW, DEV, opens)!!
        val b = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now + 5, VIEW, DEV, opens)!!
        val other = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link.replace("sess_1", "sess_2"), "keyName" to "k"), now, VIEW, DEV, opens)!!
        assertEquals(a.id, b.id)
        assertTrue(a.id != other.id)
    }

    @Test fun `the notification carries the sealed link, never the plain one`() {
        val n = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now, VIEW, DEV, opens)!!
        assertEquals(link, n.openLink)
        assertFalse(n.openLink!!.contains("#t="))
    }

    @Test fun `unknown or malformed messages are ignored`() {
        assertNull(AlertHandler.handle(mapOf("kind" to "other"), now, VIEW, DEV, opens))
        assertNull(AlertHandler.handle(mapOf("kind" to "takeover"), now, VIEW, DEV, opens))
    }

    @Test fun `the Takeovers channel is loud and the notification is posted`() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val nm = ctx.getSystemService(NotificationManager::class.java)
        Notifications.show(ctx, AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "laptop"), now, VIEW, DEV, opens)!!)
        val ch = nm.getNotificationChannel("takeovers")!!
        assertEquals("Takeovers", ch.name)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, ch.importance)
        assertTrue(ch.shouldVibrate())
        assertNotNull(ch.sound)
        val posted = shadowOf(nm).allNotifications.single()
        assertEquals("Your agent needs you: Solve the CAPTCHA · shop.example", shadowOf(posted).contentTitle)
        assertEquals("the Unstuck arrow, not a system icon", sh.unstuck.android.R.drawable.ic_stat_unstuck, posted.smallIcon.resId)
        assertEquals(0xFF22C55E.toInt(), posted.color)
    }
}
