package com.youcoded.app.parser

/** A button in an interactive terminal prompt.
 *  [submitInput] is a rare SECOND pty write, sent ~120ms after [input], used only
 *  by the arrow-navigation fallback: arrows and "\r" must never share one write
 *  (see [InkSelectParser.toPromptButtons]). */
data class PromptButton(val label: String, val input: String, val submitInput: String? = null)

data class ParsedMenu(
    val id: String,
    val title: String,
    val options: List<String>,
    val selectedIndex: Int,  // which option is currently highlighted by ❯
    val description: String? = null, // Contextual text above menu (e.g., resume trade-offs)
    // The number CC prints in front of each option ("1. Yes" -> 1), index-aligned
    // with [options]. This is what toPromptButtons sends.
    val optionNumbers: List<Int?> = emptyList(),
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
    // Same prefix, capturing the number itself ("2. Resume full session" -> 2)
    private val OPTION_NUMBER = Regex("""^(\d+)[.:]\s+""")
    // A horizontal rule / box border — the top edge of CC's prompt box, and the
    // boundary between the prompt's own body and earlier session output. "│" is
    // deliberately absent: it is a SIDE border that appears on body lines.
    private val PROMPT_BOUNDARY = Regex("""^[─═━┌┐└┘╭╮╯╰├┤┬┴┼╔╗╚╝]{8,}$""")

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

        val firstOptionLine = optionIndices.first()

        // The number CC printed for each option — read from that option's own line
        // (optionIndices is index-aligned with options). This is what
        // toPromptButtons sends, so it must come from the screen, never be assumed
        // from list position.
        val optionNumbers = optionIndices.map { idx ->
            OPTION_NUMBER.find(stripAnsi(cleanLines[idx]).trim().removePrefix("❯").trim())
                ?.groupValues?.get(1)?.toIntOrNull()
        }

        // Where the prompt's OWN body starts. CC draws its prompt inside a box whose
        // top edge is a horizontal rule; above that rule is unrelated session output
        // (on a resumed session, the whole replayed transcript tail). Bounding both
        // extractors at the rule is what stops that output being rendered as the
        // prompt's description, and stops TITLE_OVERRIDES matching conversation text
        // (2026-07-26). Keep in sync with desktop's findBodyStart.
        val bodyStart = findBodyStart(lines, firstOptionLine)

        // Extract title from the prompt's own body
        val title = extractTitle(lines, firstOptionLine, screenText, options, bodyStart)

        // Generate a stable ID from the options
        val id = "menu_" + options.joinToString("_") { it.take(10) }
            .lowercase().replace(Regex("[^a-z0-9_]"), "")

        // Extract contextual description from the prompt's own body (e.g., resume
        // session trade-off text: session age, token count, usage warning)
        val description = extractDescription(lines, firstOptionLine, title, bodyStart)

        return ParsedMenu(
            id = id,
            title = title,
            options = options,
            selectedIndex = selectedIndex,
            description = description,
            optionNumbers = optionNumbers,
        )
    }

    /**
     * First line of the prompt's own body: one past the nearest box border above the
     * options, or a 15-line window when the prompt is not boxed.
     */
    private fun findBodyStart(lines: List<String>, firstOptionLine: Int): Int {
        val floor = maxOf(0, firstOptionLine - 15)
        for (i in (firstOptionLine - 1) downTo floor) {
            if (PROMPT_BOUNDARY.matches(stripAnsi(lines[i]).trim())) return i + 1
        }
        return floor
    }

    /**
     * Extract descriptive text from lines above the menu options, between the
     * title region and the first option. Used to surface contextual info like
     * the resume prompt's session-age and usage-limit trade-off explanation.
     */
    private fun extractDescription(
        lines: List<String>,
        firstOptionLine: Int,
        title: String,
        bodyStart: Int = maxOf(0, firstOptionLine - 15),
    ): String? {
        val searchStart = bodyStart
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
        bodyStart: Int = maxOf(0, firstOptionLine - 10),
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
        // Never look above the prompt's own box, and never further than 10 lines.
        val searchStart = maxOf(bodyStart, firstOptionLine - 10)
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
     * Generate PromptButtons from a parsed menu: each one types the option's NUMBER.
     *
     * Why not arrow keys — two facts measured against the real CC CLI (2.1.220) on
     * 2026-07-26:
     *
     *  1. Arrows in a write that ends with "\r" are DISCARDED. CC acts on the Enter
     *     alone, confirming whatever option is highlighted — so every button on the
     *     Resume Session card confirmed option 1 ("Resume from summary"), which runs
     *     /compact. Every option compacted the session.
     *  2. These menus WRAP, they do not clamp. UP×5 on the 3-option resume prompt
     *     moves index 0 → 1, not → 0, so the old "anchor to the top by overshooting
     *     UP" trick was wrong on its own terms.
     *
     * A bare digit selects AND submits in one byte with no dependency on cursor
     * position. Verified on /model, the real Resume Session prompt, and the
     * folder-trust prompt.
     *
     * Ported from desktop (youcoded/desktop/src/renderer/parser/ink-select-parser.ts)
     * so both platforms emit identical keystrokes.
     */
    fun toPromptButtons(menu: ParsedMenu): List<PromptButton> {
        val down = "\u001b[B"
        val count = menu.options.size
        return menu.options.mapIndexed { index, label ->
            val number = menu.optionNumbers.getOrNull(index)
            if (number != null && number in 1..9) {
                PromptButton(label = label, input = number.toString())
            } else {
                // Fallback for a menu whose options carry no usable digit: relative
                // DOWN steps (wrap-correct), with the Enter as a SEPARATE write.
                val steps = ((index - menu.selectedIndex) % count + count) % count
                PromptButton(label = label, input = down.repeat(steps), submitInput = "\r")
            }
        }
    }
}
