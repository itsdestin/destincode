package com.destin.code.ui.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.state.ChatMessage
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.v2.DesktopColors as DC

/**
 * User message bubble — matches desktop's UserMessage.tsx.
 * In Material themes, uses the dynamic primary color for the bubble.
 */
@Composable
fun UserMessageBubble(
    message: ChatMessage,
    modifier: Modifier = Modifier,
) {
    val isMaterial = DestinCodeTheme.extended.isMaterial
    val bubbleBg = if (isMaterial) MaterialTheme.colorScheme.primaryContainer else DC.userBubbleBg
    val bubbleText = if (isMaterial) MaterialTheme.colorScheme.onPrimaryContainer else DC.userBubbleText

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = 16.dp,
                        bottomEnd = 4.dp,
                    )
                )
                .background(bubbleBg)
                .padding(horizontal = 16.dp, vertical = 10.dp)
        ) {
            Text(
                text = message.content,
                color = bubbleText,
                fontSize = 14.sp,
                fontFamily = CascadiaMono,
            )
        }
    }
}
