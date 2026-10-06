package com.nickbolles.jarvis.widgets

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.lifecycle.lifecycleScope
import com.nickbolles.jarvis.ui.theme.JarvisTheme
import kotlinx.coroutines.launch

/** Shown when "Next up" is added to the home screen: how many items to show. */
class NextUpConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        setContent {
            JarvisTheme {
                Surface {
                    var count by remember { mutableIntStateOf(3) }
                    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("Next up widget", style = MaterialTheme.typography.headlineSmall)
                        Text("How many actions should it show? It shows fewer when it's small.", style = MaterialTheme.typography.bodyMedium)
                        val options = listOf(1, 3, 5)
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            options.forEachIndexed { i, n ->
                                SegmentedButton(selected = count == n, onClick = { count = n }, shape = SegmentedButtonDefaults.itemShape(i, options.size)) { Text("$n") }
                            }
                        }
                        Button(onClick = { save(appWidgetId, count) }, modifier = Modifier.fillMaxWidth()) { Text("Add widget") }
                    }
                }
            }
        }
    }

    private fun save(appWidgetId: Int, count: Int) {
        lifecycleScope.launch {
            val id = GlanceAppWidgetManager(this@NextUpConfigActivity).getGlanceIdBy(appWidgetId)
            updateAppWidgetState(this@NextUpConfigActivity, id) { it[NEXT_COUNT] = count }
            NextUpWidget().update(this@NextUpConfigActivity, id)
            WidgetUpdater.requestRefresh(this@NextUpConfigActivity)
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
            finish()
        }
    }
}
