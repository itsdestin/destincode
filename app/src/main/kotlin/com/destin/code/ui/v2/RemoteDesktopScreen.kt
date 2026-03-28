package com.destin.code.ui.v2

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.view.ViewGroup
import android.webkit.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.v2.DesktopColors as DC
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Remote Desktop mode — connects to the desktop app's remote server
 * via WebView, providing the full desktop UI.
 *
 * Features:
 * - QR code scanner to pair with desktop
 * - Stored list of paired devices
 * - Manual host/port/password entry
 * - Full desktop UI in WebView
 */

data class PairedDevice(
    val name: String,
    val host: String,
    val port: Int,
    val password: String,
) {
    val url: String get() = "http://$host:$port"
}

// ─── Paired device storage ───────────────────────────────────────

private const val PREFS_NAME = "remote_devices"
private const val KEY_DEVICES = "paired_devices"

private fun loadPairedDevices(context: Context): List<PairedDevice> {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val json = prefs.getString(KEY_DEVICES, null) ?: return emptyList()
    return try {
        val arr = JSONArray(json)
        (0 until arr.length()).map { i ->
            val obj = arr.getJSONObject(i)
            PairedDevice(
                name = obj.optString("name", "Desktop"),
                host = obj.getString("host"),
                port = obj.optInt("port", 9900),
                password = obj.optString("password", ""),
            )
        }
    } catch (_: Exception) { emptyList() }
}

private fun savePairedDevices(context: Context, devices: List<PairedDevice>) {
    val arr = JSONArray()
    for (d in devices) {
        arr.put(JSONObject().apply {
            put("name", d.name)
            put("host", d.host)
            put("port", d.port)
            put("password", d.password)
        })
    }
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit().putString(KEY_DEVICES, arr.toString()).apply()
}

private fun removePairedDevice(context: Context, device: PairedDevice) {
    val devices = loadPairedDevices(context).filter { it.host != device.host || it.port != device.port }
    savePairedDevices(context, devices)
}

private fun addPairedDevice(context: Context, device: PairedDevice) {
    val existing = loadPairedDevices(context).filter { it.host != device.host || it.port != device.port }
    savePairedDevices(context, existing + device)
}

// ─── Main screen ─────────────────────────────────────────────────

@Composable
fun RemoteDesktopScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var activeConnection by remember { mutableStateOf<PairedDevice?>(null) }

    if (activeConnection != null) {
        RemoteWebView(
            device = activeConnection!!,
            onDisconnect = { activeConnection = null },
            modifier = modifier,
        )
    } else {
        RemoteDeviceList(
            onConnect = { activeConnection = it },
            onBack = onBack,
            modifier = modifier,
        )
    }
}

// ─── Device list + scan + manual entry ───────────────────────────

