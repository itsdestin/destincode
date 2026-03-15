package com.destins.claudemobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

enum class MessageRole { USER, CLAUDE, SYSTEM }

sealed class MessageContent {
    data class Text(val text: String) : MessageContent()
    data class RawTerminal(val text: String) : MessageContent()
    data class ApprovalRequest(val summary: String) : MessageContent()
}

data class ChatMessage(
    val role: MessageRole,
    val content: MessageContent,
    val isBtw: Boolean = false,
    val timestamp: Long = System.currentTimeMillis(),
)

class ChatState {
    val messages = mutableStateListOf<ChatMessage>()
    var isWaitingForApproval by mutableStateOf(false)
    var approvalSummary by mutableStateOf("")

    fun addUserMessage(text: String, isBtw: Boolean = false) {
        messages.add(ChatMessage(MessageRole.USER, MessageContent.Text(text), isBtw = isBtw))
    }

    fun addClaudeText(text: String) {
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.Text(text)))
    }

    fun addRawOutput(text: String) {
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.RawTerminal(text)))
    }

    fun requestApproval(summary: String) {
        isWaitingForApproval = true
        approvalSummary = summary
        messages.add(ChatMessage(MessageRole.CLAUDE, MessageContent.ApprovalRequest(summary)))
    }

    fun resolveApproval() {
        isWaitingForApproval = false
        approvalSummary = ""
    }
}
