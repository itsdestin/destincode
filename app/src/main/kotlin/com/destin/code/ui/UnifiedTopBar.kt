package com.destin.code.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.destin.code.runtime.ManagedSession
import com.destin.code.ui.theme.AppIcons
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.v2.DesktopColors as DC

enum class ScreenMode { Chat, Terminal, Shell }

private val MODE_CYCLE_FULL = listOf("Normal", "Auto-Accept", "Plan Mode", "Bypass")
private val MODE_CYCLE_SAFE = listOf("Normal", "Auto-Accept", "Plan Mode")

@Composable
fun UnifiedTopBar(
    screenMode: ScreenMode,
    onModeChange: (ScreenMode) -> Unit,
    currentSession: ManagedSession?,
    switcherExpanded: Boolean,
    onSwitcherToggle: () -> Unit,
    // Settings menu content
    settingsMenuContent: @Composable (onDismiss: () -> Unit) -> Unit,
    // Session dropdown content
    sessionDropdownContent: @Composable () -> Unit,
) {
    val borderColor = DestinCodeTheme.extended.surfaceBorder
    val pillShape = RoundedCornerShape(6.dp)
    val pillModifier = Modifier
        .height(34.dp)
        .clip(pillShape)
        .background(MaterialTheme.colorScheme.surface)
        .border(0.5.dp, borderColor.copy(alpha = 0.5f), pillShape)

    Column {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(40.dp)
                .background(MaterialTheme.colorScheme.background)
                .padding(horizontal = 6.dp),
        ) {
            // LEFT: Settings button + permission mode badge
            Row(
                modifier = Modifier.align(Alignment.CenterStart),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Box {
                    var menuExpanded by remember { mutableStateOf(false) }

                    // Gear rotates when menu is open
                    val gearRotation by animateFloatAsState(
                        targetValue = if (menuExpanded) 90f else 0f,
                        animationSpec = spring(
                            dampingRatio = Spring.DampingRatioMediumBouncy,
                            stiffness = Spring.StiffnessMedium,
                        ),
                        label = "gearRotation",
                    )

                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clickable { menuExpanded = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            AppIcons.SettingsGear,
                            contentDescription = "Settings",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier
                                .size(20.dp)
                                .graphicsLayer { rotationZ = gearRotation },
                        )
                    }

                    if (menuExpanded) {
                        ExpandingSettingsMenu(
                            onDismiss = { menuExpanded = false },
                            content = { settingsMenuContent { menuExpanded = false } },
                        )
                    }
                }

                // Permission mode badge (desktop: HeaderBar.tsx)
                val permMode = currentSession?.chatReducer?.state?.permissionMode ?: "Normal"
                // Permission mode badge — animated color transitions, theme-aware
                val tc = com.destin.code.ui.v2.ThemedColors
                val (modeColorTarget, modeBgTarget, modeBorderTarget) = when (permMode) {
                    "Bypass" -> Triple(tc.permBypassText, tc.permBypassBg, tc.permBypassBorder)
                    "Auto-Accept" -> Triple(tc.permAcceptText, tc.permAcceptBg, tc.permAcceptBorder)
                    "Plan Mode" -> Triple(tc.permPlanText, tc.permPlanBg, tc.permPlanBorder)
                    else -> Triple(tc.permNormalText, tc.permNormalBg, tc.permNormalBorder)
                }
                val modeColor by androidx.compose.animation.animateColorAsState(
                    targetValue = modeColorTarget, animationSpec = tween(300), label = "modeColor",
                )
                val modeBg by androidx.compose.animation.animateColorAsState(
                    targetValue = modeBgTarget, animationSpec = tween(300), label = "modeBg",
                )
                val modeBorder by androidx.compose.animation.animateColorAsState(
                    targetValue = modeBorderTarget, animationSpec = tween(300), label = "modeBorder",
                )
                val shortLabel = when (permMode) {
                    "Bypass" -> "BYPASS"
                    "Auto-Accept" -> "AUTO"
                    "Plan Mode" -> "PLAN"
                    else -> "NORMAL"
                }
                Box(
                    modifier = Modifier
                        .height(28.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(modeBg)
                        .border(0.5.dp, modeBorder, RoundedCornerShape(4.dp))
                        .clickable {
                            // Cycle permission mode by sending Shift+Tab to PTY
                            val hasBypass = currentSession?.dangerousMode == true
                            val cycle = if (hasBypass) MODE_CYCLE_FULL else MODE_CYCLE_SAFE
                            val currentIdx = cycle.indexOf(permMode).coerceAtLeast(0)
                            val nextMode = cycle[(currentIdx + 1) % cycle.size]
                            currentSession?.chatReducer?.state?.permissionMode = nextMode
                            currentSession?.chatState?.permissionMode = nextMode
                            currentSession?.writeInput("\u001b[Z") // Shift+Tab
                        }
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        shortLabel,
                        color = modeColor,
                        fontSize = 10.sp,
                        fontFamily = CascadiaMono,
                    )
                }
            }

            // CENTER: Session selector pill
            Box(modifier = Modifier.align(Alignment.Center)) {
                SessionSwitcherPill(
                    currentSession = currentSession,
                    expanded = switcherExpanded,
                    onToggle = onSwitcherToggle,
                )
                sessionDropdownContent()
            }

            // RIGHT: Chat/Terminal toggle or shell-only icon
            Box(modifier = Modifier.align(Alignment.CenterEnd)) {
                if (currentSession?.shellMode == true) {
                    // Shell session — just show terminal icon, no toggle
                    Box(
                        modifier = pillModifier
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            AppIcons.Terminal,
                            contentDescription = "Shell",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                } else {
                    // Claude session — animated chat/terminal toggle
                    val chatAlpha by animateFloatAsState(
                        targetValue = if (screenMode == ScreenMode.Chat) 1f else 0.4f,
                        animationSpec = tween(200), label = "chatAlpha",
                    )
                    val termAlpha by animateFloatAsState(
                        targetValue = if (screenMode != ScreenMode.Chat) 1f else 0.4f,
                        animationSpec = tween(200), label = "termAlpha",
                    )
                    val chatBgAlpha by animateFloatAsState(
                        targetValue = if (screenMode == ScreenMode.Chat) 0.1f else 0f,
                        animationSpec = tween(200), label = "chatBg",
                    )
                    val termBgAlpha by animateFloatAsState(
                        targetValue = if (screenMode != ScreenMode.Chat) 0.1f else 0f,
                        animationSpec = tween(200), label = "termBg",
                    )

                    Row(
                        modifier = pillModifier
                            .clickable {
                                val next = when (screenMode) {
                                    ScreenMode.Chat -> ScreenMode.Terminal
                                    else -> ScreenMode.Chat
                                }
                                onModeChange(next)
                            }
                            .padding(horizontal = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier
                                .height(30.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = chatBgAlpha))
                                .padding(horizontal = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                AppIcons.Chat,
                                contentDescription = "Chat",
                                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = chatAlpha),
                                modifier = Modifier.size(18.dp),
                            )
                        }
                        Box(
                            modifier = Modifier
                                .height(30.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = termBgAlpha))
                                .padding(horizontal = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                AppIcons.Terminal,
                                contentDescription = "Terminal",
                                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = termAlpha),
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                }
            }
        }

        HorizontalDivider(color = borderColor, thickness = 0.5.dp)
    }
}

