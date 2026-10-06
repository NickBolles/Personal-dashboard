package com.nickbolles.jarvis

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.PairingState
import com.nickbolles.jarvis.push.PushRegistrar
import com.nickbolles.jarvis.ui.nav.JarvisRoot
import com.nickbolles.jarvis.ui.nav.LaunchRequest
import com.nickbolles.jarvis.widgets.WidgetUpdater
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val requests = MutableStateFlow<LaunchRequest?>(null)
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requests.value = LaunchRequest.from(intent)
        setContent { JarvisRoot(requests) }

        val graph = AppGraph.get(this)
        lifecycleScope.launch {
            graph.pairingState.filterIsInstance<PairingState.Paired>().first()
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            PushRegistrar.register(graph)
            graph.prefs.refresh()
            WidgetUpdater.requestRefresh(this@MainActivity)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        LaunchRequest.from(intent)?.let { requests.value = it }
    }
}
