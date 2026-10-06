package com.nickbolles.jarvis.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences as DsPreferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.KSerializer

/** Who this phone is paired with. The token never leaves the device unencrypted at rest. */
data class Pairing(val server: String, val token: String, val deviceId: String, val userName: String)

private val Context.dataStore: DataStore<DsPreferences> by preferencesDataStore(name = "jarvis")

/**
 * Pairing, Firebase config and small app settings in DataStore. The device
 * token is encrypted with an Android Keystore AES-GCM key (non-exportable).
 * Last-known API payloads live in files so screens and widgets open instantly.
 */
class SessionStore(private val context: Context, private val crypto: TokenCrypto = KeystoreTokenCrypto()) {
    private object K {
        val server = stringPreferencesKey("server")
        val token = stringPreferencesKey("token_enc")
        val deviceId = stringPreferencesKey("device_id")
        val userName = stringPreferencesKey("user_name")
        val push = stringPreferencesKey("push_config")
        val pushToken = stringPreferencesKey("push_token_sent")
        val fcmToken = stringPreferencesKey("fcm_token")
    }

    val pairing: Flow<Pairing?> = context.dataStore.data.map { p -> p.toPairing() }

    private fun DsPreferences.toPairing(): Pairing? {
        val server = this[K.server] ?: return null
        val enc = this[K.token] ?: return null
        val token = runCatching { crypto.decrypt(enc) }.getOrNull() ?: return null
        return Pairing(server, token, this[K.deviceId] ?: "", this[K.userName] ?: "")
    }

    suspend fun current(): Pairing? = context.dataStore.data.first().toPairing()

    suspend fun savePairing(p: Pairing) {
        context.dataStore.edit {
            it[K.server] = p.server
            it[K.token] = crypto.encrypt(p.token)
            it[K.deviceId] = p.deviceId
            it[K.userName] = p.userName
        }
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
        cacheDir().listFiles()?.forEach { it.delete() }
    }

    suspend fun pushConfig(): PushConfig? = context.dataStore.data.first()[K.push]?.let { runCatching { JarvisJson.decodeFromString(PushConfig.serializer(), it) }.getOrNull() }

    suspend fun savePushConfig(c: PushConfig?) {
        context.dataStore.edit { if (c == null) it.remove(K.push) else it[K.push] = JarvisJson.encodeToString(PushConfig.serializer(), c) }
    }

    /** Latest registration token Firebase gave us (onRegistered). */
    suspend fun fcmToken(): String? = context.dataStore.data.first()[K.fcmToken]

    suspend fun saveFcmToken(token: String?) {
        context.dataStore.edit { if (token == null) it.remove(K.fcmToken) else it[K.fcmToken] = token }
    }

    suspend fun sentPushToken(): String? = context.dataStore.data.first()[K.pushToken]

    suspend fun markPushTokenSent(token: String?) {
        context.dataStore.edit { if (token == null) it.remove(K.pushToken) else it[K.pushToken] = token }
    }

    /* ------------------------------------------------------- payload cache */

    private fun cacheDir() = File(context.filesDir, "cache").apply { mkdirs() }

    fun <T> readCache(name: String, serializer: KSerializer<T>): T? =
        runCatching { File(cacheDir(), "$name.json").takeIf { it.exists() }?.readText()?.let { JarvisJson.decodeFromString(serializer, it) } }.getOrNull()

    fun <T> writeCache(name: String, serializer: KSerializer<T>, value: T) {
        runCatching {
            val f = File(cacheDir(), "$name.json")
            val tmp = File(cacheDir(), "$name.json.tmp")
            tmp.writeText(JarvisJson.encodeToString(serializer, value))
            tmp.renameTo(f)
        }
    }
}

interface TokenCrypto {
    fun encrypt(plain: String): String
    fun decrypt(encoded: String): String
}

class KeystoreTokenCrypto(private val alias: String = "jarvis_token_key") : TokenCrypto {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    override fun decrypt(encoded: String): String {
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12)) }
        return String(c.doFinal(bytes, 12, bytes.size - 12))
    }
}

/** For tests (Robolectric has no AndroidKeyStore). */
class PlainTokenCrypto : TokenCrypto {
    override fun encrypt(plain: String) = plain
    override fun decrypt(encoded: String) = encoded
}
