package com.youcoded.app.parser

/** A button in an interactive terminal prompt. */
data class PromptButton(val label: String, val input: String)

data class ParsedMenu(
    val id: String,
    val title: String,
    val options: List<String>,
    val selectedIndex: Int,  // which option is currently highlighted by ❯
    val description: String? = null, // Contextual text above menu (e.g., resume trade-offs)
)

object InkSelectParser {

    // Matches the selected line: optional leading whitespace + ❯, optionally followed by number
    // Supports both period ("1. ") and colon ("1: ") numbered formats — resume prompt uses colons
    private val SELECTED_LINE = Regex("""^\s*❯\s*(?:\d+[.:]\s+)?(.+)$""")
    // Strips ANSI escape sequences from terminal output
    private val ANSI_ESCAPE = Regex("""\u001B\[[0-9;]*[a-zA-Z]""")
    // Matches unselected lines: 2+ leading spaces (no ❯), optionally numbered
    private val UNSELECTED_LINE = Regex("""^\s{2,}(?:\d+[.:]\s+)?(.+)$""")
    // Detects a new option (has a number prefix like "1. " or "1: ")
    private val NUMBERED_PREFIX = Regex("""^\s*\d+[.:]\s+""")

    // Title overrides for known prompts — keyed by lowercase keyword found in context.
    // Keys are matched as bare substrings against screen text that includes arbitrary
    // conversation output, so each key must be a phrase distinctive enough that normal
    // conversation can't contain it — a single common word is never acceptable (the old
    // "trust" key relabeled ANY menu whenever the word appeared nearby; fixed 2026-07-16
    // in lockstep with desktop's ink-select-parser.ts — keep the two maps in sync).
    // Note: bypass permissions prompt is handled by a hardcoded handler in ManagedSession,
    // not by the generic InkSelectParser, because it uses Enter/Esc (not arrow navigation).
    private val TITLE_OVERRIDES = mapOf(
        // Folder-trust prompt — anchored on the "Quick safety check:" opener of the
        // CC ~2.1.2xx rewrite. The previous anchor ("files you trust", from the old
        // "Important: Only use Claude Code with files you trust…" note) no longer
        // appears in this dialog at all; in the 2.1.220 bundle that sentence survives
        // only in the external-CLAUDE.md-imports dialog below, so keeping it here both
        // missed the real prompt and hijacked the wrong one (2026-07-26).
        "quick safety check" to "Trust This Folder?",
        // Same dialog, second anchor — the body varies (optional "This folder
        // pre-approves N tool permissions" / "This folder adds …" lines), and this
        // sentence sits closer to the options, inside extractTitle's lookback window.
        "execute files here" to "Trust This Folder?",
        // External CLAUDE.md imports — the dialog that inherited the old
        // "…files you trust…" security note. Anchored on its own body sentence
        // because the generic heuristic would otherwise title it "security risks".
        "imports files outside the current working directory" to "Allow External Imports?",
        // Model-safeguard fallback prompt — "This model's safeguards flagged this
        // message…" with Switch-model / Edit-and-retry options.
        "safeguards flagged this message" to "Message Flagged",
        // Theme select — anchored on its heading ("Choose the text style that looks
        // best with your terminal"); the old "dark mode" key matched conversation text.
        "text style that looks best" to "Choose a Theme for the Terminal",
        // Login select — anchored on its "Select login method:" heading.
        "select login method" to "Select Login Method",
        // Resume session prompt — shown when resuming a stale/large session
        "resuming from a summary" to "Resume Session",
        // Usage-limit prompt — shown when the user hits their plan's usage cap.
        // Key on "limit to reset" (unique to option 1) rather than the generic
        // "What do you want to do?" title to avoid false matches on future menus.
        "limit to reset" to "Usage Limit Reached",
    )

