package sh.unstuck.android

import org.junit.Assert.assertEquals
import org.junit.Test

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
class FlavorTest {
    @Test fun `prod talks to Unstuck Cloud`() {
        assertEquals("https://unstuck.sh", BuildConfig.API_ORIGIN)
        assertEquals("https://view.unstuck.sh", BuildConfig.VIEW_ORIGIN)
        assertEquals("sh.unstuck.android", BuildConfig.APPLICATION_ID)
    }

    @Test fun `the prod app is named Unstuck and uses the Unstuck launcher icon`() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        assertEquals("Unstuck", ctx.getString(R.string.app_name))
        assertEquals(R.mipmap.ic_launcher, ctx.applicationInfo.icon)
    }
}
