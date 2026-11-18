package sh.unstuck.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.firebase.messaging.FirebaseMessaging
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import sh.unstuck.android.alerts.Notifications
import sh.unstuck.android.alerts.TestAlerts
import sh.unstuck.android.crypto.AlertCrypto
import sh.unstuck.android.pair.DeviceKeys
import sh.unstuck.android.pair.EncryptedPairingStore
import sh.unstuck.android.pair.Forget
import sh.unstuck.android.pair.PairApi
import sh.unstuck.android.ui.AppModel
import sh.unstuck.android.ui.Brand
import sh.unstuck.android.ui.UnstuckTheme
import sh.unstuck.android.ui.HomeScreen
import sh.unstuck.android.ui.Screen
import sh.unstuck.android.ui.SetupScreen
import sh.unstuck.android.ui.WelcomeScreen
import kotlin.coroutines.resume

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel
    private val refresh = mutableIntStateOf(0)
    private val scan = registerForActivityResult(ScanContract()) { r -> r.contents?.let { pair(it) } }
    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // Denied twice, Android stops asking: the app's notification settings are the only way left.
        if (!granted || !Notifications.canShow(this)) openNotificationSettings()
        refresh.intValue++
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        Notifications.ensureChannel(this)
        val keys = DeviceKeys(this)
        model = AppModel(
            store = EncryptedPairingStore(this),
            api = PairApi(BuildConfig.API_ORIGIN),
            publicKey = { AlertCrypto.rawPublicKey(keys.publicKey()) },
            deleteKey = { keys.delete() },
            fcmToken = { fcmToken() },
            deleteFcmToken = { Forget.deleteFcmToken() },
            label = "${Build.MODEL} · App",
            viewOrigin = BuildConfig.VIEW_ORIGIN,
            batteryUnrestricted = { getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) },
            notificationsAllowed = { Notifications.canShow(this) },
        )
        setContent {
            UnstuckTheme {
                Surface(color = Brand.Background) {
                    val screen by model.screen.collectAsState()
                    val error by model.error.collectAsState()
                    val notice by model.notice.collectAsState()
                    val testAgainAt by model.testAgainAt.collectAsState()
                    val testConfirmed by model.testConfirmed.collectAsState()
                    val shownAt by TestAlerts.shownAt.collectAsState()
                    LaunchedEffect(shownAt) { if (shownAt > 0) model.onTestArrived(shownAt) }
                    val tick = refresh.intValue
                    val checklist = remember(tick, screen) { model.checklist() }
                    when (screen) {
                        Screen.WELCOME -> WelcomeScreen(error, onScan = ::startScan, onCode = ::pair)
                        Screen.SETUP -> SetupScreen(checklist, notice, ::askNotifications, ::openBatterySetting, { lifecycleScope.launch { model.sendTest() } }, model::finishSetup, testAgainAt, testConfirmed)
                        Screen.HOME -> HomeScreen(model.pairing()?.label ?: "", checklist, notice, ::askNotifications, ::openBatterySetting, { lifecycleScope.launch { model.sendTest() } }, { lifecycleScope.launch { model.unpair() } }, testAgainAt)
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh.intValue++ // the person may have changed a setting
        lifecycleScope.launch { model.refresh() } // re-sends the FCM token; a phone removed on the dashboard goes back to Welcome
    }

    private fun pair(input: String) {
        lifecycleScope.launch { model.pairWith(input) }
    }

    private fun startScan() {
        scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the QR code from your dashboard").setBeepEnabled(false).setOrientationLocked(false))
    }

    private fun askNotifications() {
        val granted = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted) notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS) else openNotificationSettings()
    }

    /** The app's notification settings (also where the Takeovers channel is turned back on). */
    private fun openNotificationSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) }
    }

    /**
     * The app's App info page (Battery → Unrestricted lives there). No REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: Google Play
     * restricts that permission, so the person makes the change in Android's own settings.
     */
    private fun openBatterySetting() {
        val appInfo = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        runCatching { startActivity(appInfo) }.onFailure { runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } }
    }

    /** The FCM registration token; null when this build has no Firebase config (it can't receive alerts then). */
    private suspend fun fcmToken(): String? = try {
        suspendCancellableCoroutine { c ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> c.resume(if (t.isSuccessful) t.result else null) }
        }
    } catch (e: IllegalStateException) {
        null
    }
}
