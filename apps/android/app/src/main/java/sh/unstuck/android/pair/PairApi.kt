package sh.unstuck.android.pair

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class Paired(val deviceId: String, val deviceToken: String)

sealed class PairException(message: String) : Exception(message) {
    class CodeExpired : PairException("This code has expired or was already used. Make a new one in the dashboard.")
    class RateLimited : PairException("Too many tries. Wait a minute and try again.")
    /** The device was removed (unpaired from the dashboard, or its token is no longer valid). */
    class Unpaired : PairException("This phone is no longer paired.")
    class Http(val status: Int) : PairException("Unstuck Cloud answered $status.")
}

/** What the app's screens need from Unstuck Cloud (PairApi; fakes in tests). */
interface DeviceApi {
    suspend fun pair(code: String, publicKey: String, label: String): Paired
    suspend fun putFcm(deviceToken: String, token: String)
    suspend fun test(deviceToken: String): JSONObject?
    suspend fun unpair(deviceToken: String)
    /** Throws Unpaired when Cloud no longer knows this phone. */
    suspend fun check(deviceToken: String)
}

/** Unstuck Cloud's device API: pairing with a code, then calls authenticated with the device token. */
class PairApi(private val apiOrigin: String) : DeviceApi {
    override suspend fun pair(code: String, publicKey: String, label: String): Paired {
        val body = JSONObject().put("code", code).put("publicKey", publicKey).put("label", label).put("kind", "android")
        val (status, json) = call("POST", "/api/v1/devices/pair", null, body)
        return when (status) {
            200, 201 -> Paired(json!!.getString("deviceId"), json.getString("deviceToken"))
            410 -> throw PairException.CodeExpired()
            429 -> throw PairException.RateLimited()
            else -> throw PairException.Http(status)
        }
    }

    override suspend fun putFcm(deviceToken: String, token: String) {
        self("PUT", "/api/v1/devices/self/fcm", deviceToken, JSONObject().put("token", token))
    }

    /** Sends a test alert to this phone; the per-channel results. */
    override suspend fun test(deviceToken: String): JSONObject? = self("POST", "/api/v1/devices/self/test", deviceToken, null).second

    override suspend fun check(deviceToken: String) {
        self("GET", "/api/v1/devices/self", deviceToken, null)
    }

    override suspend fun unpair(deviceToken: String) {
        self("DELETE", "/api/v1/devices/self", deviceToken, null)
    }

    /** The key's name when Cloud delivered this session's alert to this phone; null when it didn't. */
    suspend fun sender(deviceToken: String, sessionId: String): String? {
        val (status, json) = call("GET", "/api/v1/devices/self/alerts/$sessionId", deviceToken, null)
        return when (status) {
            200 -> json?.optString("keyName")?.takeIf { it.isNotEmpty() }
            401 -> throw PairException.Unpaired()
            else -> null
        }
    }

    private suspend fun self(method: String, path: String, deviceToken: String, body: JSONObject?): Pair<Int, JSONObject?> {
        val r = call(method, path, deviceToken, body)
        if (r.first == 401) throw PairException.Unpaired()
        if (r.first == 429) throw PairException.RateLimited()
        if (r.first !in 200..299) throw PairException.Http(r.first)
        return r
    }

    private suspend fun call(method: String, path: String, deviceToken: String?, body: JSONObject?): Pair<Int, JSONObject?> = withContext(Dispatchers.IO) {
        val c = URL(apiOrigin + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = 15_000
            c.setRequestProperty("accept", "application/json")
            if (deviceToken != null) c.setRequestProperty("Authorization", "Bearer $deviceToken")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = c.responseCode
            val text = (if (status in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            status to text.takeIf { it.trimStart().startsWith("{") }?.let { JSONObject(it) }
        } finally {
            c.disconnect()
        }
    }
}
