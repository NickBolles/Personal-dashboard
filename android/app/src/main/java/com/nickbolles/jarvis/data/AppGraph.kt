package com.nickbolles.jarvis.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer

/** Whether we know the pairing yet (DataStore loads asynchronously). */
sealed interface PairingState {
    data object Loading : PairingState
    data object Unpaired : PairingState
    data class Paired(val pairing: Pairing) : PairingState
}

/**
 * Process-wide dependencies (manual DI). Screens, widgets, the notification
 * service and workers all reach the server through this.
 */
class AppGraph(val context: Context, val store: SessionStore = SessionStore(context)) {
    val scope = CoroutineScope(SupervisorJob())

    val pairingState: StateFlow<PairingState> = store.pairing
        .map { p -> if (p == null) PairingState.Unpaired else PairingState.Paired(p) }
        .stateIn(scope, SharingStarted.Eagerly, PairingState.Loading)

    /** Shown once after the server revoked this phone. */
    private val _signedOutReason = MutableStateFlow<String?>(null)
    val signedOutReason = _signedOutReason.asStateFlow()

    private var cachedApi: Pair<Pairing, JarvisApi>? = null

    suspend fun api(): JarvisApi {
        val p = store.current() ?: throw ApiException(401, "unpaired", "This phone isn't paired with Jarvis")
        cachedApi?.let { (key, api) -> if (key == p) return api }
        return JarvisApi(p.server, p.token).also { cachedApi = p to it }
    }

    /** Run a call; a 401 means the device token was revoked, so forget the pairing. */
    suspend fun <T> call(block: suspend (JarvisApi) -> T): T {
        try {
            return block(api())
        } catch (e: ApiException) {
            if (e.isAuth && e.code != "unpaired") signOutLocally("Jarvis signed this phone out. Pair it again from Settings → Phones.")
            throw e
        }
    }

    suspend fun signOutLocally(reason: String? = null) {
        _signedOutReason.value = reason
        cachedApi = null
        store.clear()
    }

    fun clearSignedOutReason() {
        _signedOutReason.value = null
    }

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    /** Shared preferences resource: Home, Settings and the theme all observe the same copy. */
    val prefs by lazy { Resource(this, "prefs", Preferences.serializer()) { it.preferences() } }

    /** Called after anything that changes what widgets show (actions, alerts, pushes). */
    var onDataChanged: () -> Unit = {}

    companion object {
        @Volatile
        private var instance: AppGraph? = null

        fun get(context: Context): AppGraph = instance ?: synchronized(this) {
            instance ?: AppGraph(context.applicationContext).also { instance = it }
        }

        /** Tests install a graph with fakes. */
        fun install(graph: AppGraph) {
            instance = graph
        }
    }
}

/** UI state for anything loaded from the server with a cached copy shown first. */
data class Loadable<T>(
    val data: T? = null,
    val loading: Boolean = false,
    val error: String? = null,
    /** data came from the local cache and a refresh hasn't succeeded yet */
    val fromCache: Boolean = false,
)

/**
 * Cache-then-network loader: emits the last saved copy immediately (so the
 * app opens instantly, also offline), then the server's answer.
 */
class Resource<T>(
    private val graph: AppGraph,
    private val cacheName: String?,
    private val serializer: KSerializer<T>,
    private val fetch: suspend (JarvisApi) -> T,
) {
    private val _state = MutableStateFlow(Loadable<T>(data = cacheName?.let { graph.store.readCache(it, serializer) }, fromCache = cacheName != null))
    val state: StateFlow<Loadable<T>> = _state.asStateFlow()

    suspend fun refresh() {
        _state.value = _state.value.copy(loading = true, error = null)
        try {
            val v = graph.call(fetch)
            cacheName?.let { graph.store.writeCache(it, serializer, v) }
            _state.value = Loadable(data = v)
        } catch (e: ApiException) {
            _state.value = _state.value.copy(loading = false, error = e.message)
        }
    }

    fun set(value: T) {
        _state.value = _state.value.copy(data = value)
        cacheName?.let { graph.store.writeCache(it, serializer, value) }
    }
}
