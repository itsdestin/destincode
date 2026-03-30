package com.destin.code.ui.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.state.InteractivePrompt
import com.destin.code.ui.theme.AppIcons
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.v2.DesktopColors as DC

@Composable
fun PromptCardV2(
    prompt: InteractivePrompt,
    onAction: (promptId: String, input: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (prompt.completed != null) {
        // Completed state — compact row matching tool card completion style
        Row(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 2.dp)
                .clip(RoundedCornerShape(8.dp))
                .border(0.5.dp, DC.gray700.copy(alpha = 0.3f), RoundedCornerShape(8.dp))
                .background(
                    if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.surfaceContainer
                    else DC.gray800
                )
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = AppIcons.CheckCircle,
                contentDescription = "Complete",
                tint = DC.gray400,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(prompt.title, fontSize = 12.sp, color = DC.gray400, fontFamily = CascadiaMono)
            Spacer(Modifier.width(6.dp))
            Text(prompt.completed, fontSize = 12.sp, color = DC.gray200, fontFamily = CascadiaMono)
        }
        return
    }

    // Active state — bordered card matching ToolCardV2 approval style
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, DC.gray400, RoundedCornerShape(8.dp))
            .background(
                if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.surfaceContainer
                else DC.gray800
            )
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Title row — matches ToolCardV2 approval header
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = AppIcons.ShieldAlert,
                contentDescription = "Action needed",
                tint = DC.gray400,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                prompt.title,
                color = DC.gray200,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
                fontFamily = CascadiaMono,
            )
        }

        // Buttons — stacked, matching approval card button style
        for (button in prompt.buttons) {
            Button(
                onClick = { onAction(prompt.promptId, button.input) },
                modifier = Modifier.fillMaxWidth().height(42.dp),
                shape = RoundedCornerShape(6.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = DC.gray600,
                    contentColor = DC.gray100,
                ),
                contentPadding = PaddingValues(0.dp),
            ) {
                Text(button.label, fontSize = 13.sp, fontFamily = CascadiaMono)
            }
        }
    }
}
