package sh.unstuck.android.pair

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The phone's P-256 key pair for sealed alerts.
 * - Android 12+ (API 31): generated in the Android Keystore for key agreement (StrongBox when the phone has it); the
 *   private key never leaves it.
 * - Android 8–11: the Keystore can't do ECDH there, so the key pair is made in software and its private key is stored
 *   encrypted with a Keystore AES-GCM key (non-exportable), and decrypted in memory only to unseal an alert.
 */
class DeviceKeys(private val context: Context) {
    private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val prefs = context.getSharedPreferences("unstuck_device_key", Context.MODE_PRIVATE)

    fun getOrCreate(): KeyPair = load() ?: create()

    fun publicKey(): ECPublicKey = getOrCreate().public as ECPublicKey

    /** The paired key; throws when there is none (reading never makes a new key). */
    fun privateKey(): PrivateKey = load()?.private ?: throw IllegalStateException("no device key")

    fun delete() {
        if (ks.containsAlias(EC_ALIAS)) ks.deleteEntry(EC_ALIAS)
        if (ks.containsAlias(WRAP_ALIAS)) ks.deleteEntry(WRAP_ALIAS)
        prefs.edit().clear().apply()
    }

    private fun load(): KeyPair? {
        if (Build.VERSION.SDK_INT >= 31 && ks.containsAlias(EC_ALIAS)) {
            val e = ks.getEntry(EC_ALIAS, null) as KeyStore.PrivateKeyEntry
            return KeyPair(e.certificate.publicKey, e.privateKey)
        }
        val pub = prefs.getString("pub", null) ?: return null
        val sealed = prefs.getString("priv", null) ?: return null
        val iv = prefs.getString("iv", null) ?: return null
        val pkcs8 = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            doFinal(Base64.decode(sealed, Base64.NO_WRAP))
        }
        val kf = KeyFactory.getInstance("EC")
        return KeyPair(kf.generatePublic(X509EncodedKeySpec(Base64.decode(pub, Base64.NO_WRAP))), kf.generatePrivate(PKCS8EncodedKeySpec(pkcs8)))
    }

    private fun create(): KeyPair {
        if (Build.VERSION.SDK_INT >= 31) {
            fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(EC_ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setIsStrongBoxBacked(strongBox)
                .build()
            val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
            val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            return runCatching { gen.initialize(spec(strongBox)); gen.generateKeyPair() }
                .getOrElse { gen.initialize(spec(false)); gen.generateKeyPair() }
        }
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, wrapKey()) }
        val sealed = c.doFinal(pair.private.encoded)
        prefs.edit()
            .putString("pub", Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP))
            .putString("priv", Base64.encodeToString(sealed, Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
            .apply()
        return pair
    }

    private fun wrapKey(): SecretKey {
        (ks.getEntry(WRAP_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val EC_ALIAS = "unstuck-device"
        const val WRAP_ALIAS = "unstuck-device-wrap"
    }
}
