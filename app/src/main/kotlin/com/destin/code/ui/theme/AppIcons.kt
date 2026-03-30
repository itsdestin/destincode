package com.destin.code.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

object AppIcons {
    /**
     * Terminal icon — Windows Terminal style.
     * A rounded rectangle with ">_" prompt inside, with the ">"
     * rendered at a slightly playful angle.
     */
    val Terminal: ImageVector by lazy {
        ImageVector.Builder(
            name = "Terminal",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Outer rounded rectangle
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(4f, 4f)
                lineTo(20f, 4f)
                arcTo(2f, 2f, 0f, false, true, 22f, 6f)
                lineTo(22f, 18f)
                arcTo(2f, 2f, 0f, false, true, 20f, 20f)
                lineTo(4f, 20f)
                arcTo(2f, 2f, 0f, false, true, 2f, 18f)
                lineTo(2f, 6f)
                arcTo(2f, 2f, 0f, false, true, 4f, 4f)
                close()
            }
            // ">" chevron prompt
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(6f, 9f)
                lineTo(10f, 12f)
                lineTo(6f, 15f)
            }
            // "_" cursor underscore
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 15f)
                lineTo(17f, 15f)
            }
        }.build()
    }

    /**
     * Chat icon — speech bubble with three dots.
     * Simple rounded bubble with tail and dots inside.
     */
    val Chat: ImageVector by lazy {
        ImageVector.Builder(
            name = "Chat",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Speech bubble outline with tail
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Rounded rectangle bubble
                moveTo(4f, 5f)
                lineTo(20f, 5f)
                arcTo(2f, 2f, 0f, false, true, 22f, 7f)
                lineTo(22f, 15f)
                arcTo(2f, 2f, 0f, false, true, 20f, 17f)
                lineTo(10f, 17f)
                lineTo(6f, 20f)
                lineTo(7f, 17f)
                lineTo(4f, 17f)
                arcTo(2f, 2f, 0f, false, true, 2f, 15f)
                lineTo(2f, 7f)
                arcTo(2f, 2f, 0f, false, true, 4f, 5f)
                close()
            }
            // Three dots — drawn as short thick lines (more reliable than arcs)
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(8.5f, 11f)
                lineTo(8.5f, 11.01f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 11f)
                lineTo(12f, 11.01f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(15.5f, 11f)
                lineTo(15.5f, 11.01f)
            }
        }.build()
    }

    /**
     * Menu icon — three horizontal dots (kebab menu rotated to horizontal).
     */
    val Menu: ImageVector by lazy {
        ImageVector.Builder(
            name = "Menu",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Left dot
            path(
                fill = SolidColor(Color.Black),
            ) {
                moveTo(6f, 12f)
                arcTo(1.5f, 1.5f, 0f, true, true, 6f, 11.99f)
                close()
            }
            // Center dot
            path(
                fill = SolidColor(Color.Black),
            ) {
                moveTo(12f, 12f)
                arcTo(1.5f, 1.5f, 0f, true, true, 12f, 11.99f)
                close()
            }
            // Right dot
            path(
                fill = SolidColor(Color.Black),
            ) {
                moveTo(18f, 12f)
                arcTo(1.5f, 1.5f, 0f, true, true, 18f, 11.99f)
                close()
            }
        }.build()
    }

    /**
     * Paperclip attachment icon — angled paperclip shape.
     * Stroke-only, matches the terminal/chat icon style.
     */
    val Attach: ImageVector by lazy {
        ImageVector.Builder(
            name = "Attach",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Paperclip shape: bottom-up, inner loop
                moveTo(15.5f, 6f)
                lineTo(15.5f, 15.5f)
                arcTo(3.5f, 3.5f, 0f, false, true, 8.5f, 15.5f)
                lineTo(8.5f, 7f)
                arcTo(2f, 2f, 0f, false, true, 12.5f, 7f)
                lineTo(12.5f, 15.5f)
                arcTo(0.5f, 0.5f, 0f, false, true, 11.5f, 15.5f)
                lineTo(11.5f, 8.5f)
            }
        }.build()
    }

    /**
     * Settings gear icon — matches desktop's inline SVG (Heroicons outline).
     * Stroke-only, no background — just the gear shape with center circle.
     */
    val SettingsGear: ImageVector by lazy {
        ImageVector.Builder(
            name = "SettingsGear",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Gear body (outer ring with teeth)
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Heroicons gear path
                moveTo(10.325f, 4.317f)
                curveTo(10.751f, 2.561f, 13.249f, 2.561f, 13.675f, 4.317f)
                arcTo(1.724f, 1.724f, 0f, false, false, 16.248f, 5.383f)
                curveTo(17.791f, 4.443f, 19.558f, 6.209f, 18.618f, 7.753f)
                arcTo(1.724f, 1.724f, 0f, false, false, 19.684f, 10.326f)
                curveTo(21.44f, 10.752f, 21.44f, 13.25f, 19.684f, 13.676f)
                arcTo(1.724f, 1.724f, 0f, false, false, 18.618f, 16.249f)
                curveTo(19.558f, 17.792f, 17.792f, 19.559f, 16.248f, 18.619f)
                arcTo(1.724f, 1.724f, 0f, false, false, 13.675f, 19.685f)
                curveTo(13.249f, 21.441f, 10.751f, 21.441f, 10.325f, 19.685f)
                arcTo(1.724f, 1.724f, 0f, false, false, 7.752f, 18.619f)
                curveTo(6.209f, 19.559f, 4.442f, 17.793f, 5.382f, 16.249f)
                arcTo(1.724f, 1.724f, 0f, false, false, 4.316f, 13.676f)
                curveTo(2.56f, 13.25f, 2.56f, 10.752f, 4.316f, 10.326f)
                arcTo(1.724f, 1.724f, 0f, false, false, 5.382f, 7.753f)
                curveTo(4.442f, 6.21f, 6.208f, 4.443f, 7.752f, 5.383f)
                arcTo(1.724f, 1.724f, 0f, false, false, 10.325f, 4.317f)
                close()
            }
            // Center circle
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(15f, 12f)
                arcTo(3f, 3f, 0f, true, true, 9f, 12f)
                arcTo(3f, 3f, 0f, true, true, 15f, 12f)
                close()
            }
        }.build()
    }

    /**
     * Compass icon — circle with needle and center point.
     * Matches desktop's CompassIcon.
     */
    val Compass: ImageVector by lazy {
        ImageVector.Builder(
            name = "Compass",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Outer circle
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.8f,
            ) {
                moveTo(22f, 12f)
                arcTo(10f, 10f, 0f, true, true, 2f, 12f)
                arcTo(10f, 10f, 0f, true, true, 22f, 12f)
                close()
            }
            // Diamond needle (filled, semi-transparent)
            path(
                fill = SolidColor(Color.Black),
                strokeLineWidth = 1.5f,
                stroke = SolidColor(Color.Black),
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(16.24f, 7.76f)
                lineTo(14.12f, 14.12f)
                lineTo(7.76f, 16.24f)
                lineTo(9.88f, 9.88f)
                close()
            }
            // Center dot
            path(fill = SolidColor(Color.Black)) {
                moveTo(13.2f, 12f)
                arcTo(1.2f, 1.2f, 0f, true, true, 10.8f, 12f)
                arcTo(1.2f, 1.2f, 0f, true, true, 13.2f, 12f)
                close()
            }
        }.build()
    }

    /**
     * Arrow right icon — matches desktop's send button SVG.
     * Horizontal line with right arrowhead.
     */
    val ArrowRight: ImageVector by lazy {
        ImageVector.Builder(
            name = "ArrowRight",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Horizontal line
                moveTo(5f, 12f)
                lineTo(19f, 12f)
                // Arrowhead
                moveTo(12f, 5f)
                lineTo(19f, 12f)
                lineTo(12f, 19f)
            }
        }.build()
    }

    /**
     * Welcome app icon — mascot with round eyes (sparkle variant).
     * Matches desktop's WelcomeAppIcon: same body but with round eyes
     * and a waving arm instead of >< eyes.
     */
    val WelcomeAppIcon: ImageVector by lazy {
        ImageVector.Builder(
            name = "WelcomeAppIcon",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Body with round eye cutouts (EvenOdd)
            path(
                fill = SolidColor(Color.Black),
                stroke = null,
                pathFillType = PathFillType.EvenOdd,
            ) {
                // Rounded rect body
                moveTo(9f, 4f)
                lineTo(15f, 4f)
                arcTo(4f, 4f, 0f, false, true, 19f, 8f)
                lineTo(19f, 12f)
                arcTo(4f, 4f, 0f, false, true, 15f, 16f)
                lineTo(9f, 16f)
                arcTo(4f, 4f, 0f, false, true, 5f, 12f)
                lineTo(5f, 8f)
                arcTo(4f, 4f, 0f, false, true, 9f, 4f)
                close()

                // Left eye (round cutout)
                moveTo(11f, 10f)
                arcTo(1.6f, 2f, 0f, true, true, 7.8f, 10f)
                arcTo(1.6f, 2f, 0f, true, true, 11f, 10f)
                close()

                // Right eye (round cutout)
                moveTo(16.2f, 10f)
                arcTo(1.6f, 2f, 0f, true, true, 13f, 10f)
                arcTo(1.6f, 2f, 0f, true, true, 16.2f, 10f)
                close()
            }
            // Left nub arm
            path(fill = SolidColor(Color.Black)) {
                moveTo(1.8f, 9f)
                lineTo(3.2f, 9f)
                arcTo(0.8f, 0.8f, 0f, false, true, 4f, 9.8f)
                lineTo(4f, 12.2f)
                arcTo(0.8f, 0.8f, 0f, false, true, 3.2f, 13f)
                lineTo(1.8f, 13f)
                arcTo(0.8f, 0.8f, 0f, false, true, 1f, 12.2f)
                lineTo(1f, 9.8f)
                arcTo(0.8f, 0.8f, 0f, false, true, 1.8f, 9f)
                close()
            }
            // Right arm — waving (raised and rotated)
            path(fill = SolidColor(Color.Black)) {
                moveTo(21f, 3.5f)
                lineTo(22.4f, 3.5f)
                arcTo(0.8f, 0.8f, 0f, false, true, 23.2f, 4.3f)
                lineTo(23.2f, 6.7f)
                arcTo(0.8f, 0.8f, 0f, false, true, 22.4f, 7.5f)
                lineTo(21f, 7.5f)
                arcTo(0.8f, 0.8f, 0f, false, true, 20.2f, 6.7f)
                lineTo(20.2f, 4.3f)
                arcTo(0.8f, 0.8f, 0f, false, true, 21f, 3.5f)
                close()
            }
            // Left leg
            path(fill = SolidColor(Color.Black)) {
                moveTo(8.75f, 16f)
                lineTo(10.5f, 16f)
                lineTo(10.5f, 18.25f)
                arcTo(1.75f, 1.75f, 0f, false, true, 8.75f, 20f)
                arcTo(1.75f, 1.75f, 0f, false, true, 7f, 18.25f)
                lineTo(7f, 16f)
                close()
            }
            // Right leg
            path(fill = SolidColor(Color.Black)) {
                moveTo(15.25f, 16f)
                lineTo(17f, 16f)
                lineTo(17f, 18.25f)
                arcTo(1.75f, 1.75f, 0f, false, true, 15.25f, 20f)
                arcTo(1.75f, 1.75f, 0f, false, true, 13.5f, 18.25f)
                lineTo(13.5f, 16f)
                close()
            }
        }.build()
    }

    // ─── Tool status icons (Lucide-style, stroke-only) ────────────

    /** Checkmark circle — completed tool indicator */
    val CheckCircle: ImageVector by lazy {
        ImageVector.Builder(
            name = "CheckCircle",
            defaultWidth = 16.dp,
            defaultHeight = 16.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Circle
                moveTo(22f, 12f)
                arcTo(10f, 10f, 0f, true, true, 2f, 12f)
                arcTo(10f, 10f, 0f, true, true, 22f, 12f)
                close()
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Checkmark
                moveTo(9f, 12f)
                lineTo(11f, 14f)
                lineTo(15f, 10f)
            }
        }.build()
    }

    /** X circle — failed tool indicator */
    val XCircle: ImageVector by lazy {
        ImageVector.Builder(
            name = "XCircle",
            defaultWidth = 16.dp,
            defaultHeight = 16.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Circle
                moveTo(22f, 12f)
                arcTo(10f, 10f, 0f, true, true, 2f, 12f)
                arcTo(10f, 10f, 0f, true, true, 22f, 12f)
                close()
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // X
                moveTo(15f, 9f)
                lineTo(9f, 15f)
                moveTo(9f, 9f)
                lineTo(15f, 15f)
            }
        }.build()
    }

    /** Shield alert — approval/permission indicator */
    val ShieldAlert: ImageVector by lazy {
        ImageVector.Builder(
            name = "ShieldAlert",
            defaultWidth = 16.dp,
            defaultHeight = 16.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Shield shape
                moveTo(12f, 22f)
                curveTo(12f, 22f, 20f, 18f, 20f, 12f)
                lineTo(20f, 5f)
                lineTo(12f, 2f)
                lineTo(4f, 5f)
                lineTo(4f, 12f)
                curveTo(4f, 18f, 12f, 22f, 12f, 22f)
                close()
            }
            // Exclamation mark
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 8f)
                lineTo(12f, 12f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 16f)
                lineTo(12f, 16.01f)
            }
        }.build()
    }

    /**
     * App icon — squat rounded character with >< eyes, nub arms, stubby legs.
     * Body + eyes use EvenOdd so eyes are cutouts (works with Icon tint).
     * Arms and legs are separate filled paths.
     */
    val AppIcon: ImageVector by lazy {
        ImageVector.Builder(
            name = "AppIcon",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Body with eye cutouts (EvenOdd)
            path(
                fill = SolidColor(Color.Black),
                stroke = null,
                pathFillType = PathFillType.EvenOdd,
            ) {
                // Rounded rect body: x=5, y=4, w=14, h=12, rx=4
                moveTo(9f, 4f)
                lineTo(15f, 4f)
                arcTo(4f, 4f, 0f, false, true, 19f, 8f)
                lineTo(19f, 12f)
                arcTo(4f, 4f, 0f, false, true, 15f, 16f)
                lineTo(9f, 16f)
                arcTo(4f, 4f, 0f, false, true, 5f, 12f)
                lineTo(5f, 8f)
                arcTo(4f, 4f, 0f, false, true, 9f, 4f)
                close()

                // Left eye > (cutout)
                moveTo(8.5f, 8f)
                lineTo(10.5f, 10f)
                lineTo(8.5f, 12f)
                lineTo(9.5f, 12f)
                lineTo(11.5f, 10f)
                lineTo(9.5f, 8f)
                close()

                // Right eye < (cutout)
                moveTo(15.5f, 8f)
                lineTo(13.5f, 10f)
                lineTo(15.5f, 12f)
                lineTo(14.5f, 12f)
                lineTo(12.5f, 10f)
                lineTo(14.5f, 8f)
                close()
            }
            // Left nub arm (air gap — 1 unit from body)
            path(fill = SolidColor(Color.Black)) {
                moveTo(1.8f, 9f)
                lineTo(3.2f, 9f)
                arcTo(0.8f, 0.8f, 0f, false, true, 4f, 9.8f)
                lineTo(4f, 12.2f)
                arcTo(0.8f, 0.8f, 0f, false, true, 3.2f, 13f)
                lineTo(1.8f, 13f)
                arcTo(0.8f, 0.8f, 0f, false, true, 1f, 12.2f)
                lineTo(1f, 9.8f)
                arcTo(0.8f, 0.8f, 0f, false, true, 1.8f, 9f)
                close()
            }
            // Right nub arm (air gap — 1 unit from body)
            path(fill = SolidColor(Color.Black)) {
                moveTo(20.8f, 9f)
                lineTo(22.2f, 9f)
                arcTo(0.8f, 0.8f, 0f, false, true, 23f, 9.8f)
                lineTo(23f, 12.2f)
                arcTo(0.8f, 0.8f, 0f, false, true, 22.2f, 13f)
                lineTo(20.8f, 13f)
                arcTo(0.8f, 0.8f, 0f, false, true, 20f, 12.2f)
                lineTo(20f, 9.8f)
                arcTo(0.8f, 0.8f, 0f, false, true, 20.8f, 9f)
                close()
            }
            // Left stubby leg (rx=1.75)
            path(fill = SolidColor(Color.Black)) {
                moveTo(8.75f, 16f)
                lineTo(10.5f, 16f)
                lineTo(10.5f, 18.25f)
                arcTo(1.75f, 1.75f, 0f, false, true, 8.75f, 20f)
                lineTo(8.75f, 20f)
                arcTo(1.75f, 1.75f, 0f, false, true, 7f, 18.25f)
                lineTo(7f, 16f)
                close()
            }
            // Right stubby leg (rx=1.75)
            path(fill = SolidColor(Color.Black)) {
                moveTo(15.25f, 16f)
                lineTo(17f, 16f)
                lineTo(17f, 18.25f)
                arcTo(1.75f, 1.75f, 0f, false, true, 15.25f, 20f)
                lineTo(15.25f, 20f)
                arcTo(1.75f, 1.75f, 0f, false, true, 13.5f, 18.25f)
                lineTo(13.5f, 16f)
                close()
            }
        }.build()
    }
}
