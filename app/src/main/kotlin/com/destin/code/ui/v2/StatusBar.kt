package com.destin.code.ui.v2

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.v2.DesktopColors as DC

/**
 * Status bar matching the desktop's StatusBar.tsx.
 * Permission mode colors now match desktop's HeaderBar.tsx exactly.
 */
@Composable
fun StatusBar(
    permissionMode: String,
    activeToolName: String?,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(DC.gray950)
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        // Left: permission mode badge (desktop colors from HeaderBar.tsx)
        val (modeColor, modeBg) = when (permissionMode) {
            "Bypass" -> DC.permBypassColor to DC.permBypassColor.copy(alpha = 0.15f)
            "Auto-Accept" -> DC.permAcceptColor to DC.permAcceptColor.copy(alpha = 0.15f)
            "Plan Mode" -> DC.permPlanColor to DC.permPlanColor.copy(alpha = 0.15f)
            else -> DC.permNormalColor to androidx.compose.ui.graphics.Color.Transparent
        }

        if (permissionMode != "Normal") {
            Box(
                modifier = Modifier
                    .background(modeBg, shape = RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(
                    text = permissionMode.uppercase(),
                    color = modeColor,
                    fontSize = 10.sp,
                    fontFamily = CascadiaMono,
                )
            }
        }

        Spacer(Modifier.weight(1f))

        // Right: active tool indicator
        if (activeToolName != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                BrailleSpinner(fontSize = 10.sp, color = DC.gray400)
                Text(
                    text = activeToolName,
                    color = DC.gray400,
                    fontSize = 10.sp,
                    fontFamily = CascadiaMono,
                )
            }
        }
    }
}
