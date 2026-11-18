package sh.unstuck.android.viewer

import android.content.Intent
import android.os.Looper
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import sh.unstuck.android.alerts.Notifications
import sh.unstuck.android.crypto.AlertPayload
import sh.unstuck.android.pair.MemoryPairingStore
import sh.unstuck.android.pair.PairException
import sh.unstuck.android.pair.Pairing

@RunWith(RobolectricTestRunner::class)
class ViewerActivityTest {
    private val link = "${sh.unstuck.android.BuildConfig.VIEW_ORIGIN}/v/0.5.0/s/sess_1#x=dev_1.BLOB"
    private val store = MemoryPairingStore(Pairing("dev_1", "tok_1", "Pixel · App"))
    private val live = AlertPayload("TOK", "KEY", "Solve the CAPTCHA", "shop.example", System.currentTimeMillis() + 60_000)

    private var unsealed = false
    private var forgot = false
    private fun launch(payload: AlertPayload?, open: String = link, unseal: (String) -> AlertPayload? = { unsealed = true; payload }, sender: suspend (String, String) -> String?): ViewerActivity {
        ViewerActivity.deps = ViewerDeps(store = { store }, unseal = unseal, sender = sender, forget = { forgot = true; store.clear() })
        val intent = Intent(ApplicationProvider.getApplicationContext(), ViewerActivity::class.java).putExtra(Notifications.EXTRA_LINK, open)
        val a = Robolectric.buildActivity(ViewerActivity::class.java, intent).setup().get()
        shadowOf(Looper.getMainLooper()).idle()
        return a
    }

    @After fun reset() { ViewerActivity.deps = ViewerDeps.real() }

    @Test fun `loads the viewer locked down, with the app's user agent, and keeps the screen on`() {
        val a = launch(live) { _, _ -> "laptop" }
        val web = a.findViewById<WebView>(ViewerActivity.WEB_ID)!!
        assertTrue(shadowOf(web).lastLoadedUrl.startsWith("${sh.unstuck.android.BuildConfig.VIEW_ORIGIN}/v/0.5.0/s/sess_1#t=TOK&k=KEY&from=laptop"))
        val s = web.settings
        assertTrue(s.javaScriptEnabled)
        assertTrue(s.domStorageEnabled)
        assertFalse(s.allowFileAccess)
        assertFalse(s.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, s.mixedContentMode)
        assertTrue(s.userAgentString.endsWith(" UnstuckAndroid/${sh.unstuck.android.BuildConfig.VERSION_NAME}"))
        assertTrue(a.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test fun `sender check fails shows Couldn't confirm who sent this before loading`() {
        val a = launch(live) { _, _ -> null }
        assertNull(a.findViewById<WebView>(ViewerActivity.WEB_ID))
        assertTrue(a.messageText().contains("Couldn't confirm who sent this"))
    }

    @Test fun `tapped after expiresAt shows This takeover has ended, no WebView`() {
        val a = launch(live.copy(expiresAt = 1)) { _, _ -> "laptop" }
        assertNull(a.findViewById<WebView>(ViewerActivity.WEB_ID))
        assertTrue(a.messageText().contains("This takeover has ended"))
    }

    @Test fun `C1 a link off the viewer origin opens nothing and is never unsealed`() {
        val a = launch(live, open = "https://evil.test/v/0.5.0/s/sess_1#x=dev_1.BLOB") { _, _ -> "laptop" }
        assertNull(a.findViewById<WebView>(ViewerActivity.WEB_ID))
        assertTrue(a.messageText().contains("Nothing to open"))
        assertFalse(unsealed)
    }

    @Test fun `I4 an unseal that throws says Couldn't open this alert, no crash`() {
        val a = launch(live, unseal = { throw IllegalStateException("keystore") }) { _, _ -> "laptop" }
        assertTrue(a.messageText().contains("Couldn't open this alert"))
    }

    @Test fun `a 401 on any self call unpairs`() {
        val a = launch(live) { _, _ -> throw PairException.Unpaired() }
        assertNull(store.load())
        assertTrue("I5: the shared forget wipes the key too", forgot)
        assertTrue(a.isFinishing)
        assertNotNull(shadowOf(a).nextStartedActivity)
    }

    @Test fun `back asks Leave the takeover while live, ended closes by itself`() {
        val a = launch(live) { _, _ -> "laptop" }
        a.onTitle("Unstuck · live")
        a.onBackPressedDispatcher.onBackPressed()
        assertFalse(a.isFinishing)
        assertTrue(a.leavePromptShown)
        a.onTitle("Unstuck · handed back")
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(1600))
        assertTrue(a.isFinishing)
    }

    @Test fun `no JS bridge anywhere in the app`() {
        val sources = java.io.File("src/main").walkTopDown().filter { it.extension == "kt" }.map { it.readText() }.joinToString()
        assertFalse(sources.contains("addJavascriptInterface"))
    }

    @Test fun `a crashed WebView renderer closes the takeover screen instead of the app`() {
        val a = launch(live) { _, _ -> "laptop" }
        val web = a.findViewById<WebView>(ViewerActivity.WEB_ID)!!
        val gone = object : android.webkit.RenderProcessGoneDetail() {
            override fun didCrash() = true
            override fun rendererPriorityAtExit() = 0
        }
        assertTrue("handled, so Android doesn't kill the app", shadowOf(web).webViewClient.onRenderProcessGone(web, gone))
        assertTrue(a.isFinishing)
    }
}