    // Overrides keyed on an OPTION LABEL rather than on body text above the menu.
    // Body text is fragile: extractTitle only looks 10 lines up, and CC's dialogs grow
    // and shrink optional body lines (the folder-trust dialog adds "This folder
    // pre-approves N tool permissions" / "This folder adds …" when the project ships
    // settings), which can push the distinctive phrase out of range. Option labels are
    // the prompt's own vocabulary and survive every body rewrite, so they must be exact
    // whole-label matches — a substring would be as collision-prone as the old bare
    // "trust" key. Keep in sync with desktop's ink-select-parser.ts.
    private val OPTION_TITLE_OVERRIDES = mapOf(
        // Present in BOTH the old ("Do you trust the files in this folder?") and the
        // CC ~2.1.2xx ("Accessing workspace: … Quick safety check:") trust dialogs.
        "yes, i trust this folder" to "Trust This Folder?",
    )

    /**
     * Attempt to parse an Ink Select menu from combined screen+raw PTY output.
     * Returns null if no menu is detected.
     */
    /** Strip ANSI escape codes from a line for clean matching. */
    private fun stripAnsi(line: String): String = line.replace(ANSI_ESCAPE, "")

    fun parse(screenText: String): ParsedMenu? {
        val lines = screenText.lines()
        // Pre-strip ANSI codes for matching (terminal output is full of color codes)
        val cleanLines = lines.map { stripAnsi(it) }

        // Find the selected-item line (starts with ❯)
        val selectorIndex = cleanLines.indexOfLast { line ->
            SELECTED_LINE.matches(line.trimEnd())
        }
        if (selectorIndex < 0) return null

        // Gather contiguous option lines around the selector
        val options = mutableListOf<String>()
        val optionIndices = mutableListOf<Int>()

        // Detect whether this menu uses numbered options (e.g. "1. Yes")
        val isNumberedMenu = cleanLines.any { NUMBERED_PREFIX.containsMatchIn(it) }

        // Walk backward from selector to find earlier options
        // Collect raw lines first, then merge continuations
        val rawAbove = mutableListOf<Pair<Int, String>>() // (lineIndex, text)
        for (i in (selectorIndex - 1) downTo 0) {
            val clean = cleanLines[i].trimEnd()
            if ("❯" in clean) break
            val match = UNSELECTED_LINE.matchEntire(clean) ?: break
            rawAbove.add(0, i to match.groupValues[1].trim())
        }
        // Merge continuation lines into their parent option (backward pass)
        for ((idx, text) in rawAbove) {
            val isNewOption = !isNumberedMenu || NUMBERED_PREFIX.containsMatchIn(cleanLines[idx])
            if (isNewOption || options.isEmpty()) {
                options.add(text)
                optionIndices.add(idx)
            } else {
                // Continuation line — merge into the last option
                options[options.lastIndex] = options.last() + " " + text
            }
        }

        // Add the selected item
        val selectedMatch = SELECTED_LINE.matchEntire(cleanLines[selectorIndex].trimEnd()) ?: return null
        val selectedIndex = options.size
        options.add(selectedMatch.groupValues[1].trim())
        optionIndices.add(selectorIndex)

        // Walk forward from selector+1 to find later options, merging continuations
        for (i in (selectorIndex + 1) until cleanLines.size) {
            val clean = cleanLines[i].trimEnd()
            if ("❯" in clean) break
            val match = UNSELECTED_LINE.matchEntire(clean) ?: break
            val text = match.groupValues[1].trim()
            val isNewOption = !isNumberedMenu || NUMBERED_PREFIX.containsMatchIn(clean)
            if (isNewOption) {
                options.add(text)
                optionIndices.add(i)
            } else {
                // Continuation line — merge into the previous option
                if (options.isNotEmpty()) {
                    options[options.lastIndex] = options.last() + " " + text
                }
            }
        }

        // Need at least 2 options for a valid menu
        if (options.size < 2) return null

        // Filter out noise — each option should be relatively short (< 120 chars)
        if (options.any { it.length > 120 }) return null

        // Extract title from context above the menu
        val title = extractTitle(lines, optionIndices.first(), screenText, options)

        // Generate a stable ID from the options
        val id = "menu_" + options.joinToString("_") { it.take(10) }
            .lowercase().replace(Regex("[^a-z0-9_]"), "")

        // Extract contextual description from lines above the menu (e.g., resume
        // session trade-off text: session age, token count, usage warning)
        val description = extractDescription(lines, optionIndices.first(), title)

        return ParsedMenu(id = id, title = title, options = options, selectedIndex = selectedIndex, description = description)
    }

