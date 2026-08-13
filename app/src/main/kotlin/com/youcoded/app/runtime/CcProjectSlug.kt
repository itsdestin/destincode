package com.youcoded.app.runtime

/**
 * Mirrors Claude Code 2.1.229's ~/.claude/projects/<slug>/ encoding,
 * bug-for-bug: every non-alphanumeric → '-'; slugs over 200 chars truncate
 * and append base36(abs(rolling hash of the ORIGINAL path)).
 * Anchored to CC-generated fixtures (CcProjectSlugTest) — never to the
 * desktop TS implementation. Spec:
 * youcoded-dev/docs/active/specs/2026-08-11-project-slug-encoding-repair.md §5.3.
 */
object CcProjectSlug {
    // WHY caveat (final review, MINOR fold): Kotlin's Regex.replace iterates
    // per Unicode CODE POINT; JS's String.replace(/[^a-zA-Z0-9]/g, ...) (the
    // mirror this class mirrors) iterates per UTF-16 CODE UNIT. For any
    // non-BMP character (e.g. emoji) that's two different answers — JS emits
    // TWO replacement dashes (one per surrogate half), Kotlin emits ONE. This
    // is currently UNREACHABLE: the only input this object ever receives is
    // Android's canonicalHome, which is ASCII. Do NOT "fix" this to force
    // agreement without a real non-ASCII cwd forcing the question — see
    // slug-encoding.ts's own version note for the sibling mirror's anchor.
    private const val MAX = 200
    private val NON_ALNUM = Regex("[^a-zA-Z0-9]")

    fun hash(s: String): String {
        var h = 0
        for (c in s) h = (h shl 5) - h + c.code   // Int wraparound == JS's |0
        // JS Math.abs on an int32 is exact (doubles); Kotlin abs(Int.MIN_VALUE)
        // stays NEGATIVE. Widen to Long BEFORE abs or the mirror breaks at
        // exactly int32-min. (Desktop's slug-encoding.ts documents the JS side.)
        return kotlin.math.abs(h.toLong()).toString(36)
    }

    fun slug(cwd: String): String {
        val s = NON_ALNUM.replace(cwd, "-")
        return if (s.length <= MAX) s else s.substring(0, MAX) + "-" + hash(cwd)
    }
}
