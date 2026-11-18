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
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ScrollView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import sh.unstuck.android.R
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import sh.unstuck.android.BuildConfig
import sh.unstuck.android.alerts.Notifications
import sh.unstuck.android.alerts.UnstuckMessagingService
import sh.unstuck.android.crypto.AlertPayload
import sh.unstuck.android.pair.EncryptedPairingStore
import sh.unstuck.android.pair.Forget
import sh.unstuck.android.pair.PairApi
import sh.unstuck.android.pair.PairException
import sh.unstuck.android.pair.PairingStore

/** What the viewer screen needs from the rest of the app (replaced in tests). */
class ViewerDeps(
    val store: (Context) -> PairingStore,
    val unseal: (Context, String) -> AlertPayload?,
    val sender: suspend (deviceToken: String, sessionId: String) -> String?,
    /** Forgets the pairing, the key and the FCM token (Forget.all). */
    val forget: (Context) -> Unit,
) {
    constructor(store: (Context) -> PairingStore, unseal: (String) -> AlertPayload?, sender: suspend (String, String) -> String?, forget: (Context) -> Unit) :
        this(store, { _: Context, l: String -> unseal(l) }, sender, forget)

    companion object {
        fun real() = ViewerDeps(
            store = { c: Context -> EncryptedPairingStore(c) },
            unseal = { c: Context, l: String -> UnstuckMessagingService.unseal(c, l) },
            sender = { t: String, s: String -> PairApi(BuildConfig.API_ORIGIN).sender(t, s) },
            forget = { c: Context -> Forget.all(c) },
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
        val parsed = link?.let { trustedAlertLink(it, BuildConfig.VIEW_ORIGIN) }
        val store = deps.store(this)
        val pairing = store.load()
        if (link == null || parsed == null) return showMessage("Nothing to open", "This alert has no takeover link.")
        if (pairing == null) return unpaired()
        val payload = runCatching { deps.unseal(this, link) }.getOrNull()
            ?: return showMessage("Couldn't open this alert", "It may be for another phone, or this phone was paired again.")
        if (payload.expiresAt <= System.currentTimeMillis()) return showMessage("This takeover has ended", "The agent is no longer waiting. If it still needs you, it will send a new alert.")
        lifecycleScope.launch {
            val keyName = try {
                deps.sender(pairing.deviceToken, parsed.sessionId)
            } catch (e: PairException.Unpaired) {
                return@launch unpaired()
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
        if (!allowed(url, BuildConfig.VIEW_ORIGIN)) return showMessage("Nothing to open", "This alert has no takeover link.")
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
        setContentView(insetRoot(w))
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

    private fun unpaired() {
        deps.forget(this)
        startActivity(Intent().setClassName(this, "sh.unstuck.android.MainActivity").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    private fun showMessage(title: String, body: String, action: Pair<String, () -> Unit>? = null) {
        val dp = resources.displayMetrics.density
        val pad = (24 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(ImageView(this).apply { setImageResource(R.drawable.logo_mark); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams((56 * dp).toInt(), (56 * dp).toInt()).apply { bottomMargin = pad })
        layout.addView(TextView(this).apply {
            text = title; textSize = 24f; gravity = Gravity.CENTER; setTextColor(getColor(R.color.brand_text)); setTypeface(typeface, Typeface.BOLD)
            ViewCompat.setAccessibilityHeading(this, true)
        })
        message = TextView(this).apply { text = "$title\n$body"; visibility = View.GONE }
        layout.addView(message)
        layout.addView(TextView(this).apply {
            text = body; textSize = 16f; gravity = Gravity.CENTER; setTextColor(getColor(R.color.brand_muted)); setLineSpacing(0f, 1.25f); setPadding(0, pad / 2, 0, pad)
        })
        val buttonParams = { LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (52 * dp).toInt()).apply { topMargin = (12 * dp).toInt() } }
        action?.let { (label, run) -> layout.addView(button(label, primary = true) { run() }, buttonParams()) }
        layout.addView(button("Close", primary = action == null) { finish() }, buttonParams())
        setContentView(insetRoot(ScrollView(this).apply { isFillViewport = true; addView(layout) }))
    }

    /** A brand button as a plain View: green filled, or outlined. */
    private fun button(label: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 16f
        setTypeface(typeface, Typeface.BOLD)
        stateListAnimator = null
        val radius = 14 * resources.displayMetrics.density
        background = android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x33FFFFFF),
            GradientDrawable().apply {
                cornerRadius = radius
                if (primary) setColor(getColor(R.color.brand_green)) else setStroke((1.5f * resources.displayMetrics.density).toInt(), 0xFF475569.toInt())
            },
            null,
        )
        setTextColor(if (primary) getColor(R.color.brand_bg) else getColor(R.color.brand_text))
        setOnClickListener { onClick() }
    }

    /** Android 15 draws apps edge to edge: keep the content clear of the status bar, navigation bar and keyboard. */
    private fun insetRoot(child: View): View = FrameLayout(this).apply {
        setBackgroundColor(getColor(R.color.brand_bg))
        addView(child, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
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
