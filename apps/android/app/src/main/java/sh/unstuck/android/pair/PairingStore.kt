package sh.unstuck.android.pair

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** This phone's pairing: the device id and the device token Cloud gave it, and its label. */
data class Pairing(val deviceId: String, val deviceToken: String, val label: String)

interface PairingStore {
    fun load(): Pairing?
    fun save(p: Pairing)
    fun clear()
}

/** Kept in EncryptedSharedPreferences (its key in the Android Keystore). */
class EncryptedPairingStore(context: Context) : PairingStore {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "unstuck_pairing",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun load(): Pairing? {
        val id = prefs.getString("deviceId", null) ?: return null
        val token = prefs.getString("deviceToken", null) ?: return null
        return Pairing(id, token, prefs.getString("label", "") ?: "")
    }

    override fun save(p: Pairing) {
        prefs.edit().putString("deviceId", p.deviceId).putString("deviceToken", p.deviceToken).putString("label", p.label).apply()
    }

    override fun clear() {
        prefs.edit().clear().apply()
    }
}

/** For tests and previews. */
class MemoryPairingStore(private var p: Pairing? = null) : PairingStore {
    override fun load() = p
    override fun save(p: Pairing) { this.p = p }
    override fun clear() { p = null }
}
