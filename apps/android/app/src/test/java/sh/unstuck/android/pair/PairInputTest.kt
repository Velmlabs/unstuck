package sh.unstuck.android.pair

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairInputTest {
    private val view = "https://view.unstuck.sh"

    @Test fun `pair input parsing`() {
        assertEquals("ABCDEFGH", parsePairInput("https://view.unstuck.sh/pair#c=ABCDEFGH", view))
        assertEquals("ABCDEFGH", parsePairInput("https://view.unstuck.sh/pair?api=https%3A%2F%2Fevil.test#c=ABCDEFGH", view)) // ?api= ignored
        assertNull(parsePairInput("https://evil.test/pair#c=ABCDEFGH", view))
        assertNull(parsePairInput("http://view.unstuck.sh/pair#c=ABCDEFGH", view))
        assertNull(parsePairInput("https://view.unstuck.sh.evil.test/pair#c=ABCDEFGH", view))
        assertNull(parsePairInput("https://view.unstuck.sh/pair", view))
        assertEquals("ABCDEFGH", parsePairInput("abcd-efgh", view))
        assertEquals("ABCDEFGH", parsePairInput(" ABCD EFGH ", view))
        assertNull(parsePairInput("ABCDEFG0", view)) // 0 is not in the code alphabet
        assertNull(parsePairInput("ABCDEFG", view))
        assertNull(parsePairInput("", view))
    }
}
