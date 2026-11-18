package sh.unstuck.android

import org.junit.Assert.assertEquals
import org.junit.Test

class ToolchainTest {
    @Test fun `prod flavor points at Unstuck Cloud`() = assertEquals("https://view.unstuck.sh", BuildConfig.VIEW_ORIGIN)
}