    /**
     * Extract descriptive text from lines above the menu options, between the
     * title region and the first option. Used to surface contextual info like
     * the resume prompt's session-age and usage-limit trade-off explanation.
     */
    private fun extractDescription(lines: List<String>, firstOptionLine: Int, title: String): String? {
        val searchStart = maxOf(0, firstOptionLine - 15)
        val descLines = mutableListOf<String>()
        val titleNorm = title.trimEnd(':', '?').trim()
        val boxDrawing = Regex("""^[─┌┐└┘│╭╮╯╰┬┴├┤┼╔╗╚╝║═━]+$""")

        for (i in searchStart until firstOptionLine) {
            val clean = stripAnsi(lines[i]).trim()
            if (clean.isEmpty()) continue
            if (boxDrawing.matches(clean)) continue
            // Skip the line that became the title (avoid duplication)
            if (clean.trimEnd(':', '?').trim() == titleNorm) continue
            // Skip footer instructions
            if (clean.contains("enter to confirm", ignoreCase = true)) continue
            descLines.add(clean)
        }

        return if (descLines.isEmpty()) null else descLines.joinToString(" ")
    }

    /**
     * Look for a title/question in the lines above the menu.
     * First checks TITLE_OVERRIDES, then scans for the nearest question or heading.
     */
    private fun extractTitle(
        lines: List<String>,
        firstOptionLine: Int,
        fullText: String,
        options: List<String> = emptyList(),
    ): String {
        // Option-label overrides win: they don't depend on how far the prompt's body
        // text happens to sit above the menu (see OPTION_TITLE_OVERRIDES).
        for (option in options) {
            OPTION_TITLE_OVERRIDES[option.trim().lowercase()]?.let { return it }
        }
        // Check title overrides against only the ~10 lines ABOVE the menu, not the
        // full screen text — matches desktop's ink-select-parser.ts. Full-screen
        // matching let stale content from earlier prompts (still in the buffer)
        // relabel every subsequent menu.
        val searchStart = maxOf(0, firstOptionLine - 10)
        val nearby = lines.subList(searchStart, firstOptionLine.coerceAtLeast(searchStart))
            .joinToString(" ") { stripAnsi(it) }.lowercase()
        for ((keyword, title) in TITLE_OVERRIDES) {
            if (keyword in nearby) return title
        }
        for (i in (firstOptionLine - 1) downTo searchStart) {
            val line = lines[i].trim()
            if (line.isEmpty()) continue
            // Skip ANSI escape sequences for matching
            val clean = line.replace(ANSI_ESCAPE, "").trim()
            if (clean.isEmpty()) continue
            // Prefer lines ending with ? or : as titles
            if (clean.endsWith("?") || clean.endsWith(":")) {
                return clean.trimEnd(':', '?').trim() + if (clean.endsWith("?")) "?" else ""
            }
            // Otherwise use the first non-empty line above as the title
            if (clean.length in 3..80) return clean
        }

        return "Select an Option"
    }

    /**
     * Generate PromptButtons from a parsed menu.
     *
     * Anchor-then-navigate: always overshoot UP to snap Ink's cursor to the top
     * of the menu (Ink clamps arrow-up at index 0), THEN press DOWN to reach the
     * target. This makes the keystroke sequence independent of cursor state at
     * click time — previously we computed a relative offset from the parsed
     * selectedIndex, which went stale the moment the user arrowed in the
     * terminal view or Ink re-rendered (same menu.id, so the prompt detector
     * doesn't re-emit SHOW_PROMPT). Stale offset was the root cause of
     * "clicked option N, got option M" bugs on the Resume Session menu.
     *
     * Ported from desktop (youcoded/desktop/src/renderer/parser/ink-select-parser.ts)
     * so both platforms emit identical keystroke sequences.
     */
    fun toPromptButtons(menu: ParsedMenu): List<PromptButton> {
        val up = "\u001b[A"
        val down = "\u001b[B"
        val anchorUps = up.repeat(menu.options.size + 2)
        return menu.options.mapIndexed { index, label ->
            PromptButton(label = label, input = anchorUps + down.repeat(index) + "\r")
        }
    }
}
