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

    @Test fun `takeover alert`() {
        val n = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "laptop"), now, opens)!!
        assertEquals("Your agent needs you: Solve the CAPTCHA · shop.example", n.title)
        assertEquals("Sent by key: laptop", n.body)
        assertEquals("takeovers", n.channel)
    }

    @Test fun `test alert`() {
        val n = AlertHandler.handle(mapOf("kind" to "test"), now, opens)!!
        assertEquals("Test alert from Unstuck", n.title)
        assertNull(n.openLink)
    }

    @Test fun `unseal fails shows the generic alert`() {
        val n = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "laptop"), now, fails)!!
        assertEquals("Your agent needs you", n.title)
        assertEquals(link, n.openLink)
    }

    @Test fun `expired alerts are not shown`() {
        assertNull(AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now, { payload.copy(expiresAt = now - 1) }))
    }

    @Test fun `one notification per session id`() {
        val a = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now, opens)!!
        val b = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now + 5, opens)!!
        val other = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link.replace("sess_1", "sess_2"), "keyName" to "k"), now, opens)!!
        assertEquals(a.id, b.id)
        assertTrue(a.id != other.id)
    }

    @Test fun `the notification carries the sealed link, never the plain one`() {
        val n = AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "k"), now, opens)!!
        assertEquals(link, n.openLink)
        assertFalse(n.openLink!!.contains("#t="))
    }

    @Test fun `unknown or malformed messages are ignored`() {
        assertNull(AlertHandler.handle(mapOf("kind" to "other"), now, opens))
        assertNull(AlertHandler.handle(mapOf("kind" to "takeover"), now, opens))
    }

    @Test fun `the Takeovers channel is loud and the notification is posted`() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val nm = ctx.getSystemService(NotificationManager::class.java)
        Notifications.show(ctx, AlertHandler.handle(mapOf("kind" to "takeover", "link" to link, "keyName" to "laptop"), now, opens)!!)
        val ch = nm.getNotificationChannel("takeovers")!!
        assertEquals("Takeovers", ch.name)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, ch.importance)
        assertTrue(ch.shouldVibrate())
        assertNotNull(ch.sound)
        val posted = shadowOf(nm).allNotifications.single()
        assertEquals("Your agent needs you: Solve the CAPTCHA · shop.example", shadowOf(posted).contentTitle)
    }
}
