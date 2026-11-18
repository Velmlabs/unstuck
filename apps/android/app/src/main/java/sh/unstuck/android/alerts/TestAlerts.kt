package sh.unstuck.android.alerts

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** When a test alert last showed as a notification on this phone (the setup's proof that alerts arrive). */
object TestAlerts {
    private val _shownAt = MutableStateFlow(0L)
    val shownAt: StateFlow<Long> = _shownAt

    fun shown(at: Long) {
        _shownAt.value = at
    }
}