/**
 * Settings menu — animated slide-down + fade from gear icon position.
 * Styled to match the desktop's dark panel aesthetic.
 */
@Composable
fun ExpandingSettingsMenu(
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    // Animate in/out with a visible flag
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { visible = true }

    Popup(
        alignment = Alignment.TopStart,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        // Scrim — fades in
        Box(
            modifier = Modifier
                .fillMaxSize()
                .then(
                    if (visible) Modifier.background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.3f))
                    else Modifier
                )
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { onDismiss() },
        ) {
            AnimatedVisibility(
                visible = visible,
                enter = slideInVertically(
                    initialOffsetY = { -it / 3 },
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioLowBouncy,
                        stiffness = Spring.StiffnessMediumLow,
                    ),
                ) + fadeIn(animationSpec = tween(200)),
            ) {
                Column(
                    modifier = Modifier
                        .padding(start = 6.dp, top = 48.dp)
                        .widthIn(min = 200.dp, max = 260.dp)
                        .shadow(12.dp, RoundedCornerShape(8.dp))
                        .clip(RoundedCornerShape(8.dp))
                        .background(DC.gray900)
                        .border(1.dp, DC.gray700, RoundedCornerShape(8.dp))
                        .clickable(
                            indication = null,
                            interactionSource = remember { MutableInteractionSource() },
                        ) { /* consume */ }
                        .padding(vertical = 4.dp),
                ) {
                    content()
                }
            }
        }
    }
}
