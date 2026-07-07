package com.youcoded.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.youcoded.app.runtime.SessionService

// Tier 2 of android-terminal-data-parity: removed the native Termux
// TerminalView Compose block, the applyTerminalColors helper, the
// BaseTerminalViewClient + TerminalView + TerminalSession imports, and the
// layoutInsets / screenMode plumbing they fed. xterm.js inside the React
// WebView is the sole terminal renderer now (see TerminalView.tsx). The
// React side toggles chat↔terminal entirely via viewModes; Compose only
// hosts the WebView. screenMode + viewModeRequest collector were removed
// because their only consumer was the deleted render block. shellMode auto-
// switch is also gone for the same reason — if shell auto-switch needs to
// drive the React UI later, it should fire a viewMode message instead.

@Composable
fun ChatScreen(service: SessionService) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF111111))
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        // WebView is the only surface — xterm.js (in React) renders the
        // terminal, ChatView renders chat. Pass bridge auth token so the
        // WebView can authenticate with LocalBridgeServer.
        WebViewHost(
            modifier = Modifier.fillMaxSize(),
            bridgeAuthToken = service.bridgeServer.authToken
        )
    }
}
