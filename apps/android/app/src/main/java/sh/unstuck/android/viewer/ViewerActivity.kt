package sh.unstuck.android.viewer

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import sh.unstuck.android.BuildConfig
import sh.unstuck.android.alerts.Notifications
import sh.unstuck.android.alerts.UnstuckMessagingService
import sh.unstuck.android.crypto.AlertCrypto
import sh.unstuck.android.crypto.AlertPayload
import sh.unstuck.android.pair.EncryptedPairingStore
import sh.unstuck.android.pair.PairApi
import sh.unstuck.android.pair.PairException
import sh.unstuck.android.pair.PairingStore

/** What the viewer screen needs from the rest of the app (replaced in tests). */
class ViewerDeps(
    val store: (Context) -> PairingStore,
    val unseal: (Context, String) -> AlertPayload?,
    val sender: suspend (deviceToken: String, sessionId: String) -> String?,
) {
    constructor(store: (Context) -> PairingStore, unseal: (String) -> AlertPayload?, sender: suspend (String, String) -> String?) :
        this(store, { _: Context, l: String -> unseal(l) }, sender)

    companion object {
        fun real() = ViewerDeps(
            store = { c: Context -> EncryptedPairingStore(c) },
            unseal = { c: Context, l: String -> UnstuckMessagingService.unseal(c, l) },
            sender = { t: String, s: String -> PairApi(BuildConfig.API_ORIGIN).sender(t, s) },
        )
    }
}

/**
 * Opens a takeover: unseals the tapped alert's sealed link again, checks with Cloud that it sent this alert to this
 * phone, then shows the hosted viewer in a WebView locked to its origin. The plain link lives only in memory and in
 * the WebView's URL fragment.
 */
class ViewerActivity : ComponentActivity() {
    private var web: WebView? = null
    private var message: TextView? = null
    private var state = ViewerState.OTHER
    private val main = Handler(Looper.getMainLooper())
    var leavePromptShown = false
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = back()
        })
        val link = intent.getStringExtra(Notifications.EXTRA_LINK)
        val parsed = link?.let { AlertCrypto.parseAlertLink(it) }
        val store = deps.store(this)
        val pairing = store.load()
        if (link == null || parsed == null) return showMessage("Nothing to open", "This alert has no takeover link.")
        if (pairing == null) return unpaired(store)
        val payload = deps.unseal(this, link)
            ?: return showMessage("Couldn't open this alert", "It may be for another phone, or this phone was paired again.")
        if (payload.expiresAt <= System.currentTimeMillis()) return showMessage("This takeover has ended", "The agent is no longer waiting. If it still needs you, it will send a new alert.")
        lifecycleScope.launch {
            val keyName = try {
                deps.sender(pairing.deviceToken, parsed.sessionId)
            } catch (e: PairException.Unpaired) {
                return@launch unpaired(store)
            } catch (e: Exception) {
                null
            }
            if (keyName == null) {
                showMessage(
                    "Couldn't confirm who sent this",
                    "Unstuck Cloud didn't confirm it sent this alert to this phone. Open it only if you expected it.",
                    "Open anyway" to { load(viewerUrl(parsed, payload, "")) },
                )
            } else {
                load(viewerUrl(parsed, payload, keyName))
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun load(url: String) {
        val w = WebView(this).apply {
            id = WEB_ID
            settings.javaScriptEnabled = true // the viewer is a web app
            settings.domStorageEnabled = true // resume key (sessionStorage, IndexedDB)
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.userAgentString = "${settings.userAgentString} UnstuckAndroid/${BuildConfig.VERSION_NAME}"
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url.toString()
                    if (allowed(u, BuildConfig.VIEW_ORIGIN)) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addCategory(Intent.CATEGORY_BROWSABLE)) }
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) = onTitle(title)
            }
        }
        web = w
        setContentView(w)
        w.loadUrl(url)
    }

    /** The viewer's state, from its title: back asks while live; an ended takeover closes a moment later. */
    fun onTitle(title: String?) {
        state = viewerState(title)
        if (state == ViewerState.ENDED || state == ViewerState.HANDED_BACK) main.postDelayed({ if (!isFinishing) finish() }, 1500)
    }

    private fun back() {
        if (state != ViewerState.LIVE) return finish()
        leavePromptShown = true
        AlertDialog.Builder(this)
            .setTitle("Leave the takeover?")
            .setMessage("The agent keeps waiting until you tap Done or Can't solve, or the time runs out.")
            .setPositiveButton("Leave") { _, _ -> finish() }
            .setNegativeButton("Stay", null)
            .show()
    }

    private fun unpaired(store: PairingStore) {
        store.clear()
        startActivity(Intent().setClassName(this, "sh.unstuck.android.MainActivity").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    private fun showMessage(title: String, body: String, action: Pair<String, () -> Unit>? = null) {
        val pad = (24 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(this).apply { text = title; textSize = 22f; gravity = Gravity.CENTER })
        message = TextView(this).apply { text = "$title\n$body"; visibility = View.GONE }
        layout.addView(message)
        layout.addView(TextView(this).apply { text = body; textSize = 16f; gravity = Gravity.CENTER; setPadding(0, pad / 2, 0, pad) })
        action?.let { (label, run) -> layout.addView(Button(this).apply { text = label; setOnClickListener { run() } }) }
        layout.addView(Button(this).apply { text = "Close"; setOnClickListener { finish() } })
        setContentView(layout)
    }

    /** The message screen's text (tests). */
    fun messageText(): String = message?.text?.toString() ?: ""

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        web?.destroy()
        super.onDestroy()
    }

    companion object {
        const val WEB_ID = 0x7f0a0001
        var deps: ViewerDeps = ViewerDeps.real()
    }
}
