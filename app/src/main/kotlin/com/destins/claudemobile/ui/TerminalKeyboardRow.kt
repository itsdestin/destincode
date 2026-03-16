package com.destins.claudemobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme

data class TerminalKey(val label: String, val sequence: String)

@Composable
fun TerminalKeyboardRow(
    onKeyPress: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var ctrlActive by remember { mutableStateOf(false) }

    val borderColor = ClaudeMobileTheme.extended.surfaceBorder

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Ctrl toggle — separate styling
        KeyPill(
            label = "Ctrl",
            isActive = ctrlActive,
            borderColor = borderColor,
            modifier = Modifier.weight(1f),
        ) { ctrlActive = !ctrlActive }

        // Esc
        KeyPill("Esc", borderColor = borderColor, modifier = Modifier.weight(1f)) {
            sendKey("\u001b", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Tab
        KeyPill("Tab", borderColor = borderColor, modifier = Modifier.weight(1f)) {
            sendKey("\t", ctrlActive, onKeyPress) { ctrlActive = false }
        }

        // Arrow cluster — grouped tighter
        Row(
            modifier = Modifier.weight(2.2f),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            KeyPill("←", borderColor = borderColor, modifier = Modifier.weight(1f)) {
                sendKey("\u001b[D", ctrlActive, onKeyPress) { ctrlActive = false }
            }
            KeyPill("↓", borderColor = borderColor, modifier = Modifier.weight(1f)) {
                sendKey("\u001b[B", ctrlActive, onKeyPress) { ctrlActive = false }
            }
            KeyPill("↑", borderColor = borderColor, modifier = Modifier.weight(1f)) {
                sendKey("\u001b[A", ctrlActive, onKeyPress) { ctrlActive = false }
            }
            KeyPill("→", borderColor = borderColor, modifier = Modifier.weight(1f)) {
                sendKey("\u001b[C", ctrlActive, onKeyPress) { ctrlActive = false }
            }
        }

        // Enter
        KeyPill(
            "⏎",
            borderColor = borderColor,
            isPrimary = true,
            modifier = Modifier.weight(1f),
        ) {
            sendKey("\r", ctrlActive, onKeyPress) { ctrlActive = false }
        }
    }
}

private fun sendKey(
    sequence: String,
    ctrlActive: Boolean,
    onKeyPress: (String) -> Unit,
    clearCtrl: () -> Unit,
) {
    if (ctrlActive && sequence.length == 1) {
        val ch = sequence[0]
        val code = when {
            ch in 'a'..'z' -> ch.code - 'a'.code + 1
            ch in 'A'..'Z' -> ch.code - 'A'.code + 1
            else -> null
        }
        if (code != null) {
            onKeyPress(code.toChar().toString())
            clearCtrl()
            return
        }
    }
    onKeyPress(sequence)
    if (ctrlActive) clearCtrl()
}

@Composable
private fun KeyPill(
    label: String,
    isActive: Boolean = false,
    isPrimary: Boolean = false,
    borderColor: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Gray,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val bg = when {
        isActive -> MaterialTheme.colorScheme.primary
        isPrimary -> MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        else -> MaterialTheme.colorScheme.surface
    }
    val textColor = when {
        isActive -> MaterialTheme.colorScheme.onPrimary
        isPrimary -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurface
    }

    Box(
        modifier = modifier
            .height(34.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(bg)
            .border(0.5.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            fontWeight = if (isActive || isPrimary) FontWeight.SemiBold else FontWeight.Normal,
            color = textColor,
        )
    }
}
