package com.destin.code.ui.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.state.InteractivePrompt
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.v2.DesktopColors as DC

@Composable
fun PromptCardV2(
    prompt: InteractivePrompt,
    onAction: (promptId: String, input: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (prompt.completed != null) {
        Row(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 2.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(DC.gray800)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("✓", fontSize = 13.sp, color = DC.green400)
            Spacer(Modifier.width(8.dp))
            Text(prompt.title, fontSize = 12.sp, color = DC.gray400, fontFamily = CascadiaMono)
            Spacer(Modifier.width(6.dp))
            Text(prompt.completed, fontSize = 12.sp, color = DC.blue600, fontFamily = CascadiaMono)
        }
        return
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(DC.gray800)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(prompt.title, color = DC.blue600, fontSize = 14.sp, fontFamily = CascadiaMono)
        Spacer(Modifier.height(2.dp))
        for (button in prompt.buttons) {
            Button(
                onClick = { onAction(prompt.promptId, button.input) },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = DC.blue600.copy(alpha = 0.15f),
                    contentColor = DC.blue600,
                ),
            ) {
                Text(button.label, fontSize = 13.sp, fontFamily = CascadiaMono)
            }
        }
    }
}
