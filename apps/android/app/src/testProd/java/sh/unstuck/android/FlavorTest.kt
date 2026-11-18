package sh.unstuck.android

import org.junit.Assert.assertEquals
import org.junit.Test

class FlavorTest {
    @Test fun `prod talks to Unstuck Cloud`() {
        assertEquals("https://unstuck.sh", BuildConfig.API_ORIGIN)
        assertEquals("https://view.unstuck.sh", BuildConfig.VIEW_ORIGIN)
        assertEquals("sh.unstuck.android", BuildConfig.APPLICATION_ID)
    }
}