@Composable
private fun RemoteDeviceList(
    onConnect: (PairedDevice) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var devices by remember { mutableStateOf(loadPairedDevices(context)) }
    var showScanner by remember { mutableStateOf(false) }
    var showManualEntry by remember { mutableStateOf(false) }
    var prefillHost by remember { mutableStateOf("") }
    var prefillPort by remember { mutableStateOf("9900") }

    if (showScanner) {
        QrScannerScreen(
            onScanned = { url ->
                showScanner = false
                val parsed = parseRemoteUrl(url)
                if (parsed != null) {
                    prefillHost = parsed.first
                    prefillPort = parsed.second.toString()
                    showManualEntry = true
                }
            },
            onBack = { showScanner = false },
        )
        return
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(DC.gray950)
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Header
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "←",
                fontSize = 18.sp,
                color = DC.gray400,
                modifier = Modifier.clickable { onBack() }.padding(8.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "Connect to Desktop",
                fontSize = 18.sp,
                fontFamily = CascadiaMono,
                color = DC.gray200,
            )
        }

        Spacer(Modifier.height(24.dp))

        if (!showManualEntry) {
            // Paired devices list
            if (devices.isNotEmpty()) {
                Text(
                    "PAIRED DEVICES",
                    fontSize = 10.sp,
                    fontFamily = CascadiaMono,
                    color = DC.gray500,
                    letterSpacing = 1.sp,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(DC.gray900)
                        .border(1.dp, DC.gray700, RoundedCornerShape(8.dp)),
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    devices.forEachIndexed { index, device ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onConnect(device) }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    device.name,
                                    fontSize = 13.sp,
                                    fontFamily = CascadiaMono,
                                    color = DC.gray200,
                                )
                                Text(
                                    "${device.host}:${device.port}",
                                    fontSize = 11.sp,
                                    fontFamily = CascadiaMono,
                                    color = DC.gray500,
                                )
                            }
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "Remove",
                                tint = DC.gray500,
                                modifier = Modifier
                                    .size(16.dp)
                                    .clickable {
                                        removePairedDevice(context, device)
                                        devices = loadPairedDevices(context)
                                    },
                            )
                        }
                        if (index < devices.size - 1) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 12.dp)
                                    .height(0.5.dp)
                                    .background(DC.gray700),
                            )
                        }
                    }
                }

                Spacer(Modifier.height(16.dp))
            }

            // Action buttons
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Scan QR Code
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(DC.gray300)
                        .clickable { showScanner = true }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Scan QR Code", fontSize = 14.sp, fontFamily = CascadiaMono, color = DC.gray950)
                }

                // Manual entry
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .border(1.dp, DC.gray700, RoundedCornerShape(6.dp))
                        .clickable { showManualEntry = true }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Enter Manually", fontSize = 14.sp, fontFamily = CascadiaMono, color = DC.gray400)
                }
            }

            Spacer(Modifier.height(24.dp))

            // Setup help
            val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(DC.gray900)
                    .border(1.dp, DC.gray700, RoundedCornerShape(8.dp))
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "HOW IT WORKS",
                    fontSize = 10.sp,
                    fontFamily = CascadiaMono,
                    color = DC.gray500,
                    letterSpacing = 1.sp,
                )
                Text(
                    "DestinCode connects to the DestinCode desktop app, which is included " +
                    "in the DestinClaude plugin and extension package. The desktop app runs " +
                    "Claude Code locally and provides a remote access server that this app " +
                    "connects to over your network.",
                    fontSize = 12.sp,
                    fontFamily = CascadiaMono,
                    color = DC.gray400,
                    lineHeight = 18.sp,
                )
                Text(
                    "For access from anywhere, install Tailscale on both devices. " +
                    "Tailscale creates a secure private network so you can connect " +
                    "to your desktop from any location — no port forwarding needed.",
                    fontSize = 12.sp,
                    fontFamily = CascadiaMono,
                    color = DC.gray400,
                    lineHeight = 18.sp,
                )
                Text(
                    "Setup: Desktop app → Settings → Remote Access → Set password → Scan QR code from this screen.",
                    fontSize = 12.sp,
                    fontFamily = CascadiaMono,
                    color = DC.gray300,
                    lineHeight = 18.sp,
                )

                Spacer(Modifier.height(4.dp))

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .border(1.dp, DC.gray700, RoundedCornerShape(6.dp))
                        .clickable {
                            uriHandler.openUri("https://itsdestin.github.io/destinclaude/")
                        }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Get DestinClaude",
                        fontSize = 13.sp,
                        fontFamily = CascadiaMono,
                        color = Color(0xFF60A5FA),
                    )
                }
            }
        } else {
            // Manual entry form (pre-filled from QR scan if available)
            ManualEntryForm(
                onConnect = { device ->
                    addPairedDevice(context, device)
                    devices = loadPairedDevices(context)
                    onConnect(device)
                },
                onBack = {
                    showManualEntry = false
                    prefillHost = ""
                    prefillPort = "9900"
                },
                initialHost = prefillHost,
                initialPort = prefillPort,
            )
        }
    }
}

// ─── Manual entry form ───────────────────────────────────────────

@Composable
private fun ManualEntryForm(
    onConnect: (PairedDevice) -> Unit,
    onBack: () -> Unit,
    initialHost: String = "",
    initialPort: String = "9900",
) {
    var name by remember { mutableStateOf("Desktop") }
    var host by remember { mutableStateOf(initialHost) }
    var port by remember { mutableStateOf(initialPort) }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(DC.gray900)
            .border(1.dp, DC.gray700, RoundedCornerShape(8.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        FormField("DEVICE NAME") {
            FormInput(value = name, onValueChange = { name = it }, placeholder = "My Desktop")
        }
        FormField("HOST / IP") {
            FormInput(value = host, onValueChange = { host = it }, placeholder = "100.x.x.x")
        }
        FormField("PORT") {
            FormInput(value = port, onValueChange = { port = it }, placeholder = "9900")
        }
        FormField("PASSWORD") {
            FormInput(
                value = password,
                onValueChange = { password = it },
                placeholder = "Remote access password",
                isPassword = !showPassword,
            )
        }

        // Show password toggle
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("SHOW PASSWORD", fontSize = 10.sp, fontFamily = CascadiaMono, color = DC.gray500, letterSpacing = 1.sp)
            Box(
                modifier = Modifier
                    .width(32.dp).height(18.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(if (showPassword) DC.gray300 else DC.gray700)
                    .clickable { showPassword = !showPassword },
            ) {
                Box(
                    modifier = Modifier
                        .offset(x = if (showPassword) 16.dp else 2.dp, y = 2.dp)
                        .size(14.dp).clip(CircleShape).background(Color.White),
                )
            }
        }

        // Buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(DC.gray700)
                    .clickable { onBack() }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Back", fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray200)
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (host.isNotBlank()) DC.gray300 else DC.gray300.copy(alpha = 0.3f))
                    .clickable(enabled = host.isNotBlank()) {
                        val p = port.toIntOrNull() ?: 9900
                        onConnect(PairedDevice(name.ifBlank { "Desktop" }, host, p, password))
                    }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Connect & Save", fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray950)
            }
        }
    }
}

// ─── QR Scanner ──────────────────────────────────────────────────

