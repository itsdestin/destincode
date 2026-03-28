package com.destin.code.ui.v2

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.MaterialTheme
import com.destin.code.ui.MarkdownRenderer
import com.destin.code.ui.state.*
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.v2.DesktopColors as DC

/**
 * Renders an assistant turn as multiple sub-bubbles, matching the desktop's
 * AssistantTurnBubble.tsx splitIntoBubbles() pattern.
 *
 * Each text segment starts a new sub-bubble. Tool groups attach to the
 * preceding text's bubble. Leading tool groups (before any text) get their
 * own tools-only bubble.
 */

private data class SubBubble(
    val key: String,
    val text: AssistantTurnSegment.Text? = null,
    val toolGroupIds: MutableList<String> = mutableListOf(),
)

/** Split turn segments into sub-bubbles matching desktop's splitIntoBubbles(). */
private fun splitIntoBubbles(segments: List<AssistantTurnSegment>): List<SubBubble> {
    val bubbles = mutableListOf<SubBubble>()
    var current: SubBubble? = null

    for (seg in segments) {
        when (seg) {
            is AssistantTurnSegment.Text -> {
                // Each text segment starts a new bubble
                current = SubBubble(key = seg.messageId, text = seg)
                bubbles.add(current)
            }
            is AssistantTurnSegment.ToolGroupRef -> {
                if (current != null) {
                    // Attach to current text bubble
                    current.toolGroupIds.add(seg.groupId)
                } else {
                    // Leading tool group before any text — own bubble
                    val bubble = SubBubble(key = "tools-${seg.groupId}")
                    bubble.toolGroupIds.add(seg.groupId)
                    bubbles.add(bubble)
                }
            }
        }
    }
    return bubbles
}

@Composable
fun AssistantTurnBubble(
    turn: AssistantTurn,
    toolGroups: Map<String, ToolGroupState>,
    toolCalls: Map<String, ToolCallState>,
    expandedToolId: String?,
    onToggleTool: (String) -> Unit,
    onAccept: (ToolCallState) -> Unit,
    onAcceptAlways: (ToolCallState) -> Unit,
    onReject: (ToolCallState) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Filter out segments with only awaiting-approval tools
    val visibleSegments = turn.segments.filter { segment ->
        when (segment) {
            is AssistantTurnSegment.Text -> true
            is AssistantTurnSegment.ToolGroupRef -> {
                val group = toolGroups[segment.groupId]
                val tools = group?.toolIds?.mapNotNull { toolCalls[it] } ?: emptyList()
                tools.any { it.status != ToolCallStatus.AwaitingApproval }
            }
        }
    }

    if (visibleSegments.isEmpty()) return

    val bubbles = splitIntoBubbles(visibleSegments)

    Column(modifier = modifier) {
        for (bubble in bubbles) {
            val toolsOnly = bubble.text == null
            val hasTools = bubble.toolGroupIds.isNotEmpty()

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 4.dp), // desktop: px-4 py-1
                horizontalArrangement = Arrangement.Start,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth(0.85f) // desktop: max-w-[85%]
                        .clip(
                            RoundedCornerShape(
                                topStart = 16.dp, // desktop: rounded-2xl
                                topEnd = 16.dp,
                                bottomStart = 4.dp, // desktop: rounded-bl-sm
                                bottomEnd = 16.dp,
                            )
                        )
                        .background(
                            if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.surfaceContainerHigh
                            else DC.gray800
                        )
                        .padding(
                            // desktop: px varies with hasTools, py varies with toolsOnly
                            horizontal = if (hasTools) 8.dp else 16.dp,
                            vertical = if (toolsOnly) 4.dp else 12.dp,
                        ),
                ) {
                    // Text content
                    if (bubble.text != null) {
                        Box(
                            modifier = if (hasTools) Modifier.padding(horizontal = 8.dp) else Modifier,
                        ) {
                            MarkdownRenderer(
                                markdown = bubble.text.content,
                                textColor = if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.onSurface
                                else DC.gray200,
                            )
                        }
                    }

                    // Tool groups
                    for (groupId in bubble.toolGroupIds) {
                        val group = toolGroups[groupId] ?: continue
                        val tools = group.toolIds.mapNotNull { toolCalls[it] }
                            .filter { it.status != ToolCallStatus.AwaitingApproval }
                        if (tools.isEmpty()) continue

                        if (bubble.text != null) {
                            Spacer(Modifier.height(8.dp)) // desktop: mt-2
                        }

                        ToolGroupInline(
                            tools = tools,
                            expandedToolId = expandedToolId,
                            onToggleTool = onToggleTool,
                        )
                    }
                }
            }
        }
    }
}

/** Renders tool cards inline within a bubble — matching desktop's ToolGroupInline. */
@Composable
private fun ToolGroupInline(
    tools: List<ToolCallState>,
    expandedToolId: String?,
    onToggleTool: (String) -> Unit,
) {
    if (tools.size <= 2) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (tool in tools) {
                ToolCardV2(
                    tool = tool,
                    isExpanded = expandedToolId == tool.toolUseId,
                    onToggle = { onToggleTool(tool.toolUseId) },
                )
            }
        }
    } else {
        CollapsedToolGroup(
            tools = tools,
            expandedToolId = expandedToolId,
            onToggleTool = onToggleTool,
        )
    }
}

/**
 * Collapsed tool group — desktop's CollapsedToolGroup.
 * Shows "Read, Grep ×2" summary with expand/collapse.
 */
@Composable
private fun CollapsedToolGroup(
    tools: List<ToolCallState>,
    expandedToolId: String?,
    onToggleTool: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    val runningCount = tools.count { it.status == ToolCallStatus.Running }
    val failedCount = tools.count { it.status == ToolCallStatus.Failed }

    val nameCounts = tools.groupBy { it.toolName }
        .map { (name, list) ->
            val friendly = ToolInputFormatter.friendlyName(name)
            if (list.size > 1) "$friendly ×${list.size}" else friendly
        }
    val summary = nameCounts.joinToString(", ")

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (DestinCodeTheme.extended.isMaterial) MaterialTheme.colorScheme.surfaceContainerHighest
                else DC.gray700.copy(alpha = 0.3f)
            )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (runningCount > 0) {
                BrailleSpinner(fontSize = 12.sp, color = DC.gray400)
            } else if (failedCount > 0) {
                Text("✗", fontSize = 12.sp, color = DC.red400)
            } else {
                Text("✓", fontSize = 12.sp, color = DC.green400)
            }

            Spacer(Modifier.width(6.dp))

            Text(
                "${tools.size} tool calls",
                color = DC.gray200,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = CascadiaMono,
            )

            Spacer(Modifier.width(8.dp))

            Text(
                summary,
                color = DC.gray400,
                fontSize = 11.sp,
                fontFamily = CascadiaMono,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )

            Text(
                if (expanded) "▾" else "▸",
                color = DC.gray400,
                fontSize = 10.sp,
                modifier = Modifier.padding(start = 4.dp),
            )
        }

        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(start = 6.dp, end = 6.dp, bottom = 6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (tool in tools) {
                    ToolCardV2(
                        tool = tool,
                        isExpanded = expandedToolId == tool.toolUseId,
                        onToggle = { onToggleTool(tool.toolUseId) },
                    )
                }
            }
        }
    }
}
