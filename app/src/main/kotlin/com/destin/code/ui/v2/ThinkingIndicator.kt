package com.destin.code.ui.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.MaterialTheme
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.v2.DesktopColors as DC
import kotlinx.coroutines.delay

/**
 * Thinking indicator matching desktop's ThinkingIndicator.tsx.
 * Cycles through rotating messages with BrailleSpinner.
 */
private val THINKING_MESSAGES = listOf(
    "Thinking", "Cogitating", "Pondering", "Ruminating", "Deliberating",
    "Consulting the vibes", "Percolating", "Simmering", "Brewing thoughts",
    "Noodling", "Mulling it over", "Chewing on it", "Processing",
    "Contemplating", "Reflecting", "Brainstorming", "Calculating",
    "Musing", "Considering", "Weighing options", "Evaluating",
    "Analyzing", "Synthesizing",
)

@Composable
fun ThinkingIndicator(
    modifier: Modifier = Modifier,
) {
    var messageIndex by remember { mutableIntStateOf(THINKING_MESSAGES.indices.random()) }

    LaunchedEffect(Unit) {
        while (true) {
            delay(2500)
            messageIndex = THINKING_MESSAGES.indices.random()
        }
    }

    Row(
        modifier = modifier
            .padding(horizontal = 16.dp, vertical = 4.dp), // same as assistant bubble px
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(16.dp))
                .background(
                    if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.surfaceContainerHigh
                    else DC.gray800
                )
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val tColor = if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.onSurfaceVariant else DC.gray400
            BrailleSpinner(color = tColor)
            Text(
                text = THINKING_MESSAGES[messageIndex],
                color = tColor,
                fontSize = 13.sp,
                fontFamily = CascadiaMono,
            )
        }
    }
}
