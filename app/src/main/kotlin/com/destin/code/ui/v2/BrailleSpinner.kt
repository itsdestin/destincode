package com.destin.code.ui.v2

import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.v2.DesktopColors as DC
import kotlinx.coroutines.delay

/** Braille character spinner matching the desktop's BrailleSpinner.tsx. */
private val BRAILLE_FRAMES = charArrayOf('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')

@Composable
fun BrailleSpinner(
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = DC.gray400,
    fontSize: TextUnit = 14.sp,
) {
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(80)
            frame = (frame + 1) % BRAILLE_FRAMES.size
        }
    }
    Text(
        text = BRAILLE_FRAMES[frame].toString(),
        color = color,
        fontSize = fontSize,
        fontFamily = CascadiaMono,
        modifier = modifier,
    )
}
