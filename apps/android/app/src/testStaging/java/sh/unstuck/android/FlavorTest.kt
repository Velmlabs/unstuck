package sh.unstuck.android

import org.junit.Assert.assertEquals
import org.junit.Test

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
class FlavorTest {
    @Test fun `staging talks to the staging servers and installs next to prod`() {
        assertEquals("https://unstuck-cloud-staging.zeandcode.workers.dev", BuildConfig.API_ORIGIN)
        assertEquals("https://unstuck-viewer-staging.zeandcode.workers.dev", BuildConfig.VIEW_ORIGIN)
        assertEquals("sh.unstuck.android.staging", BuildConfig.APPLICATION_ID)
    }

    @Test fun `the staging app is named Unstuck Staging and uses the Unstuck launcher icon`() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        assertEquals("Unstuck Staging", ctx.getString(R.string.app_name))
        assertEquals(R.mipmap.ic_launcher, ctx.applicationInfo.icon)
    }
}
