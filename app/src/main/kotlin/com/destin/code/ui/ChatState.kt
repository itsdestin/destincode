package com.destin.code.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.UUID
import com.destin.code.ui.state.PromptButton

enum class MessageRole { SYSTEM }

sealed class MessageContent {
    data class InteractivePrompt(
        val promptId: String,
        val title: String,
        val buttons: List<PromptButton>,
    ) : MessageContent()
    data class CompletedPrompt(
        val promptId: String,
        val title: String,
        val selection: String,
    ) : MessageContent()
}

data class ChatMessage(
    val role: MessageRole,
    val content: MessageContent,
    val id: String = UUID.randomUUID().toString(),
)

/**
 * Legacy v1 state — retained only for prompt detection dual-writes
 * and permission mode tracking during the transition period.
 * All tool/response/queue infrastructure has been removed;
 * the v2 ChatReducer is now the source of truth for chat state.
 */
class ChatState {
    val messages = mutableStateListOf<ChatMessage>()

    /** Claude Code's current permission mode, detected from status bar */
    var permissionMode: String by mutableStateOf("Normal")

    /** Show an interactive prompt card. Replaces existing prompt with same ID. */
    fun showInteractivePrompt(promptId: String, title: String, buttons: List<PromptButton>) {
        messages.removeAll { (it.content as? MessageContent.InteractivePrompt)?.promptId == promptId }
        messages.add(ChatMessage(
            MessageRole.SYSTEM,
            MessageContent.InteractivePrompt(promptId, title, buttons),
        ))
    }

    /** Collapse a prompt to show the user's selection. */
    fun completePrompt(promptId: String, selection: String) {
        val idx = messages.indexOfLast {
            (it.content as? MessageContent.InteractivePrompt)?.promptId == promptId
        }
        if (idx >= 0) {
            val prompt = messages[idx].content as? MessageContent.InteractivePrompt ?: return
            messages[idx] = messages[idx].copy(
                content = MessageContent.CompletedPrompt(promptId, prompt.title, selection)
            )
        }
    }

    /** Remove a prompt entirely (used when detector clears stale prompts). */
    fun dismissPrompt(promptId: String) {
        messages.removeAll {
            (it.content as? MessageContent.InteractivePrompt)?.promptId == promptId
        }
    }
}
