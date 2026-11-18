package sh.unstuck.android.viewer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.unstuck.android.crypto.AlertLink
import sh.unstuck.android.crypto.AlertPayload

class ViewerUrlTest {
    private val link = AlertLink("https://view.unstuck.sh/v/0.5.0/s/sess_1?r=wss%3A%2F%2Frelay.unstuck.sh", "sess_1", "dev_1", "BLOB")
    private val p = AlertPayload("TOK-1", "KEY_1", "Solve the CAPTCHA & pay", "shop.example", 0)

    @Test fun `viewer url`() {
        assertEquals(
            "https://view.unstuck.sh/v/0.5.0/s/sess_1?r=wss%3A%2F%2Frelay.unstuck.sh#t=TOK-1&k=KEY_1&from=my%20laptop&r=Solve%20the%20CAPTCHA%20%26%20pay&s=shop.example",
            viewerUrl(link, p, "my laptop"),
        )
        assertTrue(viewerUrl(link, p.copy(mode = "question", question = "Which?"), "k").contains("&m=q&") && viewerUrl(link, p.copy(mode = "question", question = "Which?"), "k").endsWith("&q=Which%3F"))
        assertTrue(viewerUrl(link, p.copy(mode = "approval"), "k").contains("&m=a&"))
    }

    @Test fun `origin lock`() {
        val v = "https://view.unstuck.sh"
        assertTrue(allowed("https://view.unstuck.sh/v/0.5.0/s/x#t=1", v))
        assertFalse(allowed("https://view.unstuck.sh.evil.test/v/", v))
        assertFalse(allowed("http://view.unstuck.sh/v/", v))
        assertFalse(allowed("https://view.unstuck.sh:444/v/", v))
        assertFalse(allowed("https://evil.test/", v))
        assertFalse(allowed("file:///sdcard/x.html", v))
        assertFalse(allowed("intent://x#Intent;end", v))
        assertFalse(allowed("javascript:alert(1)", v))
        assertFalse(allowed("not a url", v))
    }

    @Test fun `title states`() {
        assertEquals(ViewerState.LIVE, viewerState("Unstuck · live"))
        assertEquals(ViewerState.ENDED, viewerState("Unstuck · ended"))
        assertEquals(ViewerState.HANDED_BACK, viewerState("Unstuck · handed back"))
        assertEquals(ViewerState.OTHER, viewerState("Unstuck"))
    }

    @Test fun `trusted alert links are on the viewer origin with the viewer path`() {
        val v = "https://view.unstuck.sh"
        assertEquals("sess_1", trustedAlertLink("https://view.unstuck.sh/v/0.5.0/s/sess_1?r=https%3A%2F%2Frelay.unstuck.sh#x=dev_1.BLOB", v)?.sessionId)
        for (bad in listOf(
            "https://evil.test/v/0.5.0/s/sess_1#x=dev_1.BLOB",
            "http://view.unstuck.sh/v/0.5.0/s/sess_1#x=dev_1.BLOB",
            "https://view.unstuck.sh/s/sess_1#x=dev_1.BLOB",
            "https://view.unstuck.sh/v/latest/s/sess_1#x=dev_1.BLOB",
            "https://a:b@view.unstuck.sh/v/0.5.0/s/sess_1#x=dev_1.BLOB",
        )) org.junit.Assert.assertNull(bad, trustedAlertLink(bad, v))
    }
}
