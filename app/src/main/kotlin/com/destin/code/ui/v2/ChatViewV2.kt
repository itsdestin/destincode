package com.destin.code.ui.v2

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontStyle
import com.destin.code.ui.MarkdownRenderer
import com.destin.code.ui.state.*
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.v2.DesktopColors as DC
import kotlinx.coroutines.launch

/**
 * Turn-based chat view matching the desktop's ChatView.tsx.
 *
 * Renders the timeline from ChatReducer's SessionChatState:
 *   [User] → [AssistantTurn] → [Prompt] → [User] → ...
 *
 * Tools awaiting approval are rendered as standalone cards at the bottom,
 * separate from the turn they belong to (matching desktop behavior).
 *
 * Auto-scrolls to bottom on new content unless user has scrolled up.
 */
@Composable
fun ChatViewV2(
    reducer: ChatReducer,
    onPromptAction: (promptId: String, input: String) -> Unit,
    onAcceptTool: (ToolCallState) -> Unit,
    onAcceptAlwaysTool: (ToolCallState) -> Unit,
    onRejectTool: (ToolCallState) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = reducer.state

    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    // Track which tool is expanded
    var expandedToolId by remember { mutableStateOf<String?>(null) }

    // Collect tools awaiting approval (rendered at bottom, outside turns).
    // Reading from SnapshotStateMap — Compose observes mutations directly.
    val awaitingApproval = state.toolCalls.values.filter {
        it.status == ToolCallStatus.AwaitingApproval
    }

    // Build display list: timeline entries + awaiting approval + thinking indicator.
    // state.timeline is a mutableStateListOf — Compose observes additions/removals.
    val displayItems = buildList {
        for (entry in state.timeline) {
            add(DisplayItem.Timeline(entry))
        }
        // Optimistic user message echo — shown before transcript confirms
        val pendingText = state.pendingUserText
        if (pendingText.isNotBlank()) {
            add(DisplayItem.PendingUser(pendingText))
        }
        // Streaming text preview
        val streamingText = state.streamingText
        if (streamingText.isNotBlank()) {
            add(DisplayItem.Streaming(streamingText))
        }
        for (tool in awaitingApproval) {
            add(DisplayItem.ApprovalCard(tool))
        }
        if (state.isThinking && awaitingApproval.isEmpty()) {
            add(DisplayItem.Thinking)
        }
    }

    // Auto-scroll to bottom when new content arrives
    LaunchedEffect(displayItems.size) {
        if (displayItems.isNotEmpty()) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()
            val totalItems = listState.layoutInfo.totalItemsCount
            // Only auto-scroll if we're near the bottom (within 3 items)
            if (lastVisible != null && totalItems - lastVisible.index <= 3) {
                coroutineScope.launch {
                    listState.animateScrollToItem(displayItems.size - 1)
                }
            }
        }
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 8.dp),
    ) {
        items(
            items = displayItems,
            key = { it.key },
        ) { item ->
            when (item) {
                is DisplayItem.Timeline -> {
                    when (val entry = item.entry) {
                        is TimelineEntry.User -> {
                            UserMessageBubble(message = entry.message)
                        }
                        is TimelineEntry.Turn -> {
                            val turn = state.assistantTurns[entry.turnId]
                            if (turn != null) {
                                AssistantTurnBubble(
                                    turn = turn,
                                    toolGroups = state.toolGroups,
                                    toolCalls = state.toolCalls,
                                    expandedToolId = expandedToolId,
                                    onToggleTool = { id ->
                                        expandedToolId = if (expandedToolId == id) null else id
                                    },
                                    onAccept = onAcceptTool,
                                    onAcceptAlways = onAcceptAlwaysTool,
                                    onReject = onRejectTool,
                                )
                            }
                        }
                        is TimelineEntry.Prompt -> {
                            PromptCardV2(
                                prompt = entry.prompt,
                                onAction = onPromptAction,
                            )
                        }
                        is TimelineEntry.Notice -> {
                            Text(
                                text = entry.message,
                                color = DC.gray400,
                                fontSize = 12.sp,
                                fontFamily = CascadiaMono,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 4.dp),
                                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                            )
                        }
                        is TimelineEntry.History -> {
                            HistorySection(messages = entry.messages)
                        }
                    }
                }
                is DisplayItem.ApprovalCard -> {
                    // Standalone approval card at bottom — desktop: px-4
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.Start,
                    ) {
                        ToolCardV2(
                            tool = item.tool,
                            isExpanded = true,
                            onAccept = { onAcceptTool(item.tool) },
                            onAcceptAlways = { onAcceptAlwaysTool(item.tool) },
                            onReject = { onRejectTool(item.tool) },
                            modifier = Modifier.fillMaxWidth(0.85f),
                        )
                    }
                }
                is DisplayItem.PendingUser -> {
                    UserMessageBubble(
                        message = ChatMessage(
                            id = "pending",
                            role = ChatRole.User,
                            content = item.text,
                            timestamp = System.currentTimeMillis(),
                        ),
                    )
                }
                is DisplayItem.Streaming -> {
                    Text(
                        text = item.text,
                        color = DC.gray300,
                        fontSize = 13.sp,
                        fontFamily = CascadiaMono,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
                is DisplayItem.Thinking -> {
                    ThinkingIndicator()
                }
            }
        }
    }
}

