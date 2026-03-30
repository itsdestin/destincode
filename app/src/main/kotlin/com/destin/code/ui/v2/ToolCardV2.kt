package com.destin.code.ui.v2

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import com.destin.code.ui.v2.DesktopColors as DC
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.state.ToolCallState
import com.destin.code.ui.state.ToolCallStatus
import com.destin.code.ui.state.ToolInputFormatter
import androidx.compose.material3.MaterialTheme
import com.destin.code.ui.theme.AppIcons
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme

/**
 * Tool call card matching the desktop's ToolCard.tsx + PermissionButtons.
 *
 * Key difference from v1: when awaiting approval, the outer container is NOT
 * clickable — only the permission buttons are interactive. This matches the
 * desktop where the expand/collapse toggle is suppressed during approval.
 */
@Composable
fun ToolCardV2(
    tool: ToolCallState,
    isExpanded: Boolean = false,
    onToggle: () -> Unit = {},
    onAccept: (() -> Unit)? = null,
    onAcceptAlways: (() -> Unit)? = null,
    onReject: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val isApproval = tool.status == ToolCallStatus.AwaitingApproval

    val borderColor = when (tool.status) {
        ToolCallStatus.Running -> DC.gray700.copy(alpha = 0.5f)
        ToolCallStatus.AwaitingApproval -> DC.gray400
        ToolCallStatus.Complete -> DC.gray700.copy(alpha = 0.3f)
        ToolCallStatus.Failed -> DC.red400
    }

    val friendlyName = ToolInputFormatter.friendlyName(tool.toolName)
    val inputSummary = ToolInputFormatter.summarizeInput(tool.toolName, tool.input)

    // Responding guard — prevents double-taps (matches desktop's useState pattern)
    var responding by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .border(
                width = if (isApproval) 1.dp else 0.5.dp,
                color = borderColor,
                shape = RoundedCornerShape(8.dp),
            )
            .background(
                if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.surfaceContainer
                else DC.gray800
            )
            // Only clickable for expand/collapse when NOT awaiting approval
            .then(if (!isApproval) Modifier.clickable { onToggle() } else Modifier)
            .padding(10.dp)
    ) {
        // Header row: status icon + tool name + input summary
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            when (tool.status) {
                ToolCallStatus.Running -> {
                    BrailleSpinner(fontSize = 13.sp, color = DC.gray400)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        ToolInputFormatter.friendlyAction(tool.toolName),
                        color = DC.gray400,
                        fontSize = 13.sp,
                        fontFamily = CascadiaMono,
                    )
                }
                ToolCallStatus.AwaitingApproval -> {
                    Icon(
                        imageVector = AppIcons.ShieldAlert,
                        contentDescription = "Approval needed",
                        tint = DC.gray400,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        friendlyName,
                        color = DC.gray200,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                        fontFamily = CascadiaMono,
                    )
                }
                ToolCallStatus.Complete -> {
                    Icon(
                        imageVector = AppIcons.CheckCircle,
                        contentDescription = "Complete",
                        tint = DC.gray400,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        friendlyName,
                        color = DC.gray200,
                        fontSize = 13.sp,
                        fontFamily = CascadiaMono,
                    )
                }
                ToolCallStatus.Failed -> {
                    Icon(
                        imageVector = AppIcons.XCircle,
                        contentDescription = "Failed",
                        tint = DC.gray400,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        friendlyName,
                        color = DC.red400,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                        fontFamily = CascadiaMono,
                    )
                }
            }

            if (inputSummary.isNotBlank()) {
                Spacer(Modifier.width(8.dp))
                Text(
                    inputSummary,
                    color = DC.gray400,
                    fontSize = 12.sp,
                    fontFamily = CascadiaMono,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }

        // ─── Awaiting approval: tool input + permission buttons ─────
        if (isApproval) {
            Spacer(Modifier.height(8.dp))

            // Tool input display (code block style)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 200.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(DC.gray900)
                    .padding(8.dp)
                    .horizontalScroll(rememberScrollState())
            ) {
                Text(
                    text = formatToolInput(tool),
                    color = DC.gray300,
                    fontSize = 12.sp,
                    fontFamily = CascadiaMono,
                )
            }

            Spacer(Modifier.height(8.dp))

            // Permission buttons — matching desktop's PermissionButtons component
            val hasAlways = onAcceptAlways != null &&
                !tool.permissionSuggestions.isNullOrEmpty()

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Yes — green
                Button(
                    onClick = {
                        if (!responding) {
                            responding = true
                            onAccept?.invoke()
                        }
                    },
                    enabled = !responding,
                    modifier = Modifier
                        .then(if (hasAlways) Modifier.width(52.dp) else Modifier.weight(1f))
                        .height(42.dp),
                    shape = RoundedCornerShape(6.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFF2E7D32).copy(alpha = 0.7f),
                        contentColor = Color.White,
                        disabledContainerColor = Color(0xFF2E7D32).copy(alpha = 0.3f),
                        disabledContentColor = Color.White.copy(alpha = 0.5f),
                    ),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Text("Yes", fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = CascadiaMono)
                }

                // Always Allow — blue
                if (hasAlways) {
                    Button(
                        onClick = {
                            if (!responding) {
                                responding = true
                                onAcceptAlways?.invoke()
                            }
                        },
                        enabled = !responding,
                        modifier = Modifier.weight(1f).height(42.dp),
                        shape = RoundedCornerShape(6.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = DC.blue600.copy(alpha = 0.7f),
                            contentColor = Color.White,
                            disabledContainerColor = DC.blue600.copy(alpha = 0.3f),
                            disabledContentColor = Color.White.copy(alpha = 0.5f),
                        ),
                        contentPadding = PaddingValues(0.dp),
                    ) {
                        Text("Always Allow", fontSize = 13.sp, fontFamily = CascadiaMono)
                    }
                }

                // No — red
                Button(
                    onClick = {
                        if (!responding) {
                            responding = true
                            onReject?.invoke()
                        }
                    },
                    enabled = !responding,
                    modifier = Modifier
                        .then(if (hasAlways) Modifier.width(52.dp) else Modifier.weight(1f))
                        .height(42.dp),
                    shape = RoundedCornerShape(6.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFFCC3333).copy(alpha = 0.7f),
                        contentColor = Color.White,
                        disabledContainerColor = Color(0xFFCC3333).copy(alpha = 0.3f),
                        disabledContentColor = Color.White.copy(alpha = 0.5f),
                    ),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Text("No", fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = CascadiaMono)
                }
            }
        }

        // ─── Expanded details (complete/failed) ─────────────────────
        AnimatedVisibility(visible = isExpanded && tool.status == ToolCallStatus.Complete) {
            Column(modifier = Modifier.padding(top = 6.dp)) {
                val response = tool.response ?: ""
                if (response.isNotBlank()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 200.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(DC.gray900)
                            .padding(8.dp)
                            .horizontalScroll(rememberScrollState())
                    ) {
                        Text(
                            text = response.take(2000),
                            color = DC.gray400,
                            fontSize = 11.sp,
                            fontFamily = CascadiaMono,
                        )
                    }
                }
            }
        }

        AnimatedVisibility(visible = isExpanded && tool.status == ToolCallStatus.Failed) {
            Column(modifier = Modifier.padding(top = 6.dp)) {
                val error = tool.error ?: ""
                if (error.isNotBlank()) {
                    Text(
                        text = error,
                        color = DC.red400.copy(alpha = 0.8f),
                        fontSize = 11.sp,
                        fontFamily = CascadiaMono,
                    )
                }
            }
        }
    }
}

/** Format tool input for the approval detail view. */
private fun formatToolInput(tool: ToolCallState): String {
    return when (tool.toolName) {
        "Bash" -> {
            val cmd = tool.input.optString("command", "")
            val desc = tool.input.optString("description", "")
            if (desc.isNotBlank()) "# $desc\n$cmd" else cmd
        }
        "Edit" -> {
            val path = tool.input.optString("file_path", "")
            val old = tool.input.optString("old_string", "")
            val new = tool.input.optString("new_string", "")
            buildString {
                appendLine(path)
                if (old.isNotBlank()) {
                    appendLine("--- old")
                    appendLine(old.take(500))
                }
                if (new.isNotBlank()) {
                    appendLine("+++ new")
                    append(new.take(500))
                }
            }
        }
        "Write" -> {
            val path = tool.input.optString("file_path", "")
            val content = tool.input.optString("content", "")
            "$path\n${content.take(500)}"
        }
        else -> {
            try { tool.input.toString(2) } catch (_: Exception) { tool.input.toString() }
        }
    }
}
