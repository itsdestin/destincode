package com.destins.claudemobile.ui.theme

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
     * Terminal icon — Claude-ified Windows Terminal style.
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
                stroke = SolidColor(Color.White),
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
                stroke = SolidColor(Color.White),
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
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 15f)
                lineTo(17f, 15f)
            }
        }.build()
    }

    /**
     * Chat icon — speech bubble with a subtle Claude sparkle.
     * Rounded speech bubble with a small dot pattern inside.
     */
    val Chat: ImageVector by lazy {
        ImageVector.Builder(
            name = "Chat",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Speech bubble outline
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(21f, 11.5f)
                arcTo(8.38f, 5.56f, 0f, false, true, 19.5f, 15.7f)
                arcTo(17.5f, 17.5f, 0f, false, true, 12f, 17f)
                lineTo(7f, 20f)
                lineTo(8f, 16.5f)
                arcTo(8.38f, 5.56f, 0f, false, true, 3f, 11.5f)
                arcTo(8.38f, 5.56f, 0f, false, true, 12f, 6f)
                arcTo(8.38f, 5.56f, 0f, false, true, 21f, 11.5f)
                close()
            }
            // Three dots inside (Claude's thinking dots)
            // Left dot
            path(
                fill = SolidColor(Color.White),
                stroke = null,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(9.25f, 10.5f)
                arcTo(0.75f, 0.75f, 0f, true, true, 9.25f, 12f)
                arcTo(0.75f, 0.75f, 0f, true, true, 9.25f, 10.5f)
                close()
            }
            // Center dot
            path(
                fill = SolidColor(Color.White),
                stroke = null,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(12f, 10.5f)
                arcTo(0.75f, 0.75f, 0f, true, true, 12f, 12f)
                arcTo(0.75f, 0.75f, 0f, true, true, 12f, 10.5f)
                close()
            }
            // Right dot
            path(
                fill = SolidColor(Color.White),
                stroke = null,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(14.75f, 10.5f)
                arcTo(0.75f, 0.75f, 0f, true, true, 14.75f, 12f)
                arcTo(0.75f, 0.75f, 0f, true, true, 14.75f, 10.5f)
                close()
            }
        }.build()
    }
}