/** Sealed items for the display list — provides stable keys for LazyColumn. */
private sealed class DisplayItem {
    abstract val key: String

    data class Timeline(val entry: TimelineEntry) : DisplayItem() {
        override val key: String get() = when (entry) {
            is TimelineEntry.User -> "user-${entry.message.id}"
            is TimelineEntry.Turn -> "turn-${entry.turnId}"
            is TimelineEntry.Prompt -> "prompt-${entry.prompt.promptId}"
            is TimelineEntry.Notice -> "notice-${entry.id}"
            is TimelineEntry.History -> "history"
        }
    }

    data class ApprovalCard(val tool: ToolCallState) : DisplayItem() {
        override val key: String get() = "approval-${tool.toolUseId}"
    }

    data class PendingUser(val text: String) : DisplayItem() {
        override val key: String = "pending-user"
    }

    data class Streaming(val text: String) : DisplayItem() {
        override val key: String = "streaming"
    }

    data object Thinking : DisplayItem() {
        override val key: String = "thinking"
    }
}

/**
 * Renders historical messages from a resumed session with dimmed styling
 * and a "Previous conversation" header.
 */
@Composable
private fun HistorySection(messages: List<HistoryEntry>) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        // Header
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Text(
                "Previous Conversation",
                color = DC.gray500,
                fontSize = 11.sp,
                fontFamily = CascadiaMono,
                fontStyle = FontStyle.Italic,
            )
        }

        Spacer(Modifier.height(8.dp))

        // Messages — dimmed to distinguish from current conversation
        for (msg in messages) {
            val isUser = msg.role == "user"
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp),
                horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(0.85f)
                        .clip(RoundedCornerShape(
                            topStart = if (isUser) 16.dp else 4.dp,
                            topEnd = if (isUser) 4.dp else 16.dp,
                            bottomStart = 16.dp,
                            bottomEnd = 16.dp,
                        ))
                        .background(
                            if (isUser) DC.gray700.copy(alpha = 0.3f)
                            else DC.gray800.copy(alpha = 0.5f)
                        )
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    if (isUser) {
                        // User messages: plain text, dimmed
                        Text(
                            text = msg.content,
                            color = DC.gray500,
                            fontSize = 12.sp,
                            fontFamily = CascadiaMono,
                        )
                    } else {
                        // Assistant messages: markdown rendered, dimmed
                        MarkdownRenderer(
                            markdown = msg.content,
                            textColor = DC.gray500,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(4.dp))

        HorizontalDivider(
            color = DC.gray700,
            modifier = Modifier.padding(vertical = 4.dp),
        )
    }
}
