package com.nickbolles.jarvis.ui.screens

import android.net.Uri
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.nickbolles.jarvis.BuildConfig
import com.nickbolles.jarvis.R
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.JarvisApi
import com.nickbolles.jarvis.data.Pairing
import com.nickbolles.jarvis.push.PushRegistrar
import com.nickbolles.jarvis.ui.components.StatusBanner
import kotlinx.coroutines.launch

/** Parsed `jarvis://pair?server=…&code=…`. */
data class PairLink(val server: String, val code: String) {
    companion object {
        fun parse(raw: String?): PairLink? {
            val uri = runCatching { Uri.parse(raw ?: return null) }.getOrNull() ?: return null
            if (uri.scheme != "jarvis" || uri.host != "pair") return null
            val server = uri.getQueryParameter("server") ?: return null
            val code = uri.getQueryParameter("code") ?: return null
            return PairLink(server, code)
        }
    }
}

suspend fun pairPhone(graph: AppGraph, serverInput: String, code: String): Pairing {
    val server = runCatching { JarvisApi.normalizeServer(serverInput) }.getOrElse { throw ApiException(400, "bad_server", "That server address doesn't look right") }
    val name = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".trim()
    val r = JarvisApi(server, null).pair(code.trim(), name, BuildConfig.VERSION_NAME)
    val pairing = Pairing(server, r.token, r.deviceId, r.user.name)
    graph.store.savePairing(pairing)
    graph.launch { PushRegistrar.register(graph) }
    return pairing
}

@Composable
fun PairScreen(graph: AppGraph, link: PairLink?, signedOutReason: String?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var server by rememberSaveable { mutableStateOf(link?.server ?: "") }
    var code by rememberSaveable { mutableStateOf(link?.code ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit(s: String, c: String) {
        busy = true
        error = null
        scope.launch {
            try {
                pairPhone(graph, s, c)
                graph.clearSignedOutReason()
            } catch (e: ApiException) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    // Opened from a scanned QR link: pair straight away.
    LaunchedEffect(link) { if (link != null) submit(link.server, link.code) }

    PairContent(
        server = server,
        code = code,
        busy = busy,
        error = error,
        notice = signedOutReason,
        onServer = { server = it },
        onCode = { code = it },
        onSubmit = { submit(server, code) },
        onScan = {
            val scanner = GmsBarcodeScanning.getClient(context, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
            scanner.startScan()
                .addOnSuccessListener { barcode ->
                    val l = PairLink.parse(barcode.rawValue)
                    if (l == null) error = "That QR code isn't a Jarvis pairing code" else {
                        server = l.server
                        code = l.code
                        submit(l.server, l.code)
                    }
                }
                .addOnFailureListener { error = "Couldn't open the scanner. Type the server and code instead." }
        },
    )
}

@Composable
fun PairContent(
    server: String,
    code: String,
    busy: Boolean,
    error: String?,
    notice: String?,
    onServer: (String) -> Unit,
    onCode: (String) -> Unit,
    onSubmit: () -> Unit,
    onScan: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.Start,
    ) {
        Image(painterResource(R.drawable.jarvis_logo), contentDescription = null, modifier = Modifier.padding(top = 32.dp).size(64.dp))
        Text("Connect to Jarvis", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
        Text(
            "In Jarvis on the web, open Settings → Phones → Show pairing code. Then scan the QR code here.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        notice?.let { StatusBanner(it, tone = "warn") }
        error?.let { StatusBanner(it, tone = "danger") }
        Button(onClick = onScan, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
            Text("  Scan pairing code")
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        Text("Or type it", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = server,
            onValueChange = onServer,
            label = { Text("Server address") },
            placeholder = { Text("jarvis.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = code,
            onValueChange = onCode,
            label = { Text("Pairing code") },
            placeholder = { Text("ABCD-EF23") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(onClick = onSubmit, enabled = !busy && server.isNotBlank() && code.length >= 4, modifier = Modifier.fillMaxWidth()) {
            Text(if (busy) "Connecting…" else "Connect")
        }
        Text(
            "Jarvis stores a revocable token for this phone. Sign it out any time from this app or from Settings → Phones on the web.",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
