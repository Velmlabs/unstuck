package sh.unstuck.android.ui

import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Renders each screen to build/outputs/roborazzi/ (./gradlew testProdDebugUnitTest -Pscreenshots); skipped otherwise. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w393dp-h852dp-xxhdpi", sdk = [34])
class ScreensScreenshotTest {
    @Before fun onlyWhenAsked() = assumeTrue(System.getProperty("roborazzi.test.record") == "true")

    private fun shot(name: String, content: @androidx.compose.runtime.Composable () -> Unit) =
        captureRoboImage("build/outputs/roborazzi/$name.png") { UnstuckTheme { content() } }

    @Test fun welcome() = shot("welcome") { WelcomeScreen(null, {}, {}) }
    @Test fun welcomeError() = shot("welcome-error") { WelcomeScreen("This code has expired or was already used. Make a new one in the dashboard.", {}, {}) }
    @Test fun setup() = shot("setup") { SetupScreen(Checklist(notificationsAllowed = true, batteryUnrestricted = false), null, {}, {}, {}, {}) }
    @Test fun setupDone() = shot("setup-done") { SetupScreen(Checklist(true, true), "Test alert sent. It should arrive in a few seconds.", {}, {}, {}, {}) }
    @Test fun home() = shot("home") { HomeScreen("SM-A556E · App", "Test alert sent. It should arrive in a few seconds.", {}, {}) }

    /** The launcher icon as a circle-masked adaptive icon, and the status bar icon, at a glance. */
    @Test fun icons() = shot("icons") {
        androidx.compose.foundation.layout.Row(androidx.compose.ui.Modifier.background(Brand.Card).padding(24.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            androidx.compose.foundation.Image(
                androidx.compose.ui.res.painterResource(sh.unstuck.android.R.drawable.ic_launcher_foreground), null,
                androidx.compose.ui.Modifier.size(108.dp).clip(androidx.compose.foundation.shape.CircleShape).background(Brand.Background),
            )
            androidx.compose.foundation.layout.Spacer(androidx.compose.ui.Modifier.size(24.dp))
            androidx.compose.material3.Icon(androidx.compose.ui.res.painterResource(sh.unstuck.android.R.drawable.ic_stat_unstuck), null, tint = Brand.Green, modifier = androidx.compose.ui.Modifier.size(48.dp))
        }
    }
}
