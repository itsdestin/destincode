package com.destin.code.ui

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.destin.code.runtime.ManagedSession
import com.destin.code.runtime.SessionBrowser
import com.destin.code.runtime.SessionStatus
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.v2.DesktopColors as DC
import java.io.File

/**
 * Session trigger pill — matches desktop's SessionSelector trigger.
 */
@Composable
fun SessionSwitcherPill(
    currentSession: ManagedSession?,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val name by currentSession?.name?.collectAsState() ?: remember { mutableStateOf("No Session") }
    val status by currentSession?.status?.collectAsState() ?: remember { mutableStateOf(SessionStatus.Dead) }

    Row(
        modifier = modifier
            .widthIn(max = 180.dp)
            .height(34.dp)
            .clip(RoundedCornerShape(6.dp))
            .clickable { onToggle() }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StatusDot(status)
        Text(
            name,
            fontSize = 13.sp,
            color = DC.gray200,
            fontFamily = CascadiaMono,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Text(
            if (expanded) "▴" else "▾",
            fontSize = 10.sp,
            color = DC.gray400,
        )
    }
}

/**
 * Session dropdown — matches desktop's SessionSelector dropdown.
 * "New Session" expands an inline form with folder picker + skip permissions toggle.
 */
@Composable
fun SessionDropdown(
    expanded: Boolean,
    onDismiss: () -> Unit,
    sessions: Map<String, ManagedSession>,
    currentSessionId: String?,
    onSelect: (String) -> Unit,
    onDestroy: (String) -> Unit,
    onRelaunch: (String) -> Unit,
    onNewSession: () -> Unit,
    knownDirs: List<Pair<String, File>>? = null,
    onCreateSession: ((cwd: File, dangerous: Boolean, shell: Boolean) -> Unit)? = null,
    pastSessions: List<SessionBrowser.PastSession> = emptyList(),
    onResumeSession: ((SessionBrowser.PastSession) -> Unit)? = null,
) {
    if (!expanded) return

    var showNewForm by remember { mutableStateOf(false) }
    var selectedDir by remember { mutableStateOf(knownDirs?.firstOrNull()?.second) }
    var dangerous by remember { mutableStateOf(false) }
    var shellMode by remember { mutableStateOf(false) }

    Popup(
        alignment = Alignment.TopCenter,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { onDismiss() },
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier
                    .padding(top = 48.dp)
                    .widthIn(max = 288.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(DC.gray900)
                    .border(1.dp, DC.gray700, RoundedCornerShape(8.dp))
                    .clickable(
                        indication = null,
                        interactionSource = remember { MutableInteractionSource() },
                    ) { /* consume */ }
                    .padding(vertical = 4.dp),
            ) {
                // Session list
                sessions.entries.sortedBy { it.value.createdAt }.forEach { (id, session) ->
                    val name by session.name.collectAsState()
                    val status by session.status.collectAsState()
                    val isCurrent = id == currentSessionId

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(if (isCurrent) Modifier.background(DC.gray800) else Modifier)
                            .clickable { onSelect(id); onDismiss() }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatusDot(status)
                        Column(modifier = Modifier.weight(1f)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text(
                                    name,
                                    fontSize = 13.sp,
                                    fontFamily = CascadiaMono,
                                    color = DC.gray200,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                if (session.dangerousMode) {
                                    Text("DANGER", fontSize = 9.sp, fontFamily = CascadiaMono, color = DC.red400)
                                }
                            }
                            Text(
                                session.cwd.name,
                                fontSize = 11.sp,
                                fontFamily = CascadiaMono,
                                color = DC.gray500,
                            )
                        }
                        if (status == SessionStatus.Dead) {
                            Text(
                                "Relaunch",
                                fontSize = 11.sp,
                                fontFamily = CascadiaMono,
                                color = DC.gray400,
                                modifier = Modifier.clickable { onRelaunch(id); onDismiss() },
                            )
                        } else {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = "Close session",
                                modifier = Modifier
                                    .size(16.dp)
                                    .clickable { onDestroy(id); onDismiss() },
                                tint = DC.gray500,
                            )
                        }
                    }
                }

                HorizontalDivider(color = DC.gray700, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))

                // ─── Resume past sessions ───
                if (pastSessions.isNotEmpty() && onResumeSession != null) {
                    var showResume by remember { mutableStateOf(false) }

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { showResume = !showResume }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "RESUME",
                            fontSize = 10.sp,
                            fontFamily = CascadiaMono,
                            color = DC.gray500,
                            letterSpacing = 1.sp,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            if (showResume) "▴" else "▾",
                            fontSize = 10.sp,
                            color = DC.gray500,
                        )
                    }

                    if (showResume) {
                        for (past in pastSessions.take(10)) {
                            val timeAgo = formatTimeAgo(past.lastModified)
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        onResumeSession(past)
                                        onDismiss()
                                    }
                                    .padding(horizontal = 16.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        past.name,
                                        fontSize = 12.sp,
                                        fontFamily = CascadiaMono,
                                        color = DC.gray300,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        timeAgo,
                                        fontSize = 10.sp,
                                        fontFamily = CascadiaMono,
                                        color = DC.gray500,
                                    )
                                }
                            }
                        }
                    }

                    HorizontalDivider(color = DC.gray700, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                }

                if (!showNewForm) {
                    // "New Session" button
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                if (knownDirs != null && onCreateSession != null) {
                                    showNewForm = true
                                } else {
                                    onNewSession(); onDismiss()
                                }
                            }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.Add, contentDescription = "New session", modifier = Modifier.size(16.dp), tint = DC.gray400)
                        Text("New Session", fontSize = 13.sp, fontFamily = CascadiaMono, color = DC.gray200)
                    }
                } else {
                    // ─── Inline new session form (matches desktop) ───
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        // Folder picker
                        Text(
                            "PROJECT FOLDER",
                            fontSize = 10.sp,
                            fontFamily = CascadiaMono,
                            color = DC.gray500,
                            letterSpacing = 1.sp,
                        )

                        // Directory list
                        knownDirs?.forEach { (label, dir) ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(4.dp))
                                    .then(if (selectedDir == dir) Modifier.background(DC.gray800) else Modifier)
                                    .clickable { selectedDir = dir }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    if (selectedDir == dir) "●" else "○",
                                    fontSize = 8.sp,
                                    color = if (selectedDir == dir) DC.gray300 else DC.gray500,
                                    modifier = Modifier.padding(end = 8.dp),
                                )
                                Text(
                                    label,
                                    fontSize = 12.sp,
                                    fontFamily = CascadiaMono,
                                    color = DC.gray300,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }

                        // Skip Permissions toggle — desktop: w-8 h-4.5 custom switch
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "SKIP PERMISSIONS",
                                fontSize = 10.sp,
                                fontFamily = CascadiaMono,
                                color = DC.gray500,
                                letterSpacing = 1.sp,
                            )
                            // Custom toggle matching desktop: w-8 h-4.5 rounded-full
                            Box(
                                modifier = Modifier
                                    .width(32.dp)
                                    .height(18.dp)
                                    .clip(RoundedCornerShape(9.dp))
                                    .background(if (dangerous) DC.red400 else DC.gray700)
                                    .clickable { dangerous = !dangerous },
                            ) {
                                Box(
                                    modifier = Modifier
                                        .offset(x = if (dangerous) 16.dp else 2.dp, y = 2.dp)
                                        .size(14.dp)
                                        .clip(CircleShape)
                                        .background(Color.White),
                                )
                            }
                        }

                        // Warning text when dangerous
                        if (dangerous) {
                            Text(
                                "Claude will execute tools without asking for approval.",
                                fontSize = 10.sp,
                                fontFamily = CascadiaMono,
                                color = DC.red400,
                            )
                        }

                        // Shell Mode toggle
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "SHELL MODE",
                                fontSize = 10.sp,
                                fontFamily = CascadiaMono,
                                color = DC.gray500,
                                letterSpacing = 1.sp,
                            )
                            Box(
                                modifier = Modifier
                                    .width(32.dp)
                                    .height(18.dp)
                                    .clip(RoundedCornerShape(9.dp))
                                    .background(if (shellMode) DC.gray300 else DC.gray700)
                                    .clickable { shellMode = !shellMode },
                            ) {
                                Box(
                                    modifier = Modifier
                                        .offset(x = if (shellMode) 16.dp else 2.dp, y = 2.dp)
                                        .size(14.dp)
                                        .clip(CircleShape)
                                        .background(Color.White),
                                )
                            }
                        }

                        // Create button — red when dangerous, gray otherwise
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(6.dp))
                                .background(if (dangerous) DC.red400 else DC.gray300)
                                .clickable {
                                    selectedDir?.let { dir ->
                                        onCreateSession?.invoke(dir, dangerous, shellMode)
                                        onDismiss()
                                    }
                                }
                                .padding(vertical = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                when {
                                    shellMode -> "Create Shell"
                                    dangerous -> "Create (Dangerous)"
                                    else -> "Create Session"
                                },
                                fontSize = 13.sp,
                                fontFamily = CascadiaMono,
                                fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
                                color = if (dangerous) Color.White else DC.gray950,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Status dot — matches desktop's StatusDot.tsx exactly.
 * - green/red: pulsing glow animation (active/awaiting)
 * - gray: solid (idle/dead)
 *
 * Desktop: container w-2 h-2, core dot w-1.5 h-1.5,
 * green/red get animate-ping on outer glow layer.
 */
@Composable
fun StatusDot(status: SessionStatus, modifier: Modifier = Modifier) {
    val dotColor = when (status) {
        SessionStatus.Active -> DC.green400.copy(alpha = 0.8f)
        SessionStatus.AwaitingApproval -> DC.red400.copy(alpha = 0.8f)
        SessionStatus.Unseen -> Color(0xFF60A5FA).copy(alpha = 0.7f) // blue-400/70
        SessionStatus.Idle -> DC.gray500.copy(alpha = 0.5f)
        SessionStatus.Dead -> DC.gray500.copy(alpha = 0.5f)
    }
    val glowColor = when (status) {
        SessionStatus.Active -> DC.green400.copy(alpha = 0.3f)
        SessionStatus.AwaitingApproval -> DC.red400.copy(alpha = 0.3f)
        else -> null
    }
    val pulsing = status == SessionStatus.Active || status == SessionStatus.AwaitingApproval

    if (pulsing && glowColor != null) {
        PulsingStatusDot(dotColor = dotColor, glowColor = glowColor, modifier = modifier)
    } else {
        // Static dot
        Box(
            modifier = modifier.size(8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(dotColor),
            )
        }
    }
}

@Composable
private fun PulsingStatusDot(
    dotColor: Color,
    glowColor: Color,
    modifier: Modifier = Modifier,
) {
    val transition = rememberInfiniteTransition(label = "ping")
    val scale by transition.animateFloat(
        initialValue = 1f,
        targetValue = 2f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000, easing = LinearOutSlowInEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pingScale",
    )
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000, easing = LinearOutSlowInEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pingAlpha",
    )

    Box(
        modifier = modifier.size(8.dp),
        contentAlignment = Alignment.Center,
    ) {
        // Glow ping layer
        Box(
            modifier = Modifier
                .size(6.dp)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    this.alpha = alpha
                }
                .clip(CircleShape)
                .background(glowColor),
        )
        // Core dot
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(dotColor),
        )
    }
}

/** Format epoch millis as a human-friendly relative time string. */
private fun formatTimeAgo(timestamp: Long): String {
    val now = System.currentTimeMillis()
    val diff = now - timestamp
    val minutes = diff / 60_000
    val hours = minutes / 60
    val days = hours / 24
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        hours < 24 -> "${hours}h ago"
        days < 7 -> "${days}d ago"
        days < 30 -> "${days / 7}w ago"
        else -> "${days / 30}mo ago"
    }
}
