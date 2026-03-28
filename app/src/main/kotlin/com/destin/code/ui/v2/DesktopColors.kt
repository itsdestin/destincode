package com.destin.code.ui.v2

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.theme.LocalIsDarkTheme

/**
 * Exact color values from the desktop app's globals.css @theme block.
 * Pure grays with no blue tint — matches the DestinCode neutral palette.
 * Used as the dark mode palette; light mode inverts key values.
 */
object DesktopColors {
    // ─── Gray palette (from desktop CSS @theme) ──────────────────
    val gray50  = Color(0xFFF5F5F5)
    val gray100 = Color(0xFFEBEBEB)
    val gray200 = Color(0xFFE0E0E0)
    val gray300 = Color(0xFFB0B0B0)
    val gray400 = Color(0xFF999999)
    val gray500 = Color(0xFF666666)
    val gray600 = Color(0xFF555555)
    val gray700 = Color(0xFF333333)
    val gray800 = Color(0xFF222222)
    val gray850 = Color(0xFF1C1C1C)
    val gray900 = Color(0xFF191919)
    val gray950 = Color(0xFF111111)

    // ─── Status colors ───────────────────────────────────────────
    val green400 = Color(0xFF4CAF50)
    val red400   = Color(0xFFDD4444)
    val amber700 = Color(0xFFFF9800)

    // ─── Accent colors ───────────────────────────────────────────
    val blue600 = Color(0xFF2563EB)

    // ─── Permission mode colors (from desktop HeaderBar.tsx) ─────
    val permNormalColor  = Color(0xFF9CA3AF)
    val permAcceptColor  = Color(0xFFA78BFA) // purple
    val permPlanColor    = Color(0xFF2DD4BF) // teal
    val permBypassColor  = Color(0xFFFA8072) // salmon

    // ─── User message ────────────────────────────────────────────
    val userBubbleBg   = gray300
    val userBubbleText = gray950

    // ─── Assistant message ───────────────────────────────────────
    val assistantBubbleBg = gray800
    val assistantText     = gray200
}

/**
 * Theme-aware color accessor. Returns dark or light variants
 * based on the current theme mode.
 */
object ThemedColors {
    /** Input bar background */
    val inputBarBg: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.surfaceContainer
        } else if (LocalIsDarkTheme.current) Color(0xFF222222) else Color(0xFFD0D0D0)

    /** Input bar text */
    val inputBarText: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.onSurface
        } else if (LocalIsDarkTheme.current) Color(0xFFE0E0E0) else Color(0xFF1A1A1A)

    /** Input bar placeholder */
    val inputBarPlaceholder: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.onSurfaceVariant
        } else if (LocalIsDarkTheme.current) Color(0xFF666666) else Color(0xFF888888)

    /** Input bar cursor */
    val inputBarCursor: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.primary
        } else if (LocalIsDarkTheme.current) Color(0xFFE0E0E0) else Color(0xFF1A1A1A)

    /** Input bar icon color */
    val inputBarIcon: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.onSurfaceVariant
        } else if (LocalIsDarkTheme.current) Color(0xFF999999) else Color(0xFF666666)

    /** Send button bg */
    val sendButtonBg: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.primary
        } else if (LocalIsDarkTheme.current) Color(0xFFB0B0B0) else Color(0xFF4A4A4A)

    /** Send button icon */
    val sendButtonIcon: Color
        @Composable @ReadOnlyComposable
        get() = if (DestinCodeTheme.extended.isMaterial) {
            MaterialTheme.colorScheme.onPrimary
        } else if (LocalIsDarkTheme.current) Color(0xFF111111) else Color(0xFFE0E0E0)

    /** Permission badge — normal mode */
    val permNormalBg: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permNormalColor.copy(alpha = 0.1f)
        else
            DesktopColors.permNormalColor.copy(alpha = 0.15f)

    val permNormalBorder: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permNormalColor.copy(alpha = 0.15f)
        else
            DesktopColors.permNormalColor.copy(alpha = 0.3f)

    val permNormalText: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current) DesktopColors.permNormalColor else Color(0xFF666666)

    /** Permission badge — bypass mode */
    val permBypassText: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current) DesktopColors.permBypassColor else Color(0xFFCC3333)

    val permBypassBg: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permBypassColor.copy(alpha = 0.15f)
        else
            Color(0xFFCC3333).copy(alpha = 0.12f)

    val permBypassBorder: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permBypassColor.copy(alpha = 0.25f)
        else
            Color(0xFFCC3333).copy(alpha = 0.25f)

    /** Permission badge — auto-accept mode */
    val permAcceptText: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current) DesktopColors.permAcceptColor else Color(0xFF7C3AED)

    val permAcceptBg: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permAcceptColor.copy(alpha = 0.15f)
        else
            Color(0xFF7C3AED).copy(alpha = 0.1f)

    val permAcceptBorder: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permAcceptColor.copy(alpha = 0.25f)
        else
            Color(0xFF7C3AED).copy(alpha = 0.2f)

    /** Permission badge — plan mode */
    val permPlanText: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current) DesktopColors.permPlanColor else Color(0xFF0D9488)

    val permPlanBg: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permPlanColor.copy(alpha = 0.15f)
        else
            Color(0xFF0D9488).copy(alpha = 0.1f)

    val permPlanBorder: Color
        @Composable @ReadOnlyComposable
        get() = if (LocalIsDarkTheme.current)
            DesktopColors.permPlanColor.copy(alpha = 0.25f)
        else
            Color(0xFF0D9488).copy(alpha = 0.2f)
}
