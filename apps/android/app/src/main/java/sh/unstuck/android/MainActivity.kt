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
    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { refresh.intValue++ }

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
            notificationsAllowed = {
                Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            },
        )
        setContent {
            UnstuckTheme {
                Surface(color = Brand.Background) {
                    val screen by model.screen.collectAsState()
                    val error by model.error.collectAsState()
                    val notice by model.notice.collectAsState()
                    val tick = refresh.intValue
                    val checklist = remember(tick, screen) { model.checklist() }
                    when (screen) {
                        Screen.WELCOME -> WelcomeScreen(error, onScan = ::startScan, onCode = ::pair)
                        Screen.SETUP -> SetupScreen(checklist, notice, ::askNotifications, ::openBatterySetting, { lifecycleScope.launch { model.sendTest() } }, model::finishSetup)
                        Screen.HOME -> HomeScreen(model.pairing()?.label ?: "", notice, { lifecycleScope.launch { model.sendTest() } }, { lifecycleScope.launch { model.unpair() } })
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
        if (Build.VERSION.SDK_INT >= 33) notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun openBatterySetting() {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        runCatching { startActivity(direct) }.onFailure { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
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
