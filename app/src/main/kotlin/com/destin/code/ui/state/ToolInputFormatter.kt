package com.destin.code.ui.state

import org.json.JSONObject

/**
 * Formats tool names and inputs for display, mirroring the desktop's
 * ToolCard.tsx friendly label mapping and input summarization.
 */
object ToolInputFormatter {

    /** Map tool names to user-friendly action labels. */
    fun friendlyName(toolName: String): String = when (toolName) {
        "Bash" -> "Run Command"
        "Read" -> "Read File"
        "Write" -> "Write File"
        "Edit" -> "Edit File"
        "Glob" -> "Search Files"
        "Grep" -> "Search Content"
        "LS" -> "List Directory"
        "Agent" -> "Sub-agent"
        "WebFetch" -> "Fetch URL"
        "WebSearch" -> "Web Search"
        "Skill" -> "Run Skill"
        "NotebookEdit" -> "Edit Notebook"
        "NotebookRead" -> "Read Notebook"
        else -> {
            // MCP tools: "mcp__server__tool" → "server: tool"
            if (toolName.startsWith("mcp__")) {
                val parts = toolName.removePrefix("mcp__").split("__", limit = 2)
                if (parts.size == 2) "${parts[0]}: ${parts[1]}" else toolName
            } else {
                toolName
            }
        }
    }

    /** Map tool names to short action verbs for running state. */
    fun friendlyAction(toolName: String): String = when (toolName) {
        "Read" -> "Reading"
        "Write" -> "Writing"
        "Edit" -> "Editing"
        "Bash" -> "Running"
        "Glob" -> "Searching"
        "Grep" -> "Searching"
        "Agent" -> "Delegating"
        "WebSearch" -> "Searching"
        "WebFetch" -> "Fetching"
        "Skill" -> "Running"
        "LS" -> "Listing"
        else -> "Working"
    }

    /**
     * Extract the most relevant field from tool input for a one-line summary.
     * Mirrors the desktop ToolCard's input display logic.
     */
    fun summarizeInput(toolName: String, input: JSONObject): String {
        return when (toolName) {
            "Bash" -> {
                val cmd = input.optString("command", "")
                val desc = input.optString("description", "")
                if (desc.isNotBlank()) desc else truncate(cmd, 80)
            }
            "Read" -> {
                val path = input.optString("file_path", "")
                shortenPath(path)
            }
            "Write" -> {
                val path = input.optString("file_path", "")
                shortenPath(path)
            }
            "Edit" -> {
                val path = input.optString("file_path", "")
                shortenPath(path)
            }
            "Glob" -> {
                val pattern = input.optString("pattern", "")
                val path = input.optString("path", "")
                if (path.isNotBlank()) "$pattern in ${shortenPath(path)}" else pattern
            }
            "Grep" -> {
                val pattern = input.optString("pattern", "")
                val path = input.optString("path", "")
                if (path.isNotBlank()) "\"$pattern\" in ${shortenPath(path)}" else "\"$pattern\""
            }
            "LS" -> {
                val path = input.optString("path", "")
                shortenPath(path)
            }
            "Agent" -> {
                input.optString("description", input.optString("prompt", "").take(60))
            }
            "WebFetch" -> {
                input.optString("url", "")
            }
            "WebSearch" -> {
                input.optString("query", "")
            }
            "Skill" -> {
                val skill = input.optString("skill", "")
                val args = input.optString("args", "")
                if (args.isNotBlank()) "$skill $args" else skill
            }
            else -> {
                // Generic: show first string field value
                val keys = input.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = input.optString(key, "")
                    if (value.isNotBlank()) return truncate(value, 60)
                }
                ""
            }
        }
    }

    /** Shorten file paths by keeping only the last 2-3 segments. */
    private fun shortenPath(path: String): String {
        if (path.length <= 50) return path
        val parts = path.split("/")
        return if (parts.size > 3) {
            ".../" + parts.takeLast(3).joinToString("/")
        } else {
            path
        }
    }

    private fun truncate(text: String, maxLen: Int): String {
        val singleLine = text.replace('\n', ' ').trim()
        return if (singleLine.length > maxLen) {
            singleLine.take(maxLen) + "…"
        } else {
            singleLine
        }
    }
}
