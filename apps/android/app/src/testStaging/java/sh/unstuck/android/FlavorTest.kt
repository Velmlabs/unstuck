package sh.unstuck.android

import org.junit.Assert.assertEquals
import org.junit.Test

class FlavorTest {
    @Test fun `staging talks to the staging servers and installs next to prod`() {
        assertEquals("https://unstuck-cloud-staging.zeandcode.workers.dev", BuildConfig.API_ORIGIN)
        assertEquals("https://unstuck-viewer-staging.zeandcode.workers.dev", BuildConfig.VIEW_ORIGIN)
        assertEquals("sh.unstuck.android.staging", BuildConfig.APPLICATION_ID)
    }
}
