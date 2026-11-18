package sh.unstuck.android

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What Google Play checks before it accepts the app. */
@RunWith(RobolectricTestRunner::class)
class PlayPolicyTest {
    private val ctx = ApplicationProvider.getApplicationContext<Context>()
    private val requested by lazy {
        ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty().toList()
    }

    @Test fun `no restricted battery permission (the app opens Android's battery settings instead)`() {
        assertFalse(requested.toString(), "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" in requested)
    }

    @Test fun `targets Android 16 (API 36), Play's floor for new apps`() {
        assertTrue(ctx.applicationInfo.targetSdkVersion >= 36)
    }
}