@Composable
private fun QrScannerScreen(
    onScanned: (String) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var hasCameraPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> hasCameraPermission = granted }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        if (hasCameraPermission) {
            var scanned by remember { mutableStateOf(false) }

            AndroidView(
                factory = { ctx ->
                    val previewView = PreviewView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                    }

                    val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                    cameraProviderFuture.addListener({
                        val cameraProvider = cameraProviderFuture.get()
                        val preview = Preview.Builder().build().also {
                            it.surfaceProvider = previewView.surfaceProvider
                        }

                        val barcodeScanner = BarcodeScanning.getClient()
                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                            .also { imageAnalysis ->
                                imageAnalysis.setAnalyzer(Executors.newSingleThreadExecutor()) { imageProxy ->
                                    @SuppressLint("UnsafeOptInUsageError")
                                    val mediaImage = imageProxy.image
                                    if (mediaImage != null && !scanned) {
                                        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
                                        barcodeScanner.process(image)
                                            .addOnSuccessListener { barcodes ->
                                                for (barcode in barcodes) {
                                                    val rawValue = barcode.rawValue
                                                    if (rawValue != null && rawValue.startsWith("http") && !scanned) {
                                                        scanned = true
                                                        onScanned(rawValue)
                                                    }
                                                }
                                            }
                                            .addOnCompleteListener {
                                                imageProxy.close()
                                            }
                                    } else {
                                        imageProxy.close()
                                    }
                                }
                            }

                        try {
                            cameraProvider.unbindAll()
                            cameraProvider.bindToLifecycle(
                                lifecycleOwner,
                                CameraSelector.DEFAULT_BACK_CAMERA,
                                preview,
                                analysis,
                            )
                        } catch (_: Exception) {}
                    }, ContextCompat.getMainExecutor(ctx))

                    previewView
                },
                modifier = Modifier.fillMaxSize(),
            )

            // Overlay
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "Close",
                        tint = Color.White,
                        modifier = Modifier
                            .size(24.dp)
                            .clickable { onBack() },
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(
                        "Scan Desktop QR Code",
                        fontSize = 16.sp,
                        fontFamily = CascadiaMono,
                        color = Color.White,
                    )
                }

                // Center target area
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .size(200.dp)
                        .border(2.dp, Color.White.copy(alpha = 0.5f), RoundedCornerShape(12.dp)),
                )

                Text(
                    "Point camera at the QR code in Desktop Settings → Remote Access",
                    fontSize = 12.sp,
                    fontFamily = CascadiaMono,
                    color = Color.White.copy(alpha = 0.7f),
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                )
            }
        } else {
            Column(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text("Camera permission required", fontSize = 14.sp, fontFamily = CascadiaMono, color = DC.gray400)
                Spacer(Modifier.height(16.dp))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(DC.gray700)
                        .clickable { onBack() }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Back", fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray200)
                }
            }
        }
    }
}

// ─── WebView ─────────────────────────────────────────────────────

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun RemoteWebView(
    device: PairedDevice,
    onDisconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var loadError by remember { mutableStateOf<String?>(null) }

    if (loadError != null) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .background(DC.gray950)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Connection Failed", fontSize = 18.sp, fontFamily = CascadiaMono, color = DC.red400)
            Spacer(Modifier.height(8.dp))
            Text(loadError ?: "", fontSize = 12.sp, fontFamily = CascadiaMono, color = DC.gray400)
            Spacer(Modifier.height(24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(DC.gray700)
                        .clickable { onDisconnect() }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Back", fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray200)
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(DC.gray300)
                        .clickable { loadError = null }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Retry", fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray950)
                }
            }
        }
        return
    }

    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

                webViewClient = object : WebViewClient() {
                    override fun onReceivedError(
                        view: WebView?,
                        request: WebResourceRequest?,
                        error: WebResourceError?,
                    ) {
                        if (request?.isForMainFrame == true) {
                            loadError = "Could not reach ${device.host}:${device.port}"
                        }
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        // If password is set, inject it for remote-shim auth
                        if (device.password.isNotBlank()) {
                            val escaped = device.password.replace("\\", "\\\\").replace("'", "\\'")
                            evaluateJavascript(
                                "(function(){if(!localStorage.getItem('destincode-remote-token')){window.__destincodePassword='$escaped';}})();",
                                null,
                            )
                        }
                    }
                }

                webChromeClient = WebChromeClient()
                loadUrl(device.url)
            }
        },
        modifier = modifier.fillMaxSize(),
    )
}

// ─── Helpers ─────────────────────────────────────────────────────

private fun parseRemoteUrl(url: String): Pair<String, Int>? {
    return try {
        val u = java.net.URL(url)
        val host = u.host ?: return null
        val port = if (u.port > 0) u.port else 9900
        host to port
    } catch (_: Exception) { null }
}

@Composable
private fun FormField(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontSize = 10.sp, fontFamily = CascadiaMono, color = DC.gray500, letterSpacing = 1.sp)
        content()
    }
}

@Composable
private fun FormInput(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    isPassword: Boolean = false,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        cursorBrush = SolidColor(DC.gray200),
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray200),
        visualTransformation = if (isPassword) PasswordVisualTransformation() else VisualTransformation.None,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(DC.gray800)
            .border(1.dp, DC.gray700, RoundedCornerShape(6.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray500)
                inner()
            }
        },
    )
}
